# Computer-Use Automation System — Implementation Plan

## Context

This builds the deliverable for interface.ai's take-home (`Assignment A — Computer-Use Automation System.pdf`). The project directory currently contains only that PDF.

The problem: banks run legacy back-office apps with no API. An LLM drives the UI **once** to discover how to accomplish a goal; that run is recorded as a typed, versioned **capability artifact**; thereafter the flow is **replayed deterministically with no LLM in the decision loop**, so production AI agents can invoke it cheaply and reliably. A human must be able to take over the *same live session* when the system gets stuck, and everything runs inside safety guardrails.

The brief is deliberately under-specified and states that judgment is what's evaluated. Weighting (Section 7, in order): system design → correctness of core loop → robustness/error handling → human-in-the-loop escalation → generalization → safety → code quality → communication. It explicitly rewards **a thin-but-real version of every core requirement** over a polished subset, and explicitly does *not* reward feature breadth or scaling infrastructure.

**Decisions already made (by the user):**

| Decision | Choice |
|---|---|
| Control mechanism | Playwright + accessibility-tree snapshot, hand-rolled agent loop |
| Target app | ParaBank (`parabank.parasoft.com`) — public demo online-banking app |
| Language/runtime | TypeScript / Node |
| Stretch goal | Agent-facing capability catalog (exactly one) |
| LLM | `claude-opus-5`, adaptive thinking, `effort: high` |

Why ParaBank: it is literally a bank app, server-rendered JSP with `jsessionid`, table-based layout, **no test IDs** — a genuine "legacy, no clean DOM" surface. It supplies real business outcomes for free (loan denial, "no transactions found", invalid login, genuine session expiry) rather than requiring simulated ones.

---

## Architecture

Single process, single package, filesystem persistence. No queues, no services, no DB — justified in REPORT.md as deliberate (the brief penalises premature scaling infrastructure).

```
src/
  surface/     surface.ts  playwright-web.ts  types.ts     <- the perceive/act seam
  artifact/    schema.ts   store.ts   recorder.ts
  agent/       loop.ts     tools.ts   prompt.ts            <- LLM in the loop (discovery only)
  replay/      engine.ts   locator.ts outcomes.ts          <- NO LLM
  policy/      allowlist.ts risk.ts   redact.ts
  escalation/  broker.ts   lease.ts   console/             <- HITL
  evidence/    logger.ts   capture.ts
  catalog/     catalog.ts  invoke.ts                       <- stretch
  cli/         discover.ts replay.ts operator.ts agent-demo.ts
capabilities/  *.json                                      <- saved artifacts
evidence/      runs/<runId>/...                            <- required deliverable path
fixtures/      parabank/*.html                             <- offline replay for tests
policy.yaml
```

### The load-bearing seam: `Surface`

Everything the system knows about "how to perceive and act on a UI" lives behind one interface. The recorded flow never references Playwright.

```ts
interface Surface {
  observe(): Promise<Observation>;             // normalized UI graph + url + title
  act(action: Action): Promise<ActionResult>;  // <- single policy chokepoint
  resolve(loc: Locator): Promise<Resolution>;  // exactly-one-match or ambiguity error
  capture(): Promise<EvidenceBundle>;          // screenshot + DOM + aria snapshot
  lease: SessionLease;                         // who is in control
}
```

`Observation` is a normalized node list, **not** raw DOM:
`{ ref, role, name, value, enabled, labelHint, cssPath, siblingIndex, framePath }`.

Built from Playwright's `ariaSnapshot()` plus a legacy-fallback enrichment pass (ParaBank inputs have no `<label for>`, so derive `labelHint` from the preceding table cell / `<b>` text / `name` attribute). This enrichment is not incidental — it *is* the "legacy surface" handling, and REPORT.md should say so.

**Key architectural point to defend:** perceive and act share one vocabulary (role + accessible name). The model sees `textbox "Username"`; the replay engine executes `getByRole('textbox', { name: 'Username' })`. That single vocabulary is also what makes the desktop story credible — Windows UIA exposes ControlType + Name, the same two axes — so a desktop adapter slots in behind `Surface` without touching the schema or the replay engine.

---

## Artifact schema (`src/artifact/schema.ts`, Zod)

The focal point of the evaluation. One Zod definition yields: TypeScript types, runtime validation of caller inputs, and JSON Schema for the catalog.

