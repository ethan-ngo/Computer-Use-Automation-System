/**
 * The offline integration replay.
 *
 * This is the "how do I run this with no live services" path, and it is an integration test
 * rather than a script because the claim it makes is falsifiable: **the artifact recorded
 * against the live bank replays, unedited, against captured HTML on a different origin.**
 * Not a re-recorded fixture variant, not a stubbed surface — the committed
 * `capabilities/parabank.open-savings-account.json`, a real browser, and real captured
 * pages served from `127.0.0.1`.
 *
 * It replays to the *exceptional* state on purpose. ParaBank's authenticated pages populate
 * themselves over AJAX and submit through JavaScript, so a scripts-stripped capture cannot
 * complete the happy path — that limit is documented in README.md and is a property of the
 * app, not of the design. The login leg is a plain server-rendered form POST, which means
 * the offline path can still demonstrate the behaviour that matters most:
 *
 *   a declared business outcome returns in milliseconds as a RESULT,
 *   instead of grinding out a checkpoint timeout and paging a human.
 *
 * The same run against the same fixtures *without* the outcome declared is the contrast
 * pair, and it escalates. That pair is the whole argument for declaring outcomes in the
 * contract, reproduced offline on a reviewer's laptop in about a second.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createFixtureApp } from '../src/cli/serve-fixtures.js';
import { PlaywrightWebSurface } from '../src/surface/playwright-web.js';
import { LeaseManager } from '../src/escalation/lease.js';
import { loadPolicy } from '../src/policy/policy.js';
import { Redactor } from '../src/policy/redact.js';
import { MemoryLogger } from '../src/evidence/types.js';
import { loadResolved } from '../src/artifact/store.js';
import { replay, type SecretResolver } from '../src/replay/engine.js';
import { NO_CAPTURE } from '../src/evidence/capture.js';

/**
 * The world the artifact is replayed into: a login that ParaBank refuses.
 *
 * `login-rejected.htm` is not a hand-written mock. It is the page the live bank actually
 * served on a wrong password, captured during the run kept in
 * `evidence/runs/124db8ff…` — ParaBank reports a rejected login as a generic internal
 * error, which is exactly why the artifact's detector matches that wording.
 */
const REJECTING = { 'POST /parabank/login.htm': 'login-rejected.htm' };

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = await createFixtureApp(REJECTING);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Credentials never come from the environment here: the point is that both are wrong. */
const WRONG_CREDENTIALS: SecretResolver = {
  resolve: (ref) => (ref === 'PARABANK_USERNAME' ? 'not-a-customer' : 'not-the-password'),
};

async function run(options: { declareOutcomes: boolean }) {
  const policy = loadPolicy();
  const redactor = new Redactor(policy);
  const logger = new MemoryLogger();
  const capability = await loadResolved('parabank.open-savings-account');

  // The only thing the contrast pair changes: whether the capability admits that this
  // state exists. Everything else — pages, locators, timeouts, code — is identical.
  const under = options.declareOutcomes
    ? capability
    : { ...capability, outcomes: [], artifact: { ...capability.artifact, outcomes: [] } };

  const surface = await PlaywrightWebSurface.launch({
    policy,
    redactor,
    leases: new LeaseManager(),
    extraOrigins: [baseUrl],
    headless: true,
  });

  try {
    await surface.act({
      type: 'navigate',
      url: new URL(capability.artifact.target.entryPoint, baseUrl).toString(),
    });
    const started = Date.now();
    const result = await replay({
      capability: under,
      surface,
      policy,
      redactor,
      baseUrl,
      logger,
      secrets: WRONG_CREDENTIALS,
      capture: NO_CAPTURE,
      // Deny rather than prompt: nothing in this test should be able to reach an
      // irreversible step, and if it ever does the test must fail rather than hang.
      approve: () => false,
    });
    return { result, logger, elapsed: Date.now() - started };
  } finally {
    await surface.close();
  }
}

describe('offline replay against captured fixtures', () => {
  it(
    'replays the recorded artifact, unedited, and returns its declared business outcome',
    async () => {
      const { result, logger, elapsed } = await run({ declareOutcomes: true });

      expect(result.kind).toBe('business_outcome');
      if (result.kind !== 'business_outcome') return;
      expect(result.outcome.name).toBe('LOGIN_REJECTED');
      expect(result.atStepId).toBe('step.submit-the-login-form');

      // The point of declaring it: the bank's "no" arrives as a result, long before the
      // 15s checkpoint on that step could have timed out.
      expect(elapsed).toBeLessThan(10_000);

      // Nothing irreversible was reached — the flow terminated at the login.
      expect(result.steps.some((s) => s.id === 'step.go-to-the-open-new-account-form')).toBe(false);

      // The locators recorded against the live bank resolved against captured HTML on a
      // different origin. That is the artifact being portable, which is the whole claim.
      const resolved = logger.phases('step.resolve');
      expect(resolved).toHaveLength(3);
      expect(resolved.every((e) => e.degraded === false)).toBe(true);
    },
    60_000,
  );

  it(
    'the contrast pair: the same pages, the same run, undeclared — and it escalates',
    async () => {
      const { result } = await run({ declareOutcomes: false });

      // Identical application behaviour. The only difference is that the capability never
      // said this state was possible, so a legitimate refusal becomes a page-a-human event.
      expect(result.kind).toBe('escalated');
      if (result.kind !== 'escalated') return;
      expect(result.errorClass).toBe('CHECKPOINT_FAILED');
      expect(result.atStepId).toBe('step.submit-the-login-form');
    },
    60_000,
  );
});
