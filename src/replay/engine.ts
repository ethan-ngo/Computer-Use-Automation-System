/**
 * The replay engine.
 *
 * No model, ever. A recorded capability replays as a deterministic state machine over the
 * `Surface` interface: assert the precondition, resolve the locator, check policy, act,
 * then *race the step's checkpoint against every declared business outcome*, then extract.
 *
 * Three things in here are the load-bearing design, and each is defended in REPORT.md:
 *
 *  1. **Outcomes beat checkpoints.** Every observation taken while waiting is offered to
 *     the outcome detectors first. A loan denial therefore returns in milliseconds as a
 *     legitimate business result instead of timing out as CHECKPOINT_FAILED fifteen
 *     seconds later. Conflating those two is the most expensive mistake this class of
 *     system makes, and the precedence rule is the structural fix.
 *  2. **Never assume an action worked.** A click that resolved and did not throw is not
 *     evidence of anything. The checkpoint is.
 *  3. **Three tiers of failure.** Recoverable (declared `onError` specs, bounded retry),
 *     business outcome (a result), and hard failure (escalate or fail, per the taxonomy).
 *     Retrying a hard failure and escalating a recoverable one are both expensive; the
 *     tier is decided by the error class, which is a closed set.
 */

import { randomUUID } from 'node:crypto';
import type { Assertion, RecoverySpec, Step, ValueSource } from '../artifact/schema.js';
import type { ResolvedCapability } from '../artifact/store.js';
import type { Surface } from '../surface/surface.js';
import type { Observation, SurfaceAction } from '../surface/types.js';
import type { Policy } from '../policy/policy.js';
import type { Redactor } from '../policy/redact.js';
import type { RunEvent, RunLogger } from '../evidence/types.js';
import { evaluate } from './assertions.js';
import { detectOutcome, type OutcomeHit } from './outcomes.js';
import { extractAll, DEFAULT_LOCALE, type ExtractedValue, type Locale } from './extract.js';
import { describeStrategy, type CssMatcher } from './locator.js';
import { asReplayError, BudgetExceededError, DISPOSITION, ReplayError } from './errors.js';

// ---------------------------------------------------------------------------
// Injected collaborators — all of them exist so the engine is testable without a browser
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Resolves a `secretRef` to a value at replay time. Secrets never appear in the artifact,
 * so this is the only place one enters the system, and every value it returns is handed to
 * the redactor immediately.
 */
export interface SecretResolver {
  resolve(ref: string): Promise<string> | string;
}

