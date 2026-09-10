import { describe, expect, it } from 'vitest';
import { replay, EnvSecretResolver, type ReplayOptions } from '../src/replay/engine.js';
import { detectOutcome } from '../src/replay/outcomes.js';
import { Redactor } from '../src/policy/redact.js';
import { MemoryLogger } from '../src/evidence/types.js';
import { OutcomeSpecSchema } from '../src/artifact/schema.js';
import { node } from './helpers/observation.js';
import { capability, css, policy } from './helpers/capability.js';
import { FakeSurface, fakeClock, page } from './helpers/fake-surface.js';
import type { ResolvedCapability } from '../src/artifact/store.js';

const BASE = 'https://parabank.parasoft.com';

function harness(
  cap: ResolvedCapability,
  surface: FakeSurface,
  extra: Partial<ReplayOptions> = {},
) {
  const clock = fakeClock();
  const logger = new MemoryLogger();
  const options: ReplayOptions = {
    capability: cap,
    surface,
    policy: policy(),
    redactor: new Redactor(policy()),
    baseUrl: BASE,
    clock,
    logger,
    pollMs: 100,
    ...extra,
  };
  return { clock, logger, result: replay(options) };
}

// ---------------------------------------------------------------------------
// The headline behaviour: a declared business outcome beats the checkpoint timeout
// ---------------------------------------------------------------------------

const SUBMIT_BUTTON = node({
  role: 'button',
  name: 'Open New Account',
  cssPath: "input[value='Open New Account']",
});

const FORM_PAGE = page({
  url: `${BASE}/parabank/openaccount.htm`,
  text: 'Open New Account form',
  nodes: [SUBMIT_BUTTON],
});

const REFUSAL_PAGE = page({
  url: `${BASE}/parabank/openaccount.htm`,
  text: 'The funding account has insufficient funds for the minimum deposit.',
  nodes: [],
});

const SUBMIT_STEP = {
  id: 'step.submit',
  index: 0,
  intent: 'submit the request to open the account',
  action: { type: 'click' },
  locator: css("input[value='Open New Account']", 'Open New Account submit button'),
  checkpoint: { kind: 'textPresent', text: 'Account Opened!' },
  timeoutMs: 15_000,
};

const REFUSED_OUTCOME = {
  name: 'ACCOUNT_OPEN_REFUSED',
  description: 'ParaBank declined to open the account.',
  detect: { kind: 'textPresent', text: 'insufficient funds' },
  terminal: true,
};

function refusalSurface() {
  return new FakeSurface({
    start: FORM_PAGE,
    onAct: (action, surface) => {
      if (action.type === 'click') surface.current = REFUSAL_PAGE;
    },
  });
}

