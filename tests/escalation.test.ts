/**
 * Escalation and handoff tests.
 *
 * The headline is the last block: force a failure, confirm automation is *incapable* of
 * acting while a human holds the session, let the human finish the step, resume, and
 * confirm the engine detects the satisfied checkpoint and **advances rather than
 * repeating**. Repeating is the failure that opens a second account.
 */

import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import {
  InterventionBroker,
  issueResumeToken,
  recogniseResumeState,
  ResumeRejected,
  verifyResumeToken,
  type ResumeContext,
} from '../src/escalation/broker.js';
import { recordHumanSession } from '../src/escalation/human-recorder.js';
import { LeaseConflictError, LeaseManager } from '../src/escalation/lease.js';
import { PlaywrightWebSurface } from '../src/surface/playwright-web.js';
import { LeaseDeniedError } from '../src/surface/types.js';
import { ReplayEngine } from '../src/replay/engine.js';
import { loadPolicy } from '../src/policy/policy.js';
import { Redactor } from '../src/policy/redact.js';
import { MemoryLogger } from '../src/evidence/types.js';
import { parseArtifact } from '../src/artifact/store.js';
import { capability } from './helpers/capability.js';
import { FakeSurface, page, fakeClock } from './helpers/fake-surface.js';
import { node } from './helpers/observation.js';
import type { Step } from '../src/artifact/schema.js';

const policy = loadPolicy();
const redactor = () => new Redactor(policy);

function ctx(patch: Partial<ResumeContext> = {}): ResumeContext {
  const artifact = parseArtifact({
    schemaVersion: '1.0',
    id: 'parabank.test-flow',
    version: '1.0.0',
    name: 'Test flow',
    description: 'A capability built for a unit test.',
    target: { app: 'parabank', surfaceKind: 'legacy-web', entryPoint: '/parabank/index.htm' },
    steps: [{ id: 'step.one', index: 0, intent: 'do the thing', action: { type: 'click' }, locator: loc() }],
    postcondition: { kind: 'textPresent', text: 'Done' },
    policy: { riskClass: 'safe', requiresApproval: false, allowedDomains: ['parabank.parasoft.com'] },
    provenance: {
      discoveredAt: '2026-01-01T00:00:00Z',
      model: 'test',
      runId: 'r',
      evidenceRef: 'n/a',
    },
  });
  return {
    runId: 'run-1',
    lease: new LeaseManager('11111111-1111-4111-8111-111111111111').current,
    artifact,
    steps: artifact.steps,
    ...patch,
  };
}

function loc() {
  return {
    primary: { kind: 'role', role: 'button', name: 'Go' },
    fallbacks: [],
    description: 'the Go button',
    rationale: 'test',
    confidence: 1,
  };
}

function tokenFor(c: ResumeContext) {
  return issueResumeToken({
    runId: c.runId,
    sessionId: c.lease.sessionId,
    stepId: 'step.one',
    artifactId: c.artifact.id,
    artifactVersion: c.artifact.version,
    leaseEpoch: c.lease.epoch,
  });
}

// ---------------------------------------------------------------------------

