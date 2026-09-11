# Implementation checklist

Execution tracker for `docs/PLAN.md`. Check items off as they complete.
Resume rule: find the first unchecked box, do that.

**State as of last session:** M0-M8 complete plus `src/cli/replay.ts` — 130 tests green,
typecheck clean. **Discover → record → replay is verified end to end against live
ParaBank**, in all three terminal states: success, business outcome, and escalation.
Next code action is M9 (evidence capture), then M10/M11.

**Environment notes**
- Node v23.7.0, npm 11.6.2, git 2.39.2 — all present.
- Chromium **is** installed (`chromium-1243` plus the headless shell).
- `ANTHROPIC_API_KEY` is set in `.env` (gitignored), workspace-scoped, and credited.
  Discovery runs cost roughly 3k output tokens; prompt caching carries ~107k input
  tokens per run at ~22 uncached.
- `ANTHROPIC_WORKSPACE_ID` is read by `newClient()` in `src/agent/loop.ts` if an
  organization-scoped key is ever used again.
- ParaBank reachable: `https://parabank.parasoft.com/parabank/index.htm` → HTTP 200.
- Repo initialised, working on branch `build/capability-system`.

---

## M0 — Scaffolding

- [x] `git init`, branch `build/capability-system`
- [x] Directory skeleton (`src/{surface,artifact,agent,replay,policy,escalation,evidence,catalog,cli}`, `capabilities/`, `tenants/`, `evidence/runs/`, `fixtures/parabank/`, `tests/`)
- [x] `package.json` — scripts: build, typecheck, test, discover, replay, operator, agent-demo, catalog, fixtures:serve, fixtures:capture
- [x] `tsconfig.json` (ES2022, strict, `noUncheckedIndexedAccess`)
- [x] `vitest.config.ts`
- [x] `.gitignore`, `.env.example`
- [x] `npm install` (139 packages: zod, playwright, express, yaml, @anthropic-ai/sdk, zod-to-json-schema; tsx/vitest/typescript dev)
- [x] `npx playwright install chromium` (headed build plus the headless shell)
- [ ] First commit of the scaffold

## M1 — Artifact schema + store

- [x] `src/artifact/schema.ts` — Zod `CapabilityArtifact`: `schemaVersion`, `id`, `version`, `name`, `description`, `target{app,surfaceKind,entryPoint,tenantBinding?}`, `inputs`, `outputs`, `steps[]`, `outcomes[]`, `postcondition`, `policy{riskClass,requiresApproval,allowedDomains}`, `provenance`, `reliability?`
- [x] `Step` — `id` (stable, index-independent), `index`, `intent`, `action{type,valueFrom?}`, `locator?`, `waitFor?`, `checkpoint?`, `extract?`, `onError?`, `risk`, `timeoutMs`
- [x] `Locator` / `Strategy` discriminated union — `role`, `label`, `placeholder`, `nearbyText`, `text`, `css`, `nth` (+ `confidence`, `rationale`)
- [x] `OutcomeSpec` with detector + `terminal` flag
- [x] `TenantBinding` schema — `tenantId`, `app`, `baseUrl`, `secrets`, `locale`, `policy` (stricter-only), `overrides` keyed by step id, `disabledSteps`
- [x] `src/artifact/store.ts` — load/save/list from `capabilities/`, validate on read, resolve tenant overrides
- [x] Hand-written example artifact `capabilities/parabank.open-new-account.json` (proves the schema before any LLM exists)
- [x] Tests: schema rejects malformed artifacts; tenant override resolution order (artifact → override → error); tenant policy cannot widen

## M2 — Surface + locator engine

- [x] `src/surface/types.ts` — `Observation`, `Action`, `ActionResult`, `Resolution`, `EvidenceBundle`, `SessionLease`
- [x] `src/surface/surface.ts` — the `Surface` interface (`observe`/`act`/`resolve`/`capture`/`lease`)
- [x] `src/surface/playwright-web.ts` — `ariaSnapshot()` + legacy enrichment pass deriving `labelHint` from preceding `<td>` / `<b>` / `name` attr (this *is* the legacy-surface handling)
- [x] Normalized node shape: `{ref,role,name,value,enabled,labelHint,cssPath,siblingIndex,framePath}`
- [x] `src/replay/locator.ts` — try primary then fallbacks in order; **require exactly one match**; `LOCATOR_AMBIGUOUS` on >1; record which strategy resolved
- [x] Tests: fallback ordering; ambiguity raises rather than picking first; resolved-strategy telemetry emitted

