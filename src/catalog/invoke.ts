/**
 * Invoking a catalogued capability.
 *
 * Validate the caller's arguments against the capability's own schema, replay it, and hand
 * back a typed result. The whole file is deliberately thin — everything that makes this
 * safe already exists in the artifact and the engine, and re-implementing any of it here
 * would create a second path with different rules.
 *
 * The one decision worth defending: **a business outcome comes back as a result, not as an
 * error.** `ok: false` is reserved for the automation being broken. A calling agent that
 * receives `LOAN_DENIED` has its answer, and a retry would be wrong; a calling agent that
 * receives `failed` may legitimately retry or escalate. Collapsing those two into one
 * "error" shape is the mistake this system is built to avoid, and the invoke boundary is
 * the last place it could be reintroduced.
 */

import { randomUUID } from 'node:crypto';
import { compileInputs, sensitiveInputNames } from '../artifact/params.js';
import { loadResolved } from '../artifact/store.js';
import { loadPolicy } from '../policy/policy.js';
import { Redactor } from '../policy/redact.js';
import { LeaseManager } from '../escalation/lease.js';
import { PlaywrightWebSurface } from '../surface/playwright-web.js';
import { FileRunLogger } from '../evidence/logger.js';
import { RunEvidence } from '../evidence/capture.js';
import { replay, type ApprovalHook } from '../replay/engine.js';
import type { Catalog } from './catalog.js';

/**
 * What a calling agent sees. Flat and JSON-serialisable, because it goes straight back into
 * a `tool_result` block — and shaped so the three non-success cases cannot be mistaken for
 * each other by a model skimming the text.
 */
export type InvocationResult =
  | { ok: true; status: 'success'; capability: string; runId: string; outputs: Record<string, unknown>; evidence: string }
  | {
      ok: true;
      status: 'business_outcome';
      capability: string;
      runId: string;
      outcome: string;
      description: string;
      detail: string;
      retryable: false;
      evidence: string;
    }
  | { ok: false; status: 'escalated'; capability: string; runId: string; atStep: string; expected: string; observed: string; evidence: string }
  | { ok: false; status: 'failed'; capability: string; runId: string; atStep: string; errorClass: string; message: string; evidence: string }
  | { ok: false; status: 'rejected'; capability: string; reason: string };

export interface InvokeOptions {
  catalog: Catalog;
  toolName: string;
  args: unknown;
  tenantId?: string;
  baseUrl?: string;
  headless?: boolean;
  /** Defaults to declining: an unattended agent must not be able to approve its own act. */
  approve?: ApprovalHook;
}

export async function invoke(options: InvokeOptions): Promise<InvocationResult> {
  const entry = options.catalog.lookup(options.toolName);
  if (!entry) {
    return {
      ok: false,
      status: 'rejected',
      capability: options.toolName,
      reason: `no capability named "${options.toolName}" is in the catalog`,
    };
  }

  /*
   * A caller may never supply a credential, even for a capability whose schema declares one.
   *
   * The tool definition already omits sensitive inputs, so a well-behaved agent cannot ask
   * to. This is the enforcement behind that omission: the catalog is a trust boundary, and
   * "the schema does not mention it" is a description, not a control. Credentials resolve
   * from the tenant binding at replay time or the run does not happen.
   */
  const smuggled = sensitiveInputNames(entry.artifact).filter(
    (name) => typeof options.args === 'object' && options.args !== null && name in options.args,
  );
  if (smuggled.length > 0) {
    return {
      ok: false,
      status: 'rejected',
      capability: entry.capabilityId,
      reason:
        `refusing arguments for sensitive input(s): ${smuggled.join(', ')}. ` +
        'Credentials are resolved from the tenant binding, never passed by a caller.',
    };
  }

  // Validated against the capability's own declaration, before a browser opens. A calling
  // agent is an untrusted source of arguments like any other.
  const parsed = compileInputs(entry.artifact).safeParse(options.args ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      status: 'rejected',
      capability: entry.capabilityId,
      reason:
        'arguments do not satisfy the capability contract: ' +
        parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '),
    };
  }

  const runId = randomUUID();
  const policy = loadPolicy();
  const redactor = new Redactor(policy).learnFromEnv();
  const logger = new FileRunLogger(runId, redactor);
  const leases = new LeaseManager(runId).attachLogger(logger, runId);
  const capability = await loadResolved(entry.capabilityId, options.tenantId);

  const baseUrl =
    options.baseUrl ??
    capability.baseUrl ??
    `https://${capability.artifact.policy.allowedDomains[0]}`;

  const surface = await PlaywrightWebSurface.launch({
    policy,
    redactor,
    leases,
    extraOrigins: [baseUrl],
    headless: options.headless ?? true,
    // Never for an agent-driven run: a trace cannot be redacted, and nobody is watching.
    trace: false,
  });
  const evidence = new RunEvidence(surface, logger, runId, logger);

  try {
    await surface.act({
      type: 'navigate',
      url: new URL(capability.artifact.target.entryPoint, baseUrl).toString(),
    });

    const result = await replay({
      capability,
      surface,
      policy,
      redactor,
      inputs: parsed.data,
      baseUrl,
      runId,
      logger,
      capture: evidence,
      // Declining by default is the safe failure: an irreversible step escalates to a human
      // rather than being authorised by the agent that asked for it.
      approve: options.approve ?? (() => false),
    });

    logger.write('result.json', JSON.stringify(redactor.value(result), null, 2));
    if (result.kind === 'failed' || result.kind === 'escalated') await evidence.failure(result.kind);

    const common = { capability: entry.capabilityId, runId, evidence: logger.dir };

    switch (result.kind) {
      case 'success':
        return {
          ok: true,
          status: 'success',
          ...common,
          outputs: result.outputs,
        };
      case 'business_outcome':
        return {
          ok: true,
          status: 'business_outcome',
          ...common,
          outcome: result.outcome.name,
          description: result.outcome.description,
          detail: result.outcome.detail,
          retryable: false,
        };
      case 'escalated':
        return {
          ok: false,
          status: 'escalated',
          ...common,
          atStep: result.intent,
          expected: result.expected,
          observed: result.observed,
        };
      case 'failed':
        return {
          ok: false,
          status: 'failed',
          ...common,
          atStep: result.atStepId,
          errorClass: result.errorClass,
          message: result.error.message,
        };
    }
  } finally {
    await surface.close();
  }
}
