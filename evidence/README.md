# Evidence

One directory per run, named by run id. Each holds `run.jsonl` (the event log, redacted at
the write boundary), plus whatever that run produced: `discovery.json`, `artifact.json`,
`result.json`, `steps/*.png`, and on failure `failure.html` / `failure.aria.yaml`.

## The end-to-end demonstration

Four files, in the order the system actually works. Everything else on this page is
supporting material.

| # | What | Where |
|---|---|---|
| 1 | **The saved artifact** — what discovery compiled, typed and replayable | [`runs/b459913e…/artifact.json`](runs/b459913e-c2bd-4656-a026-c99bdf1f6332/artifact.json) (shipped as [`capabilities/parabank.open-savings-account.json`](../capabilities/parabank.open-savings-account.json)) |
| 2 | **A discovery run** — Opus 5 driving the browser, 6 actions, 2 outcomes | [`runs/b459913e…/`](runs/b459913e-c2bd-4656-a026-c99bdf1f6332/) — `run.jsonl`, `discovery.json`, `steps/*.png` |
| 3 | **A replay run** — same artifact, no model in the loop, real account opened | [`runs/9b9b3d06…/`](runs/9b9b3d06-ec91-48a9-8f1e-3ce55d15b1ef/) — `result.json` reports `newAccountNumber: 13677` |
| 4 | **A replay hitting an exceptional state** — wrong credentials | [`runs/9367801d…/`](runs/9367801d-6633-474d-a091-e04364326751/) — `LOGIN_REJECTED` in 1.4s, exit 0 |

On (4): the bank saying no is a **result, not a crash**. The artifact declares
`LOGIN_REJECTED` as a business outcome with a detector, so replay recognises it at
`step.submit-the-login-form`, stops, and reports it as structured data with an exit code of
0. Three further failure modes are recorded below: an *undeclared* version of that same
rejection (`124db8ff`), a refused irreversible step (`e03d6faa`), and a discovery run that
escalated rather than guess (`d5e0348e`).

## Every run kept here, and why

| Run | What it shows |
|---|---|
| `b459913e` | **The discovery run.** Opus 5, 6 actions, 2 outcomes, finished cleanly. This is the run `capabilities/parabank.open-savings-account.json` was compiled from. |
| `9b9b3d06` | **A successful replay.** Same artifact, no model in the loop. All six steps resolved on their *primary* locator strategy — no drift — and it read back a real new account number. |
| `9367801d` | **A replay reaching an exceptional state.** Wrong credentials. `LOGIN_REJECTED` in 1.4s, exit code 0: the bank said no, which is a result. |
| `124db8ff` | **The same case before the detector was corrected**, kept because the artifact's `provenance.humanEdits` cites it. Discovery took the happy path and never saw a failed login, so the model *inferred* the wording. It guessed wrong, and a legitimate rejection escalated to a human as `CHECKPOINT_FAILED` after 16s. This pair is the clearest evidence in the repo for why declared outcomes matter — and for why an inferred one is flagged at record time. |
| `d5e0348e` | **A discovery run that escalated rather than guessing.** The Open New Account form needed a funding account; the default had a negative balance, and opening the account is irreversible. The model stopped and asked instead of picking one. Designed behaviour, caught in the wild. |
| `e03d6faa` | **The approval gate stopping an irreversible step, live.** Real ParaBank, logged in, all three login steps on their primary locators — then `--approve deny` refused "go to the Open New Account form" and the run exited 2 with the full failure bundle. Run this way on purpose: re-verifying the happy path would open another real account on somebody's public demo. |
| `e1bab268` | **The offline replay.** The same artifact, unedited, against captured HTML on `127.0.0.1` — `LOGIN_REJECTED` in 1.4s, exit 0, with per-step before/after screenshots. Every locator resolved on its **primary** strategy against a different origin, which is the artifact's portability measured rather than asserted. |
| `1b69c2c7` | **The capability invoked by an agent.** `npm run agent-demo` asked in plain English for a savings account; the model was given the catalog and nothing else — no browser, no page text, no knowledge that ParaBank exists — chose the capability, and on the business outcome answered "this isn't something I can retry". |
| `b48d442e` | **Sonnet 5 on the same goal**, for comparison: 0 business outcomes, the account number extracted from the account-type dropdown, the username hardcoded as a literal. |

## Redaction

No credential appears in any of these. That is checked, not assumed — the password,
username and API key values are grepped for across every tracked file before a commit.
(The demo password is an English word, so the scan is read with that in mind; the positive
check is that the run logs contain `«redacted»` where a secret was resolved.)

Playwright traces are the exception and are **not** kept here. A trace is written by
Playwright directly and never passes through the redactor — it contains request bodies and
typed values in clear text, which was measured against a real login. Tracing is opt-in
(`--trace`) and `trace.zip` is gitignored.

### A repair, recorded rather than hidden

The three `artifact.json` files here were written by a logger that scrubbed **serialised
JSON as text**. The card-number pattern matches any run of 13–19 digits, so the mantissa of
an ordinary float was redacted: a step `confidence` of `0.8500000000000001` was written as
`0.«redacted»`, which is not JSON at all. The writer now redacts the *structure* and then
serialises (`FileRunLogger.writeJson`, covered by `tests/evidence-json.test.ts`), and the
three recorded files were repaired in place:

| Run | Sites | Restored to | Basis |
|---|---|---|---|
| `b459913e` | 4 | `0.8500000000000001` | **Exact.** The shipped capability compiled from this run retains the values; all 7 confidence sites align 1:1 in document order. |
| `b48d442e` | 4 | `0.85` | **Approximate — this digit string was not recovered from any record.** No intact copy of this run's artifact survives. |
| `d5e0348e` | 3 | `0.85` | **Approximate — same caveat.** |

Only the redacted numeric literals were touched; nothing else in those files was edited.