## M3 + M6 — Replay engine, outcomes, error taxonomy

- [x] `src/replay/outcomes.ts` — outcome detectors compiled from `OutcomeSpec`
- [x] `src/replay/engine.ts` — per step: assert `waitFor` → resolve → policy check → act → **race checkpoint against all outcome detectors** → `extract`
- [x] `ReplayResult` union: `success` | `business_outcome` | `escalated` | `failed`
- [x] `ReplayError` classes: `LOCATOR_NOT_FOUND`, `LOCATOR_AMBIGUOUS`, `CHECKPOINT_FAILED`, `TIMEOUT`, `SESSION_EXPIRED`, `UNEXPECTED_DIALOG`, `POLICY_DENIED`, `NAVIGATION_BLOCKED`, `APP_ERROR`, `STRUCTURAL_DIVERGENCE`, `RESUME_STATE_UNRECOGNIZED`
- [x] Three-tier handling: recoverable (`onError` specs + bounded retry/backoff, re-login once on `SESSION_EXPIRED`) / business outcome / hard failure
- [x] Budgets: step budget, wall clock, retry caps
- [x] Capture `fixtures/parabank/*.html` while the live site is up — `index`, `register`,
      `overview`, `openaccount`, `requestloan`, `transfer`. Needed two fixes: the CLI's
      entrypoint guard never fired on Windows (hand-built `file://` URL vs. three-slash
      `import.meta.url`), and the authenticated pages captured as ParaBank's error page
      until `--login` was added. **Known limit:** `openaccount.htm`'s selects are
      AJAX-populated and its submit is a JS `input[type=button]`, so with scripts stripped
      the offline fixture exercises locator resolution and structure, not the live submit.
- [x] `src/cli/serve-fixtures.ts` — static server for offline replay
- [x] `src/replay/extract.ts` — typed extraction; locale-aware money/date parsing through the tenant binding *(not in the original plan; the alternative was untyped scraping, which is how locale bugs go silent)*
- [x] `src/evidence/types.ts` — `RunEvent` / `RunLogger`, so the engine emits evidence without touching a filesystem
- [x] Tests: **outcome detectors take precedence over timeout** (the headline test, plus its contrast pair: the identical page escalates when the outcome is *not* declared); recovery spec fires; budget exhaustion terminates; approval gate blocks an irreversible action; resume never re-runs a human-completed step; fallback strategy recorded as degraded; secrets redacted out of outputs

## M7 — Policy

- [x] `policy.yaml` — allowed domains + route globs, allowed/denied action types, risk patterns, secret refs, redaction patterns
- [x] Parsed-origin + path-glob allowlist, never string prefix; scheme allowlist (`http`/`https` only) — landed in `src/policy/policy.ts` alongside risk classification rather than as a separate `allowlist.ts`; they are twenty lines each and share the policy file
- [x] `safe` | `irreversible` classification and `requiresApproval` on irreversible — same module, `classifyRisk()`
- [x] `src/policy/redact.ts` — redaction at every write boundary; screenshot `mask:` over credential fields
- [x] Wire enforcement **inside `Surface.act()`** — single chokepoint for both discovery and replay
- [x] Tests: denies off-origin (`parabank.parasoft.com.evil.tld`), denies non-http schemes, denies new-tab/download, secrets redacted in logs+artifacts, **act() throws when policy denies**

## M4 + M5 — Discovery loop + recorder

- [x] `src/agent/tools.ts` — closed vocabulary: `observe`, `navigate`, `click`, `fill`, `select`, `press`, `extract`, `declare_outcome`, `checkpoint`, `escalate_to_human`, `finish`
- [x] `src/agent/prompt.ts` — system prompt; page text framed as untrusted data
- [x] `src/agent/loop.ts` — `claude-opus-5`, `thinking: {type:"adaptive"}`, `output_config: {effort:"high"}`, prompt caching on the frozen tools+system prefix, streaming
- [x] Stopping conditions: `maxSteps` ~40, wall clock, no-progress detector (same URL + aria-hash N times → escalate)
- [x] Token control: numbered element list as text each turn; screenshot only on request or every N steps
- [x] `src/artifact/recorder.ts` — consumes the **structured action log**, never model prose: resolve locators + fallback chains from the live observation, synthesise checkpoints, canonicalise URLs (`?id=12345` → `{{accountId}}`), promote literals to `valueFrom` references
- [x] Ambiguity during discovery → escalate; the operator's pick is what gets recorded
- [x] `src/cli/discover.ts`
- [x] Live run — works. Sonnet 5 first, as asked; its artifact was rejected (below), so
      the committed one is Opus 5 at effort `high`:
      `npm run discover -- --goal "log in, open a new SAVINGS account, and read back the
      new account number shown on the confirmation" --model claude-opus-5 --headless`
