/**
 * The capability artifact schema.
 *
 * One Zod definition yields three things we need: TypeScript types, runtime validation
 * of anything we load off disk, and (via `params.ts`) JSON Schema for the agent-facing
 * catalog.
 *
 * Four decisions are load-bearing and defended in REPORT.md §2:
 *
 *  1. Values are *references*, not literals. `{ valueFrom: "$.inputs.accountType" }` and
 *     `{ secretRef: "PARABANK_PASSWORD" }`. Parameterization and never-persisting-secrets
 *     become the same mechanism rather than two bolted-on features — and it is also what
 *     makes an artifact safe to share across institutions (it carries no tenant data).
 *  2. Business outcomes are declared here, in the contract, not inferred at runtime.
 *  3. Per-step checkpoints, not just a capability-level postcondition.
 *  4. Every step carries a human-readable `intent`, which serves three separate
 *     requirements: escalation context, artifact review, and scoped re-discovery on drift.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

/**
 * Targeting strategies, most robust first.
 *
 * `role` + accessible name is preferred because it survives restyling and rebranding,
 * and because it is the one vocabulary shared by the web (ARIA), Windows (UIA
 * ControlType + Name) and macOS (AX). That shared vocabulary is why adding a desktop
 * adapter widens this union rather than changing the schema.
 *
 * `nearbyText` exists for legacy surfaces: ParaBank's JSP tables have no `<label for>`,
 * so the label is a `<td>` beside the input. Legacy WinForms has the same shape.
 */
export const StrategySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('role'), role: z.string(), name: z.string() }),
  z.object({ kind: z.literal('label'), text: z.string() }),
  z.object({ kind: z.literal('placeholder'), text: z.string() }),
  z.object({ kind: z.literal('nearbyText'), text: z.string(), role: z.string() }),
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('testId'), id: z.string() }),
  // Last resort. A locator whose *only* strategy is css should be recorded with low
  // confidence rather than papered over.
  z.object({ kind: z.literal('css'), selector: z.string() }),
  z.object({
    kind: z.literal('nth'),
    within: z.object({ kind: z.literal('css'), selector: z.string() }),
    index: z.number().int().nonnegative(),
  }),
]);
export type Strategy = z.infer<typeof StrategySchema>;

export const LocatorSchema = z.object({
  primary: StrategySchema,
  /** Tried in order when `primary` misses. A fallback winning is the drift signal. */
  fallbacks: z.array(StrategySchema).default([]),
  framePath: z.array(z.string()).optional(),
  description: z.string(),
  /** The brief explicitly asks for reasoning about robustness; record it per locator. */
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
});
export type Locator = z.infer<typeof LocatorSchema>;

// ---------------------------------------------------------------------------
// Assertions — used for preconditions, checkpoints, postconditions and outcome detectors
// ---------------------------------------------------------------------------

/**
 * Deliberately a small, closed, declarative language. Replay must evaluate these with no
 * model in the loop, and a human must be able to review one and know what it means.
 */
export type Assertion =
  | { kind: 'urlMatches'; pattern: string }
  | { kind: 'titleMatches'; pattern: string }
  | { kind: 'textPresent'; text: string }
  | { kind: 'textAbsent'; text: string }
  | { kind: 'elementVisible'; locator: Locator }
  | { kind: 'elementAbsent'; locator: Locator }
  | { kind: 'all'; of: Assertion[] }
  | { kind: 'any'; of: Assertion[] };

// The explicit input type is `unknown` rather than `Assertion`: schemas nested inside
// (Locator.fallbacks) carry defaults, so the parsed output type is narrower than what the
// parser accepts. Annotating both sides as `Assertion` would claim they are identical.
export const AssertionSchema: z.ZodType<Assertion, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('urlMatches'), pattern: z.string() }),
    z.object({ kind: z.literal('titleMatches'), pattern: z.string() }),
    z.object({ kind: z.literal('textPresent'), text: z.string() }),
    z.object({ kind: z.literal('textAbsent'), text: z.string() }),
    z.object({ kind: z.literal('elementVisible'), locator: LocatorSchema }),
    z.object({ kind: z.literal('elementAbsent'), locator: LocatorSchema }),
    z.object({ kind: z.literal('all'), of: z.array(AssertionSchema).min(1) }),
    z.object({ kind: z.literal('any'), of: z.array(AssertionSchema).min(1) }),
  ]),
);

