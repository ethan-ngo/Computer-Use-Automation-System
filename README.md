# Computer-Use Automation System

An LLM drives a legacy web application **once** to work out how to accomplish a goal. That
run is recorded as a typed, versioned **capability artifact**. From then on the flow is
replayed **deterministically, with no model in the decision loop** — cheap, fast, auditable
— and when replay gets genuinely stuck, a human takes over *the same live browser session*
and hands it back.

The target application is [ParaBank](https://parabank.parasoft.com/parabank/index.htm), a
public demo online-banking app: server-rendered JSP, `jsessionid` in the URL path,
table-based layout, no test ids. A real legacy surface rather than a friendly one.

For the design reasoning and the honest limits, read **[REPORT.md](REPORT.md)**. This file
is how to run it.

---

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env        # then fill it in
```

`.env` holds `ANTHROPIC_API_KEY` (discovery and the agent demo only) and the ParaBank
credentials. It is gitignored, and no credential is ever written into an artifact, a run
log, or a screenshot — see [Safety](#safety).

```bash
npm run typecheck
npm test                    # 151 tests, ~20s, no network and no API key needed
```

---

## Running with no live services

**Everything in this section works offline** — no bank, no Anthropic API, no credentials.
Start the fixture server, which serves HTML captured from the real ParaBank:

```bash
npm run fixtures:serve -- --reject-login
```

Then, in another terminal, replay the recorded capability against it:

```bash
npm run replay -- --capability parabank.open-savings-account --fixtures --headless
```

```
business_outcome  (1395ms)

  ok    enter the online banking username  [label="username"]
  ok    enter the online banking password  [label="password"]
  ok    submit the login form              [role=button name="Log In"]  outcome LOGIN_REJECTED

  LOGIN_REJECTED: ParaBank did not accept the credentials.
  This is a result, not a failure. Exit code 0.
```

That is **the artifact recorded against the live bank, unedited, replaying against captured
HTML on a different origin** — every locator resolving on its primary strategy. The pages
are real: `fixtures/parabank/login-rejected.htm` is what the live bank actually served on a
wrong password, captured in `evidence/runs/124db8ff…`. `--reject-login` chooses which world
the artifact is replayed into; the artifact never changes.

`npm test` runs the same thing as an integration test (`tests/offline-replay.test.ts`),
along with its contrast pair: identical pages, identical run, **outcomes stripped from the
capability** — which escalates after 16.6s instead of answering in 1.6s. That pair is the
argument for declaring business outcomes, reproducible on a laptop with no network.

**Offline limit, stated plainly:** the *happy* path cannot complete offline. ParaBank's
authenticated pages populate their dropdowns over AJAX and submit through JavaScript, so a
scripts-stripped capture can exercise locator resolution and structure but not the account
opening itself. That is a property of the app, not of the design; the happy path is
evidenced live in `evidence/runs/9b9b3d06…`.

---

## The demo path, live

### 1. Discover — the only step with a model in the loop

```bash
npm run discover -- \
  --goal "log in, open a new SAVINGS account, and read back the new account number shown on the confirmation" \
  --model claude-opus-5 --headless
```

Claude is given a closed action vocabulary (`observe`, `navigate`, `click`, `fill`,
`select`, `press`, `extract`, `declare_outcome`, `checkpoint`, `escalate_to_human`,
`finish`) and the page as a numbered element list. It never sees a credential: `fill` takes
a *reference* (`{ secretRef: "PARABANK_PASSWORD" }`), which is resolved downstream of the
model.

The recorder then compiles the **structured action log** — never the model's prose — into
`capabilities/<id>.json`: locators with fallback chains computed from the live observation,
checkpoints synthesised from the post-action page, URLs canonicalised, literals promoted to
input references.

> Every discovery run opens a real account on somebody's public demo. Use
> `--from-run <runId>` to re-compile an artifact from a saved log instead of re-running the
> bank.

### 2. Replay — no model, ever

```bash
npm run replay -- --capability parabank.open-savings-account --approve ask
```

Per step: assert the precondition → resolve the locator (exactly one match, or a named
ambiguity error) → policy check → act → **race the checkpoint against every declared
business outcome** → extract.

Exit codes encode the distinction the whole design is built around:

| code | result | meaning |
|---|---|---|
| `0` | `success` | the flow completed |
| `0` | `business_outcome` | the application said no — **a result, not a failure** |
| `2` | `escalated` | a human is needed |
| `1` | `failed` | the automation broke |

A business outcome exiting `0` is deliberate. A scheduler that retries a loan denial, or a
rota that pages someone for one, is the failure this design exists to prevent.

### 3. Operator — replay with a human in the loop

```bash
npm run operator -- --capability parabank.open-savings-account
# then open the console it prints, usually http://127.0.0.1:8788
```

Every escalation and every approval gate routes to a small web console instead of failing
the run. The operator takes control, finishes the step by hand in the *same* browser
session, and hands it back; the engine then **re-observes to work out where it is** rather
than trusting what it was told, and advances rather than repeating.

While a human holds the session, automation is *incapable* of acting — the lease is checked
at the same chokepoint as the policy, so this is enforced rather than agreed.

### 4. Catalog — the capability as an agent tool

```bash
npm run catalog             # what a calling agent would see
npm run catalog -- --json   # the raw tool definitions
```

```bash
npm run agent-demo -- --ask "Please open me a new savings account and tell me the number."
npm run agent-demo -- --fixtures    # offline; reaches a business outcome, no live bank
npm run agent-demo -- --dry-run     # choose a tool, do not execute it
```

Claude is asked in plain English and given only the catalog — no browser, no page text, no
locators, no knowledge that ParaBank exists. It picks a capability and calls it; the flow
replays underneath with no model in the execution path. On the offline run it answers:

> *"The account could not be opened — ParaBank rejected the vaulted login credentials… This
> isn't something I can retry."*

It knows not to retry because the tool description, derived from the artifact, says a
declared business outcome is a result.

---

## What is in the repository

```
src/
  surface/     the perceive/act seam — Surface interface + Playwright adapter
  artifact/    the capability schema (Zod), the store, the recorder
  agent/       the discovery loop — the ONLY place a model is in the loop
  replay/      the deterministic engine, locators, outcomes, extraction — no model
  policy/      origin allowlist, risk classification, redaction
  escalation/  session lease, intervention broker, operator console
  evidence/    run log and capture
  catalog/     artifacts as agent-facing tools
  cli/         discover · replay · operator · catalog · agent-demo · fixtures
capabilities/  the recorded artifacts
tenants/       per-tenant bindings (baseUrl, secrets, locale, step overrides)
fixtures/      captured ParaBank HTML, for the offline path
evidence/runs/ one directory per run
policy.yaml    the guardrails, in one file
```

**Start with `capabilities/parabank.open-savings-account.json`** — the artifact is the
centre of the design, and it was written by the system, not by hand.

---

## Evidence

`evidence/runs/<runId>/` holds `run.jsonl` (one structured event per line, including
**which locator strategy resolved** and every control transfer), per-step
`steps/NNN-{before,after}.png`, and on failure `failure.png`, `failure.html` and
`failure.aria.yaml`. Every text write passes through the redactor at a single boundary;
screenshots mask credential fields at capture time, because pixels cannot be scrubbed
afterwards.

Pass `--trace` to also record a Playwright trace, saved as `trace.zip` when a run fails.
**It is opt-in, and it is gitignored, because it is the one artefact the redactor cannot
reach**: Playwright writes request bodies and typed values into it verbatim, so a trace
taken over a login contains the password in clear text. That was measured, not assumed. It
is the best tool there is for diagnosing a `LOCATOR_NOT_FOUND`, so the trade is to keep it,
make it deliberate, and never ship it.

`evidence/README.md` indexes the kept runs and says what each one demonstrates, including
the pair where a real login rejection escalated as a false alarm before its detector was
corrected, and answered in 1.4s afterwards.

---

## Safety

- **One chokepoint.** Every action from discovery and replay alike passes through
  `Surface.act()`, which enforces the origin allowlist *and* the session lease. There is no
  second path to the application.
- **Origins are parsed, never prefix-matched.** `parabank.parasoft.com.evil.tld` is a
  different origin and is denied. Only `http`/`https` are navigable.
- **A closed action vocabulary**, so there is no general expression to sanitise. Downloads,
  uploads, new tabs, script evaluation and dialogs are refused at the browser.
- **Credentials are references, never values.** The model names a secret; the value is
  resolved at replay time and redacted at every write boundary. A calling agent cannot pass
  one — the tool definition omits sensitive inputs, and `invoke()` refuses them anyway.
- **Irreversible steps require approval on every replay**, and the default approval hook
  declines, so an unattended agent escalates rather than authorising its own action.
- **Page text is untrusted data.** It is framed as such to the model, and the action
  vocabulary bounds what a successful injection could ask for.

The limits of all of this — including what the risk heuristic misses and why human review
at promotion is the real control — are in [REPORT.md](REPORT.md) §6.