- [x] `--from-run <runId>` re-compiles the artifact from a saved discovery log. Every real
      run opens an actual account on a public demo, so iterating on the recorder must not
      require iterating on the bank.
- [x] **Verified the recorded artifact replays.** `src/cli/replay.ts` written (out of M11
      order, because "does the artifact actually work" is the question the whole design
      answers). `npm run replay -- --capability parabank.open-savings-account --approve auto`:
      all six steps `ok`, every locator resolved on its **primary** strategy — zero drift —
      and it read back a real new account number. No model in the loop.
- [x] Verified the business-outcome path: the same artifact with a wrong password returns
      `LOGIN_REJECTED` in **1.4s, exit code 0**. Before the detector was corrected the same
      run escalated as `CHECKPOINT_FAILED` after 16s and paged a human. That pair is the
      clearest measurement in the project of what declaring outcomes buys.

**Replay exit codes.** `success` and `business_outcome` both exit 0; `escalated` exits 2;
`failed` exits 1. A business outcome exiting 0 is the point — a scheduler that retries a
loan denial, or a rota that pages someone for it, is the failure this design exists to
prevent.

**What the live runs actually taught us.** Four failures, all real, all now fixed and tested:

1. `page.evaluate(COLLECT)` returned `undefined` for every observation. Playwright evaluates
   a *string* argument as an expression, so a bare `() => {…}` yields an unserialisable
   function object. Now an IIFE, and `observe()` throws a named error rather than letting
   perception fail silently.
2. `strict: true` on the tool schemas → HTTP 400 `Schema is too complex`. Constrained
   decoding compiles the whole vocabulary into one grammar and twelve tools exceed it.
   Dropped; the loop validates defensively instead. (`count_tokens` does *not* catch this —
   it validated the same tools happily.)
3. **The loop observed too early.** After `act()` it called `observe()` immediately, so a
   click that navigates or fires AJAX was recorded against the *previous* page. Both models
   then declared checkpoints the stale snapshot contradicted, and looked like they were
   hallucinating success. `observeSettled()` polls to quiescence instead.
4. The extract locator was keyed on the value being extracted — `role=link name="21558"`,
   the account number that run had just created. It would resolve exactly once, ever.
   Extraction locators now exclude every strategy derived from the node's own name.

**Sonnet 5 vs Opus 5 on this task.** Sonnet: 0 business outcomes, extracted the account
number from the account-type dropdown, hardcoded the username as a literal. Opus: 2
outcomes with real detectors (`LOGIN_REJECTED`, `ACCOUNT_NOT_OPENED`), both credentials as
`secretRef`, a correct regex extract, and both irreversible steps flagged. The recorder's
checkpoint verification rejected the pre-fix runs of *both* models, which is the check
doing its job — but note that fix 3 was the real cause, so this is not purely a model gap.
- [x] Tests (`tests/recorder.test.ts`, 16): every synthesised strategy resolves through
      `resolveLocator`; an ambiguous strategy is discarded rather than recorded; css-only
      locators are low-confidence and say so; the stricter of model hint and policy pattern
      wins on risk; secrets stay references; colliding intents get distinct step ids

## M8 — Escalation & handoff

- [x] `src/escalation/lease.ts` — `SessionLease` with `epoch`, compare-and-swap acquire, expiry
- [x] `Surface.act()` hard-gates on the lease (automation *cannot* act while human-held)
- [x] `src/escalation/broker.ts` — `InterventionRequest` (capability id+version, tenant, goal,
      step id + **intent**, expected vs observed, error class, screenshot, aria snapshot, URL,
      runId, evidence path); `resumeToken` binding `{runId,sessionId,stepId,artifactVersion,leaseEpoch}`
