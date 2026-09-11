# Design write-up

## 1. Architecture

One process, one package, filesystem persistence. No queue, no service, no database — the
interesting problems here are the artifact contract and the replay semantics, and scaling
infrastructure would only obscure them.

Two seams carry the design.

**`Surface` — the perceive/act boundary.** Everything the system knows about how to see and
touch a UI lives behind `observe` / `act` / `resolve` / `capture` / `lease`. The recorded
artifact never references Playwright. `Observation` is a normalized node list
(`{ref, role, name, value, enabled, labelHint, cssPath, siblingIndex, framePath}`), built
from Playwright's `ariaSnapshot()` plus an enrichment pass that derives `labelHint` from the
preceding `<td>` / `<b>` / `name` attribute. **That enrichment is the legacy-surface
handling**: ParaBank's JSP inputs have no `<label for>`, exactly as legacy WinForms puts its
caption in a sibling static-text control.

**The model/no-model line.** A model appears in exactly one file, `src/agent/loop.ts`, and
only during discovery. Replay is a state machine. This is the central trade-off of the whole
submission: replay cannot improvise when the app changes, and in exchange it is fast,
auditable, costs nothing, and cannot be talked into a transfer by page content. When replay
is stuck it routes to a human, not to a model.

Perception and actuation share one vocabulary — role plus accessible name. The model reads
`textbox "Username"`; the engine executes `getByRole('textbox', {name:'Username'})`. That
single vocabulary is also what makes the desktop story credible (§4).

The evidence layer is split deliberately: the run logger owns structured events and is
synchronous, cheap and always on; capture owns screenshots, DOM and traces, which are
asynchronous, expensive and allowed to fail. Evidence is instrumentation — a screenshot lost
to a mid-capture navigation costs a log line, not a transaction, and there is a test that
makes `capture()` throw and watches the run still succeed.

---

## 2. Artifact schema

The artifact is one Zod definition yielding three things from a single source: TypeScript
types, runtime validation of caller arguments, and JSON Schema for the agent catalog. Four
decisions are load-bearing.

**Values are references, never literals.** `valueFrom: "$.inputs.accountType"`;
credentials as `{ secretRef: "PARABANK_PASSWORD" }`. Parameterization and
never-persisting-secrets become *the same mechanism* rather than two features. The model
names a secret and never holds one. This decision has already earned its keep twice: the
recorder rejected a Sonnet-produced artifact that hardcoded a username as a literal, and a
redaction bug that scrubbed `secretRef` *names* (matching `/secret/i`) produced a capability
whose credentials could never resolve — a reference is a name, and names are safe to
persist, which is the whole point.

**Business outcomes are declared in the contract, not inferred at runtime.**
`{ name: "LOGIN_REJECTED", detect: {...}, terminal: true }`. Conflating an outcome with a
failure is the expensive mistake in this class of system, and declaring them is the
structural fix rather than a runtime heuristic. §3 has the measurement.

**Per-step checkpoints, not just a final one.** Cheap to record from the post-action
observation, and they make a failure debuggable to the exact step. A click that resolved and
did not throw is not evidence that anything happened.

**Every step carries a human-readable `intent`.** One field serves three requirements: the
escalation payload a human reads, the review story at promotion, and the capability
description handed to a calling agent.

Locators are a `primary` strategy plus an ordered `fallbacks` chain, each with `confidence`
and a `rationale`, over a closed `Strategy` union (`role`, `label`, `placeholder`,
`nearbyText`, `text`, `css`, `nth`). A css-only locator is recorded as low confidence and
says so, rather than being papered over.

---

## 3. Determinism & error handling

Per step: assert the precondition → resolve the locator → policy check → act → **race the
checkpoint against every declared outcome detector** → extract.

**Resolution requires exactly one match.** More than one is `LOCATOR_AMBIGUOUS`, a surfaced
failure class, never a silent `.nth(0)`. **Which strategy resolved is recorded** on the
success path — a fallback winning is the drift signal (§4).

**Outcomes beat checkpoints, and that ordering is the headline.** Every observation taken
while waiting is offered to the detectors before the timeout can fire. The measurement, from
this repository: a wrong-password replay returns `LOGIN_REJECTED` in **1.4s, exit code 0**.
Before the detector was corrected, the identical run escalated as `CHECKPOINT_FAILED` after
**16s** and paged a human. Both runs are in `evidence/`, and the pair is reproduced offline
as an integration test — same pages, same code, outcomes stripped from the capability — so
the claim is executable rather than asserted.

