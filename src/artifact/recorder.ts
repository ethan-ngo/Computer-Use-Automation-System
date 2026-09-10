/**
 * The recorder: structured action log → capability artifact.
 *
 * The single most important property of this module is what it does *not* read. It never
 * parses model prose. `intent`, `name` and `description` are copied into labelled fields
 * verbatim and are display text; every load-bearing field — locators, fallback chains,
 * checkpoints, extraction targets, risk — is computed from the observations the surface
 * captured either side of each action.
 *
 * That is the difference between "the model wrote an automation" and "the model showed us
 * a path and we recorded what actually happened". A model that hallucinates a selector
 * cannot get one into an artifact from here: candidate strategies are generated from the
 * live node the action targeted, and each is then **verified against the same matcher the
 * replay engine uses** before it is written down. A strategy that would not resolve is
 * discarded rather than recorded and discovered in production.
 */

import { classifyRisk, type Policy } from '../policy/policy.js';
import { evaluate } from '../replay/assertions.js';
import { matchStrategy } from '../replay/locator.js';
import type { Observation, UiNode } from '../surface/types.js';
import type {
  Assertion,
  CapabilityArtifact,
  ExtractSpec,
  Locator,
  OutcomeSpec,
  OutputSpec,
  ParamSpec,
  Step,
  Strategy,
} from './schema.js';
import type {
  DeclaredAssertion,
  DeclaredExtract,
  DiscoveryLog,
  ObservationSnapshot,
  RecordedAction,
} from '../agent/tools.js';

export interface RecordOptions {
  policy: Policy;
  /** Where the run's evidence bundle lives, recorded in provenance. */
  evidenceRef: string;
  /** Overrides the id derived from the app and the capability name. */
  id?: string;
  version?: string;
  surfaceKind?: CapabilityArtifact['target']['surfaceKind'];
}

export class RecorderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecorderError';
  }
}

// ---------------------------------------------------------------------------
// Locator synthesis
// ---------------------------------------------------------------------------

/**
 * Strategies in preference order. Robustness first, `css` only ever as a last resort.
 *
 * `forExtraction` drops every strategy keyed on the node's own accessible name, and that
 * distinction is not a nicety — it is the difference between a capability that works twice
 * and one that works once.
 *
 * For an element we *act on*, the name is its stable identity: the button says "Log In"
 * on every run. For an element we *extract from*, the name is the payload. The first live
 * Opus run recorded the new account number's locator as `role=link name="21336"` — the
 * number it had just created. On the next replay the account number is different, the
 * locator matches nothing, and the capability fails at the only step that produced value.
 * Where the value lives is described by the things around it, never by the value itself.
 */
function candidateStrategies(node: UiNode, forExtraction = false): Strategy[] {
  const out: Strategy[] = [];
  if (node.name && !forExtraction) out.push({ kind: 'role', role: node.role, name: node.name });
  if (node.testId) out.push({ kind: 'testId', id: node.testId });
  if (node.labelHint) out.push({ kind: 'label', text: node.labelHint });
  if (node.placeholder) out.push({ kind: 'placeholder', text: node.placeholder });
  // The legacy-surface strategy: role plus the caption a sighted user reads as the label,
  // which on a JSP table is an adjacent cell rather than a `<label for>`.
  if (node.labelHint) out.push({ kind: 'nearbyText', text: node.labelHint, role: node.role });
  if (node.name && !forExtraction) out.push({ kind: 'text', text: node.name });
  return out;
}

const CONFIDENCE: Record<Strategy['kind'], number> = {
  role: 0.95,
  testId: 0.95,
  label: 0.8,
  placeholder: 0.75,
  nearbyText: 0.75,
  text: 0.6,
  css: 0.3,
  nth: 0.25,
};

function describe(node: UiNode, forExtraction = false): string {
  // For an extraction target the accessible name is this run's value, which in a
  // description reads as though the locator were pinned to it. Lead with the surrounding
  // caption instead, so a reviewer sees "link \"Your new account number\"" rather than
  // "link \"21558\"" and is not misled about what the locator actually matches on.
  const label = forExtraction
    ? node.labelHint || node.placeholder || node.cssPath
    : node.name || node.labelHint || node.placeholder || node.cssPath;
  return `${node.role} "${label}"`;
}

/**
 * Builds a verified locator for one node within the observation it came from.
 *
 * Verification is the point: a candidate survives only if `matchStrategy` — the exact
 * function `resolveLocator` calls at replay time — returns this node and nothing else.
 * A strategy that matches two elements is dropped here rather than becoming a
 * `LOCATOR_AMBIGUOUS` escalation on every future replay.
 */
