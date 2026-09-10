/**
 * The closed tool vocabulary handed to the discovery model, and the structured action log
 * it produces.
 *
 * Two things here carry most of the design weight:
 *
 *  1. **The vocabulary is a safety boundary, not a convenience.** There is no `evaluate`,
 *     no `goto_arbitrary_url`, no shell. The model cannot express an action outside this
 *     list, which is a stronger guarantee than filtering a general-purpose one — there is
 *     no expression left to sanitise. Every tool that acts routes through `Surface.act()`,
 *     so policy and the session lease apply to discovery exactly as they do to replay.
 *
 *  2. **`extract`, `checkpoint` and `declare_outcome` turn a click-path into a contract.**
 *     Without them the recorder would have to infer what the capability returns and what
 *     "success" means, by reading model prose. With them, the model states the semantics
 *     as it goes, in structured fields, and the recorder never parses a sentence.
 *
 * The model never handles a credential. `fill` takes a *reference* — an input name or a
 * secret name — and the loop resolves it, so a password is never in the transcript, never
 * in the action log, and never in the artifact.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { UiNode } from '../surface/types.js';
import type { ValueSource } from '../artifact/schema.js';

// ---------------------------------------------------------------------------
// The structured action log — the recorder's only input
// ---------------------------------------------------------------------------

/** Everything the recorder needs from one moment in time. */
export interface ObservationSnapshot {
  url: string;
  title: string;
  ariaHash: string;
  /** The full node list, so the recorder can compute a fallback chain from live evidence. */
  nodes: UiNode[];
  text: string;
}

/** A checkpoint or detector as the model may declare it — deliberately narrower than the
 *  full `Assertion` union, so the model cannot emit something unevaluable. */
export interface DeclaredAssertion {
  textPresent?: string;
  textAbsent?: string;
  urlMatches?: string;
}

export interface DeclaredExtract {
  name: string;
  ref: string;
  as: 'string' | 'number' | 'money' | 'date' | 'boolean';
  description: string;
  pattern?: string;
}

export interface DeclaredOutcome {
  name: string;
  description: string;
  detect: DeclaredAssertion;
  terminal: boolean;
}

export interface RecordedAction {
  seq: number;
  /**
   * The model's one-line statement of purpose.
   *
   * This is the only model-authored prose that reaches the artifact, and it lands in a
   * labelled field that is never parsed for meaning — it is display text for a human
   * reviewer, escalation context, and the seed for scoped re-discovery. Everything
   * load-bearing (locators, checkpoints, values) is computed from the observations.
   */
  intent: string;
  tool: 'navigate' | 'click' | 'fill' | 'select' | 'press';
  url?: string;
  key?: string;
  /** Which element was acted on, as a ref into `before.nodes`. */
  targetRef?: string;
  value?: ValueSource;
  before: ObservationSnapshot;
  after: ObservationSnapshot;
  checkpoint?: DeclaredAssertion;
  extracts: DeclaredExtract[];
  /** The model's own risk read. The recorder takes the stricter of this and the policy's. */
  riskHint?: 'safe' | 'irreversible';
  /** True when an operator disambiguated the target; the recorder marks confidence high. */
  humanChose?: boolean;
}

export interface RecordedEscalation {
  seq: number;
  reason: string;
  question: string;
  url: string;
  resolution?: string;
}