```ts
CapabilityArtifact {
  schemaVersion: "1.0"
  id: "parabank.open-new-account"
  version: "1.0.0"                  // semver; bump on step change
  name, description                  // legible to BOTH a human reviewer and a calling agent
  target: {
    app: "parabank"                  // vendor product identity — NOT the tenant
    surfaceKind: "legacy-web"        // web | legacy-web | desktop  <- the heterogeneity seam
    entryPoint: "/parabank/index.htm"
    tenantBinding?: { baseUrl, overridesRef }   // designed, not built out
  }
  inputs:  ZodObject                 // typed params, incl. { secretRef } for credentials
  outputs: ZodObject                 // typed extraction shape returned to the caller
  steps:   Step[]
  outcomes: OutcomeSpec[]            // DECLARED business outcomes + their detectors
  postcondition: Assertion           // the capability-level checkpoint
  policy: { riskClass, requiresApproval, allowedDomains }
  provenance: { discoveredAt, model, runId, evidenceRef, humanEdits[] }
  reliability?: { replays, successes }
}

Step {
  id, index
  intent: string                     // "enter the member id" — for review + escalation context
  action: { type, valueFrom?: "$.inputs.accountType" }   // reference, never a literal
  locator?: Locator
  waitFor?: WaitSpec                 // precondition asserted BEFORE acting
  checkpoint?: Assertion             // asserted AFTER acting — never assume a click worked
  extract?: { name, from: Locator, as: "string"|"number"|"money", pattern? }
  onError?: RecoverySpec[]           // known interstitials: { when, do, thenRetry }
  risk: "safe" | "irreversible"
  timeoutMs
}
```

Four schema decisions to defend explicitly in REPORT.md §2:

1. **Values are references, not literals** (`valueFrom: "$.inputs.accountType"`, credentials as `{ secretRef: "PARABANK_PASSWORD" }`). This makes parameterization and the never-persist-sensitive-data requirement *the same mechanism* rather than two bolted-on features.
2. **Business outcomes are declared in the artifact, not inferred at runtime.** `{ name: "INSUFFICIENT_FUNDS", detect: {...}, terminal: true }`. The glossary calls conflating outcomes with failures "the most common design mistake here" — declaring them in the contract is the structural fix.
3. **Per-step checkpoints, not just a final one.** Cheap to record, and it makes failures debuggable to the exact step.
4. **Steps carry a human-readable `intent`.** Powers the escalation payload, the review story, and the generated capability description — one field serving three requirements.

### Locator model

```ts
Locator {
  primary: Strategy
  fallbacks: Strategy[]
  framePath?: string[]
  description: string
  rationale: string      // brief explicitly asks for reasoning about robustness
  confidence: number
}
Strategy =
  | { kind:"role"; role; name }        // preferred — survives restyling/rebranding
  | { kind:"label"; text }
  | { kind:"placeholder"; text }
  | { kind:"nearbyText"; text; role }  // legacy tables: label cell -> adjacent input
  | { kind:"text"; text }
  | { kind:"css"; selector }           // last resort
  | { kind:"nth"; within: Strategy; index }
```

Resolution rules (`src/replay/locator.ts`):
- Try `primary`, then each fallback in order.
- **Require exactly one match.** Multiple matches is `LOCATOR_AMBIGUOUS` — a distinct, surfaced failure class, never a silent `.nth(0)`.
- **Record which strategy actually resolved.** If the primary failed and a fallback won, that is a drift signal — emit it to the run log. This is the concrete answer to "how do you detect per-tenant/version drift" in REPORT.md §4.

---

## Deterministic replay (`src/replay/engine.ts`) — no LLM

Per step: assert `waitFor` → resolve locator → policy check → act → assert `checkpoint` → run `extract`.

**Result contract:**

```ts
type ReplayResult =
  | { status:"success";          outputs: T;              evidence }
  | { status:"business_outcome"; outcome: string; detail; evidence }
  | { status:"escalated";        interventionId; resumeToken; evidence }
  | { status:"failed";           error: ReplayError;      evidence }

ReplayError { class, stepId, stepIntent, expected, observed, screenshotRef, domRef, traceRef }
class ∈ LOCATOR_NOT_FOUND | LOCATOR_AMBIGUOUS | CHECKPOINT_FAILED | TIMEOUT
      | SESSION_EXPIRED | UNEXPECTED_DIALOG | POLICY_DENIED | NAVIGATION_BLOCKED | APP_ERROR
```

Three-tier handling:
- **Recoverable** — handled inline via `onError` recovery specs + bounded retry with backoff (dismiss known interstitial; re-login once on `SESSION_EXPIRED`; wait/retry on transient `TIMEOUT`).
- **Business outcome** — a declared detector matched. Returned to the caller as a legitimate result. Exit code 0.
- **Hard failure** — structured error + full evidence bundle.
- Escalate when recovery is exhausted, on `LOCATOR_AMBIGUOUS`, or when an `irreversible` step needs a human decision.

**Critical ordering detail:** after each action, race the step checkpoint against *all* declared outcome detectors. The classic bug is timing out waiting for the success condition while the app has actually rendered "No transactions found." Business-outcome detection must be evaluated **before** a timeout is declared a failure. Call this out in REPORT.md §3.

---

## Discovery loop (`src/agent/loop.ts`) — the one part that must be genuinely real