export const WaitSpecSchema = z.object({
  assertion: AssertionSchema,
  timeoutMs: z.number().int().positive().default(10_000),
});
export type WaitSpec = z.infer<typeof WaitSpecSchema>;

// ---------------------------------------------------------------------------
// Values — references, never literals, wherever the value is parameterised or sensitive
// ---------------------------------------------------------------------------

export const ValueSourceSchema = z.union([
  /** JSONPath-ish reference into the caller's typed inputs, e.g. "$.inputs.accountType". */
  z.object({ valueFrom: z.string().regex(/^\$\.(inputs|outputs)\.[A-Za-z0-9_.]+$/) }),
  /** Resolved from env/vault at replay time. Never persisted, never logged. */
  z.object({ secretRef: z.string().min(1) }),
  /** Non-sensitive constants only — see the artifact-level refinement below. */
  z.object({ literal: z.string() }),
]);
export type ValueSource = z.infer<typeof ValueSourceSchema>;

// ---------------------------------------------------------------------------
// Actions — a closed vocabulary, which is itself a safety boundary (REPORT.md §6)
// ---------------------------------------------------------------------------

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), url: z.string() }),
  z.object({ type: z.literal('click') }),
  z.object({ type: z.literal('fill'), value: ValueSourceSchema }),
  z.object({ type: z.literal('select'), value: ValueSourceSchema }),
  z.object({ type: z.literal('press'), key: z.string() }),
  z.object({ type: z.literal('wait') }),
]);
export type Action = z.infer<typeof ActionSchema>;

// ---------------------------------------------------------------------------
// Extraction — typed, because untyped scraping is how locale bugs get silent
// ---------------------------------------------------------------------------

export const ExtractSpecSchema = z.object({
  name: z.string().min(1),
  from: LocatorSchema,
  /** `money` and `date` parse through the tenant locale rather than guessing. */
  as: z.enum(['string', 'number', 'money', 'date', 'boolean']),
  /** Optional capture group to pull the value out of surrounding prose. */
  pattern: z.string().optional(),
});
export type ExtractSpec = z.infer<typeof ExtractSpecSchema>;

// ---------------------------------------------------------------------------
// Recovery — known interstitials handled inline, so they never reach a human
// ---------------------------------------------------------------------------

export const RecoverySpecSchema = z.object({
  when: z.enum([
    'LOCATOR_NOT_FOUND',
    'CHECKPOINT_FAILED',
    'TIMEOUT',
    'SESSION_EXPIRED',
    'UNEXPECTED_DIALOG',
  ]),
  description: z.string(),
  do: z.array(
    z.object({
      action: ActionSchema,
      locator: LocatorSchema.optional(),
    }),
  ),
  thenRetry: z.boolean().default(true),
  maxAttempts: z.number().int().positive().max(5).default(1),
});
export type RecoverySpec = z.infer<typeof RecoverySpecSchema>;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export const RiskSchema = z.enum(['safe', 'irreversible']);
export type Risk = z.infer<typeof RiskSchema>;

export const StepSchema = z.object({
  /**
   * Stable and independent of `index`. Tenant overrides are keyed by this id, so
   * inserting a step at position 3 must not orphan every tenant's overrides.
   */
  id: z.string().regex(/^step\.[a-z0-9-]+$/, 'step ids look like "step.enter-username"'),
  index: z.number().int().nonnegative(),
  /** Human-readable. Powers escalation context, artifact review, and scoped re-discovery. */
  intent: z.string().min(1),
  action: ActionSchema,
  locator: LocatorSchema.optional(),
  /** Asserted BEFORE acting. */
  waitFor: WaitSpecSchema.optional(),
  /** Asserted AFTER acting — never assume a click worked. */
  checkpoint: AssertionSchema.optional(),
  extract: z.array(ExtractSpecSchema).default([]),
  onError: z.array(RecoverySpecSchema).default([]),
  risk: RiskSchema.default('safe'),
  timeoutMs: z.number().int().positive().default(15_000),
});
export type Step = z.infer<typeof StepSchema>;