export function buildLocator(
  node: UiNode,
  nodes: UiNode[],
  opts: { humanChose?: boolean; purpose?: string; forExtraction?: boolean } = {},
): Locator {
  const verified: Strategy[] = [];
  for (const strategy of candidateStrategies(node, opts.forExtraction)) {
    const matches = matchStrategy(nodes, strategy);
    if (matches && matches.length === 1 && matches[0]?.ref === node.ref) verified.push(strategy);
  }

  // `css` is never verified against the node list (it needs the surface) and never
  // preferred, but it is always kept: it is the strategy that still works when a redesign
  // has removed every accessible handle, and a degraded resolve is a recorded signal.
  const css: Strategy = { kind: 'css', selector: node.cssPath };
  const primary = verified[0] ?? css;
  // The chain is capped, but the cap is applied to the verified strategies only — css is
  // appended afterwards so it is always the final fallback. Truncating it away would
  // leave a locator with no last resort at exactly the moment one is needed.
  const fallbacks = [...verified.slice(1, 3), ...(primary === css ? [] : [css])];

  let confidence = CONFIDENCE[primary.kind];
  // A second independent way to find the element is worth more than the first one being
  // marginally better, so a real chain earns a bump and a css-only locator does not.
  if (verified.length >= 2) confidence = Math.min(1, confidence + 0.05);
  if (verified.length === 0) confidence = CONFIDENCE.css;
  // A human pointed at this element. That is stronger evidence than any heuristic here.
  if (opts.humanChose) confidence = Math.max(confidence, 0.9);

  const rationale =
    verified.length === 0
      ? `No accessible handle on this element resolved uniquely, so only a CSS path could be ` +
        `recorded. This locator is brittle by construction and should be reviewed; a fallback ` +
        `winning at replay time will be reported as drift.` +
        (opts.forExtraction
          ? ` Strategies keyed on this element's own text were excluded: this is an ` +
            `extraction target, so its text is the value that changes every run.`
          : '')
      : `Primary is ${primary.kind}, verified unique against the ${nodes.length} elements ` +
        `observed on this page. ${fallbacks.length} fallback${fallbacks.length === 1 ? '' : 's'} ` +
        `recorded, ending in the CSS path. Role and accessible name are preferred because they ` +
        `survive restyling and are the vocabulary a desktop adapter also exposes.` +
        (opts.humanChose ? ' An operator chose this element during discovery.' : '');

  return {
    primary,
    fallbacks,
    description: opts.purpose
      ? `${opts.purpose} — ${describe(node, opts.forExtraction)}`
      : describe(node, opts.forExtraction),
    rationale,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function toAssertion(declared: DeclaredAssertion): Assertion | undefined {
  const parts: Assertion[] = [];
  if (declared.urlMatches) parts.push({ kind: 'urlMatches', pattern: declared.urlMatches });
  if (declared.textPresent) parts.push({ kind: 'textPresent', text: declared.textPresent });
  if (declared.textAbsent) parts.push({ kind: 'textAbsent', text: declared.textAbsent });
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0]! : { kind: 'all', of: parts };
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'step'
  );
}