describe('outcome detectors take precedence over the checkpoint timeout', () => {
  it('returns a business outcome immediately rather than waiting the checkpoint out', async () => {
    const surface = refusalSurface();
    const { clock, result } = harness(
      capability({
        steps: [SUBMIT_STEP],
        outcomes: [REFUSED_OUTCOME],
        postcondition: { kind: 'textPresent', text: 'Account Opened!' },
      }),
      surface,
    );

    const replayed = await result;

    expect(replayed.kind).toBe('business_outcome');
    if (replayed.kind !== 'business_outcome') return;
    expect(replayed.outcome.name).toBe('ACCOUNT_OPEN_REFUSED');
    expect(replayed.atStepId).toBe('step.submit');
    // The point of the whole exercise: the answer arrives without burning the 15s
    // checkpoint timeout, because the detector is consulted before the checkpoint on
    // every observation.
    expect(clock.elapsed()).toBeLessThan(SUBMIT_STEP.timeoutMs);
    expect(clock.elapsed()).toBe(0);
  });

  it('is the *declaration* that makes the difference — the identical page fails without it', async () => {
    const surface = refusalSurface();
    const { clock, result } = harness(
      capability({
        // Same steps, same page, no declared outcome.
        steps: [SUBMIT_STEP],
        outcomes: [],
        postcondition: { kind: 'textPresent', text: 'Account Opened!' },
      }),
      surface,
    );

    const replayed = await result;

    expect(replayed.kind).toBe('escalated');
    if (replayed.kind !== 'escalated') return;
    expect(replayed.errorClass).toBe('CHECKPOINT_FAILED');
    // And it costs the full timeout, which is exactly the waste the declaration removes.
    expect(clock.elapsed()).toBeGreaterThanOrEqual(SUBMIT_STEP.timeoutMs);
  });

  it('a non-terminal outcome is recorded and the flow carries on', async () => {
    const surface = new FakeSurface({
      start: FORM_PAGE,
      onAct: (action, surface) => {
        if (action.type === 'click') {
          surface.current = page({
            url: `${BASE}/parabank/openaccount.htm`,
            text: 'Notice: a paper statement fee applies. Account Opened! Done',
          });
        }
      },
    });
    const { logger, result } = harness(
      capability({
        steps: [SUBMIT_STEP],
        outcomes: [
          {
            name: 'FEE_NOTICE',
            description: 'An advisory notice was shown alongside the result.',
            detect: { kind: 'textPresent', text: 'paper statement fee' },
            terminal: false,
          },
        ],
        postcondition: { kind: 'textPresent', text: 'Account Opened!' },
      }),
      surface,
    );

    const replayed = await result;
    expect(replayed.kind).toBe('success');
    expect(logger.phases('outcome.detected').map((e) => e.outcome)).toContain('FEE_NOTICE');
  });

  it('declaration order is precedence order', async () => {
    const specific = OutcomeSpecSchema.parse({
      name: 'INSUFFICIENT_FUNDS',
      description: 'The funding account cannot cover the minimum deposit.',
      detect: { kind: 'textPresent', text: 'insufficient funds' },
    });
    const generic = OutcomeSpecSchema.parse({
      name: 'GENERIC_ERROR',
      description: 'Something went wrong.',
      detect: { kind: 'textPresent', text: 'funds' },
    });

    expect((await detectOutcome([specific, generic], REFUSAL_PAGE))?.name).toBe(
      'INSUFFICIENT_FUNDS',
    );
    expect((await detectOutcome([generic, specific], REFUSAL_PAGE))?.name).toBe('GENERIC_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Never assume an action worked
// ---------------------------------------------------------------------------

describe('checkpoints', () => {
  it('a click that resolved and did not throw is still not success', async () => {
    const surface = new FakeSurface({ start: FORM_PAGE }); // the page never changes
    const { result } = harness(
      capability({ steps: [SUBMIT_STEP], postcondition: { kind: 'textPresent', text: 'Account Opened!' } }),
      surface,
    );

    const replayed = await result;
    expect(surface.acted).toHaveLength(1); // the click happened
    expect(replayed.kind).toBe('escalated'); // and proved nothing
  });

  it('reports the capability postcondition failing as structural divergence', async () => {
    const surface = new FakeSurface({
      start: FORM_PAGE,
      onAct: (action, surface) => {
        if (action.type === 'click') {
          // Every step checkpoint passes...
          surface.current = page({ url: `${BASE}/parabank/x.htm`, text: 'Account Opened!' });
        }
      },
    });
    const { result } = harness(
      capability({
        steps: [SUBMIT_STEP],
        // ...but the capability promised something else entirely.
        postcondition: { kind: 'textPresent', text: 'New account number' },
      }),
      surface,
    );

    const replayed = await result;
    expect(replayed.kind).toBe('escalated');
    if (replayed.kind !== 'escalated') return;
    expect(replayed.errorClass).toBe('STRUCTURAL_DIVERGENCE');
  });
});

// ---------------------------------------------------------------------------
// Tier one: declared recovery
// ---------------------------------------------------------------------------

describe('recovery specs', () => {
  const LOGIN_PAGE = page({
    url: `${BASE}/parabank/index.htm`,
    text: 'Customer Login',
    nodes: [node({ role: 'button', name: 'Log In', cssPath: "input[value='Log In']" })],
  });

  it('fires on the declared error class, re-runs the step, and marks it recovered', async () => {
    // The flow starts on a page that has no Log In button at all.
    const surface = new FakeSurface({
      start: page({ url: `${BASE}/parabank/expired.htm`, text: 'Your session has ended.' }),
      onAct: (action, surface) => {
        if (action.type === 'navigate') surface.current = LOGIN_PAGE;
        if (action.type === 'click') {
          surface.current = page({ url: `${BASE}/parabank/overview.htm`, text: 'Accounts Overview Done' });
        }
      },
    });

    const { logger, result } = harness(
      capability({
        steps: [
          {
            id: 'step.submit-login',
            index: 0,
            intent: 'submit the login form',
            action: { type: 'click' },
            locator: css("input[value='Log In']", 'Log In submit button'),
            checkpoint: { kind: 'textPresent', text: 'Accounts Overview' },
            onError: [
              {
                when: 'LOCATOR_NOT_FOUND',
                description: 'reload the entry point and retry once',
                do: [{ action: { type: 'navigate', url: '/parabank/index.htm' } }],
                thenRetry: true,
                maxAttempts: 1,
              },
            ],
          },
        ],
        postcondition: { kind: 'textPresent', text: 'Accounts Overview' },
      }),
      surface,
    );

    const replayed = await result;
    expect(replayed.kind).toBe('success');
    expect(replayed.steps[0]?.status).toBe('recovered');
    expect(replayed.steps[0]?.attempts).toBe(2);
    expect(logger.phases('step.recover')).toHaveLength(1);
  });

  it('escalates instead of retrying forever once the recovery attempts are used up', async () => {
    const surface = new FakeSurface({
      start: page({ url: `${BASE}/parabank/expired.htm`, text: 'Your session has ended.' }),
      // Navigation never actually fixes anything, so the retry finds the same empty page.
    });

    const { result } = harness(
      capability({
        steps: [
          {
            id: 'step.submit-login',
            index: 0,
            intent: 'submit the login form',
            action: { type: 'click' },
            locator: css("input[value='Log In']", 'Log In submit button'),
            onError: [
              {
                when: 'LOCATOR_NOT_FOUND',
                description: 'reload and retry once',
                do: [{ action: { type: 'navigate', url: '/parabank/index.htm' } }],
                thenRetry: true,
                maxAttempts: 1,
              },
            ],
          },
        ],
      }),
      surface,
    );

    const replayed = await result;
    expect(replayed.kind).toBe('escalated');
    if (replayed.kind !== 'escalated') return;
    expect(replayed.errorClass).toBe('LOCATOR_NOT_FOUND');
    expect(replayed.steps[0]?.attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tier three: budgets and the escalate/fail split
// ---------------------------------------------------------------------------

describe('budgets', () => {
  it('terminates the run when the step budget is exhausted', async () => {
    const walk = (i: number) => ({
      id: `step.walk-${i}`,
      index: i,
      intent: `walk ${i}`,
      action: { type: 'wait' },
    });
    const surface = new FakeSurface({ start: page({ text: 'Done' }) });

    const { result } = harness(
      capability({ steps: [walk(0), walk(1), walk(2)] }),
      surface,
      { policy: policy({ maxStepsPerReplay: 2 }) },
    );

    const replayed = await result;
    expect(replayed.kind).toBe('failed');
    if (replayed.kind !== 'failed') return;
    expect(replayed.errorClass).toBe('TIMEOUT');
    expect(replayed.error.context.budget).toBe('steps');
    expect(replayed.steps).toHaveLength(2);
  });

  it('fails rather than escalating when the chokepoint refuses the action', async () => {
    const denied = Object.assign(new Error('origin "https://evil.tld" is not in the allowlist'), {
      name: 'PolicyDeniedError',
      rule: 'origin.allowlist',
    });
    const surface = new FakeSurface({
      start: FORM_PAGE,
      actThrows: () => denied,
    });

    const { result } = harness(capability({ steps: [SUBMIT_STEP] }), surface);

    const replayed = await result;
    // A human staring at a browser cannot fix a policy decision, so this is a hard failure
    // rather than an intervention request.
    expect(replayed.kind).toBe('failed');
    if (replayed.kind !== 'failed') return;
    expect(replayed.errorClass).toBe('NAVIGATION_BLOCKED');
  });

  it('refuses to execute a relative navigation with nothing to resolve it against', async () => {
    const surface = new FakeSurface({ start: page({ text: 'Customer Login' }) });
    const { result } = harness(
      capability({
        steps: [
          {
            id: 'step.open-entry-point',
            index: 0,
            intent: 'load the home page',
            action: { type: 'navigate', url: '/parabank/index.htm' },
          },
        ],
      }),
      surface,
      { baseUrl: undefined },
    );

    const replayed = await result;
    expect(replayed.kind).toBe('failed');
    if (replayed.kind !== 'failed') return;
    expect(replayed.errorClass).toBe('NAVIGATION_BLOCKED');
    expect(surface.acted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Irreversible steps
// ---------------------------------------------------------------------------

describe('irreversible steps', () => {
  const IRREVERSIBLE = { ...SUBMIT_STEP, risk: 'irreversible' };

  const cap = () =>
    capability({
      steps: [IRREVERSIBLE],
      riskClass: 'irreversible',
      requiresApproval: true,
      postcondition: { kind: 'textPresent', text: 'Account Opened!' },
    });

  it('escalates without acting when no approver is attached', async () => {
    const surface = refusalSurface();
    const { result } = harness(cap(), surface);

    const replayed = await result;
    expect(replayed.kind).toBe('escalated');
    if (replayed.kind !== 'escalated') return;
    expect(replayed.reason).toBe('approval_required');
    // The load-bearing assertion: the irreversible action never happened.
    expect(surface.acted).toHaveLength(0);
  });

  it('proceeds once approval is given', async () => {
    const surface = new FakeSurface({
      start: FORM_PAGE,
      onAct: (action, surface) => {
        if (action.type === 'click') {
          surface.current = page({ url: `${BASE}/parabank/x.htm`, text: 'Account Opened!' });
        }
      },
    });
    const { result } = harness(cap(), surface, { approve: () => true });

    const replayed = await result;
    expect(replayed.kind).toBe('success');
    expect(surface.acted).toHaveLength(1);
  });

  it('never re-runs a step a human already completed during an intervention', async () => {
    const surface = new FakeSurface({
      start: page({ url: `${BASE}/parabank/x.htm`, text: 'Account Opened!' }),
    });
    // No approver, and the step is irreversible — so if resume re-ran it, this would
    // escalate. It must instead recognise the step as done and advance.
    const { result } = harness(cap(), surface, { completedSteps: ['step.submit'] });

    const replayed = await result;
    expect(replayed.kind).toBe('success');
    expect(replayed.steps[0]?.status).toBe('completed_by_human');
    expect(surface.acted).toHaveLength(0);
  });

  it('reports an unrecognised resume target rather than guessing where to restart', async () => {
    const surface = new FakeSurface({ start: FORM_PAGE });
    const { result } = harness(cap(), surface, { startAtStepId: 'step.no-longer-exists' });

    const replayed = await result;
    expect(replayed.kind).toBe('failed');
    if (replayed.kind !== 'failed') return;
    expect(replayed.errorClass).toBe('RESUME_STATE_UNRECOGNIZED');
  });
});

// ---------------------------------------------------------------------------
// Locator telemetry, values and redaction
// ---------------------------------------------------------------------------

describe('values, telemetry and redaction', () => {
  it('records which strategy resolved, and flags a fallback as degraded', async () => {
    const surface = new FakeSurface({
      start: FORM_PAGE,
      onAct: (action, surface) => {
        if (action.type === 'click') {
          surface.current = page({ url: `${BASE}/parabank/x.htm`, text: 'Account Opened!' });
        }
      },
    });

    const { logger, result } = harness(
      capability({
        steps: [
          {
            ...SUBMIT_STEP,
            locator: {
              // The preferred strategy no longer matches — the app was restyled.
              primary: { kind: 'role', role: 'button', name: 'Open Account' },
              fallbacks: [{ kind: 'css', selector: "input[value='Open New Account']" }],
              description: 'Open New Account submit button',
              rationale: 'test fixture',
              confidence: 0.9,
            },
          },
        ],
        postcondition: { kind: 'textPresent', text: 'Account Opened!' },
      }),
      surface,
    );

    const replayed = await result;
    expect(replayed.kind).toBe('success');
    expect(replayed.steps[0]?.degraded).toBe(true);
    expect(replayed.steps[0]?.strategy).toContain('css');
    // Logged on the success path, because nothing is failing yet — that is precisely what
    // makes it an early warning rather than a post-mortem.
    const resolved = logger.phases('step.resolve')[0];
    expect(resolved?.degraded).toBe(true);
    expect(resolved?.fallbackIndex).toBe(0);
  });

  it('resolves a secretRef at replay time and redacts it out of the results', async () => {
    const secretEcho = node({
      role: 'textbox',
      name: 'echo',
      value: 'hunter2',
      cssPath: 'input#echo',
    });
    const surface = new FakeSurface({
      start: page({
        url: `${BASE}/parabank/index.htm`,
        text: 'Customer Login Done',
        nodes: [node({ role: 'textbox', name: 'Password', cssPath: "input[name='password']" }), secretEcho],
      }),
    });

    const { result } = harness(
      capability({
        outputs: { echo: { type: 'string', description: 'whatever the page echoed back' } },
        steps: [
          {
            id: 'step.enter-password',
            index: 0,
            intent: 'enter the service account password',
            action: { type: 'fill', value: { secretRef: 'PARABANK_PASSWORD' } },
            locator: css("input[name='password']", 'Password field'),
            extract: [{ name: 'echo', from: css('input#echo', 'echoed value'), as: 'string' }],
          },
        ],
        postcondition: { kind: 'textPresent', text: 'Done' },
      }),
      surface,
      { secrets: new EnvSecretResolver({}, { PARABANK_PASSWORD: 'hunter2' }) },
    );

    const replayed = await result;
    expect(replayed.kind).toBe('success');
    // The value reached the page...
    expect(surface.acted[0]).toMatchObject({ type: 'fill', value: 'hunter2', sensitive: true });
    // ...and did not survive the write boundary on the way back out.
    expect(replayed.outputs.echo).not.toBe('hunter2');
    expect(JSON.stringify(replayed.outputs)).not.toContain('hunter2');
  });

  it('substitutes a declared input by reference', async () => {
    const surface = new FakeSurface({
      start: page({
        url: `${BASE}/parabank/openaccount.htm`,
        text: 'Open New Account Done',
        nodes: [node({ role: 'combobox', name: '', cssPath: 'select#type' })],
      }),
    });

    const { result } = harness(
      capability({
        inputs: {
          accountType: {
            type: 'enum',
            enum: ['CHECKING', 'SAVINGS'],
            description: 'The kind of account to open.',
          },
        },
        steps: [
          {
            id: 'step.choose-account-type',
            index: 0,
            intent: 'choose the type of account to open',
            action: { type: 'select', value: { valueFrom: '$.inputs.accountType' } },
            locator: css('select#type', 'Account type dropdown'),
          },
        ],
        postcondition: { kind: 'textPresent', text: 'Done' },
      }),
      surface,
      { inputs: { accountType: 'SAVINGS' } },
    );

    await result;
    expect(surface.acted[0]).toMatchObject({ type: 'select', value: 'SAVINGS', sensitive: false });
  });

  it('fails a step whose value reference has nothing behind it', async () => {
    const surface = new FakeSurface({
      start: page({
        url: `${BASE}/parabank/openaccount.htm`,
        text: 'Open New Account',
        nodes: [node({ role: 'combobox', name: '', cssPath: 'select#type' })],
      }),
    });

    const { result } = harness(
      capability({
        inputs: {
          accountType: {
            type: 'enum',
            enum: ['CHECKING', 'SAVINGS'],
            description: 'The kind of account to open.',
          },
        },
        steps: [
          {
            id: 'step.choose-account-type',
            index: 0,
            intent: 'choose the type of account to open',
            action: { type: 'select', value: { valueFrom: '$.inputs.accountType' } },
            locator: css('select#type', 'Account type dropdown'),
          },
        ],
      }),
      surface,
      { inputs: {} },
    );

    const replayed = await result;
    expect(replayed.kind).toBe('failed');
    expect(surface.acted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The run log
// ---------------------------------------------------------------------------

describe('the run log', () => {
  it('records the phases an auditor needs to reconstruct the run', async () => {
    const surface = new FakeSurface({
      start: FORM_PAGE,
      onAct: (action, surface) => {
        if (action.type === 'click') {
          surface.current = page({ url: `${BASE}/parabank/x.htm`, text: 'Account Opened!' });
        }
      },
    });

    const { logger, result } = harness(
      capability({
        steps: [SUBMIT_STEP],
        postcondition: { kind: 'textPresent', text: 'Account Opened!' },
      }),
      surface,
    );
    await result;

    const phases = logger.events.map((e) => e.phase);
    expect(phases).toContain('run.start');
    expect(phases).toContain('step.resolve');
    expect(phases).toContain('step.act');
    expect(phases).toContain('step.checkpoint');
    expect(phases).toContain('run.end');
    expect(logger.events.every((e) => e.runId && e.ts)).toBe(true);
  });
});