// ---------------------------------------------------------------------------
// Business outcomes — declared in the contract, not inferred at runtime
// ---------------------------------------------------------------------------

/**
 * The most common design mistake in this class of system is conflating a business outcome
 * ("insufficient funds") with a failure ("automation broke"). Declaring outcomes here, and
 * racing their detectors against the step checkpoint, is the structural fix.
 */
export const OutcomeSpecSchema = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'outcome names are SCREAMING_SNAKE_CASE'),
  description: z.string().min(1),
  detect: AssertionSchema,
  /** Terminal outcomes stop replay and are returned to the caller as a legitimate result. */
  terminal: z.boolean().default(true),
  /** Optional extraction of detail from the outcome page (a denial reason, say). */
  extract: z.array(ExtractSpecSchema).default([]),
});
export type OutcomeSpec = z.infer<typeof OutcomeSpecSchema>;

// ---------------------------------------------------------------------------
// Typed inputs and outputs
// ---------------------------------------------------------------------------

export const ParamSpecSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'money', 'date', 'enum']),
  description: z.string().min(1),
  required: z.boolean().default(true),
  enum: z.array(z.string()).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /**
   * Marks a parameter as sensitive. A sensitive parameter may never be satisfied by a
   * literal in the artifact, and is redacted at every write boundary.
   */
  sensitive: z.boolean().default(false),
});
export type ParamSpec = z.infer<typeof ParamSpecSchema>;

export const OutputSpecSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'money', 'date']),
  description: z.string().min(1),
});
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

export const SurfaceKindSchema = z.enum(['web', 'legacy-web', 'desktop', 'terminal']);
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

export const ProvenanceSchema = z.object({
  discoveredAt: z.string().datetime(),
  /** Which model discovered this, so replay reliability can be compared by model. */
  model: z.string(),
  runId: z.string(),
  evidenceRef: z.string(),
  humanEdits: z
    .array(
      z.object({
        at: z.string().datetime(),
        by: z.string(),
        what: z.string(),
      }),
    )
    .default([]),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

const CapabilityArtifactBase = z.object({
  schemaVersion: z.literal('1.0'),
  id: z.string().regex(/^[a-z0-9-]+\.[a-z0-9-]+$/, 'ids look like "parabank.open-new-account"'),
  /** Semver. Bump on any step change; tenant bindings and resume tokens pin to it. */
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string().min(1),
  /** Legible to BOTH a human reviewer and a calling agent — it becomes the tool description. */
  description: z.string().min(1),

  target: z.object({
    /** Vendor product identity — NOT the institution. This is what makes reuse possible. */
    app: z.string().min(1),
    surfaceKind: SurfaceKindSchema,
    /** Relative to the tenant's baseUrl. Web today; `{exec,args,windowTitleMatch}` on desktop. */
    entryPoint: z.string().min(1),
  }),

  inputs: z.record(ParamSpecSchema).default({}),
  outputs: z.record(OutputSpecSchema).default({}),
  steps: z.array(StepSchema).min(1),
  outcomes: z.array(OutcomeSpecSchema).default([]),
  /** The capability-level checkpoint, asserted after the last step. */
  postcondition: AssertionSchema,

  policy: z.object({
    riskClass: RiskSchema,
    requiresApproval: z.boolean(),
    allowedDomains: z.array(z.string()).min(1),
  }),

  provenance: ProvenanceSchema,
  reliability: z
    .object({
      replays: z.number().int().nonnegative(),
      successes: z.number().int().nonnegative(),
    })
    .optional(),
});

export const CapabilityArtifactSchema = CapabilityArtifactBase.superRefine((artifact, ctx) => {
  // Step ids must be unique — overrides are keyed by them.
  const ids = new Set<string>();
  for (const step of artifact.steps) {
    if (ids.has(step.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate step id "${step.id}" — overrides are keyed by step id, so they must be unique`,
        path: ['steps'],
      });
    }
    ids.add(step.id);
  }

  // Outcome names must be unique.
  const outcomeNames = new Set<string>();
  for (const outcome of artifact.outcomes) {
    if (outcomeNames.has(outcome.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate outcome name "${outcome.name}"`,
        path: ['outcomes'],
      });
    }
    outcomeNames.add(outcome.name);
  }

  for (const [i, step] of artifact.steps.entries()) {
    const path = ['steps', i] as const;

    // Every action except navigate/wait needs something to act on.
    if (!step.locator && step.action.type !== 'navigate' && step.action.type !== 'wait') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `step "${step.id}" has action "${step.action.type}" but no locator`,
        path: [...path],
      });
    }

    const value =
      step.action.type === 'fill' || step.action.type === 'select' ? step.action.value : undefined;
    if (value) {
      if ('valueFrom' in value) {
        // A reference must point at a declared input.
        const param = value.valueFrom.replace(/^\$\.inputs\./, '');
        if (value.valueFrom.startsWith('$.inputs.') && !(param in artifact.inputs)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `step "${step.id}" references undeclared input "${param}"`,
            path: [...path],
          });
        }
      }
      if ('literal' in value) {
        // Decision 1, enforced: a sensitive value can never be a literal in the artifact.
        // This is what lets one artifact be shared across institutions safely.
        const looksSensitive = /pass|secret|token|pin|ssn|cvv/i.test(step.intent + step.id);
        if (looksSensitive) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `step "${step.id}" looks sensitive but uses a literal value — use { secretRef } instead`,
            path: [...path],
          });
        }
      }
    }

    // An irreversible step must be reflected in the capability's own policy, so a reviewer
    // reading only the header cannot be surprised by what is inside.
    if (step.risk === 'irreversible' && !artifact.policy.requiresApproval) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `step "${step.id}" is irreversible but policy.requiresApproval is false`,
        path: ['policy', 'requiresApproval'],
      });
    }
  }

  // Every declared output must actually be extracted somewhere.
  const extracted = new Set<string>([
    ...artifact.steps.flatMap((s) => s.extract.map((e) => e.name)),
    ...artifact.outcomes.flatMap((o) => o.extract.map((e) => e.name)),
  ]);
  for (const name of Object.keys(artifact.outputs)) {
    if (!extracted.has(name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `output "${name}" is declared but never extracted by any step or outcome`,
        path: ['outputs', name],
      });
    }
  }
});

