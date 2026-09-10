import { describe, it, expect } from 'vitest';
import {
  resolveLocator,
  LocatorAmbiguousError,
  LocatorNotFoundError,
} from '../src/replay/locator.js';
import { evaluate } from '../src/replay/assertions.js';
import type { Locator } from '../src/artifact/schema.js';
import { node, observation } from './helpers/observation.js';

function locator(patch: Partial<Locator> & Pick<Locator, 'primary'>): Locator {
  return {
    primary: patch.primary,
    fallbacks: patch.fallbacks ?? [],
    description: patch.description ?? 'test locator',
    rationale: patch.rationale ?? 'test',
    confidence: patch.confidence ?? 0.9,
    framePath: patch.framePath,
  };
}

describe('locator resolution', () => {
  it('resolves via the primary strategy and reports no degradation', async () => {
    const obs = observation({
      nodes: [node({ role: 'textbox', name: 'Username' }), node({ role: 'button', name: 'Log In' })],
    });

    const resolution = await resolveLocator(
      obs,
      locator({ primary: { kind: 'role', role: 'textbox', name: 'Username' } }),
    );

    expect(resolution.node.role).toBe('textbox');
    expect(resolution.fallbackIndex).toBe(-1);
    expect(resolution.degraded).toBe(false);
  });

  it('falls back in order and reports WHICH strategy won', async () => {
    // This telemetry is the drift-detection primitive: a fallback winning is a signal,
    // not a success to be forgotten.
    const obs = observation({
      nodes: [node({ role: 'textbox', labelHint: 'Username', cssPath: "input[name='username']" })],
    });

    const resolution = await resolveLocator(
      obs,
      locator({
        primary: { kind: 'role', role: 'textbox', name: 'Username' }, // misses: no accessible name
        fallbacks: [
          { kind: 'placeholder', text: 'Username' }, // also misses
          { kind: 'nearbyText', text: 'Username', role: 'textbox' }, // wins
        ],
      }),
    );

    expect(resolution.degraded).toBe(true);
    expect(resolution.fallbackIndex).toBe(1);
    expect(resolution.strategy).toEqual({ kind: 'nearbyText', text: 'Username', role: 'textbox' });
  });

  it('raises on ambiguity rather than picking the first match', async () => {
    // The single most important rule in this file. A silent .nth(0) in a banking flow is
    // the failure that does not show up in testing.
    const obs = observation({
      nodes: [
        node({ role: 'button', name: 'Continue' }),
        node({ role: 'button', name: 'Continue' }),
      ],
    });

    await expect(
      resolveLocator(obs, locator({ primary: { kind: 'role', role: 'button', name: 'Continue' } })),
    ).rejects.toBeInstanceOf(LocatorAmbiguousError);
  });

  it('does not fall through to a weaker strategy after an ambiguous match', async () => {
    // Falling through would let a later strategy paper over a genuine "which one did you
    // mean?", which belongs with a human exactly once, recorded into the artifact.
    const obs = observation({
      nodes: [
        node({ role: 'button', name: 'Continue', testId: 'a' }),
        node({ role: 'button', name: 'Continue', testId: 'b' }),
      ],
    });

    await expect(
      resolveLocator(
        obs,
        locator({
          primary: { kind: 'role', role: 'button', name: 'Continue' },
          fallbacks: [{ kind: 'testId', id: 'a' }],
        }),
      ),
    ).rejects.toBeInstanceOf(LocatorAmbiguousError);
  });

  it('reports the candidates when ambiguous, so a human can choose', async () => {
    const obs = observation({
      nodes: [
        node({ role: 'link', name: 'Open New Account' }),
        node({ role: 'link', name: 'Open New Account' }),
      ],
    });

    try {
      await resolveLocator(obs, locator({ primary: { kind: 'role', role: 'link', name: 'Open New Account' } }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LocatorAmbiguousError);
      expect((err as LocatorAmbiguousError).candidates).toHaveLength(2);
    }
  });

  it('throws LOCATOR_NOT_FOUND listing every strategy it tried', async () => {
    const obs = observation({ nodes: [node({ role: 'textbox', name: 'Something else' })] });

    try {
      await resolveLocator(
        obs,
        locator({
          primary: { kind: 'role', role: 'textbox', name: 'Username' },
          fallbacks: [{ kind: 'label', text: 'Username' }],
        }),
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LocatorNotFoundError);
      expect((err as LocatorNotFoundError).tried).toHaveLength(2);
      expect((err as LocatorNotFoundError).class).toBe('LOCATOR_NOT_FOUND');
    }
  });

  it('distinguishes role=link from role=button with the same name', async () => {
    // The real ParaBank case: "Open New Account" is both a menu link and a submit button.
    const obs = observation({
      nodes: [
        node({ role: 'link', name: 'Open New Account' }),
        node({ role: 'button', name: 'Open New Account' }),
      ],
    });

    const asButton = await resolveLocator(
      obs,
      locator({ primary: { kind: 'role', role: 'button', name: 'Open New Account' } }),
    );
    expect(asButton.node.role).toBe('button');
  });

  it('matches nearbyText as a substring, since captions carry surrounding prose', async () => {
    const obs = observation({
      nodes: [
        node({
          role: 'combobox',
          labelHint: 'What type of account would you like to open?',
        }),
      ],
    });

    const resolution = await resolveLocator(
      obs,
      locator({ primary: { kind: 'nearbyText', text: 'What type of account', role: 'combobox' } }),
    );
    expect(resolution.node.role).toBe('combobox');
  });

  it('delegates css strategies to the surface', async () => {
    const target = node({ role: 'combobox', cssPath: 'select#fromAccountId' });
    const obs = observation({ nodes: [target] });
    const matchCss = async (selector: string) =>
      selector === 'select#fromAccountId' ? [target] : [];

    const resolution = await resolveLocator(
      obs,
      locator({ primary: { kind: 'css', selector: 'select#fromAccountId' } }),
      matchCss,
    );
    expect(resolution.node.cssPath).toBe('select#fromAccountId');
  });

  it('treats an explicit nth as a recorded decision, not a silent first-match', async () => {
    const rows = [node({ role: 'cell', name: 'a' }), node({ role: 'cell', name: 'b' })];
    const obs = observation({ nodes: rows });
    const matchCss = async () => rows;

    const resolution = await resolveLocator(
      obs,
      locator({ primary: { kind: 'nth', within: { kind: 'css', selector: 'td' }, index: 1 } }),
      matchCss,
    );
    expect(resolution.node.name).toBe('b');
  });
});

describe('assertion evaluation', () => {
  const obs = observation({
    url: 'https://parabank.parasoft.com/parabank/openaccount.htm',
    title: 'ParaBank | Open Account',
    nodes: [node({ role: 'heading', name: 'Account Opened!' })],
    text: 'Account Opened! Congratulations, your account is now open.',
  });

  it('evaluates urlMatches', async () => {
    expect((await evaluate({ kind: 'urlMatches', pattern: 'openaccount\\.htm' }, obs)).ok).toBe(true);
    expect((await evaluate({ kind: 'urlMatches', pattern: 'transfer\\.htm' }, obs)).ok).toBe(false);
  });

  it('evaluates textPresent and textAbsent case-insensitively', async () => {
    expect((await evaluate({ kind: 'textPresent', text: 'account opened!' }, obs)).ok).toBe(true);
    expect((await evaluate({ kind: 'textAbsent', text: 'insufficient funds' }, obs)).ok).toBe(true);
  });

  it('evaluates all() and short-circuits with a useful detail', async () => {
    const result = await evaluate(
      {
        kind: 'all',
        of: [
          { kind: 'textPresent', text: 'Account Opened!' },
          { kind: 'textPresent', text: 'never appears' },
        ],
      },
      obs,
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('never appears');
  });

  it('evaluates any()', async () => {
    const result = await evaluate(
      {
        kind: 'any',
        of: [
          { kind: 'textPresent', text: 'never appears' },
          { kind: 'textPresent', text: 'Congratulations' },
        ],
      },
      obs,
    );
    expect(result.ok).toBe(true);
  });

  it('propagates ambiguity rather than reading it as "absent"', async () => {
    // An assertion that cannot be evaluated honestly must not quietly return false.
    const ambiguous = observation({
      nodes: [node({ role: 'button', name: 'Continue' }), node({ role: 'button', name: 'Continue' })],
    });

    await expect(
      evaluate(
        {
          kind: 'elementAbsent',
          locator: locator({ primary: { kind: 'role', role: 'button', name: 'Continue' } }),
        },
        ambiguous,
      ),
    ).rejects.toBeInstanceOf(LocatorAmbiguousError);
  });
});