- [x] Human-action recorder (`src/escalation/human-recorder.ts`) — `addInitScript` +
      `exposeBinding`, re-installed on `framenavigated`, **values reduced to a shape inside
      the page** ("14 characters", "a password") so plaintext never leaves the document;
      before/after screenshots
- [x] `src/escalation/console/` — Express (`server.ts`) + one inline HTML page (`page.ts`),
      screenshot poll, Take control / finished / approve / decline. Claim carries the epoch
      the page last saw, so two operators racing get a refusal rather than an interleaving.
- [x] Resume: re-observe → checkpoint (satisfied ⇒ `completed_by_human`, advance) → outcome
      detectors → precondition (retry, **safe steps only**) → else `RESUME_STATE_UNRECOGNIZED`
- [x] `src/cli/operator.ts`
- [x] Test (`tests/escalation.test.ts`, 16): the headline handoff test — force a genuine
      `LOCATOR_AMBIGUOUS`, confirm nothing was clicked, complete it by hand, resume, and
      confirm the engine records `completed_by_human` and advances with **zero clicks ever
      reaching the surface across both runs**. Plus: the lease gate tested against the *real*
      `PlaywrightWebSurface.act()` rather than a stub; every resume-token rejection path;
      an irreversible step is never auto-retried; and the recorder proven not to leak a
      typed password or username.

**Resume-token semantics, decided during implementation.** The token is issued when control
comes *back* to automation, not when the intervention opens. Issuing it earlier looks more
careful and is useless: the handoff itself moves the lease twice (take, release), so a token
pinned to the pre-handoff epoch is guaranteed stale and the check would have to be weakened
to nothing. Pinned at the point of return it means something falsifiable — no *further*
transfer happened between the operator handing the session back and automation picking it up.

## Found while verifying replay

- [x] **`Redactor.value()` destroyed secret references.** The key `secretRef` matches
      `/secret/i`, so every `{ secretRef: "PARABANK_PASSWORD" }` in a discovery log became
      `{ secretRef: "«redacted»" }`. Re-recording from that log produced a capability whose
      credentials could never resolve, and it failed at replay time far from the cause. A
      secret *reference* is a name, and the whole "references, not literals" decision exists
      so names are safe to persist — redacting them defeated the mechanism they protect.
      Fixed with a `REFERENCE_KEYS` allowlist; tested.
- [x] **Outcome detectors cannot be verified from a happy-path discovery run**, and the
      recorder was silent about it. `unverifiedOutcomes()` now flags any detector whose
      `textPresent` wording appears nowhere in the run's observations, and the CLI says so.
      Not a rejection: an outcome for a page the run never visited is legitimate and is the
      most valuable thing the model produces. But it is inferred, and inferred wording is
      exactly what turned a real login rejection back into a false alarm.
- [x] The engine does not navigate to `target.entryPoint`; no step records it, because
      discovery navigates there before the model sees the page. The replay CLI does it —
      getting to the entry point is the harness's job, executing recorded steps is the
      engine's.
- [x] `--from-run` now honours `--id`, and discovery exits 2 with a loud warning when a run
      ends as anything other than `finished`.

## M9 — Evidence

- [x] `src/evidence/logger.ts` — `run.jsonl` (ts, phase, stepId, action, **which locator strategy resolved**, durationMs, outcome); every event passes through the redactor at the single write boundary. Written early because M4 needed it.
- [x] `src/evidence/capture.ts` — `RunEvidence`: `steps/NNN-{before,after}.png` bracketing
      the act itself, and on failure `failure.png` + `failure.html` + `failure.aria.yaml` +
      `trace.zip`. Split from the logger deliberately: the logger is synchronous, cheap and
      always on; capture is asynchronous, expensive and allowed to fail. **Capture never
      breaks a run** — every path swallows its own error and logs the miss, which is tested
      by making `capture()` reject and watching the run still succeed.
      `Surface.saveTrace?()` is *optional* on the interface rather than required, because a
      UIA adapter has no equivalent and a stub would turn a real capability difference into
      a silently empty file.
- [x] Control-transfer timeline written to the run log — emitted by `LeaseManager` itself
      via `attachLogger()`, not by the call sites. Same reasoning as the policy check living
      inside `act()`: a timeline assembled from whichever call sites remembered to log is a
      sample, not a timeline. Every transfer carries controller, holder and **epoch**.
- [x] Required deliverables in `evidence/`: one discovery run (`b459913e`), one successful
      replay (`9b9b3d06`), one replay hitting a real exceptional state (`9367801d`,
      `LOGIN_REJECTED`). Indexed with their significance in `evidence/README.md`.