describe('the resume token', () => {
  it('accepts a token that still describes the world', () => {
    const c = ctx();
    expect(verifyResumeToken(tokenFor(c), c).id).toBe('step.one');
  });

  it('rejects a token issued before control changed hands again', () => {
    // The case this exists for: a second operator grabbed the session between the first
    // one releasing it and the automation picking it up.
    const leases = new LeaseManager('11111111-1111-4111-8111-111111111111');
    const c = ctx({ lease: leases.current });
    const token = tokenFor(c);
    leases.cedeToHuman('someone else stepped in');

    expect(() => verifyResumeToken(token, { ...c, lease: leases.current })).toThrow(ResumeRejected);
    try {
      verifyResumeToken(token, { ...c, lease: leases.current });
    } catch (error) {
      expect((error as ResumeRejected).why).toBe('stale_epoch');
    }
  });

  it('rejects a token whose artifact was edited during the intervention', () => {
    const c = ctx();
    const token = tokenFor(c);
    const edited = { ...c, artifact: { ...c.artifact, version: '1.0.1' } };

    try {
      verifyResumeToken(token, edited);
      expect.unreachable('should have rejected');
    } catch (error) {
      expect((error as ResumeRejected).why).toBe('artifact_changed');
    }
  });

  it('rejects a token from another session, and a hand-edited one', () => {
    const c = ctx();
    const token = tokenFor(c);

    const otherSession = { ...c, lease: { ...c.lease, sessionId: '22222222-2222-4222-8222-222222222222' } };
    expect(() => verifyResumeToken(token, otherSession)).toThrow(/wrong_session|session/);

    // Bumping the step in the token without re-signing must not get past the signature.
    const tampered = { ...token, stepId: 'step.two' };
    try {
      verifyResumeToken(tampered, c);
      expect.unreachable('should have rejected');
    } catch (error) {
      expect((error as ResumeRejected).why).toBe('signature');
    }
  });
});

// ---------------------------------------------------------------------------

describe('recognising where the flow is after a handoff', () => {
  const step = (patch: Partial<Step> = {}): Step =>
    ({
      id: 'step.submit',
      index: 0,
      intent: 'submit the application',
      action: { type: 'click' },
      locator: loc(),
      extract: [],
      onError: [],
      risk: 'safe',
      timeoutMs: 1000,
      ...patch,
    }) as Step;

  const surfaceShowing = (text: string) =>
    new FakeSurface({ start: page({ text, nodes: [node({ role: 'button', name: 'Go' })] }) });

  it('advances when the checkpoint the operator was asked to satisfy now holds', async () => {
    const s = surfaceShowing('Application received. Reference 4471.');
    const state = await recogniseResumeState(
      step({ checkpoint: { kind: 'textPresent', text: 'Application received' } }),
      s,
      [],
      (sel) => s.matchCss(sel),
    );
    expect(state.kind).toBe('completed_by_human');
  });

  it('returns a business outcome the operator drove the flow into', async () => {
    const s = surfaceShowing('We are sorry. Your loan application was denied.');
    const state = await recogniseResumeState(
      step({ checkpoint: { kind: 'textPresent', text: 'Application received' } }),
      s,
      [
        {
          name: 'LOAN_DENIED',
          description: 'The bank declined the application.',
          detect: { kind: 'textPresent', text: 'was denied' },
          terminal: true,
          extract: [],
        },
      ],
      (sel) => s.matchCss(sel),
    );
    expect(state.kind).toBe('outcome');
    if (state.kind === 'outcome') expect(state.hit.name).toBe('LOAN_DENIED');
  });

  it('retries a safe step when the page is back at its starting state', async () => {
    const s = surfaceShowing('Loan application form');
    const state = await recogniseResumeState(
      step({
        checkpoint: { kind: 'textPresent', text: 'Application received' },
        waitFor: { assertion: { kind: 'textPresent', text: 'Loan application form' }, timeoutMs: 100 },
      }),
      s,
      [],
      (sel) => s.matchCss(sel),
    );
    expect(state.kind).toBe('retry');
  });

  it('never auto-retries an irreversible step, even when the page looks un-submitted', async () => {
    // The reason: a form that looks un-submitted is indistinguishable from one the app
    // returned us to *after* a successful submit. Retrying sends the money twice.
    const s = surfaceShowing('Transfer funds form');
    const state = await recogniseResumeState(
      step({
        risk: 'irreversible',
        checkpoint: { kind: 'textPresent', text: 'Transfer complete' },
        waitFor: { assertion: { kind: 'textPresent', text: 'Transfer funds form' }, timeoutMs: 100 },
      }),
      s,
      [],
      (sel) => s.matchCss(sel),
    );
    expect(state.kind).toBe('unrecognized');
    if (state.kind === 'unrecognized') expect(state.detail).toMatch(/irreversible/);
  });

  it('says it does not know rather than guessing', async () => {
    const s = surfaceShowing('Session timed out. Please log in again.');
    const state = await recogniseResumeState(
      step({ checkpoint: { kind: 'textPresent', text: 'Application received' } }),
      s,
      [],
      (sel) => s.matchCss(sel),
    );
    expect(state.kind).toBe('unrecognized');
  });
});