export class EnvSecretResolver implements SecretResolver {
  constructor(
    /** The tenant's mapping from artifact secret name to where this institution keeps it. */
    private readonly mapping: Record<string, string> = {},
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  resolve(ref: string): string {
    const name = this.mapping[ref] ?? ref;
    const value = this.env[name];
    if (!value) {
      // POLICY_DENIED rather than APP_ERROR: a missing credential is a configuration
      // decision, and retrying it against a bank's login form is how a service account
      // gets locked out. This class is never retried.
      throw new ReplayError(
        'POLICY_DENIED',
        `secret "${ref}" is not available (looked for environment variable ${name})`,
        { secretRef: ref },
      );
    }
    return value;
  }
}

/**
 * Asked before every irreversible step when the capability requires approval. Returning
 * false escalates rather than failing: a human declining to open an account is a decision
 * that belongs in front of a human, not a crash.
 */
export type ApprovalHook = (step: Step, observation: Observation) => Promise<boolean> | boolean;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type StepStatus = 'ok' | 'recovered' | 'skipped' | 'completed_by_human' | 'failed';

export interface StepRecord {
  id: string;
  index: number;
  intent: string;
  status: StepStatus;
  attempts: number;
  durationMs: number;
  /** Which strategy resolved, and whether it was a fallback. The drift telemetry. */
  strategy?: string;
  degraded?: boolean;
  errorClass?: string;
  detail?: string;
}

interface ResultBase {
  runId: string;
  capabilityId: string;
  capabilityVersion: string;
  tenantId?: string;
  steps: StepRecord[];
  outputs: Record<string, ExtractedValue>;
  durationMs: number;
}

/**
 * The four terminal states, kept apart in the type system so a caller cannot accidentally
 * treat "the bank said no" as "the automation broke".
 */
export type ReplayResult =
  | ({ kind: 'success' } & ResultBase)
  | ({ kind: 'business_outcome'; outcome: OutcomeHit; atStepId: string } & ResultBase)
  | ({
      kind: 'escalated';
      reason: 'approval_required' | 'error';
      atStepId: string;
      /** Carried straight into the intervention request in M8. */
      intent: string;
      expected: string;
      observed: string;
      url: string;
      errorClass?: string;
      error?: ReplayError;
    } & ResultBase)
  | ({ kind: 'failed'; atStepId: string; errorClass: string; error: ReplayError } & ResultBase);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ReplayOptions {
  capability: ResolvedCapability;
  surface: Surface;
  policy: Policy;
  redactor: Redactor;
  /** Caller arguments, already validated against `compileInputs(artifact)`. */
  inputs?: Record<string, unknown>;
  /** Absolute base for the artifact's relative navigation targets. */
  baseUrl?: string;
  runId?: string;
  logger?: RunLogger;
  secrets?: SecretResolver;
  approve?: ApprovalHook;
  clock?: Clock;
  /** How often to re-observe while waiting. */
  pollMs?: number;
  /**
   * Recognises the app bouncing us back to a login screen mid-flow. Supplied by the caller
   * because it is an application fact, not a capability fact — every capability against
   * this app shares one.
   */
  sessionExpired?: Assertion;
  /** Re-authenticate. Called at most once per run, on SESSION_EXPIRED. */
  reLogin?: () => Promise<void>;
  /** Resume support: steps a human already completed during an intervention. */
  completedSteps?: string[];
  /** Resume support: start here rather than at step 0. */
  startAtStepId?: string;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

type RaceResult =
  | { kind: 'assertion'; observation: Observation; detail: string }
  | { kind: 'outcome'; observation: Observation; hit: OutcomeHit }
  | { kind: 'timeout'; observation: Observation; detail: string };

export class ReplayEngine {
  private readonly runId: string;
  private readonly clock: Clock;
  private readonly locale: Locale;
  private readonly matchCss: CssMatcher;
  private readonly startedAt: number;
  private readonly steps: StepRecord[] = [];
  private outputs: Record<string, ExtractedValue> = {};
  private stepBudgetUsed = 0;
  private reLoginUsed = false;
  private pendingRecord: Partial<StepRecord> = {};

  constructor(private readonly opts: ReplayOptions) {
    this.runId = opts.runId ?? randomUUID();
    this.clock = opts.clock ?? REAL_CLOCK;
    this.locale = opts.capability.tenant?.locale ?? DEFAULT_LOCALE;
    this.matchCss = (selector) => opts.surface.matchCss(selector);
    this.startedAt = this.clock.now();
  }

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  private log(event: Omit<RunEvent, 'ts' | 'runId'>): void {
    // Redacted here, at the write boundary, rather than trusting every call site.
    void this.opts.logger?.event(
      this.opts.redactor.value({
        ts: new Date().toISOString(),
        runId: this.runId,
        ...event,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // The run
  // -------------------------------------------------------------------------

  async run(): Promise<ReplayResult> {
    const { capability } = this.opts;
    this.log({
      phase: 'run.start',
      detail: `${capability.artifact.id}@${capability.artifact.version}`,
      data: {
        tenant: capability.tenant?.tenantId,
        appliedOverrides: capability.appliedOverrides,
      },
    });

    const completed = new Set(this.opts.completedSteps ?? []);
    const startIndex = this.opts.startAtStepId
      ? capability.steps.findIndex((s) => s.id === this.opts.startAtStepId)
      : 0;

    if (startIndex < 0) {
      // Resuming into a step the artifact no longer has means the artifact moved under the
      // intervention. That is exactly what the resume token's version pin exists to catch.
      return this.fail(
        this.opts.startAtStepId ?? '<unknown>',
        new ReplayError(
          'RESUME_STATE_UNRECOGNIZED',
          `cannot resume at "${this.opts.startAtStepId}": no such step in ` +
            `${capability.artifact.id}@${capability.artifact.version}`,
        ),
      );
    }

    for (const step of capability.steps.slice(startIndex)) {
      if (completed.has(step.id)) {
        // A human finished this during a handoff. Recording it as such, rather than
        // re-running it, is the difference between resuming and repeating — and repeating
        // an irreversible step is the failure mode that costs money.
        this.steps.push({
          id: step.id,
          index: step.index,
          intent: step.intent,
          status: 'completed_by_human',
          attempts: 0,
          durationMs: 0,
        });
        this.log({
          phase: 'step.end',
          stepId: step.id,
          intent: step.intent,
          detail: 'completed by human',
        });
        continue;
      }

      const result = await this.runStep(step);
      if (result) return result; // terminal
    }

    return this.checkPostcondition();
  }

  // -------------------------------------------------------------------------
  // One step, with the recovery loop around it
  // -------------------------------------------------------------------------

  /** Returns a terminal result, or undefined to continue with the next step. */
  private async runStep(step: Step): Promise<ReplayResult | undefined> {
    const startedAt = this.clock.now();
    const recoveryAttempts = new Map<string, number>();
    let attempts = 0;

    for (;;) {
      const budget = this.checkBudgets();
      if (budget) return this.fail(step.id, budget);

      attempts += 1;
      this.stepBudgetUsed += 1;
      this.log({
        phase: 'step.start',
        stepId: step.id,
        intent: step.intent,
        action: step.action.type,
      });

      try {
        const terminal = await this.attemptStep(step);
        if (terminal) return terminal;

        this.record(step, {
          status: attempts > 1 ? 'recovered' : 'ok',
          attempts,
          durationMs: this.clock.now() - startedAt,
        });
        return undefined;
      } catch (raw) {
        const error = await this.reclassify(asReplayError(raw));

        this.log({
          phase: 'error',
          stepId: step.id,
          intent: step.intent,
          errorClass: error.class,
          detail: error.message,
        });

        const recovery = step.onError.find((spec) => spec.when === error.class);
        const used = recovery ? (recoveryAttempts.get(recovery.when) ?? 0) : 0;
        const retriesLeft = attempts <= this.opts.policy.budgets.maxRetriesPerStep;

        if (recovery && used < recovery.maxAttempts && retriesLeft) {
          recoveryAttempts.set(recovery.when, used + 1);
          this.log({
            phase: 'step.recover',
            stepId: step.id,
            intent: step.intent,
            errorClass: error.class,
            detail: recovery.description,
          });
          try {
            await this.runRecovery(recovery);
          } catch (recoveryError) {
            // A recovery that itself fails is not worth a second recovery. Report the
            // original error, which is the one a human needs to see.
            this.record(step, {
              status: 'failed',
              attempts,
              durationMs: this.clock.now() - startedAt,
              errorClass: error.class,
              detail: error.message,
            });
            return this.disposeOf(step, error, asReplayError(recoveryError).message);
          }
          if (recovery.thenRetry) continue;

          this.record(step, {
            status: 'recovered',
            attempts,
            durationMs: this.clock.now() - startedAt,
            detail: recovery.description,
          });
          return undefined;
        }

        // The one built-in recovery, because re-authentication is an application fact
        // rather than a per-capability one and every capability would otherwise declare it.
        if (
          error.class === 'SESSION_EXPIRED' &&
          this.opts.reLogin &&
          !this.reLoginUsed &&
          retriesLeft
        ) {
          this.reLoginUsed = true;
          this.log({
            phase: 'step.recover',
            stepId: step.id,
            intent: step.intent,
            errorClass: error.class,
            detail: 're-authenticating once',
          });
          await this.opts.reLogin();
          continue;
        }

        this.record(step, {
          status: 'failed',
          attempts,
          durationMs: this.clock.now() - startedAt,
          errorClass: error.class,
          detail: error.message,
        });
        return this.disposeOf(step, error);
      }
    }
  }

  /**
   * One attempt at a step. Returns a terminal result when a business outcome fired, or
   * undefined when the step simply succeeded. Throws a `ReplayError` otherwise.
   */
  private async attemptStep(step: Step): Promise<ReplayResult | undefined> {
    // 1. Precondition. Outcomes are racing from the very first observation, so a flow that
    //    has already landed on a denial page never waits out a precondition it will never
    //    satisfy.
    let observation: Observation;
    if (step.waitFor) {
      const raced = await this.race(step.waitFor.assertion, step.waitFor.timeoutMs, step);
      if (raced.kind === 'outcome') return this.businessOutcome(step, raced.hit);
      if (raced.kind === 'timeout') {
        throw new ReplayError(
          'CHECKPOINT_FAILED',
          `precondition for "${step.intent}" never held: ${raced.detail}`,
          { stepId: step.id, url: raced.observation.url },
        );
      }
      observation = raced.observation;
      this.log({
        phase: 'step.wait',
        stepId: step.id,
        intent: step.intent,
        detail: raced.detail,
        url: observation.url,
      });
    } else {
      observation = await this.opts.surface.observe();
      const hit = await detectOutcome(
        this.opts.capability.outcomes,
        observation,
        this.locale,
        this.matchCss,
      );
      if (hit) return this.businessOutcome(step, hit);
    }

    // 2. Resolve. Exactly one match, or a distinct, surfaced failure — never a silent pick.
    let ref: string | undefined;
    if (step.locator) {
      const resolution = await this.opts.surface.resolve(step.locator);
      ref = resolution.node.ref;
      this.pendingRecord = {
        strategy: describeStrategy(resolution.strategy),
        degraded: resolution.degraded,
      };
      this.log({
        phase: 'step.resolve',
        stepId: step.id,
        intent: step.intent,
        strategy: describeStrategy(resolution.strategy),
        fallbackIndex: resolution.fallbackIndex,
        // A fallback winning is a drift signal, logged on the *success* path precisely
        // because nothing is failing yet. Aggregated across tenants it is the early
        // warning: one tenant degraded means local customisation, every tenant degraded
        // means the vendor shipped a release.
        degraded: resolution.degraded,
      });
    }

    // 3. Approval, before an irreversible action rather than after it.
    if (step.risk === 'irreversible' && this.opts.capability.requiresApproval) {
      this.log({
        phase: 'approval.requested',
        stepId: step.id,
        intent: step.intent,
        url: observation.url,
      });
      const approved = this.opts.approve ? await this.opts.approve(step, observation) : false;
      if (!approved) {
        return this.escalate(step, {
          reason: 'approval_required',
          expected: `human approval for irreversible step "${step.intent}"`,
          observed: this.opts.approve
            ? 'approval declined'
            : 'no approver is attached to this run',
          url: observation.url,
        });
      }
    }

    // 4. Act — through the chokepoint, which re-checks policy and the lease.
    const action = await this.buildAction(step, ref);
    const result = await this.opts.surface.act(action);
    this.log({
      phase: 'step.act',
      stepId: step.id,
      intent: step.intent,
      action: action.type,
      url: result.url,
      durationMs: result.durationMs,
    });

    // 5. The race. This is the headline behaviour: outcomes are evaluated before the
    //    checkpoint on every tick, so a declared business outcome wins immediately instead
    //    of the checkpoint grinding to a timeout.
    const raced = await this.race(step.checkpoint, step.timeoutMs, step);
    if (raced.kind === 'outcome') return this.businessOutcome(step, raced.hit);
    if (raced.kind === 'timeout') {
      throw new ReplayError(
        'CHECKPOINT_FAILED',
        `"${step.intent}" did not reach its checkpoint: ${raced.detail}`,
        {
          stepId: step.id,
          url: raced.observation.url,
          expected: describeAssertion(step.checkpoint),
        },
      );
    }
    this.log({
      phase: 'step.checkpoint',
      stepId: step.id,
      intent: step.intent,
      detail: raced.detail,
    });

    // 6. Extract.
    if (step.extract.length > 0) {
      const extracted = await extractAll(
        step.extract,
        raced.observation,
        this.locale,
        this.matchCss,
      );
      this.outputs = { ...this.outputs, ...extracted };
      this.log({ phase: 'step.extract', stepId: step.id, intent: step.intent, data: extracted });
    }

    return undefined;
  }

  // -------------------------------------------------------------------------
  // The race
  // -------------------------------------------------------------------------

  /**
   * Polls until the assertion holds, a declared outcome fires, or the deadline passes.
   *
   * Outcomes are checked first on every tick. That ordering *is* the precedence rule, and
   * it is why a business outcome costs one observation rather than a full timeout.
   *
   * An undefined assertion means "nothing to wait for": we still take one observation and
   * still offer it to the detectors, because a step with no checkpoint is exactly where an
   * unnoticed outcome page would otherwise slip through.
   */
  private async race(
    assertion: Assertion | undefined,
    timeoutMs: number,
    step: Step,
  ): Promise<RaceResult> {
    const pollMs = this.opts.pollMs ?? 250;
    const deadline = this.clock.now() + timeoutMs;
    let observation = await this.opts.surface.observe();

    for (;;) {
      const hit = await detectOutcome(
        this.opts.capability.outcomes,
        observation,
        this.locale,
        this.matchCss,
      );
      if (hit) {
        this.log({
          phase: 'outcome.detected',
          stepId: step.id,
          intent: step.intent,
          outcome: hit.name,
          detail: hit.detail,
          url: observation.url,
        });
        return { kind: 'outcome', observation, hit };
      }

      if (!assertion) return { kind: 'assertion', observation, detail: 'no assertion declared' };

      const evaluated = await evaluate(assertion, observation, this.matchCss);
      if (evaluated.ok) return { kind: 'assertion', observation, detail: evaluated.detail };

      if (this.clock.now() >= deadline) {
        return { kind: 'timeout', observation, detail: evaluated.detail };
      }

      await this.clock.sleep(pollMs);
      observation = await this.opts.surface.observe();
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async buildAction(step: Step, ref: string | undefined): Promise<SurfaceAction> {
    switch (step.action.type) {
      case 'navigate':
        return { type: 'navigate', url: this.absolute(step.action.url) };
      case 'wait':
        // A `wait` step exists to hold a checkpoint or an extraction, not to burn time, so
        // the dwell is one poll interval rather than the step timeout.
        return { type: 'wait', ms: this.opts.pollMs ?? 250 };
      case 'click':
        return { type: 'click', ref: this.requireRef(step, ref) };
      case 'press':
        return { type: 'press', ref: this.requireRef(step, ref), key: step.action.key };
      case 'fill': {
        const { value, sensitive } = await this.resolveValue(step.action.value);
        return { type: 'fill', ref: this.requireRef(step, ref), value, sensitive };
      }
      case 'select': {
        const { value, sensitive } = await this.resolveValue(step.action.value);
        return { type: 'select', ref: this.requireRef(step, ref), value, sensitive };
      }
    }
  }

  private requireRef(step: Step, ref: string | undefined): string {
    if (!ref) {
      throw new ReplayError('LOCATOR_NOT_FOUND', `step "${step.id}" needs a locator to act on`, {
        stepId: step.id,
      });
    }
    return ref;
  }

  private absolute(url: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    const base = this.opts.baseUrl ?? this.opts.capability.baseUrl;
    if (!base) {
      throw new ReplayError(
        'NAVIGATION_BLOCKED',
        `"${url}" is relative but no baseUrl is bound — a tenant binding or an explicit ` +
          `baseUrl is required to make an artifact executable`,
      );
    }
    return new URL(url, base).toString();
  }

  /**
   * Turns a declared value *reference* into a literal, at the last possible moment.
   *
   * This is where the "references, not literals" decision pays off: parameterisation and
   * never-persisting-secrets are the same mechanism, resolved in one place, and every
   * secret resolved here is taught to the redactor before it can reach a log.
   */
  private async resolveValue(source: ValueSource): Promise<{ value: string; sensitive: boolean }> {
    if ('literal' in source) return { value: source.literal, sensitive: false };

    if ('secretRef' in source) {
      const resolver =
        this.opts.secrets ?? new EnvSecretResolver(this.opts.capability.tenant?.secrets);
      const value = String(await resolver.resolve(source.secretRef));
      this.opts.redactor.learn(value);
      return { value, sensitive: true };
    }

    const path = source.valueFrom;
    const name = path.replace(/^\$\.(inputs|outputs)\./, '');
    const bag = path.startsWith('$.inputs.')
      ? (this.opts.inputs ?? {})
      : (this.outputs as Record<string, unknown>);
    const value = bag[name];
    if (value === undefined || value === null) {
      throw new ReplayError('APP_ERROR', `"${path}" is not available: no value for "${name}"`, {
        reference: path,
      });
    }
    const sensitive =
      path.startsWith('$.inputs.') &&
      this.opts.capability.artifact.inputs[name]?.sensitive === true;
    if (sensitive) this.opts.redactor.learn(String(value));
    return { value: String(value), sensitive: Boolean(sensitive) };
  }

  /**
   * Runs a declared recovery. Recovery actions go through `Surface.act()` like everything
   * else — there is no privileged path for "just fixing things up".
   */
  private async runRecovery(spec: RecoverySpec): Promise<void> {
    for (const move of spec.do) {
      const ref = move.locator ? (await this.opts.surface.resolve(move.locator)).node.ref : undefined;
      const synthetic = { id: 'step.recovery', action: move.action } as Step;
      await this.opts.surface.act(await this.buildAction(synthetic, ref));
    }
  }

  // -------------------------------------------------------------------------
  // Budgets, classification, terminal results
  // -------------------------------------------------------------------------

  /**
   * Bounded effort, checked before every attempt. A runaway loop against a bank's
   * back-office application is a self-inflicted denial of service on a system that tellers
   * are using at the same time.
   */
  private checkBudgets(): BudgetExceededError | undefined {
    const { budgets } = this.opts.policy;
    if (this.stepBudgetUsed >= budgets.maxStepsPerReplay) {
      return new BudgetExceededError(
        'steps',
        `step budget exhausted after ${this.stepBudgetUsed} attempts ` +
          `(limit ${budgets.maxStepsPerReplay})`,
      );
    }
    const elapsed = this.clock.now() - this.startedAt;
    if (elapsed >= budgets.wallClockMs) {
      return new BudgetExceededError(
        'wallClock',
        `wall-clock budget exhausted after ${elapsed}ms (limit ${budgets.wallClockMs}ms)`,
      );
    }
    return undefined;
  }

  /**
   * Promotes a generic failure to SESSION_EXPIRED when the app bounced us back to a login
   * screen. Worth the extra observation: "the checkpoint did not hold" sends a human to
   * look at a page, while "the session expired" is fixed automatically, once.
   */
  private async reclassify(error: ReplayError): Promise<ReplayError> {
    if (!this.opts.sessionExpired) return error;
    if (error.class !== 'CHECKPOINT_FAILED' && error.class !== 'LOCATOR_NOT_FOUND') return error;
    const observation = await this.opts.surface.observe();
    const verdict = await evaluate(this.opts.sessionExpired, observation, this.matchCss).catch(
      () => undefined,
    );
    if (!verdict?.ok) return error;
    return new ReplayError(
      'SESSION_EXPIRED',
      `session expired mid-flow: ${error.message}`,
      error.context,
    );
  }

  private record(step: Step, patch: Omit<StepRecord, 'id' | 'index' | 'intent'>): void {
    this.steps.push({
      id: step.id,
      index: step.index,
      intent: step.intent,
      ...this.pendingRecord,
      ...patch,
    });
    this.pendingRecord = {};
    this.log({
      phase: 'step.end',
      stepId: step.id,
      intent: step.intent,
      detail: patch.status,
      durationMs: patch.durationMs,
    });
  }

  private base(): ResultBase {
    return {
      runId: this.runId,
      capabilityId: this.opts.capability.artifact.id,
      capabilityVersion: this.opts.capability.artifact.version,
      tenantId: this.opts.capability.tenant?.tenantId,
      steps: this.steps,
      outputs: this.opts.redactor.value(this.outputs),
      durationMs: this.clock.now() - this.startedAt,
    };
  }

  private businessOutcome(step: Step, hit: OutcomeHit): ReplayResult | undefined {
    this.outputs = { ...this.outputs, ...hit.data };
    if (!hit.terminal) return undefined; // informational; the flow carries on
    this.record(step, {
      status: 'ok',
      attempts: 1,
      durationMs: 0,
      detail: `outcome ${hit.name}`,
    });
    this.log({ phase: 'run.end', outcome: hit.name, detail: hit.description });
    return { kind: 'business_outcome', outcome: hit, atStepId: step.id, ...this.base() };
  }

  private escalate(
    step: Step,
    info: {
      reason: 'approval_required' | 'error';
      expected: string;
      observed: string;
      url: string;
      error?: ReplayError;
    },
  ): ReplayResult {
    this.log({
      phase: 'run.end',
      stepId: step.id,
      intent: step.intent,
      detail: `escalated: ${info.reason}`,
      errorClass: info.error?.class,
    });
    return {
      kind: 'escalated',
      reason: info.reason,
      atStepId: step.id,
      intent: step.intent,
      expected: info.expected,
      observed: info.observed,
      url: info.url,
      errorClass: info.error?.class,
      error: info.error,
      ...this.base(),
    };
  }

  private fail(stepId: string, error: ReplayError): ReplayResult {
    this.log({ phase: 'run.end', stepId, errorClass: error.class, detail: error.message });
    return { kind: 'failed', atStepId: stepId, errorClass: error.class, error, ...this.base() };
  }

  /** Tier three: the error class decides between a human and a hard stop. */
  private disposeOf(step: Step, error: ReplayError, note?: string): ReplayResult {
    if (DISPOSITION[error.class] === 'fail') return this.fail(step.id, error);
    return this.escalate(step, {
      reason: 'error',
      expected: describeAssertion(step.checkpoint) ?? step.intent,
      observed: note ? `${error.message} (recovery also failed: ${note})` : error.message,
      url: String(error.context.url ?? ''),
      error,
    });
  }

  // -------------------------------------------------------------------------
  // Postcondition
  // -------------------------------------------------------------------------

  private async checkPostcondition(): Promise<ReplayResult> {
    const { postcondition } = this.opts.capability.artifact;
    const last = this.opts.capability.steps[this.opts.capability.steps.length - 1]!;
    const raced = await this.race(postcondition, last.timeoutMs, last);

    if (raced.kind === 'outcome') {
      const terminal = this.businessOutcome(last, raced.hit);
      if (terminal) return terminal;
    }

    if (raced.kind === 'timeout') {
      // Every step passed its own checkpoint and the capability still did not deliver what
      // it promised. That gap is the definition of structural divergence, and it earns a
      // distinct class: the artifact's model of the app is wrong, not one locator drifted.
      return this.disposeOf(
        last,
        new ReplayError(
          'STRUCTURAL_DIVERGENCE',
          `every step succeeded but the capability postcondition did not hold: ${raced.detail}`,
          { url: raced.observation.url },
        ),
      );
    }

    this.log({ phase: 'run.end', detail: 'success', outcome: 'SUCCESS' });
    return { kind: 'success', ...this.base() };
  }
}

/** A one-line rendering of an assertion, for "expected X, observed Y" in escalations. */
export function describeAssertion(assertion: Assertion | undefined): string | undefined {
  if (!assertion) return undefined;
  switch (assertion.kind) {
    case 'urlMatches':
      return `url matching /${assertion.pattern}/`;
    case 'titleMatches':
      return `title matching /${assertion.pattern}/`;
    case 'textPresent':
      return `the text "${assertion.text}" on the page`;
    case 'textAbsent':
      return `the text "${assertion.text}" gone from the page`;
    case 'elementVisible':
      return `"${assertion.locator.description}" visible`;
    case 'elementAbsent':
      return `"${assertion.locator.description}" absent`;
    case 'all':
      return assertion.of.map((a) => describeAssertion(a)).join(' and ');
    case 'any':
      return assertion.of.map((a) => describeAssertion(a)).join(' or ');
  }
}

/** Convenience wrapper. */
export function replay(options: ReplayOptions): Promise<ReplayResult> {
  return new ReplayEngine(options).run();
}