Custom tools handed to Claude:
`observe` · `navigate` · `click` · `fill` · `select` · `press` · `extract` · `declare_outcome` · `checkpoint` · `escalate_to_human` · `finish`

`extract`, `declare_outcome`, and `checkpoint` are what turn a step list into a **contract** — the model declares the capability's semantics as it goes, so the recorder never has to guess at outputs or success conditions.

Stopping conditions: `maxSteps` (~40), wall-clock timeout, and a no-progress detector (same URL + aria-hash N times → dead end → escalate).

Token control: send the numbered element list as text every turn; attach a screenshot only on request or every N steps.

**Recorder** (`src/artifact/recorder.ts`) consumes the *structured action log*, never the model's prose — satisfying "decoupled from the raw model transcript". At record time it: resolves each acted-on element to a full `Locator` with a fallback chain computed from that live observation; synthesises checkpoints from the post-action observation; canonicalises URLs (`/activity.htm?id=12345` → `/activity.htm?id={{accountId}}`); and promotes literal typed values that match input params into `valueFrom` references.

**Ambiguity → human, and the human's pick is what gets recorded.** When resolution finds more than one candidate during discovery, the agent escalates; the operator's choice becomes the locator baked into the artifact. This strengthens the robustness story — the targeting wasn't just a model guess.

---

## Heterogeneity & multi-tenant (`surfaceKind` + `TenantBinding`)

Feeds REPORT.md §4. Mostly a design obligation rather than a build obligation — the seams are built, the far side of them is argued.

**Framing to lead with:** "heterogeneity" is three problems wearing one word, and conflating them is what produces unmaintainable automation estates. They are separate because the *unit of reuse* differs — an adapter is reused across every capability, an artifact across every tenant, an override by nobody (it *is* the diff).

| Axis | Example | Design response |
|---|---|---|
| **Surface kind** | ParaBank (legacy web) vs. a WinForms teller client | `Surface` interface + `target.surfaceKind` |
| **Tenant** | 40 credit unions running the same vendor core | Product-level artifact + per-tenant `TenantBinding` |
| **Version / config drift** | Vendor ships 6.3; one tenant customizes a label | Resolution telemetry + override layer + version bump |

### Surface kind — what the `Surface` seam actually buys

The invariant the design bets on: every UI surface worth automating exposes a tree of elements carrying (a) a *kind* and (b) a *human-meaningful name*, and supports programmatic invocation. ARIA on the web, UI Automation on Windows, AX on macOS.

| Concept | Web (ARIA / Playwright) | Windows (UIA) | macOS (AX) | Mainframe (3270) |
|---|---|---|---|---|
| role | `role` | `ControlType` (Edit, Button, ComboBox) | `AXRole` | field attribute |
| accessible name | label / `aria-label` / text | `Name` | `AXTitle` / `AXDescription` | adjacent literal text |
| stable id | *(rarely present)* | `AutomationId` — often genuinely stable | `AXIdentifier` | row/col — fully stable |
| container path | frame path | window / pane path | window path | screen id |
| value read | `value` | `ValuePattern.Value` | `AXValue` | buffer slice |
| act: click | `click()` | `InvokePattern.Invoke()` | `AXPress` | AID key |
| act: fill | `fill()` | `ValuePattern.SetValue()` | set `AXValue` | write at row/col |
| act: select | `selectOption()` | `SelectionItemPattern.Select()` | `AXPress` on item | field + AID |
| observe | DOM + `ariaSnapshot()` | scoped, cached UIA tree walk | AX tree walk | screen buffer read |
| capture | screenshot + DOM + aria | screenshot + UIA tree dump | same | buffer dump (text) |

**Unchanged by a desktop adapter:** artifact schema, locator strategy chain, exactly-one-match resolution, replay engine, policy chokepoint, escalation lease, evidence format. `Strategy` is a discriminated union, so `{ kind:"automationId"; id }` is purely additive. That is the concrete claim behind "the seam is real" — a whole new surface technology widens one union and adds one implementation of one interface.

**Evidence rather than aspiration:** `nearbyText` exists because ParaBank's JSP tables have no `<label for>` — the label is a `<td>` beside the input. That is structurally identical to legacy WinForms, where the label is a separate static-text sibling with no programmatic association. The legacy-web work *is* the desktop work; that is why legacy web was chosen as the target.

**What genuinely changes, and must be said out loud:**