// ---------------------------------------------------------------------------

describe('the broker', () => {
  const open = (broker: InterventionBroker) =>
    broker.open({
      capabilityId: 'parabank.test-flow',
      capabilityVersion: '1.0.0',
      runId: 'run-1',
      sessionId: '11111111-1111-4111-8111-111111111111',
      goal: 'open an account',
      stepId: 'step.one',
      intent: 'submit the application',
      reason: 'error',
      expected: 'the confirmation page',
      observed: 'two Submit buttons',
      url: 'https://parabank.parasoft.com/parabank/openaccount.htm',
      evidencePath: 'evidence/runs/run-1',
    });

  it('hands the waiting automation whatever the operator decided', async () => {
    const broker = new InterventionBroker({ logger: new MemoryLogger(), redactor: redactor() });
    const request = open(broker);
    const answer = broker.wait(request.id);

    broker.claim(request.id, 'alex');
    broker.resolve(request.id, { kind: 'completed', note: 'picked the payee one', actions: [] });

    expect((await answer).kind).toBe('completed');
    expect(broker.get(request.id)?.status).toBe('resolved');
  });

  it('refuses a second operator on an already-resolved intervention', () => {
    const broker = new InterventionBroker({ logger: new MemoryLogger(), redactor: redactor() });
    const request = open(broker);
    broker.claim(request.id, 'alex');
    broker.resolve(request.id, { kind: 'approved', note: '' });
    expect(() => broker.claim(request.id, 'sam')).toThrow(/already resolved/);
  });

  it('redacts a credential an operator pastes into the note', () => {
    const r = redactor().learn('hunter2-the-real-password');
    const broker = new InterventionBroker({ logger: new MemoryLogger(), redactor: r });
    const request = open(broker);
    broker.claim(request.id, 'alex');
    broker.resolve(request.id, {
      kind: 'completed',
      note: 'logged in with hunter2-the-real-password',
      actions: [],
    });
    expect(JSON.stringify(broker.get(request.id))).not.toContain('hunter2');
  });
});

// ---------------------------------------------------------------------------

describe('the lease is the enforcement', () => {
  it('makes automation incapable of acting while a human holds the session', async () => {
    // Against the real chokepoint, not a fake: this is the claim the whole handoff design
    // rests on, and a test against a stub would prove nothing about it.
    const leases = new LeaseManager('11111111-1111-4111-8111-111111111111');
    const surface = await PlaywrightWebSurface.launch({
      policy,
      redactor: redactor(),
      leases,
      headless: true,
    });
    try {
      leases.cedeToHuman('ambiguous target');
      leases.takeControl('alex');

      await expect(surface.act({ type: 'click', ref: 'e1' })).rejects.toBeInstanceOf(
        LeaseDeniedError,
      );

      leases.releaseToAutomation();
      // Now it fails for an ordinary reason — an unknown ref — rather than the lease,
      // which is what shows the gate opened rather than the action being impossible.
      await expect(surface.act({ type: 'click', ref: 'e1' })).rejects.toThrow(/unknown element/);
    } finally {
      await surface.close();
    }
  }, 60_000);

  it('denies a second operator rather than interleaving two humans', () => {
    const leases = new LeaseManager('11111111-1111-4111-8111-111111111111');
    leases.cedeToHuman('stuck');
    leases.takeControl('alex');
    expect(() => leases.takeControl('sam')).toThrow(LeaseConflictError);
  });
});

// ---------------------------------------------------------------------------

