/**
 * The discovery loop — the only place in the system where a model is in the loop.
 *
 * Its job is not "drive the browser". Its job is to produce a **structured action log**
 * that the recorder can compile into an artifact. Everything here is arranged around that:
 * the model's prose is captured into one labelled field and never parsed, while every
 * load-bearing fact (which element, what changed, what must be true) is read off the
 * observations the surface produced either side of each action.
 *
 * Three properties are worth stating plainly, because they are what make this safe to
 * point at a real application:
 *
 *  1. **The model never touches a credential.** `fill` takes a value *reference*; this
 *     loop resolves it. The secret is taught to the redactor and handed to the surface,
 *     and it appears in neither the transcript nor the action log nor the artifact.
 *  2. **Every action goes through `Surface.act()`**, so the origin allowlist, the denied
 *     capability list and the session lease apply to discovery exactly as to replay.
 *     There is no discovery-only bypass.
 *  3. **The loop stops itself.** Step budget, wall clock and a no-progress detector, all
 *     three of which end the run with a usable log rather than an exception — a partial
 *     capability is worth much more than a truncated transcript.
 *
 * Prompt caching is why `DISCOVERY_TOOLS` is a frozen module-level constant and the system
 * prompt is a frozen string: caching is a prefix match over `tools` → `system` → `messages`,
 * so anything varying at the front would invalidate the whole prefix on every turn.
 */

import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { Surface } from '../surface/surface.js';
import type { Observation } from '../surface/types.js';
import type { RunLogger } from '../evidence/types.js';
import type { Redactor } from '../policy/redact.js';
import type { ValueSource } from '../artifact/schema.js';
import {
  DISCOVERY_TOOLS,
  isDeclaredAssertionEmpty,
  pickAssertion,
  toValueSource,
  type DeclaredExtract,
  type DeclaredOutcome,
  type DiscoveryLog,
  type ObservationSnapshot,
  type RecordedAction,
  type RecordedEscalation,
} from './tools.js';
import {
  DISCOVERY_SYSTEM,
  renderBudgetWarning,
  renderGoal,
  renderNoProgress,
  renderObservation,
} from './prompt.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Asked to resolve an ambiguity or an unexpected page. Returning a string resumes the run
 * with that answer; returning undefined ends it as `escalated`.
 *
 * In M8 this is the console broker. Here it is an injected function so the loop has no
 * opinion about how a human is reached.
 */
export type EscalationHandler = (request: {
  reason: string;
  question: string;
  observation: Observation;
}) => Promise<string | undefined>;

export interface DiscoveryOptions {
  surface: Surface;
  goal: string;
  /** Vendor product identity, e.g. "parabank". Not the institution. */
  app: string;
  baseUrl: string;
  entryPoint: string;
  redactor: Redactor;
  logger: RunLogger;

  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxSteps?: number;
  wallClockMs?: number;
  /** Consecutive unchanged pages before the model is nudged; twice this ends the run. */
  noProgressLimit?: number;
  maxTokens?: number;

  /** Values for `valueKind="input"` parameters, used only to drive this discovery run. */
  inputs?: Record<string, string>;
  /** Overrides for `valueKind="secret"`; falls back to `process.env`. */
  secrets?: Record<string, string>;

  onEscalation?: EscalationHandler;
  client?: Anthropic;
  runId?: string;
  /** Called after every observation, so a CLI can print progress without polling. */
  onProgress?: (note: string) => void;
}