1. **No URL.** `entryPoint` generalizes to `{ exec, args, windowTitleMatch }`. "Where am I" becomes window identity + focused pane. The navigation allowlist becomes a process/window allowlist — same policy shape, different primitive.
2. **No load event.** Desktop has no network-idle equivalent; waits go on control existence and UIA events. This is exactly why per-step `waitFor` and `checkpoint` are in the schema from day one — the part that looks over-engineered on the web is load-bearing on desktop.
3. **Dialogs are OS-level** — they steal focus and sit outside the app tree. `UNEXPECTED_DIALOG` + `onError` already model this; the adapter adds a top-level-window sweep per observe.
4. **Focus is global.** Desktop actions go wherever focus is, so `act()` must assert window focus — and a human nudging the mouse mid-run is a real hazard, another argument for the lease being enforced rather than conventional.
5. **Worst case: an opaque tree.** Some Win32/Delphi/terminal-emulator surfaces expose one "custom" node. Honest answer is vision + coordinates: permit `{ kind:"ocrText" }` / `{ kind:"imageAnchor" }`, but **any artifact containing one is automatically `confidence: low` and `requiresApproval: true`** — coordinate targeting is the strategy most likely to silently click the *wrong* thing after a resolution/DPI/theme change, failing invisibly rather than loudly, which inverts the property everything else here is built for.
6. **Mainframe is the easy case, not the hard one.** 3270/5250 is fixed row/column with a deterministic buffer — a `{ kind:"position" }` adapter with near-perfect replay. Worth a sentence because it inverts the usual "legacy = hard" intuition.

### Multi-tenant — reuse across institutions (brief §3.7)

**Core claim: a capability is a property of the vendor product, not of the institution running it.** "Open a savings account in ParaBank" is the *vendor's* flow, identical at First National and Second Federal. What differs is where it lives, who logs in, what policy applies, and a few local customizations. Hence `target.app = "parabank"` (product identity) with the tenant held separately:

```
CapabilityArtifact          TenantBinding             executable capability
(product-level,       +     (per-institution,    =    (resolved at replay time)
 versioned, shared)          small, local)
```

```ts
TenantBinding {
  tenantId: "first-national"
  app: "parabank"                              // must match artifact.target.app
  appVersion?: "6.2.1"
  baseUrl: "https://fnb.internal/parabank"     // desktop: { exec, args, windowTitleMatch }
  secrets: { PARABANK_PASSWORD: "vault://fnb/parabank/svc-automation" }
  locale?: { number: "en-US", date: "MM/dd/yyyy", currency: "USD" }
  policy?: { allowedDomains, riskOverrides }   // may be STRICTER, never looser
  overrides?: {
    "step.enter-account-type": { locator: {...} }
    "outcome.INSUFFICIENT_FUNDS": { detect: {...} }
  }
  disabledSteps?: ["step.marketing-optin"]     // feature-flag differences
}
```

Resolution order at replay: **artifact step → tenant override → hard error.** A tenant may narrow policy but never widen it, enforced at binding-load time rather than by convention — the alternative is a tenant config that quietly re-enables downloads.

**Why an override layer instead of forking per tenant:** forking gives N copies that drift independently and no way to ship one fix to all of them. Overrides give one canonical flow, a tiny per-tenant diff, and — the part worth naming — **a measurement**: the diff *is* the divergence metric. A tenant with 12 overrides is telling you either the canonical artifact is wrong or that tenant is genuinely a different product, and it told you without anyone investigating.

This is also why steps carry **stable ids independent of index**: overrides are keyed by step id, so inserting a step at position 3 doesn't orphan every tenant's overrides. Buys nothing in a single-tenant demo; buys everything at 40 institutions.

### Drift detection — the mechanism, not a promise

The primitive already exists in the replay engine: every resolution records **which strategy in the chain actually won**.

| Outcome | Meaning | Action |
|---|---|---|
| `primary` resolved | healthy | none |
| `fallback[k]` resolved | **degraded** | emit `LOCATOR_DRIFT { stepId, expected, resolvedBy, tenant, runId }` |
| nothing resolved | broken | `LOCATOR_NOT_FOUND` → escalate |
| more than one match | ambiguous | `LOCATOR_AMBIGUOUS` → escalate (never `.nth(0)`) |

The tenant dimension turns the signal into a diagnosis:

- Fallback starts winning for step X at **one** tenant → local customization or an early upgrade. Fix: a tenant override.
- Fallback starts winning for step X across **all** tenants → the vendor shipped a release. Fix: re-discover the step, bump `version`, ship once.

Same telemetry, two diagnoses, separated only by whether the signal correlates across tenants. This is the answer to "how do you keep 200 capabilities alive across 40 institutions without a human watching each one" — you don't watch runs, you watch the strategy-resolution distribution. And degradation is *graded*: the run still **succeeds** on a fallback, so drift surfaces before it becomes an outage. That is the whole argument for a fallback chain plus telemetry over a single "best" selector.

