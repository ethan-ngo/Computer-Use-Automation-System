# Evidence

One directory per run, named by run id. Each holds `run.jsonl` (the event log, redacted at
the write boundary), plus whatever that run produced: `discovery.json`, `artifact.json`,
`result.json`, `steps/*.png`, and on failure `failure.html` / `failure.aria.yaml`.

No credential appears in any of these. That is checked, not assumed — the password,
username and API key are grepped for across this directory before every commit.

## The runs kept here, and why

| Run | What it shows |
|---|---|
| `b459913e` | **The discovery run.** Opus 5, 6 actions, 2 outcomes, finished cleanly. This is the run `capabilities/parabank.open-savings-account.json` was compiled from. |
| `9b9b3d06` | **A successful replay.** Same artifact, no model in the loop. All six steps resolved on their *primary* locator strategy — no drift — and it read back a real new account number. |
| `9367801d` | **A replay reaching an exceptional state.** Wrong credentials. `LOGIN_REJECTED` in 1.4s, exit code 0: the bank said no, which is a result. |
| `124db8ff` | **The same case before the detector was corrected**, kept because the artifact's `provenance.humanEdits` cites it. Discovery took the happy path and never saw a failed login, so the model *inferred* the wording. It guessed wrong, and a legitimate rejection escalated to a human as `CHECKPOINT_FAILED` after 16s. This pair is the clearest evidence in the repo for why declared outcomes matter — and for why an inferred one is flagged at record time. |
| `d5e0348e` | **A discovery run that escalated rather than guessing.** The Open New Account form needed a funding account; the default had a negative balance, and opening the account is irreversible. The model stopped and asked instead of picking one. Designed behaviour, caught in the wild. |
| `b48d442e` | **Sonnet 5 on the same goal**, for comparison: 0 business outcomes, the account number extracted from the account-type dropdown, the username hardcoded as a literal. |