describe('the human action recorder', () => {
  it('records what was typed as a shape, never as the characters', async () => {
    const browser = await chromium.launch({ headless: true });
    const p = await browser.newPage();
    try {
      await p.setContent(`
        <form>
          <input name="username" type="text">
          <input name="password" type="password">
          <button type="button" id="go">Continue</button>
        </form>`);
      const recording = await recordHumanSession(p);

      await p.fill('input[name=username]', 'casey.fielding');
      await p.fill('input[name=password]', 'sup3r-s3cret-value');
      await p.click('#go');

      const { actions } = await recording.stop();
      const serialised = JSON.stringify(actions);

      expect(serialised).not.toContain('sup3r-s3cret-value');
      expect(serialised).not.toContain('casey.fielding');
      // Still useful: a reviewer can see a password was supplied and a name was typed.
      expect(serialised).toContain('a password');
      expect(serialised).toContain('14 characters');
      expect(actions.some((a) => a.kind === 'click' && a.target.includes('Continue'))).toBe(true);
    } finally {
      await browser.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe('the handoff end to end', () => {
  it('resumes past a step a human completed instead of repeating it', async () => {
    // Two Submit buttons: the locator is genuinely ambiguous, which is a real reason to
    // ask a person rather than guess.
    const ambiguous = page({
      text: 'Transfer funds',
      nodes: [
        node({ ref: 'a', role: 'button', name: 'Submit', labelHint: 'Address' }),
        node({ ref: 'b', role: 'button', name: 'Submit', labelHint: 'Payee' }),
      ],
    });
    const settled = page({ text: 'Transfer complete. Reference 88213.', nodes: [] });

    const resolved = capability({
      steps: [
        {
          id: 'step.submit-transfer',
          index: 0,
          intent: 'submit the transfer',
          action: { type: 'click' },
          locator: {
            primary: { kind: 'role', role: 'button', name: 'Submit' },
            fallbacks: [],
            description: 'the Submit button',
            rationale: 'test',
            confidence: 0.9,
          },
          checkpoint: { kind: 'textPresent', text: 'Transfer complete' },
          risk: 'irreversible',
        },
        {
          id: 'step.read-reference',
          index: 1,
          intent: 'read the reference back',
          action: { type: 'wait' },
        },
      ],
      riskClass: 'irreversible',
      requiresApproval: true,
      postcondition: { kind: 'textPresent', text: 'Transfer complete' },
    });

    const surface = new FakeSurface({ start: ambiguous });
    const logger = new MemoryLogger();
    const base = {
      capability: resolved,
      surface,
      policy,
      redactor: redactor(),
      logger,
      clock: fakeClock(),
      baseUrl: 'https://parabank.parasoft.com',
      runId: 'run-1',
      approve: () => true,
    };

    // 1. It escalates rather than picking one of the two buttons.
    const first = await new ReplayEngine(base).run();
    expect(first.kind).toBe('escalated');
    if (first.kind !== 'escalated') return;
    expect(first.errorClass).toBe('LOCATOR_AMBIGUOUS');
    // The operator is told the intent, not the mechanics.
    expect(first.intent).toBe('submit the transfer');
    expect(surface.acted).toHaveLength(0);

    // 2. The human does it by hand. The page now satisfies the step's own checkpoint.
    surface.current = settled;

    const state = await recogniseResumeState(
      resolved.steps[0]!,
      surface,
      resolved.outcomes,
      (s) => surface.matchCss(s),
    );
    expect(state.kind).toBe('completed_by_human');

    // 3. Resume. The engine must record the step as done by a human and move on — never
    // re-click a Submit that has already moved money.
    const second = await new ReplayEngine({
      ...base,
      completedSteps: [resolved.steps[0]!.id],
      startAtStepId: resolved.steps[0]!.id,
    }).run();

    expect(second.kind).toBe('success');
    expect(second.steps[0]?.status).toBe('completed_by_human');
    expect(second.steps[0]?.attempts).toBe(0);
    // The proof it did not repeat: no click ever reached the surface, across both runs.
    expect(surface.acted.filter((a) => a.type === 'click')).toHaveLength(0);
  });
});