**Repair loop (designed, not built):** drift for `(stepId, tenant)` crosses a rolling threshold → re-run discovery **scoped to that step only**, seeded with the recorded `intent` (the second job that field does, and why it's on every step) → produce a candidate patch, tenant override or artifact version bump → **human approves, never auto-promote** → gate on `reliability { replays, successes }`.

### Limits to state honestly

- **Semantic divergence is not a locator problem.** If institution B's wire flow has an extra dual-approval page, no override chain rescues it — that's a *different capability*. Detect it (preconditions that never hold, an unrecognized interstitial) and escalate as `STRUCTURAL_DIVERGENCE` rather than patch into a lie. Suppressing that distinction is how automation estates rot.
- **Override count needs a governance ceiling** — past N, fork into a declared variant artifact. A policy call, but leaving it unstated is how you get a "shared" artifact nobody shares.
- **Locale is the sneaky one.** `extract` parsing money without a tenant locale turns `1.234,56` into `1.234` — a wrong *number*, not an error. Hence `locale` on the binding and typed extraction (`as: "money"`).
- **Auth topology varies per institution** (SSO, MFA, IP allowlisting) even when the app doesn't — so login is best modeled as its own capability a tenant can override wholesale, not the first three steps of every other capability.

**The property that makes cross-institution sharing possible at all:** artifacts hold references, never literals (`valueFrom`, `secretRef`, canonicalized URLs). Introduced for parameterization and secret hygiene; the third payoff is that **an artifact carries no tenant data, so it is safe to share across institutions.** One mechanism, three requirements. If artifacts embedded literals, cross-tenant reuse would be a data-leak vector rather than a feature.

---

## Safety guardrails (`src/policy/`)

Feeds REPORT.md §6. `policy.yaml` — allowlisted domains and route globs, allowed action types, denied action types (download/upload/eval/new-tab), risk rules, secret refs, redaction patterns.

**The organizing decision is not the list of rules but the fact that there is exactly one place an action can happen.** Enforcement lives inside `Surface.act()`; discovery and replay both pass through it, so neither safety nor control transfer can be bypassed by adding a caller. A unit test asserts that acting under a denied policy or a human-held lease throws. This is the strongest single architectural argument in the safety section.

**Layer 0 — blast radius (environment, not code).** Synthetic tenant, demo instance, dedicated service identity, no real PII, no real money. The most effective control in the system is that the credential in use *cannot move real funds*; code guardrails are defense in depth on top of that, not a substitute. A design that quietly relied on code guardrails alone while pointed at production would be the wrong answer however good the code was.

**Layer 1 — the chokepoint.** One function: policy check → lease check → risk gate → redaction → act.

**Layer 2 — navigation and scope.**
- Parsed-origin + path-glob matching, **never string prefix** — prefix matching is defeated by `https://parabank.parasoft.com.evil.tld/`, same prefix, different origin.
- Scheme allowlist: `http`/`https` only; reject `javascript:`, `file:`, `data:`.
- Blocked: downloads, uploads, popups/new tabs, arbitrary JS evaluation. New-tab blocking isn't incidental — an unconstrained new tab is precisely how an automation escapes the surface it was scoped to.

**Layer 3 — the action vocabulary as a capability boundary.** The agent can emit only the closed tool set; there is no "run this selector" or "evaluate this script". A restricted vocabulary is categorically stronger than filtering a general one — there is no expression to sanitize.

**Layer 4 — risk classification and irreversibility.** Steps classified `safe` | `irreversible` at record time by pattern (transfer/pay/send/submit/confirm/delete), **reviewable and editable by a human** before the artifact is trusted (`provenance.humanEdits`). `irreversible` → `requiresApproval` → explicit human confirmation via the escalation path, **on every replay**, not just the first. Confirmation rather than blocking is deliberate: blocking means real workflows can't complete, which means people route around the system.
Weakness, stated plainly: pattern matching is a heuristic and *will* miss a "Continue" button that commits a wire. Mitigations, neither complete — (a) default to `irreversible` when the post-action state looks like a commit confirmation, (b) human review at promotion time. **(b) is the real control**; the classifier's job is to make review cheap and focused, not to be correct alone.

**Layer 5 — secrets and data.** Credentials never in the artifact (`secretRef`, resolved from env/vault at replay); redaction at *every* write boundary (run log, artifact, extracted outputs, intervention records); Playwright `mask:` over credential fields in screenshots.
Residual exposure, stated: screenshots and DOM captures are the leak surface, and masking is selector-based — an account number rendered mid-page, a statement, an error echoing input, all captured in the clear. Evidence bundles therefore **inherit the data classification of the app** and need the same encryption, retention and access controls. Not solvable in a take-home; claiming it was solved would be worse than naming it.

**Layer 6 — budgets and pacing.** Step budget, wall clock, capped retries with backoff, deliberate pacing (also ParaBank hygiene). A runaway loop against a bank's back-office app is a self-inflicted DoS on a system tellers are actively using — bounded effort is an operational safety property, not just cost control.

**Layer 7 — auditability, and determinism *as* a safety property.** Every run emits an evidence bundle, every intervention is recorded, every artifact carries provenance and a version. The deeper point: an LLM-free replay path moves the trust boundary from *"trust a model's judgment on every execution"* to *"trust a reviewed artifact"*. You cannot review what a prompt will do next Tuesday; you can review, diff, version, approve and roll back a step list. Determinism is what makes safety review tractable at all — the reason the brief's core loop is the right architecture, not merely a cheaper one.

### Limits — where the guardrail model does not hold

1. **Prompt injection is only partially mitigated.** Discovery reads page content and page content is attacker-influenceable. The closed vocabulary + allowlist + chokepoint bound what an injected instruction can *do* (no off-domain navigation, no eval, no download, no new tab) — but it can absolutely steer *which in-scope action* the model takes: "before continuing, transfer $500 to account X" is expressible entirely within the allowed vocabulary on the allowed domain. Real mitigations, not built: framing page text as untrusted data with explicit provenance, an independent policy check on the *semantics* of each proposed action against the stated goal, and — the actual answer — **human approval of every discovered artifact before promotion**. That last is a process control, not a code control, and pretending otherwise would be the mistake.
2. **Replay is safe only to the extent the artifact was reviewed.** Trust moved to the artifact; if nobody reviews artifacts the guarantee is hollow. The promotion gate is a *required* part of the safety model, not a workflow nicety.
3. **Risk classification is heuristic** (Layer 4).
4. **Evidence capture is a data-exposure surface** (Layer 5).
5. **No operator authn/authz** — localhost, single user, no identity on the intervention record. Banking needs *which* human, authenticated, with the approval bound to their identity and retained.
6. **No idempotency / exactly-once.** If a transfer commits but the checkpoint read fails, the system can't distinguish "didn't happen" from "happened, wasn't observed". Stance: irreversible steps are never auto-retried — they escalate, converting a possible double-spend into a human decision. That's the correct trade; the real fix (idempotency keys, or reading back a server-side transaction id) needs cooperation from an app that by definition has no API.
7. **Time-of-check / time-of-use** — policy is checked before the act and the page can change in between. Bounded, not eliminated, by asserting the checkpoint after every action.
8. **The allowlist protects the surface, not the semantics.** Staying on `parabank.parasoft.com` says nothing about whether the *right* account was debited. Only typed inputs, per-step checkpoints and artifact review address that.

---

## Escalation & handoff (`src/escalation/`)

Feeds REPORT.md §5. The control-transfer model, made real rather than notional.

### Detecting "stuck"

Four terminal-ish states, and the quality of the whole story rests on the second one existing:

1. **Success** — postcondition holds, outputs extracted.
2. **Business outcome** — a *declared* detector matched. The app worked; the answer is "no". **Not stuck, must never escalate.**
3. **Recoverable fault** — handled inline: dismiss a known interstitial, re-login once on `SESSION_EXPIRED`, bounded retry with backoff on transient `TIMEOUT`.
4. **Stuck** — everything else.

The failure mode this is specifically built to avoid: timing out waiting for the success condition and reporting "automation failed" while the page has been displaying **"Insufficient funds"** for 29 of those 30 seconds — escalating to a human who looks at the screen and sees an app working perfectly. Structural fix in two parts: outcomes are *declared in the artifact* at discovery time, and after every action the engine **races the step checkpoint against all outcome detectors**, evaluating outcomes **before** a timeout is allowed to become a failure.

| Stuck trigger | Class |
|---|---|
| Fallback chain exhausted, retries spent | `LOCATOR_NOT_FOUND` |
| More than one element matched | `LOCATOR_AMBIGUOUS` (never auto-resolved) |
| Acted, but the world didn't change as recorded | `CHECKPOINT_FAILED` |
| Timed out and **no** outcome detector matched | `TIMEOUT` |
| URL + aria-hash unchanged for N actions (discovery) | no-progress dead end |
| OS/browser dialog outside the model | `UNEXPECTED_DIALOG` |
| Navigation outside the allowlist | `NAVIGATION_BLOCKED` |
| Action denied by policy | `POLICY_DENIED` |
| App rendered an error it never declared | `APP_ERROR` |
| Step budget / wall clock / retry budget exhausted | budget stop |
| Next step is `risk: "irreversible"` | **approval gate** |

Two of these deserve comment. **Budgets are a stuck condition, not just cost control** — a system that never gives up hammers a bank's back-office app in a loop. And **"irreversible step reached" is stuck by *policy*, not by failure**: the channel carries both *"I can't"* and *"I shouldn't without you"* through the same machinery, with the same payload and the same lease transfer. Sharing machinery is deliberate — the confirmation path gets exercised every time the escalation path does, instead of being a separate rarely-tested branch.

### Taking control of the live session

```ts
SessionLease {
  sessionId
  controller: 'automation' | 'human' | 'none'
  holder?: string      // operator identity
  epoch: number        // increments on every transfer
  since, reason, expiresAt?
}
```

- **`Surface.act()` hard-gates on the lease.** While the controller is `human`, automation is *incapable* of acting — not "politely refrains". Same chokepoint as policy, which is what makes control transfer enforced rather than conventional.
- **It is genuinely the same session.** The Playwright context is long-lived and headed, never torn down or recreated. Cookies, `jsessionid`, a half-completed wizard, an in-flight form, a consumed one-time token all persist. This matters more in banking than it first appears: "here's a link, log in yourself" isn't a handoff, it can be *impossible* — the OTP is spent, the wizard holds server-side state keyed to that session, step 4 of 6 already committed. Continuity of session is the requirement; the lease is how you get it without two actors racing on one browser.
- **The intervention payload** is assembled entirely from fields the schema already carries — capability id + version, tenant, goal, step id and **`intent`** ("enter the payee account number" — the third job that field does), expected vs. observed, error class, live screenshot, aria snapshot, URL, runId, evidence path. An operator should be able to act in under 30 seconds without opening a log.
- **Operator console:** minimal local Express + one HTML page, polling `page.screenshot()` for a live view, showing intervention context, offering **Take control / Release**. The operator drives the actual browser window. Mocked deliberately — a screenshot poll, not co-browsing.
- **Single-holder, compare-and-swap acquire.** A second operator is denied, not interleaved; two humans on one browser session is a real hazard.
- **The lease expires** — an unclaimed intervention resolves into a definite terminal state rather than pinning a session open forever.
- **The caller never blocks.** The invoking agent gets `{ status:"escalated", interventionId, resumeToken }` immediately. Escalation is asynchronous by contract; invoking a capability is not a phone call to a human.

### Recording what the human did

Three requirements land on one mechanism: **audit** (banking requires attributable action — an unrecorded intervention is an unexplained change to a customer's account), **repair** (the human just *demonstrated* the correct locator — better signal than re-running discovery blind), and **resume correctness**. Captured via `framenavigated` listeners plus an injected input recorder (`addInitScript` + `exposeBinding`) logging clicks and field edits with values **redacted at capture time**, plus before/after screenshots and aria snapshots, stored on the intervention record.

### Handing back — re-observe, never assume

The naive design stores "resume at step 7" and replays it, which is either a **double submission** (two wires, one intended) or an immediate precondition failure. The first is unacceptable in a way that doesn't show up in testing. On release the engine instead:

1. **Re-observes from scratch** — no cached tree; the human may have navigated anywhere.
2. Re-asserts step N's `waitFor` precondition.
3. Evaluates step N's `checkpoint`. If it already holds → the human did it → mark `completed_by_human`, log it, **advance to N+1**.
4. Evaluates every outcome detector — the human may have driven into a terminal business outcome, which is a result, not a resumption point.
5. If neither precondition nor checkpoint holds → the session is somewhere the artifact doesn't describe. **Do not guess:** terminate with `RESUME_STATE_UNRECOGNIZED` plus full evidence. On a live banking session, stopping loudly beats acting blind.
6. Re-acquire the lease (new epoch), resume with a **fresh step budget** — the human's work shouldn't be cut short by the budget already spent getting stuck.

Additional rule: **irreversible steps are never auto-resumed.** Even with the precondition satisfied, they re-confirm — the whole reason a human touched the session is that the state may no longer be what the automation believed.

`resumeToken` binds `{ runId, sessionId, stepId, artifactVersion, leaseEpoch }`. Version binding matters: resuming against an artifact edited mid-intervention would silently execute a different flow than the one the operator was looking at. The epoch is what makes a stale token detectable rather than replayable.

The whole exchange is written to the run log as a control-transfer timeline.

### Limits

- Screenshot poll, not co-browsing: visible latency, no cursor or selection sharing. The *control-transfer model* is real; the viewport is minimal.
- **No operator routing** — no queue, skills-based assignment, SLA timers, or escalation-of-the-escalation. One local operator.
- **No operator authentication** — see the safety limits.
- A human can act outside the step model; accepted, and it fails loudly (`RESUME_STATE_UNRECOGNIZED`) rather than quietly.
- **No "ask without transferring control" mode.** A cheap disambiguation ("which of these two 'Continue' buttons?") currently costs a full lease handoff. A lightweight question/answer channel that keeps the lease with automation is the obvious next increment and would likely absorb most real interventions.

---

## Evidence (`evidence/runs/<runId>/`)

`run.jsonl` (one structured event per line: ts, phase, stepId, action, **which locator strategy resolved**, durationMs, outcome) · `steps/NNN-{before,after}.png` · on failure `failure.png` + `failure.html` + `failure.aria.yaml` + Playwright `trace.zip` · `artifact.json` (discovery) · `result.json`.

Required at repo root: one discovery run, one successful replay, **and one replay that hits an exceptional state.** Use a real ParaBank business outcome (loan denial or "no transactions found") rather than an injected fault — a genuine outcome is more convincing than a simulated one.

---

## Stretch: agent-facing capability catalog (`src/catalog/`)

Read `capabilities/*.json` → emit Claude tool definitions from each artifact's `inputs` JSON Schema (already available from Zod) → `invoke(name, args)` validates against the schema, runs replay, returns the typed result. Demo script: Claude is asked in natural language to open a savings account, discovers the capability by name, and invokes it. Cheap because the artifact already carries a typed contract — and it closes the loop on the brief's central framing.

---

## Build order

Each milestone leaves the system runnable; the vertical slice is preserved throughout.

0. **Copy this plan to `docs/PLAN.md`** in the project root, as the working reference that later feeds REPORT.md.
1. **Schema + store** — Zod artifact schema, filesystem store, hand-written example artifact.
2. **Surface + locator engine** — Playwright adapter, aria snapshot + legacy enrichment, fallback resolution with exactly-one-match. Unit tests here.
3. **Replay engine against the hand-written artifact** — proves determinism before any LLM exists. Capture `fixtures/parabank/*.html` now, while the site is up.
4. **Discovery loop** — real `claude-opus-5` run against ParaBank. *Do this early*: it's the one thing the brief says cannot be faked, and it depends on a live third-party site.
5. **Recorder** — structured action log → artifact; verify the recorded artifact replays.
6. **Outcomes + error taxonomy** — declared detectors, recovery specs, the checkpoint/outcome race, the three-tier result contract.
7. **Policy** — allowlist, risk classification, redaction, wired into `Surface.act()`.
8. **Escalation** — lease, broker, operator console, human-action recording, resume-by-re-observing.
9. **Evidence** — three required runs captured into `/evidence/`.
10. **Catalog** (stretch) — only once 1–9 are solid.
11. **README.md + REPORT.md** — REPORT.md must use the seven exact headings from Section 6.

---

## Deliberate cuts (state these in REPORT.md §7)

- **Desktop surface** — not built. The seam is the `Surface` interface + `surfaceKind` field; the UIA mapping, the things that genuinely change (no URL, no load event, OS-level dialogs, global focus, opaque-tree worst case) and the argument that legacy-web *is* desktop work are in the Heterogeneity section above.
- **Multi-tenant** — `TenantBinding` + override-layer shape defined in the schema, not implemented; nor is the repair loop. Drift detection *is* real: the "which strategy resolved" telemetry is the detection primitive, and the one-tenant vs. all-tenants correlation is what turns it into a diagnosis.
- **Operator console** — screenshot-poll + take/release control, not real-time co-browsing; no operator identity, routing, or queueing. The *handoff mechanism and control-transfer model are real*; the UI is minimal.
- **No queues/services/DB** — single process, filesystem.
- **Assisted LLM fallback on replay failure** — deliberately excluded; replay stays LLM-free, and ambiguity routes to a human instead. Note it as the natural next step.
- **Semantic action review / prompt-injection defense beyond the vocabulary bound** — not built; the honest mitigation is human approval of discovered artifacts at promotion, which is a process control. Stated as a limit, not papered over.
- **Idempotency / exactly-once** — not solvable without app cooperation; irreversible steps escalate rather than auto-retry, converting a possible double-spend into a human decision.

---

## Verification

- **Unit:** locator fallback ordering; ambiguity raises rather than picking first; **outcome detectors take precedence over timeout**; redaction of secrets in logs/artifacts; allowlist denies off-domain navigation and non-http schemes.
- **Offline integration:** replay the artifact against `fixtures/parabank/*.html` served by a tiny static server — proves determinism without the live site, and satisfies the README's "how to run without live services" requirement.
- **Live end-to-end (the demo path in README.md):**
  ```
  npm run discover -- --goal "open a new savings account and read back the new account number" \
                      --target https://parabank.parasoft.com/parabank/index.htm
  npm run replay   -- --capability parabank.open-new-account --input '{"accountType":"SAVINGS"}'
  npm run replay   -- --capability parabank.request-loan --input '{"amount":"99999999"}'   # business outcome
  npm run operator                                                                          # escalation demo
  npm run agent-demo                                                                        # catalog stretch
  ```
- **Escalation check:** force a stuck state (point a step at a deliberately ambiguous locator), confirm automation *cannot* act while the lease is human-held, complete the step manually, resume, and confirm the engine detects the satisfied checkpoint and advances rather than repeating it.

## Risks

- **ParaBank availability/state resets.** Mitigate by capturing fixtures in milestone 3 and running discovery early (milestone 4).
- **Weak accessible names on legacy JSP.** This is expected and is the point — the `nearbyText` fallback strategy exists for it. If a locator has *only* a `css` strategy, treat that as a signal to record lower confidence rather than to paper over it.
