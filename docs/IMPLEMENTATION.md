# Implementation checklist

Execution tracker for `docs/PLAN.md`. Check items off as they complete.
Resume rule: find the first unchecked box, do that.

**State as of last session:** scaffolding done, dependencies installed. Next action is
M0.7 (install Chromium) — or skip it and start M1, which needs no browser.

**Environment notes**
- Node v23.7.0, npm 11.6.2, git 2.39.2 — all present.
- `ANTHROPIC_API_KEY` is **not set**. Everything builds without it; only M4's live
  discovery run needs it (`npm run discover`).
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
- [ ] `npx playwright install chromium` *(needs approval; not required for M1)*
- [ ] First commit of the scaffold

## M1 — Artifact schema + store

- [ ] `src/artifact/schema.ts` — Zod `CapabilityArtifact`: `schemaVersion`, `id`, `version`, `name`, `description`, `target{app,surfaceKind,entryPoint,tenantBinding?}`, `inputs`, `outputs`, `steps[]`, `outcomes[]`, `postcondition`, `policy{riskClass,requiresApproval,allowedDomains}`, `provenance`, `reliability?`
- [ ] `Step` — `id` (stable, index-independent), `index`, `intent`, `action{type,valueFrom?}`, `locator?`, `waitFor?`, `checkpoint?`, `extract?`, `onError?`, `risk`, `timeoutMs`
- [ ] `Locator` / `Strategy` discriminated union — `role`, `label`, `placeholder`, `nearbyText`, `text`, `css`, `nth` (+ `confidence`, `rationale`)
- [ ] `OutcomeSpec` with detector + `terminal` flag
- [ ] `TenantBinding` schema — `tenantId`, `app`, `baseUrl`, `secrets`, `locale`, `policy` (stricter-only), `overrides` keyed by step id, `disabledSteps`
- [ ] `src/artifact/store.ts` — load/save/list from `capabilities/`, validate on read, resolve tenant overrides
- [ ] Hand-written example artifact `capabilities/parabank.open-new-account.json` (proves the schema before any LLM exists)
- [ ] Tests: schema rejects malformed artifacts; tenant override resolution order (artifact → override → error); tenant policy cannot widen

## M2 — Surface + locator engine

- [ ] `src/surface/types.ts` — `Observation`, `Action`, `ActionResult`, `Resolution`, `EvidenceBundle`, `SessionLease`
- [ ] `src/surface/surface.ts` — the `Surface` interface (`observe`/`act`/`resolve`/`capture`/`lease`)
- [ ] `src/surface/playwright-web.ts` — `ariaSnapshot()` + legacy enrichment pass deriving `labelHint` from preceding `<td>` / `<b>` / `name` attr (this *is* the legacy-surface handling)
- [ ] Normalized node shape: `{ref,role,name,value,enabled,labelHint,cssPath,siblingIndex,framePath}`
- [ ] `src/replay/locator.ts` — try primary then fallbacks in order; **require exactly one match**; `LOCATOR_AMBIGUOUS` on >1; record which strategy resolved
- [ ] Tests: fallback ordering; ambiguity raises rather than picking first; resolved-strategy telemetry emitted

## M3 + M6 — Replay engine, outcomes, error taxonomy

- [ ] `src/replay/outcomes.ts` — outcome detectors compiled from `OutcomeSpec`
- [ ] `src/replay/engine.ts` — per step: assert `waitFor` → resolve → policy check → act → **race checkpoint against all outcome detectors** → `extract`
- [ ] `ReplayResult` union: `success` | `business_outcome` | `escalated` | `failed`
- [ ] `ReplayError` classes: `LOCATOR_NOT_FOUND`, `LOCATOR_AMBIGUOUS`, `CHECKPOINT_FAILED`, `TIMEOUT`, `SESSION_EXPIRED`, `UNEXPECTED_DIALOG`, `POLICY_DENIED`, `NAVIGATION_BLOCKED`, `APP_ERROR`, `STRUCTURAL_DIVERGENCE`, `RESUME_STATE_UNRECOGNIZED`
- [ ] Three-tier handling: recoverable (`onError` specs + bounded retry/backoff, re-login once on `SESSION_EXPIRED`) / business outcome / hard failure
- [ ] Budgets: step budget, wall clock, retry caps
- [ ] Capture `fixtures/parabank/*.html` while the live site is up
- [ ] `src/cli/serve-fixtures.ts` — static server for offline replay
- [ ] Tests: **outcome detectors take precedence over timeout** (the headline test); recovery spec fires; budget exhaustion terminates

