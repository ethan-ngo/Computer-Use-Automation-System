# Implementation checklist

Execution tracker for `docs/PLAN.md`. Check items off as they complete.
Resume rule: find the first unchecked box, do that.

**State as of last session:** M0-M8 complete — 128 tests green, typecheck clean.
The live discovery run **works end to end** against ParaBank and produced
`capabilities/parabank.open-parabank-savings-account.json`. Next code action is M9
(evidence capture) then M10/M11.

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
- [ ] Verify the recorded artifact replays *(needs `src/cli/replay.ts`, which does not exist
      yet even though `package.json` has the script — M11)*

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

## M9 — Evidence

- [x] `src/evidence/logger.ts` — `run.jsonl` (ts, phase, stepId, action, **which locator strategy resolved**, durationMs, outcome); every event passes through the redactor at the single write boundary. Written early because M4 needed it.
- [ ] `src/evidence/capture.ts` — `steps/NNN-{before,after}.png`; on failure `failure.png` + `failure.html` + `failure.aria.yaml` + `trace.zip`
- [ ] Control-transfer timeline written to the run log
- [ ] Required deliverables in `evidence/`: one discovery run, one successful replay, one replay hitting an exceptional state (use a real ParaBank business outcome — loan denial or "no transactions found")

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
