/**
 * Recorder tests.
 *
 * The claim under test throughout is the one the whole design rests on: **nothing the
 * model says becomes executable**. Locators are computed from observations and verified
 * against the replay engine's own matcher; risk is the stricter of two independent
 * opinions; a value reference stays a reference. The prose fields are checked only to
 * confirm they land in labelled display fields and nowhere load-bearing.
 */

import { describe, expect, it } from 'vitest';
import { buildLocator, canonicaliseUrl, recordArtifact, RecorderError } from '../src/artifact/recorder.js';
import { parseArtifact } from '../src/artifact/store.js';
import { loadPolicy } from '../src/policy/policy.js';
import { resolveLocator } from '../src/replay/locator.js';
import { node, observation } from './helpers/observation.js';
import type { DiscoveryLog, ObservationSnapshot, RecordedAction } from '../src/agent/tools.js';
import type { UiNode } from '../src/surface/types.js';

const policy = loadPolicy();

function snap(nodes: UiNode[], patch: Partial<ObservationSnapshot> = {}): ObservationSnapshot {
  const obs = observation({ nodes, ...(patch.url ? { url: patch.url } : {}) });
  return {
    url: patch.url ?? obs.url,
    title: patch.title ?? obs.title,
    ariaHash: patch.ariaHash ?? obs.ariaHash,
    nodes,
    text: patch.text ?? obs.text,
  };
}

function action(patch: Partial<RecordedAction> & { intent: string; tool: RecordedAction['tool'] }): RecordedAction {
  const nodes = patch.before?.nodes ?? [];
  return {
    seq: patch.seq ?? 1,
    intent: patch.intent,
    tool: patch.tool,
    url: patch.url,
    key: patch.key,
    targetRef: patch.targetRef,
    value: patch.value,
    before: patch.before ?? snap(nodes),
    after: patch.after ?? snap(nodes),
    checkpoint: patch.checkpoint,
    extracts: patch.extracts ?? [],
    riskHint: patch.riskHint,
    humanChose: patch.humanChose,
  };
}

function log(patch: Partial<DiscoveryLog> & { actions: RecordedAction[] }): DiscoveryLog {
  return {
    runId: 'run-1',
    goal: 'open a new savings account',
    model: 'claude-sonnet-5',
    startedAt: '2026-01-01T00:00:00.000Z',
    app: 'parabank',
    baseUrl: 'https://parabank.parasoft.com',
    entryPoint: '/parabank/index.htm',
    outcomes: patch.outcomes ?? [],
    escalations: patch.escalations ?? [],
    stoppedBecause: patch.stoppedBecause ?? 'finished',
    finish: patch.finish ?? {
      name: 'Open new account',
      description: 'Opens a new account and returns the new account number.',
      summary: 'done',
    },
    actions: patch.actions,
  };
}

describe('locator synthesis', () => {
  it('prefers role+name and records the rest of the chain as fallbacks', () => {
    const target = node({ ref: 'e1', role: 'button', name: 'Open New Account', labelHint: 'Submit' });
    const other = node({ ref: 'e2', role: 'link', name: 'Accounts Overview' });

    const locator = buildLocator(target, [target, other]);

    expect(locator.primary).toEqual({ kind: 'role', role: 'button', name: 'Open New Account' });
    expect(locator.fallbacks.at(-1)).toEqual({ kind: 'css', selector: target.cssPath });
    expect(locator.confidence).toBeGreaterThan(0.9);
  });

  it('discards a strategy that matches two elements rather than recording it', () => {
    // Two "Submit" buttons: role+name is ambiguous here and must not survive into the
    // artifact, because at replay time it would raise LOCATOR_AMBIGUOUS every single run.
    const a = node({ ref: 'e1', role: 'button', name: 'Submit', labelHint: 'Address' });
    const b = node({ ref: 'e2', role: 'button', name: 'Submit', labelHint: 'Payee' });

    const locator = buildLocator(a, [a, b]);

    const kinds = [locator.primary, ...locator.fallbacks].map((s) => s.kind);
    expect(kinds).not.toContain('role');
    expect(kinds).not.toContain('text');
    // The label cell is what actually distinguishes them, and it is what gets recorded.
    expect(locator.primary).toEqual({ kind: 'label', text: 'Address' });
  });

  it('falls back to a css-only locator with low confidence and says so', () => {
    const bare = node({ ref: 'e1', role: 'textbox', name: '', cssPath: 'input#x' });

    const locator = buildLocator(bare, [bare]);

    expect(locator.primary).toEqual({ kind: 'css', selector: 'input#x' });
    expect(locator.confidence).toBeLessThan(0.5);
    expect(locator.rationale).toMatch(/brittle/i);
  });

  it('every recorded strategy actually resolves through the replay engine', async () => {
    // The regression this guards: a recorder with its own notion of "matches" would write
    // locators the engine cannot resolve, and only production would find out.
    const target = node({
      ref: 'e1',
      role: 'textbox',
      name: '',
      labelHint: 'Username',
      placeholder: 'user',
    });
    const noise = node({ ref: 'e2', role: 'textbox', name: '', labelHint: 'Password' });
    const obs = observation({ nodes: [target, noise] });

    const locator = buildLocator(target, obs.nodes);

    for (const strategy of [locator.primary, ...locator.fallbacks]) {
      if (strategy.kind === 'css') continue; // needs the surface
      const single = { ...locator, primary: strategy, fallbacks: [] };
      const resolution = await resolveLocator(obs, single);
      expect(resolution.node.ref).toBe('e1');
    }
  });

  it('never keys an extraction locator on the value being extracted', () => {
    // The live Opus run recorded the new account number as role=link name="21336" — the
    // number it had just created. That locator resolves exactly once, on the run that
    // wrote it. Where a value lives is described by what is around it, never by itself.
    const value = node({ ref: 'e1', role: 'link', name: '21336', labelHint: 'New account number' });
    const other = node({ ref: 'e2', role: 'link', name: 'Accounts Overview' });

    const acting = buildLocator(value, [value, other]);
    expect(acting.primary).toEqual({ kind: 'role', role: 'link', name: '21336' });

    const extracting = buildLocator(value, [value, other], { forExtraction: true });
    const strategies = [extracting.primary, ...extracting.fallbacks];
    expect(JSON.stringify(strategies)).not.toContain('21336');
    expect(extracting.primary).toEqual({ kind: 'label', text: 'New account number' });
  });

  it('marks a locator high-confidence when an operator chose the element', () => {
    const bare = node({ ref: 'e1', role: 'cell', name: '', cssPath: 'td#z' });
    expect(buildLocator(bare, [bare], { humanChose: true }).confidence).toBeGreaterThanOrEqual(0.9);
  });
});