Three tiers, decided by error class, which is a closed set: **recoverable** (declared
`onError` specs, bounded retry with backoff, re-login once on `SESSION_EXPIRED`),
**business outcome** (a result; exit code 0), **hard failure** (structured error plus a full
evidence bundle). Retrying a hard failure and escalating a recoverable one are both
expensive, so the tier is never a judgement call at the call site.

Budgets bound everything: steps per replay, wall clock, retries per step, and a deliberate
inter-action delay — a runaway loop against a bank's back-office app is a self-inflicted
denial of service on a system tellers are using.

Four bugs found by live runs are worth recording because they were all real and none were
visible offline: `page.evaluate` given a string evaluates it as an *expression*, so a bare
arrow function returned `undefined` and perception failed silently; `strict: true` on the
tool schemas exceeded the grammar compiler (`count_tokens` validated them happily); the loop
observed *before the page settled*, so both models declared checkpoints a stale snapshot
contradicted and looked like they were hallucinating; and an extract locator was keyed on
the value being extracted, so it would have resolved exactly once, ever.

---

## 4. Heterogeneity & multi-tenant

"Heterogeneity" is three problems wearing one word, and conflating them is what produces
unmaintainable automation estates. They are separate because the *unit of reuse* differs: an
adapter is reused across every capability, an artifact across every tenant, an override by
nobody — it *is* the diff.

| Axis | Example | Response |
|---|---|---|
| Surface kind | ParaBank vs. a WinForms teller client | `Surface` interface + `target.surfaceKind` |
| Tenant | 40 credit unions on one vendor core | product-level artifact + per-tenant `TenantBinding` |
| Version/config drift | vendor ships 6.3; one tenant renames a label | resolution telemetry + override layer + version bump |

**Desktop.** Not built; the seam is. Windows UIA exposes ControlType + Name — the same two
axes as role + accessible name — so an adapter produces the same `Observation` without
touching the schema, the engine, the policy layer or the evidence format. What genuinely
changes: no URL and no load event (so `waitFor` leans on element-presence rather than
navigation), OS-level modal dialogs, global focus as shared state, and an opaque-tree worst
case where only coordinates remain. The claim I will defend is narrower than "it ports": the
*artifact format* survives, and the legacy-web work — deriving labels from layout because
nothing is programmatically associated — is the same work.

**Multi-tenant.** One artifact per vendor product; a `TenantBinding` supplies `baseUrl`,
secret mapping, locale, and per-step `overrides` keyed by step id. Tenant policy may only be
*stricter*, which is enforced and tested. A worked example is in
`tenants/first-national.json`: one tenant's 6.2.1 build emits `name=` but not `id=` on the
account-type select, so a narrow per-step locator patch is the fix. Forking the artifact
would give you a second copy to maintain, which is the failure this layer exists to prevent.

**Drift detection is real, not aspirational.** The engine records which strategy resolved on
every step. One tenant degraded means local customisation; every tenant degraded means the
vendor shipped a release. That correlation is what turns a signal into a diagnosis, and it
comes free from a mechanism that already had to exist.

---

## 5. Escalation & handoff

**Detecting stuck** is not a timeout. It is: recovery exhausted, `LOCATOR_AMBIGUOUS`, an
irreversible step needing approval, or — during discovery — a no-progress detector (same URL
and aria-hash N times). Each is a distinct condition, and each carries different context.

**Control transfer is enforced, not agreed.** A `SessionLease` with an `epoch` gates
`Surface.act()` at the same chokepoint as the policy check, so while a human holds the
session automation is *incapable* of acting rather than politely refraining. The headline
test forces a genuine `LOCATOR_AMBIGUOUS`, confirms nothing was clicked, completes the step
by hand, resumes, and confirms **zero clicks ever reached the surface across both runs**.

The intervention request carries what a human needs and nothing they must go looking for:
capability id and version, tenant, goal, step id **and its intent**, expected vs. observed,
error class, screenshot, aria snapshot, URL, run id, evidence path. The operator console is
a screenshot poll with take-control / approve / decline; a claim carries the epoch the page
last saw, so two operators racing get a refusal rather than an interleaving.

**What the human does is recorded as shape, not content.** The recorder reduces typed values
*inside the page* ("14 characters", "a password") before they cross the boundary, so
plaintext never leaves the document.