/** The complete structured record of a discovery run. Serialised to the evidence bundle. */
export interface DiscoveryLog {
  runId: string;
  goal: string;
  model: string;
  startedAt: string;
  finishedAt?: string;
  app: string;
  baseUrl: string;
  entryPoint: string;
  actions: RecordedAction[];
  outcomes: DeclaredOutcome[];
  escalations: RecordedEscalation[];
  finish?: { name: string; description: string; summary: string };
  /** Why the loop stopped, which is not always because the model said `finish`. */
  stoppedBecause: 'finished' | 'max_steps' | 'wall_clock' | 'no_progress' | 'escalated' | 'error';
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const REF = {
  type: 'string',
  description: 'The [eN] ref of the target element, from the most recent element list.',
} as const;

const INTENT = {
  type: 'string',
  description:
    'One short line saying what this action is for, in business terms — "submit the login form", ' +
    'not "click e7". This is recorded on the step and shown to a human reviewing or resuming the flow.',
} as const;

const VALUE_FIELDS = {
  valueKind: {
    type: 'string',
    enum: ['input', 'secret', 'literal'],
    description:
      'Where the value comes from. "input" is a parameter the caller of this capability will supply — ' +
      'use it for anything that varies per run. "secret" is a credential resolved from the vault at ' +
      'replay time; you never see its value. "literal" is a fixed non-sensitive constant.',
  },
  valueName: {
    type: 'string',
    description:
      'For "input": the parameter name to declare, e.g. "accountType". For "secret": the secret name, ' +
      'e.g. "PARABANK_PASSWORD". Omit for "literal".',
  },
  valueText: {
    type: 'string',
    description: 'For "literal" only: the constant text. Never put a credential here.',
  },
} as const;

const ASSERTION_FIELDS = {
  textPresent: { type: 'string', description: 'Text that must be visible on the page.' },
  textAbsent: { type: 'string', description: 'Text that must NOT be visible on the page.' },
  urlMatches: { type: 'string', description: 'A regular expression the URL must match.' },
} as const;

/** Builds one tool definition with strict schema validation switched on. */
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Anthropic.Tool {
  return {
    name,
    description,
    // `strict` guarantees the arguments validate against this schema, so the loop can parse
    // tool input without defensive branching on every field.
    strict: true,
    input_schema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
  } as Anthropic.Tool;
}

/**
 * The frozen tool list.
 *
 * Frozen matters literally: this array is rendered before the system prompt on every
 * request, and prompt caching is a prefix match. A tool list that varied per turn — or
 * even reordered — would invalidate the cache on every single call.
 */
export const DISCOVERY_TOOLS: Anthropic.Tool[] = [
  tool(
    'observe',
    'Re-read the current page and return the numbered element list. Call this when you are unsure ' +
      'what is on screen. Set screenshot=true only when the text list is genuinely not enough — ' +
      'images are expensive and the element list is usually sufficient.',
    {
      screenshot: {
        type: 'boolean',
        description: 'Attach a screenshot as well as the element list. Use sparingly.',
      },
    },
    [],
  ),

  tool(
    'navigate',
    'Go to a URL. Must stay within the allowlisted origin; anything else is refused by policy.',
    { url: { type: 'string', description: 'Absolute or site-relative URL.' }, intent: INTENT },
    ['url', 'intent'],
  ),

  tool(
    'click',
    'Click an element. If this commits something that cannot be undone — moving money, opening or ' +
      'closing an account, submitting an application — set risk="irreversible" so the recorded ' +
      'capability requires human approval on every replay.',
    {
      ref: REF,
      intent: INTENT,
      risk: {
        type: 'string',
        enum: ['safe', 'irreversible'],
        description: 'Whether this action commits something that cannot be undone.',
      },
    },
    ['ref', 'intent'],
  ),

  tool(
    'fill',
    'Type into a field. Pass a value REFERENCE, never a raw credential: use valueKind="secret" for ' +
      'anything sensitive and valueKind="input" for anything that should vary per run.',
    { ref: REF, intent: INTENT, ...VALUE_FIELDS },
    ['ref', 'intent', 'valueKind'],
  ),

  tool(
    'select',
    'Choose an option in a dropdown. Same value-reference rules as fill.',
    { ref: REF, intent: INTENT, ...VALUE_FIELDS },
    ['ref', 'intent', 'valueKind'],
  ),

  tool(
    'press',
    'Press a key while an element is focused, e.g. "Enter".',
    { ref: REF, intent: INTENT, key: { type: 'string', description: 'Key name, e.g. "Enter".' } },
    ['ref', 'intent', 'key'],
  ),

  tool(
    'extract',
    'Declare that a value on the current page is an OUTPUT of this capability — the account number ' +
      'that was just created, a confirmation reference, a balance. This is how the capability returns ' +
      'data to its caller, so declare every value the goal asks you to read back.',
    {
      name: {
        type: 'string',
        description: 'Output name in camelCase, e.g. "newAccountNumber".',
      },
      ref: REF,
      as: {
        type: 'string',
        enum: ['string', 'number', 'money', 'date', 'boolean'],
        description:
          'The value type. Use "money" and "date" rather than "string" where they apply — they are ' +
          'parsed through the institution\'s locale at replay time.',
      },
      description: { type: 'string', description: 'What this output means, for the caller.' },
      pattern: {
        type: 'string',
        description:
          'Optional regex with one capture group, to pull the value out of surrounding prose. ' +
          'For "Your new account number is 13566", use "(\\\\d{3,})".',
      },
    },
    ['name', 'ref', 'as', 'description'],
  ),

  tool(
    'checkpoint',
    'Declare what must be true for the action you just took to have worked. Called immediately after ' +
      'an action. Be specific: prefer text that only appears on the correct next page. Never assume a ' +
      'click worked because it did not error.',
    ASSERTION_FIELDS,
    [],
  ),

  tool(
    'declare_outcome',
    'Declare a legitimate BUSINESS outcome — an answer the application can correctly give that is not ' +
      'the happy path. "Insufficient funds", "loan denied", "no transactions found", "login rejected". ' +
      'These are results, not failures: at replay time they are returned to the caller instead of being ' +
      'retried or escalated to a human. Declare every one you see or can reach.',
    {
      name: {
        type: 'string',
        description: 'SCREAMING_SNAKE_CASE, e.g. "INSUFFICIENT_FUNDS".',
      },
      description: { type: 'string', description: 'What this outcome means in business terms.' },
      terminal: {
        type: 'boolean',
        description: 'True if the flow cannot continue past this. Advisory notices are false.',
      },
      ...ASSERTION_FIELDS,
    },
    ['name', 'description', 'terminal'],
  ),

  tool(
    'escalate_to_human',
    'Hand control to a human operator. Use this when you genuinely cannot proceed safely: two elements ' +
      'match what you meant and picking wrong would be costly, an unexpected verification step appeared, ' +
      'or the page is not what the goal describes. Escalating is not failure — a wrong guess in a banking ' +
      'flow is far more expensive than a question.',
    {
      reason: { type: 'string', description: 'What is blocking you.' },
      question: { type: 'string', description: 'The specific question for the operator.' },
    },
    ['reason', 'question'],
  ),

  tool(
    'finish',
    'The goal is complete. Give the capability a name and a description — the description becomes the ' +
      'tool description another agent reads when deciding whether to call this capability, so write it ' +
      'for that reader.',
    {
      name: { type: 'string', description: 'Short human-readable name.' },
      description: {
        type: 'string',
        description:
          'What this capability does, what it returns, and what business outcomes it can report.',
      },
      summary: { type: 'string', description: 'What you did, for the run log.' },
    },
    ['name', 'description', 'summary'],
  ),
];

// ---------------------------------------------------------------------------
// Helpers shared by the loop
// ---------------------------------------------------------------------------

export function toValueSource(input: {
  valueKind: 'input' | 'secret' | 'literal';
  valueName?: string;
  valueText?: string;
}): ValueSource {
  switch (input.valueKind) {
    case 'secret':
      return { secretRef: input.valueName ?? 'UNNAMED_SECRET' };
    case 'input':
      return { valueFrom: `$.inputs.${input.valueName ?? 'unnamed'}` };
    case 'literal':
      return { literal: input.valueText ?? '' };
  }
}

export function isDeclaredAssertionEmpty(a: DeclaredAssertion): boolean {
  return !a.textPresent && !a.textAbsent && !a.urlMatches;
}

export function pickAssertion(input: Record<string, unknown>): DeclaredAssertion {
  const out: DeclaredAssertion = {};
  if (typeof input.textPresent === 'string' && input.textPresent) out.textPresent = input.textPresent;
  if (typeof input.textAbsent === 'string' && input.textAbsent) out.textAbsent = input.textAbsent;
  if (typeof input.urlMatches === 'string' && input.urlMatches) out.urlMatches = input.urlMatches;
  return out;
}