describe('url canonicalisation', () => {
  it('strips the institution origin so the artifact is tenant-free', () => {
    expect(
      canonicaliseUrl(
        'https://parabank.parasoft.com/parabank/overview.htm',
        'https://parabank.parasoft.com',
      ),
    ).toBe('/parabank/overview.htm');
  });

  it('drops a per-run identifier rather than baking it in', () => {
    expect(
      canonicaliseUrl(
        'https://parabank.parasoft.com/parabank/activity.htm?id=13566',
        'https://parabank.parasoft.com',
      ),
    ).toBe('/parabank/activity.htm');
  });
});

describe('recording an artifact', () => {
  const usernameField = node({ ref: 'e1', role: 'textbox', name: '', labelHint: 'Username' });
  const passwordField = node({ ref: 'e2', role: 'textbox', name: '', labelHint: 'Password' });
  const loginButton = node({ ref: 'e3', role: 'button', name: 'Log In' });
  const accountNumber = node({ ref: 'e9', role: 'link', name: '13566', labelHint: 'Account' });

  const loginPage = snap([usernameField, passwordField, loginButton]);
  // The text matters: the recorder now verifies every declared checkpoint against the
  // page that was actually observed, so a fixture whose text does not support its own
  // checkpoint is rejected — exactly as a real run making that claim would be.
  const resultPage = snap([accountNumber], {
    url: 'https://parabank.parasoft.com/parabank/openaccount.htm',
    text: 'Accounts Overview Account Opened! Your new account number is 13566',
  });

  it('compiles a valid artifact that survives a round trip through the schema', async () => {
    const artifact = await recordArtifact(
      log({
        actions: [
          action({
            seq: 1,
            intent: 'enter the username',
            tool: 'fill',
            targetRef: 'e1',
            value: { valueFrom: '$.inputs.username' },
            before: loginPage,
            after: loginPage,
          }),
          action({
            seq: 2,
            intent: 'submit the login form',
            tool: 'click',
            targetRef: 'e3',
            before: loginPage,
            after: resultPage,
            checkpoint: { textPresent: 'Accounts Overview' },
            extracts: [
              {
                name: 'newAccountNumber',
                ref: 'e9',
                as: 'string',
                description: 'The account number that was created.',
              },
            ],
          }),
        ],
      }),
      { policy, evidenceRef: 'evidence/runs/run-1' },
    );

    // parseArtifact is the real gate: it runs every cross-field refinement.
    expect(() => parseArtifact(artifact)).not.toThrow();
    expect(artifact.id).toBe('parabank.open-new-account');
    expect(artifact.steps.map((s) => s.id)).toEqual([
      'step.enter-the-username',
      'step.submit-the-login-form',
    ]);
    expect(artifact.outputs.newAccountNumber?.type).toBe('string');
    expect(artifact.postcondition).toEqual({ kind: 'textPresent', text: 'Accounts Overview' });
  });

  it('keeps a secret as a reference and never as a value', async () => {
    const artifact = await recordArtifact(
      log({
        actions: [
          action({
            intent: 'enter the password',
            tool: 'fill',
            targetRef: 'e2',
            value: { secretRef: 'PARABANK_PASSWORD' },
            before: loginPage,
            after: loginPage,
          }),
        ],
      }),
      { policy, evidenceRef: 'e' },
    );

    const step = artifact.steps[0]!;
    expect(step.action).toEqual({ type: 'fill', value: { secretRef: 'PARABANK_PASSWORD' } });
    expect(JSON.stringify(artifact)).not.toContain('demo');
  });

  it('takes the stricter risk of the model hint and the policy pattern', async () => {
    // The model said "safe"; the policy's pattern list says "open .*account".
    // Under-marking costs a real transaction, so the policy wins.
    const artifact = await recordArtifact(
      log({
        actions: [
          action({
            intent: 'open the new savings account',
            tool: 'click',
            targetRef: 'e3',
            before: loginPage,
            after: resultPage,
          }),
        ],
      }),
      { policy, evidenceRef: 'e' },
    );

    expect(artifact.steps[0]!.risk).toBe('irreversible');
    expect(artifact.policy.requiresApproval).toBe(true);
    expect(artifact.policy.riskClass).toBe('irreversible');
  });

  it('honours an irreversible hint the policy pattern list would have missed', async () => {
    const artifact = await recordArtifact(
      log({
        actions: [
          action({
            intent: 'continue',
            tool: 'click',
            targetRef: 'e3',
            riskHint: 'irreversible',
            before: loginPage,
            after: resultPage,
          }),
        ],
      }),
      { policy, evidenceRef: 'e' },
    );

    expect(artifact.steps[0]!.risk).toBe('irreversible');
  });

  it('records declared business outcomes into the contract', async () => {
    const artifact = await recordArtifact(
      log({
        actions: [action({ intent: 'apply for a loan', tool: 'click', targetRef: 'e3', before: loginPage, after: resultPage })],
        outcomes: [
          {
            name: 'LOAN_DENIED',
            description: 'The application was rejected.',
            detect: { textPresent: 'Denied' },
            terminal: true,
          },
        ],
      }),
      { policy, evidenceRef: 'e' },
    );

    expect(artifact.outcomes).toHaveLength(1);
    expect(artifact.outcomes[0]!.detect).toEqual({ kind: 'textPresent', text: 'Denied' });
    expect(artifact.outcomes[0]!.terminal).toBe(true);
  });

  it('refuses to record a step whose target was not in the observation', async () => {
    await expect(
      recordArtifact(
        log({
          actions: [
            action({ intent: 'click a hallucinated button', tool: 'click', targetRef: 'e404', before: loginPage, after: loginPage }),
          ],
        }),
        { policy, evidenceRef: 'e' },
      ),
    ).rejects.toThrow(RecorderError);
  });

  it('refuses to compile a run that recorded no actions', async () => {
    await expect(
      recordArtifact(log({ actions: [], stoppedBecause: 'no_progress' }), { policy, evidenceRef: 'e' }),
    ).rejects.toThrow(/nothing to compile/);
  });

  it('flags a run that never called finish, in the description a reviewer reads', async () => {
    const artifact = await recordArtifact(
      {
        ...log({ actions: [action({ intent: 'log in', tool: 'click', targetRef: 'e3', before: loginPage, after: resultPage })] }),
        finish: undefined,
        stoppedBecause: 'max_steps',
      },
      { policy, evidenceRef: 'e' },
    );

    expect(artifact.description).toMatch(/needs review/i);
  });

  it('refuses a checkpoint the observed page contradicts', async () => {
    // The live failure this is written from: Sonnet clicked "Open New Account", the click
    // did not submit, and it declared "Account Opened!" on a page still showing the empty
    // form. The evidence to catch it was already in the action log.
    const stillTheForm = snap([loginButton], { text: 'What type of Account would you like to open?' });

    await expect(
      recordArtifact(
        log({
          actions: [
            action({
              intent: 'submit the new account request',
              tool: 'click',
              targetRef: 'e3',
              before: loginPage,
              after: stillTheForm,
              checkpoint: { textPresent: 'Account Opened!' },
            }),
          ],
        }),
        { policy, evidenceRef: 'e' },
      ),
    ).rejects.toThrow(/claimed success the evidence does not support/);
  });

  it('gives colliding intents distinct, stable step ids', async () => {
    const artifact = await recordArtifact(
      log({
        actions: [
          action({ seq: 1, intent: 'enter an amount', tool: 'fill', targetRef: 'e1', value: { literal: '100' }, before: loginPage, after: loginPage }),
          action({ seq: 2, intent: 'enter an amount', tool: 'fill', targetRef: 'e2', value: { literal: '200' }, before: loginPage, after: loginPage }),
        ],
      }),
      { policy, evidenceRef: 'e' },
    );

    expect(artifact.steps.map((s) => s.id)).toEqual(['step.enter-an-amount', 'step.enter-an-amount-2']);
  });
});