- [x] Tests (`tests/evidence.test.ts`, 8): the before/after pair brackets the act and
      nothing else; a failing capture loses a screenshot, not the run; the failure bundle
      writes all three views; no trace is reported as absent rather than as an empty zip;
      the control-transfer timeline records every controller change with its epoch

## The offline path — decided and built

The plan left a fork open: `openaccount.htm`'s AJAX selects and JS submit mean the *happy*
path cannot complete offline. Both recorded options were wrong for the same reason — they
would have demonstrated a different flow than the one the system actually discovered.

What landed instead: replay **the committed discovered artifact, unedited**, against the
fixtures, and let it reach its *declared business outcome*. ParaBank's login leg is a plain
server-rendered form POST, so it works offline; `fixtures/parabank/login-rejected.htm` is
the page the live bank really served on a wrong password (lifted from the `124db8ff`
evidence run), and the route table decides which world the artifact is replayed into.

- [x] `createFixtureApp(overrides)` — a route override is how the offline suite reaches an
      exceptional state. The artifact does not change; the world it replays into does.
- [x] `canonicalPath()` strips `;jsessionid=…` — ParaBank puts the session in the *path*, so
      every captured form action has one frozen session id in it. A replay server must not
      care which session a capture was taken in.
- [x] `--reject-login` on `fixtures:serve`, so the documented offline demo is one flag, and
      a reviewer always knows which world they are in.
- [x] **The Windows entrypoint guard bug was still in `serve-fixtures.ts`.** `npm run
      fixtures:serve` exited 0 and served nothing. Same `file://` vs `file:///` cause as the
      one fixed in `capture-fixtures.ts`; that fix had never been copied across.
- [x] `tests/offline-replay.test.ts` (2) — a real browser, real captured HTML, a real form
      POST, the committed artifact. `business_outcome LOGIN_REJECTED` in **1.6s**; all three
      locators resolved on their **primary** strategy against a different origin, which is
      the artifact's portability being measured rather than asserted. Its contrast pair —
      the same pages, the same run, outcomes stripped — **escalates after 16.6s**. That is
      the live measurement, reproduced on a laptop with no network.
- [x] CLI demo verified: `npm run replay -- --capability parabank.open-savings-account
      --fixtures --headless` → `business_outcome` in 1.4s, exit 0, with per-step before/after
      screenshots on disk (`evidence/runs/e1bab268…`).

**Known limit, stated rather than papered over:** the offline path cannot complete the
account-opening steps, because ParaBank's authenticated pages populate over AJAX and submit
through JavaScript. That is a property of the app, not of the design, and the happy path is
evidenced live in `evidence/runs/9b9b3d06`.

## M10 — Catalog (stretch)

- [ ] `src/catalog/catalog.ts` — read `capabilities/*.json`, emit Claude tool definitions from each artifact's `inputs` JSON Schema (via `zod-to-json-schema`)
- [ ] `src/catalog/invoke.ts` — validate args against the schema, run replay, return the typed result
- [ ] `src/cli/agent-demo.ts` — Claude asked in natural language to open a savings account, finds the capability, invokes it

## M11 — Docs + verification

- [ ] `README.md` — setup, the demo path, **how to run with no live services** (fixtures)
- [ ] `REPORT.md` — the seven exact headings from brief §6; §4/§5/§6 draw on the expanded sections in `docs/PLAN.md`
- [ ] `npm run typecheck` clean
- [ ] `npm test` — full suite green
- [ ] Offline integration replay against fixtures passes
- [ ] Live end-to-end demo path runs
- [ ] Final commit

---

## Deferred / needs a decision

- [ ] **Add API credits.** `ANTHROPIC_API_KEY` authenticates but the account balance is
      zero, so every Messages/count_tokens call fails. This is the only thing standing
      between here and the live discovery run.
- [ ] `strict: true` on the discovery tool schemas is unverified against the live API.
      The schemas carry optional properties alongside `required`; if the API rejects that
      combination, drop `strict` in `src/agent/tools.ts`. Cannot be checked without credits.
- [ ] `openaccount.htm` offline replay cannot complete the submit (AJAX selects, JS
      button). Either record the exceptional-path demo against `requestloan.htm`'s real
      loan-denial outcome, or keep scripts in that one fixture.