**Resume re-derives state rather than trusting it.** Re-observe → is the checkpoint already
satisfied? (then `completed_by_human`, advance) → do any outcome detectors match? → is the
precondition satisfied? (retry, **safe steps only**) → else `RESUME_STATE_UNRECOGNIZED`, and
the run stops loudly. Advancing past a step a human completed, rather than repeating it, is
the difference between resuming and opening a second account.

The `resumeToken` binds `{runId, sessionId, stepId, artifactVersion, leaseEpoch}` and is
issued when control comes *back*, not when the intervention opens. Issuing it earlier looks
more careful and is useless: the handoff moves the lease twice, so a token pinned to the
pre-handoff epoch is guaranteed stale and the check would have to be weakened to nothing.
Pinned at the point of return it means something falsifiable — no *further* transfer
happened between the operator handing back and automation picking up.

---

## 6. Safety

**One chokepoint.** Every action from discovery and replay alike passes through
`Surface.act()`, which enforces the origin allowlist *and* the lease. There is no second
path by which an action can reach the application — the strongest structural guarantee here,
and it is tested by asserting that `act()` throws under a denied policy and a human-held
lease.

**Origins are parsed, never prefix-matched** (`parabank.parasoft.com.evil.tld` is denied),
with a scheme allowlist and path globs. **The action vocabulary is closed**, which is
stronger than filtering a general one: there is no expression to sanitise. Downloads,
uploads, new tabs, script evaluation and dialogs are refused at the browser itself — an
unconstrained new tab is how automation escapes the surface it was scoped to.

**Irreversible steps require approval on every replay**, not just the first, and the default
approval hook *declines*, so an unattended agent escalates rather than authorising its own
action. **Redaction happens at a single write boundary** for text, and screenshots mask
credential fields at capture, because pixels cannot be scrubbed afterwards.

**A trace cannot be redacted, so it is opt-in.** Playwright writes a trace directly —
request bodies, DOM snapshots, typed values — and nothing passes through the redactor on
the way. I checked rather than assumed: a trace taken over the ParaBank login contains the
password in clear text, in three separate entries. So tracing is off by default, the file
is gitignored, and saving one writes a loud line into the run log. Dropping traces entirely
would remove the best tool for diagnosing a `LOCATOR_NOT_FOUND`; keeping them on by default
would have quietly contradicted the redaction claim everything else here makes.

**The limits, stated plainly.** Risk classification is a regex heuristic over step intent: it
will miss a button labelled "Continue" that commits a wire. The real control is human review
of the artifact at promotion, and the heuristic exists to make that review cheap and focused,
not to be correct alone. Page text is framed to the model as untrusted data and the closed
vocabulary bounds what a successful injection could ask for, but there is no semantic review
of discovered actions. There is no operator authentication — the console is local and
unauthenticated, which would be the first thing to fix for anything real. And a discovery run
against a live bank genuinely opens an account; `--from-run` exists so that iterating on the
recorder does not require iterating on the bank.

---

## 7. Cuts

Deliberately not built, with the seam left where the work would go:

- **Desktop adapter.** The `Surface` interface and `surfaceKind` are the seam; §4 is the
  argument. Next: a UIA adapter for one WinForms screen, which would test the claim that the
  artifact format survives.
- **Multi-tenant repair loop.** Bindings and overrides are built and tested; automated
  re-recording on drift is not. Drift *detection* is real.
- **Operator console as a real product.** Screenshot poll, not co-browsing; no identity,
  routing, queueing, or SLA timers. The control-transfer model is real; the UI is minimal.
  The highest-value next increment is a **question channel that does not transfer the
  lease** — a cheap "which of these two Continue buttons?" currently costs a full handoff,
  and would likely absorb most real interventions.
- **An LLM fallback when replay fails.** Excluded on purpose: replay stays model-free and
  ambiguity routes to a human. This is the cut I would revisit first, and the reason to be
  careful about it is that a model in the failure path is a model in the decision path.
- **Idempotency / exactly-once.** Not solvable without application cooperation. Irreversible
  steps escalate rather than auto-retry, which converts a possible double-spend into a human
  decision — the right trade, not a solution.
- **Queues, services, a database.** Single process, filesystem. The brief explicitly does not
  reward this, and it would have cost the time that went into the outcome semantics.

What I would build next, in order: the no-handoff question channel; a UIA adapter for one
desktop screen; and reliability statistics per capability per tenant (`reliability` is in the
schema and unpopulated), because the drift telemetry is already being recorded and is one
aggregation away from being the thing that tells an operations team which artifact is about
to break.