function uniqueStepId(intent: string, taken: Set<string>): string {
  const base = `step.${slug(intent)}`;
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

// ---------------------------------------------------------------------------
// URL canonicalisation
// ---------------------------------------------------------------------------

/**
 * Rewrites an absolute URL against the tenant's base so the artifact carries no
 * institution. `https://parabank.parasoft.com/parabank/overview.htm` becomes
 * `/parabank/overview.htm`, and the tenant binding supplies the origin at replay time.
 *
 * Query parameters that look like a per-run identifier are dropped rather than templated:
 * the replay engine resolves relative URLs against `baseUrl` and has no URL-interpolation
 * syntax, so recording `?id={{accountId}}` would produce an artifact that navigates to a
 * literal `{{accountId}}`. Dropping the parameter is honest — the step is recorded as
 * "go to the account overview", and any per-run identifier must be reached by acting on
 * the page, which is what the model actually did.
 */
export function canonicaliseUrl(raw: string, baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(raw, baseUrl);
  } catch {
    return raw;
  }
  const base = new URL(baseUrl);
  for (const [key, value] of [...url.searchParams]) {
    if (/^\d{3,}$/.test(value) || /(^|_)(id|no|num|acct|account)$/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  const path = `${url.pathname}${url.search}`;
  return url.origin === base.origin ? path : url.toString();
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function nodeFor(snapshot: ObservationSnapshot, ref: string | undefined): UiNode | undefined {
  return ref ? snapshot.nodes.find((n) => n.ref === ref) : undefined;
}

function extractSpec(declared: DeclaredExtract, after: ObservationSnapshot): ExtractSpec {
  const node = nodeFor(after, declared.ref);
  if (!node) {
    throw new RecorderError(
      `output "${declared.name}" points at element ${declared.ref}, which is not in the ` +
        `observation captured after the action — nothing to extract from`,
    );
  }
  return {
    name: declared.name,
    from: buildLocator(node, after.nodes, {
      purpose: declared.description,
      // See candidateStrategies: an extraction locator must never be keyed on the value
      // it is extracting.
      forExtraction: true,
    }),
    as: declared.as,
    ...(declared.pattern ? { pattern: declared.pattern } : {}),
  };
}

function toStep(
  action: RecordedAction,
  index: number,
  ids: Set<string>,
  opts: RecordOptions,
  baseUrl: string,
): Step {
  const node = nodeFor(action.before, action.targetRef);

  if (action.tool !== 'navigate' && !node) {
    throw new RecorderError(
      `step ${action.seq} ("${action.intent}") acted on element ${action.targetRef}, which is ` +
        `not present in the observation captured before the action — no locator can be recorded`,
    );
  }

  const locator = node
    ? buildLocator(node, action.before.nodes, {
        humanChose: action.humanChose,
        purpose: action.intent,
      })
    : undefined;

  // Stricter of the two wins. The model sees the semantics of the page; the policy sees a
  // pattern list maintained by the people who own the consequences. Neither is trusted to
  // downgrade the other.
  const risk =
    action.riskHint === 'irreversible' || classifyRisk(opts.policy, action.intent) === 'irreversible'
      ? ('irreversible' as const)
      : ('safe' as const);

  const step = {
    id: uniqueStepId(action.intent, ids),
    index,
    intent: action.intent,
    action: buildAction(action, baseUrl),
    ...(locator ? { locator } : {}),
    ...(action.checkpoint ? { checkpoint: toAssertion(action.checkpoint) } : {}),
    extract: action.extracts.map((e) => extractSpec(e, action.after)),
    onError: [],
    risk,
    timeoutMs: 15_000,
  };
  return step as Step;
}

function buildAction(action: RecordedAction, baseUrl: string): Step['action'] {
  switch (action.tool) {
    case 'navigate':
      return { type: 'navigate', url: canonicaliseUrl(action.url ?? '', baseUrl) };
    case 'click':
      return { type: 'click' };
    case 'press':
      return { type: 'press', key: action.key ?? 'Enter' };
    case 'fill':
    case 'select':
      if (!action.value) {
        throw new RecorderError(
          `step ${action.seq} ("${action.intent}") is a ${action.tool} with no value reference`,
        );
      }
      return { type: action.tool, value: action.value };
  }
}

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

/** Every `$.inputs.x` reference in the log becomes a declared, typed parameter. */
function collectInputs(log: DiscoveryLog): Record<string, ParamSpec> {
  const inputs: Record<string, ParamSpec> = {};
  for (const action of log.actions) {
    if (!action.value || !('valueFrom' in action.value)) continue;
    const name = action.value.valueFrom.replace(/^\$\.inputs\./, '');
    inputs[name] ??= {
      type: 'string',
      description: action.intent,
      required: true,
      sensitive: false,
    };
  }
  return inputs;
}

const OUTPUT_TYPES: Record<DeclaredExtract['as'], OutputSpec['type']> = {
  string: 'string',
  number: 'number',
  money: 'money',
  date: 'date',
  boolean: 'boolean',
};

function collectOutputs(log: DiscoveryLog): Record<string, OutputSpec> {
  const outputs: Record<string, OutputSpec> = {};
  for (const action of log.actions) {
    for (const extract of action.extracts) {
      outputs[extract.name] = {
        type: OUTPUT_TYPES[extract.as],
        description: extract.description || extract.name,
      };
    }
  }
  return outputs;
}

function collectOutcomes(log: DiscoveryLog): OutcomeSpec[] {
  const outcomes: OutcomeSpec[] = [];
  for (const declared of log.outcomes) {
    const detect = toAssertion(declared.detect);
    if (!detect) continue;
    outcomes.push({
      name: declared.name,
      description: declared.description || declared.name,
      detect,
      terminal: declared.terminal,
      extract: [],
    });
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// The postcondition
// ---------------------------------------------------------------------------

/**
 * The capability-level check, asserted after the last step.
 *
 * Prefers the last declared checkpoint, because the model stated it in terms of what the
 * page says on success. Falls back to the final URL, which is weaker but always available
 * and never vacuous — an artifact with no postcondition would report success for a run
 * that ended on an error page.
 */
function postcondition(log: DiscoveryLog, baseUrl: string): Assertion {
  for (let i = log.actions.length - 1; i >= 0; i--) {
    const declared = log.actions[i]?.checkpoint;
    const assertion = declared ? toAssertion(declared) : undefined;
    if (assertion) return assertion;
  }
  const last = log.actions[log.actions.length - 1];
  const url = last?.after.url ?? baseUrl;
  return { kind: 'urlMatches', pattern: escapeRegex(new URL(url, baseUrl).pathname) };
}

function dropPrefix(name: string, app: string): string {
  return name.startsWith(`${app}-`) ? name.slice(app.length + 1) : name;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Checks every declared checkpoint against the page that was actually observed after the
 * action, and reports the ones that did not hold.
 *
 * This is the same principle as verifying locators, applied to the model's claims about
 * success — and it earns its place. On the first live run against ParaBank the model
 * clicked "Open New Account", the click did not submit, and it declared
 * `textPresent: "Account Opened!"` on a page still showing the empty form, then extracted
 * the "account number" from the account-type dropdown and called finish. Every fact
 * needed to catch that was already in the action log.
 *
 * An artifact built on a checkpoint that was false at record time is not merely
 * low-quality; it is guaranteed to fail on its first replay, and it will fail as
 * `CHECKPOINT_FAILED` — an automation-broke error — rather than as what it really is,
 * which is a discovery run that did not achieve the goal.
 */
export async function verifyCheckpoints(log: DiscoveryLog): Promise<string[]> {
  const contradictions: string[] = [];
  for (const action of log.actions) {
    if (!action.checkpoint) continue;
    const assertion = toAssertion(action.checkpoint);
    if (!assertion) continue;
    const observed: Observation = { ...action.after, capturedAt: log.startedAt };
    const result = await evaluate(assertion, observed);
    if (!result.ok) {
      contradictions.push(
        `step ${action.seq} ("${action.intent}") declared a checkpoint that was false on ` +
          `the page observed right after the action: ${result.detail}`,
      );
    }
  }
  return contradictions;
}

export async function recordArtifact(
  log: DiscoveryLog,
  opts: RecordOptions,
): Promise<CapabilityArtifact> {
  if (log.actions.length === 0) {
    throw new RecorderError(
      `discovery run ${log.runId} recorded no actions (stopped: ${log.stoppedBecause}) — ` +
        `there is nothing to compile into a capability`,
    );
  }

  const contradictions = await verifyCheckpoints(log);
  if (contradictions.length > 0) {
    throw new RecorderError(
      `the discovery run claimed success the evidence does not support, so no capability ` +
        `was written:\n  - ${contradictions.join('\n  - ')}\n` +
        `The run's evidence is on disk. Re-run discovery — a more capable model, or a ` +
        `narrower goal — rather than promoting an artifact that will fail on first replay.`,
    );
  }

  const ids = new Set<string>();
  const steps = log.actions.map((action, index) => toStep(action, index, ids, opts, log.baseUrl));

  const anyIrreversible = steps.some((s) => s.risk === 'irreversible');
  const name = log.finish?.name ?? log.goal;
  const origin = new URL(log.baseUrl).hostname;

  return {
    schemaVersion: '1.0',
    // A model that names the capability "ParaBank — Open New Savings Account" would
    // otherwise yield "parabank.parabank-open-new-savings-account".
    id: opts.id ?? `${slug(log.app)}.${dropPrefix(slug(name), slug(log.app))}`,
    version: opts.version ?? '1.0.0',
    name,
    description:
      log.finish?.description ??
      `Discovered from the goal "${log.goal}". This run ended as "${log.stoppedBecause}" ` +
        `rather than with an explicit finish, so the description was not authored by the ` +
        `discovery run and this capability needs review before promotion.`,

    target: {
      app: log.app,
      // ParaBank is a JSP application with no `<label for>` anywhere; calling it `web`
      // would misreport what an adapter has to cope with.
      surfaceKind: opts.surfaceKind ?? 'legacy-web',
      entryPoint: canonicaliseUrl(log.entryPoint, log.baseUrl),
    },

    inputs: collectInputs(log),
    outputs: collectOutputs(log),
    steps,
    outcomes: collectOutcomes(log),
    postcondition: postcondition(log, log.baseUrl),

    policy: {
      riskClass: anyIrreversible ? 'irreversible' : 'safe',
      requiresApproval: anyIrreversible,
      allowedDomains: [origin],
    },

    provenance: {
      discoveredAt: log.startedAt,
      model: log.model,
      runId: log.runId,
      evidenceRef: opts.evidenceRef,
      humanEdits: [],
    },
  };
}