export interface DiscoveryResult {
  log: DiscoveryLog;
  /** The last observation, so the caller can capture evidence before closing the surface. */
  final: Observation;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

const DEFAULTS = {
  model: 'claude-opus-5',
  effort: 'high' as const,
  maxSteps: 40,
  wallClockMs: 300_000,
  noProgressLimit: 3,
  maxTokens: 32_000,
};

/** Tools that actually touch the application, as opposed to declaring something about it. */
const ACTING_TOOLS = new Set(['navigate', 'click', 'fill', 'select', 'press']);

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export async function runDiscovery(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const model = opts.model ?? DEFAULTS.model;
  const maxSteps = opts.maxSteps ?? DEFAULTS.maxSteps;
  const wallClockMs = opts.wallClockMs ?? DEFAULTS.wallClockMs;
  const noProgressLimit = opts.noProgressLimit ?? DEFAULTS.noProgressLimit;
  const runId = opts.runId ?? randomUUID();
  const client = opts.client ?? newClient();
  const deadline = Date.now() + wallClockMs;

  const log: DiscoveryLog = {
    runId,
    goal: opts.goal,
    model,
    startedAt: new Date().toISOString(),
    app: opts.app,
    baseUrl: opts.baseUrl,
    entryPoint: opts.entryPoint,
    actions: [],
    outcomes: [],
    escalations: [],
    stoppedBecause: 'error',
  };
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  await opts.logger.event({
    ts: new Date().toISOString(),
    phase: 'run.start',
    runId,
    detail: `discovery: ${opts.goal}`,
    data: { model, app: opts.app, entryPoint: opts.entryPoint },
  });

  // Get to the entry point through act(), so the very first navigation is policy-checked.
  await opts.surface.act({ type: 'navigate', url: absolute(opts.entryPoint, opts.baseUrl) });
  let observation = await opts.surface.observe();

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: renderGoal(opts.goal, observation) },
  ];

  let stagnant = 0;
  let lastFingerprint = fingerprint(observation);
  let seq = 0;

  while (true) {
    if (Date.now() > deadline) {
      log.stoppedBecause = 'wall_clock';
      break;
    }
    if (log.actions.length >= maxSteps) {
      log.stoppedBecause = 'max_steps';
      break;
    }

    const stream = client.messages.stream({
      model,
      max_tokens: opts.maxTokens ?? DEFAULTS.maxTokens,
      // Frozen prefix: tools render before system, system before messages. The breakpoint
      // sits at the end of the system prompt so the tool list + system prompt — by far the
      // largest stable block — is read from cache on every turn after the first.
      system: [
        { type: 'text', text: DISCOVERY_SYSTEM, cache_control: { type: 'ephemeral' } },
      ],
      tools: DISCOVERY_TOOLS,
      thinking: { type: 'adaptive' },
      output_config: { effort: opts.effort ?? DEFAULTS.effort },
      // Auto-caches the last cacheable block, which extends the cached prefix over the
      // conversation as it grows. Without it every turn re-reads the whole transcript.
      cache_control: { type: 'ephemeral' },
      messages,
    });

    const response = await stream.finalMessage();
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;

    if (response.stop_reason === 'refusal') {
      log.stoppedBecause = 'error';
      await opts.logger.event({
        ts: new Date().toISOString(),
        phase: 'error',
        runId,
        errorClass: 'MODEL_REFUSAL',
        detail: response.stop_details?.explanation ?? 'model declined the request',
      });
      break;
    }

    // Append the assistant turn verbatim. Thinking blocks must be echoed back unchanged,
    // so this pushes `response.content` rather than a reconstruction of it.
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      // The model answered in prose instead of calling a tool. One nudge, then stop —
      // repeating the nudge is how a loop burns a budget saying nothing.
      log.stoppedBecause = 'error';
      await opts.logger.event({
        ts: new Date().toISOString(),
        phase: 'error',
        runId,
        errorClass: 'NO_TOOL_CALL',
        detail: textOf(response).slice(0, 400),
      });
      break;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let stop: DiscoveryLog['stoppedBecause'] | undefined;

    // Sequential, never parallel: each of these mutates the page, so the second call's
    // refs are only meaningful after the first has landed and been re-observed.
    for (const call of toolUses) {
      const input = (call.input ?? {}) as Record<string, unknown>;

      try {
        switch (call.name) {
          case 'observe': {
            observation = await opts.surface.observe();
            results.push(
              await observeResult(call.id, observation, input.screenshot === true, opts),
            );
            break;
          }

          case 'navigate':
          case 'click':
          case 'fill':
          case 'select':
          case 'press': {
            const before = snapshot(observation);
            const action = await performAction(call.name, input, observation, opts);
            // Settled, not immediate — see observeSettled. The "after" snapshot is what
            // the recorder verifies every checkpoint against, so a stale one poisons the
            // whole artifact.
            observation = await observeSettled(opts.surface);
            const after = snapshot(observation);

            log.actions.push({
              seq: ++seq,
              intent: String(input.intent ?? call.name),
              tool: call.name,
              url: call.name === 'navigate' ? String(input.url ?? '') : undefined,
              key: call.name === 'press' ? String(input.key ?? '') : undefined,
              targetRef: typeof input.ref === 'string' ? input.ref : undefined,
              value: action.value,
              before,
              after,
              extracts: [],
              riskHint: input.risk === 'irreversible' ? 'irreversible' : undefined,
            });

            await opts.logger.event({
              ts: new Date().toISOString(),
              phase: 'step.act',
              runId,
              stepId: `discovery.${seq}`,
              intent: String(input.intent ?? call.name),
              action: call.name,
              url: observation.url,
            });
            opts.onProgress?.(`${seq}. ${input.intent ?? call.name} → ${observation.url}`);

            const now = fingerprint(observation);
            stagnant = now === lastFingerprint ? stagnant + 1 : 0;
            lastFingerprint = now;

            results.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: renderObservation(observation),
            });
            break;
          }

          case 'checkpoint': {
            const assertion = pickAssertion(input);
            const target = log.actions[log.actions.length - 1];
            if (!target) {
              results.push(err(call.id, 'no action to attach a checkpoint to — act first'));
              break;
            }
            if (isDeclaredAssertionEmpty(assertion)) {
              results.push(err(call.id, 'a checkpoint needs textPresent, textAbsent or urlMatches'));
              break;
            }
            target.checkpoint = assertion;
            results.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: `checkpoint recorded on "${target.intent}".`,
            });
            break;
          }

          case 'extract': {
            const target = log.actions[log.actions.length - 1];
            if (!target) {
              results.push(err(call.id, 'no action to attach an extraction to — act first'));
              break;
            }
            const ref = String(input.ref ?? '');
            if (!observation.nodes.some((n) => n.ref === ref)) {
              // Caught here rather than at record time: the model can still fix it.
              results.push(err(call.id, `ref "${ref}" is not on the current page — call observe first`));
              break;
            }
            const extract: DeclaredExtract = {
              name: String(input.name ?? 'value'),
              ref,
              as: (input.as as DeclaredExtract['as']) ?? 'string',
              description: String(input.description ?? ''),
              ...(typeof input.pattern === 'string' && input.pattern
                ? { pattern: input.pattern }
                : {}),
            };
            target.extracts.push(extract);
            results.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: `output "${extract.name}" declared (${extract.as}).`,
            });
            break;
          }

          case 'declare_outcome': {
            const detect = pickAssertion(input);
            if (isDeclaredAssertionEmpty(detect)) {
              results.push(
                err(call.id, 'an outcome needs a detector: textPresent, textAbsent or urlMatches'),
              );
              break;
            }
            const outcome: DeclaredOutcome = {
              name: String(input.name ?? 'OUTCOME').toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
              description: String(input.description ?? ''),
              detect,
              terminal: input.terminal !== false,
            };
            log.outcomes = log.outcomes.filter((o) => o.name !== outcome.name).concat(outcome);
            await opts.logger.event({
              ts: new Date().toISOString(),
              phase: 'outcome.detected',
              runId,
              outcome: outcome.name,
              detail: outcome.description,
            });
            results.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: `business outcome "${outcome.name}" declared.`,
            });
            break;
          }

          case 'escalate_to_human': {
            const record: RecordedEscalation = {
              seq: ++seq,
              reason: String(input.reason ?? ''),
              question: String(input.question ?? ''),
              url: observation.url,
            };
            log.escalations.push(record);
            await opts.logger.event({
              ts: new Date().toISOString(),
              phase: 'control.transfer',
              runId,
              detail: record.question,
              data: { reason: record.reason, url: record.url },
            });

            const answer = await opts.onEscalation?.({
              reason: record.reason,
              question: record.question,
              observation,
            });
            if (answer === undefined) {
              stop = 'escalated';
              results.push({
                type: 'tool_result',
                tool_use_id: call.id,
                content: 'No operator is available. The run is ending here.',
              });
              break;
            }
            record.resolution = answer;
            // The operator's answer is authoritative, and the recorder marks any locator
            // chosen after one as high-confidence — a human picked it.
            observation = await opts.surface.observe();
            results.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: `Operator answered: ${answer}\n\n${renderObservation(observation)}`,
            });
            break;
          }

          case 'finish': {
            log.finish = {
              name: String(input.name ?? opts.goal),
              description: String(input.description ?? ''),
              summary: String(input.summary ?? ''),
            };
            stop = 'finished';
            results.push({ type: 'tool_result', tool_use_id: call.id, content: 'Recorded.' });
            break;
          }

          default:
            results.push(err(call.id, `unknown tool "${call.name}"`));
        }
      } catch (error) {
        // A denied action or a stale ref is information the model can act on — a policy
        // refusal in particular is a fact about the world, not a crash.
        const message = error instanceof Error ? error.message : String(error);
        await opts.logger.event({
          ts: new Date().toISOString(),
          phase: 'error',
          runId,
          action: call.name,
          errorClass: error instanceof Error ? error.name : 'Error',
          detail: opts.redactor.text(message),
        });
        results.push(err(call.id, opts.redactor.text(message)));
        observation = await opts.surface.observe().catch(() => observation);
      }

      if (stop) break;
    }

    if (stop) {
      log.stoppedBecause = stop;
      // The final tool results still have to be appended: an assistant turn ending in
      // tool_use with no matching tool_result is an invalid transcript to persist.
      messages.push({ role: 'user', content: results });
      break;
    }

    // Steering appended after the tool results, so it never edits the cached prefix.
    const notes: string[] = [];
    if (stagnant >= noProgressLimit * 2) {
      log.stoppedBecause = 'no_progress';
      messages.push({ role: 'user', content: results });
      break;
    }
    if (stagnant >= noProgressLimit) notes.push(renderNoProgress(stagnant));

    const remaining = maxSteps - log.actions.length;
    if (remaining <= 5) notes.push(renderBudgetWarning(remaining));

    const content: Anthropic.ContentBlockParam[] = [...results];
    if (notes.length > 0) content.push({ type: 'text', text: notes.join('\n\n') });
    messages.push({ role: 'user', content });
  }

  log.finishedAt = new Date().toISOString();
  await opts.logger.event({
    ts: new Date().toISOString(),
    phase: 'run.end',
    runId,
    outcome: log.stoppedBecause,
    data: {
      actions: log.actions.length,
      outcomes: log.outcomes.length,
      escalations: log.escalations.length,
      usage,
    },
  });

  return { log, final: observation, usage };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A workspace-scoped key needs no header; an organization-scoped one is rejected without
 * `anthropic-workspace-id`. Reading it from the environment keeps that a deployment
 * concern rather than something every caller has to know about.
 */