export type CapabilityArtifact = z.infer<typeof CapabilityArtifactBase>;

// ---------------------------------------------------------------------------
// Tenant binding — the multi-tenant seam (REPORT.md §4, brief §3.7)
// ---------------------------------------------------------------------------

/**
 * A capability belongs to the vendor product; a binding belongs to the institution.
 *
 *     CapabilityArtifact  +  TenantBinding  =  executable capability
 *
 * Overrides are narrow patches keyed by step id, not a fork. The size of the override set
 * is therefore also the divergence metric for that tenant.
 */
export const TenantBindingSchema = z.object({
  schemaVersion: z.literal('1.0'),
  tenantId: z.string().regex(/^[a-z0-9-]+$/),
  /** Must match the artifact's `target.app`. */
  app: z.string().min(1),
  appVersion: z.string().optional(),
  baseUrl: z.string().url(),
  /** Maps the artifact's secretRef names to where this institution keeps them. */
  secrets: z.record(z.string()).default({}),
  locale: z
    .object({
      number: z.string().default('en-US'),
      date: z.string().default('MM/dd/yyyy'),
      currency: z.string().default('USD'),
    })
    .default({ number: 'en-US', date: 'MM/dd/yyyy', currency: 'USD' }),
  /** May narrow the artifact's policy. Never widen it — enforced in the store. */
  policy: z
    .object({
      allowedDomains: z.array(z.string()).optional(),
      requiresApproval: z.boolean().optional(),
    })
    .default({}),
  /** Keyed "step.<id>" or "outcome.<NAME>". */
  overrides: z
    .record(
      z.object({
        locator: LocatorSchema.optional(),
        waitFor: WaitSpecSchema.optional(),
        checkpoint: AssertionSchema.optional(),
        detect: AssertionSchema.optional(),
        timeoutMs: z.number().int().positive().optional(),
      }),
    )
    .default({}),
  /** Steps this institution's configuration does not present at all. */
  disabledSteps: z.array(z.string()).default([]),
});
export type TenantBinding = z.infer<typeof TenantBindingSchema>;