## M7 — Policy

- [ ] `policy.yaml` — allowed domains + route globs, allowed/denied action types, risk patterns, secret refs, redaction patterns
- [ ] `src/policy/allowlist.ts` — **parsed-origin + path-glob**, never string prefix; scheme allowlist (`http`/`https` only)
- [ ] `src/policy/risk.ts` — `safe` | `irreversible` classification; `requiresApproval` on irreversible
- [ ] `src/policy/redact.ts` — redaction at every write boundary; screenshot `mask:` over credential fields
- [ ] Wire enforcement **inside `Surface.act()`** — single chokepoint for both discovery and replay
- [ ] Tests: denies off-origin (`parabank.parasoft.com.evil.tld`), denies non-http schemes, denies new-tab/download, secrets redacted in logs+artifacts, **act() throws when policy denies**

## M4 + M5 — Discovery loop + recorder

- [ ] `src/agent/tools.ts` — closed vocabulary: `observe`, `navigate`, `click`, `fill`, `select`, `press`, `extract`, `declare_outcome`, `checkpoint`, `escalate_to_human`, `finish`
- [ ] `src/agent/prompt.ts` — system prompt; page text framed as untrusted data
- [ ] `src/agent/loop.ts` — `claude-opus-5`, `thinking: {type:"adaptive"}`, `output_config: {effort:"high"}`, prompt caching on the frozen tools+system prefix, streaming
- [ ] Stopping conditions: `maxSteps` ~40, wall clock, no-progress detector (same URL + aria-hash N times → escalate)
- [ ] Token control: numbered element list as text each turn; screenshot only on request or every N steps
- [ ] `src/artifact/recorder.ts` — consumes the **structured action log**, never model prose: resolve locators + fallback chains from the live observation, synthesise checkpoints, canonicalise URLs (`?id=12345` → `{{accountId}}`), promote literals to `valueFrom` references
- [ ] Ambiguity during discovery → escalate; the operator's pick is what gets recorded
- [ ] `src/cli/discover.ts`
- [ ] Live run: `npm run discover -- --goal "open a new savings account and read back the new account number" --target https://parabank.parasoft.com/parabank/index.htm` *(needs `ANTHROPIC_API_KEY`)*
- [ ] Verify the recorded artifact replays

## M8 — Escalation & handoff

- [ ] `src/escalation/lease.ts` — `SessionLease` with `epoch`, compare-and-swap acquire, expiry
- [ ] `Surface.act()` hard-gates on the lease (automation *cannot* act while human-held)
- [ ] `src/escalation/broker.ts` — `InterventionRequest` (capability id+version, tenant, goal, step id + **intent**, expected vs observed, error class, screenshot, aria snapshot, URL, runId, evidence path); `resumeToken` binding `{runId,sessionId,stepId,artifactVersion,leaseEpoch}`
- [ ] Human-action recorder — `framenavigated` + `addInitScript`/`exposeBinding` input capture, **values redacted at capture time**, before/after screenshots
- [ ] `src/escalation/console/` — Express + one HTML page, screenshot poll, Take control / Release
- [ ] Resume: re-observe → re-assert precondition → check checkpoint (satisfied ⇒ `completed_by_human`, advance) → check outcome detectors → else `RESUME_STATE_UNRECOGNIZED`; fresh step budget; irreversible steps never auto-resumed
- [ ] `src/cli/operator.ts`
- [ ] Test: force ambiguity, confirm automation cannot act while lease is human-held, complete manually, resume, confirm engine detects the satisfied checkpoint and advances rather than repeating

## M9 — Evidence

- [ ] `src/evidence/logger.ts` — `run.jsonl` (ts, phase, stepId, action, **which locator strategy resolved**, durationMs, outcome)
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

- [ ] `npx playwright install chromium` was declined once — re-approve when ready, or point `PLAYWRIGHT_BROWSERS_PATH` at an existing install.
- [ ] Live discovery needs `ANTHROPIC_API_KEY` in the environment (or `ant auth login`).