export function newClient(): Anthropic {
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  return new Anthropic(
    workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {},
  );
}

function err(toolUseId: string, message: string): Anthropic.ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: toolUseId, content: message, is_error: true };
}

function textOf(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** URL + node-list hash. Two identical fingerprints in a row means nothing happened. */
function fingerprint(observation: Observation): string {
  return `${observation.url}#${observation.ariaHash}`;
}

/**
 * Observes once the page has stopped moving.
 *
 * Observing immediately after an action is the wrong thing and it fails in a way that
 * looks like the model lying. A click that navigates, or fires an AJAX update, has not
 * changed anything yet at the moment `act()` returns — so the "after" snapshot is the
 * *previous* page. The model then declares a checkpoint describing the page it correctly
 * expects, the recorder checks that claim against a stale observation, and the run is
 * rejected for hallucinating a success that in fact happened. Both the Sonnet and the
 * Opus discovery runs failed exactly this way before this existed.
 *
 * Polling to quiescence rather than awaiting a Playwright load state, because `Surface`
 * is the seam a desktop adapter plugs into and "the UI stopped changing" is expressible
 * there while "domcontentloaded" is not.
 */
async function observeSettled(
  surface: Surface,
  quietMs = 350,
  timeoutMs = 8_000,
): Promise<Observation> {
  const deadline = Date.now() + timeoutMs;
  let last = await surface.observe();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, quietMs));
    const next = await surface.observe();
    if (next.url === last.url && next.ariaHash === last.ariaHash) return next;
    last = next;
  }
  // Still churning after the budget. Return what we have rather than failing: a page that
  // never settles (a spinner, a poller) is a real thing the model needs to see and reason
  // about, not a reason to abandon the run.
  return last;
}

function snapshot(observation: Observation): ObservationSnapshot {
  return {
    url: observation.url,
    title: observation.title,
    ariaHash: observation.ariaHash,
    nodes: observation.nodes,
    text: observation.text,
  };
}

function absolute(url: string, base: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : new URL(url, base).toString();
}

async function observeResult(
  toolUseId: string,
  observation: Observation,
  screenshot: boolean,
  opts: DiscoveryOptions,
): Promise<Anthropic.ToolResultBlockParam> {
  const text = renderObservation(observation);
  if (!screenshot) return { type: 'tool_result', tool_use_id: toolUseId, content: text };

  // Masked at capture, so a credential field never reaches the transcript as pixels.
  const evidence = await opts.surface.capture();
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: [
      { type: 'text', text },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: evidence.screenshot.toString('base64'),
        },
      },
    ],
  };
}

/**
 * Resolves a value reference and performs the action.
 *
 * The resolution happens here and nowhere else, which is what keeps the secret out of the
 * model's context: the model named `PARABANK_PASSWORD`, this function turned that into a
 * string, taught it to the redactor, and handed it to the surface.
 */
async function performAction(
  tool: 'navigate' | 'click' | 'fill' | 'select' | 'press',
  input: Record<string, unknown>,
  observation: Observation,
  opts: DiscoveryOptions,
): Promise<{ value?: ValueSource }> {
  switch (tool) {
    case 'navigate': {
      await opts.surface.act({
        type: 'navigate',
        url: absolute(String(input.url ?? ''), observation.url || opts.baseUrl),
      });
      return {};
    }
    case 'click': {
      await opts.surface.act({ type: 'click', ref: String(input.ref ?? '') });
      return {};
    }
    case 'press': {
      await opts.surface.act({
        type: 'press',
        ref: String(input.ref ?? ''),
        key: String(input.key ?? 'Enter'),
      });
      return {};
    }
    case 'fill':
    case 'select': {
      const source = toValueSource({
        valueKind: (input.valueKind as 'input' | 'secret' | 'literal') ?? 'literal',
        valueName: typeof input.valueName === 'string' ? input.valueName : undefined,
        valueText: typeof input.valueText === 'string' ? input.valueText : undefined,
      });
      const { value, sensitive } = resolveValue(source, opts);
      await opts.surface.act({ type: tool, ref: String(input.ref ?? ''), value, sensitive });
      return { value: source };
    }
  }
}

function resolveValue(
  source: ValueSource,
  opts: DiscoveryOptions,
): { value: string; sensitive: boolean } {
  if ('literal' in source) return { value: source.literal, sensitive: false };

  if ('secretRef' in source) {
    const value = opts.secrets?.[source.secretRef] ?? process.env[source.secretRef];
    if (value === undefined) {
      throw new Error(
        `secret "${source.secretRef}" is not available. Use a different value reference, ` +
          `or ask an operator to supply it.`,
      );
    }
    opts.redactor.learn(value);
    return { value, sensitive: true };
  }

  const name = source.valueFrom.replace(/^\$\.inputs\./, '');
  const value = opts.inputs?.[name];
  if (value === undefined) {
    throw new Error(
      `no discovery value was supplied for input "${name}". Pass --input ${name}=<value>, ` +
        `or use a literal if this does not need to vary per run.`,
    );
  }
  return { value, sensitive: false };
}
