import { describe, it, expect } from 'vitest';
import { loadPolicy, checkNavigation, checkAction, classifyRisk } from '../src/policy/policy.js';
import { Redactor, REDACTED } from '../src/policy/redact.js';

const policy = loadPolicy();

describe('navigation allowlist', () => {
  it('allows the target application', () => {
    const v = checkNavigation(policy, 'https://parabank.parasoft.com/parabank/openaccount.htm');
    expect(v.allowed).toBe(true);
  });

  it('rejects a lookalike host that shares a string prefix', () => {
    // The specific reason origins are parsed rather than prefix-matched.
    const v = checkNavigation(policy, 'https://parabank.parasoft.com.evil.tld/parabank/index.htm');
    expect(v.allowed).toBe(false);
    expect(v.rule).toBe('origin.allowlist');
  });

  it('rejects a userinfo trick where the real host follows an @', () => {
    const v = checkNavigation(policy, 'https://parabank.parasoft.com@evil.tld/parabank/');
    expect(v.allowed).toBe(false);
  });

  it('rejects a different scheme on the right host', () => {
    const v = checkNavigation(policy, 'ftp://parabank.parasoft.com/parabank/index.htm');
    expect(v.allowed).toBe(false);
    expect(v.rule).toBe('scheme.allowlist');
  });

  it('rejects javascript:, file: and data: URLs', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<h1>hi']) {
      expect(checkNavigation(policy, url).allowed).toBe(false);
    }
  });

  it('rejects a relative or malformed URL rather than guessing an origin', () => {
    expect(checkNavigation(policy, '/parabank/index.htm').allowed).toBe(false);
    expect(checkNavigation(policy, 'not a url').allowed).toBe(false);
  });

  it('distinguishes ports', () => {
    expect(checkNavigation(policy, 'http://127.0.0.1:8787/parabank/index.htm').allowed).toBe(true);
    expect(checkNavigation(policy, 'http://127.0.0.1:9999/parabank/index.htm').allowed).toBe(false);
  });
});

describe('action vocabulary', () => {
  it('allows the closed vocabulary', () => {
    for (const a of ['navigate', 'click', 'fill', 'select', 'press', 'wait']) {
      expect(checkAction(policy, a).allowed).toBe(true);
    }
  });

  it('rejects anything outside it', () => {
    for (const a of ['evaluateScript', 'download', 'upload', 'newTab']) {
      expect(checkAction(policy, a).allowed).toBe(false);
    }
  });
});

describe('risk classification', () => {
  it('flags money movement and account lifecycle as irreversible', () => {
    expect(classifyRisk(policy, 'transfer funds between accounts')).toBe('irreversible');
    expect(classifyRisk(policy, 'submit the loan application')).toBe('irreversible');
    expect(classifyRisk(policy, 'submit the request to open the account')).toBe('irreversible');
    expect(classifyRisk(policy, 'confirm the payment')).toBe('irreversible');
  });

  it('leaves navigation and data entry safe', () => {
    expect(classifyRisk(policy, 'enter the service account username')).toBe('safe');
    expect(classifyRisk(policy, 'load the ParaBank home page')).toBe('safe');
    expect(classifyRisk(policy, 'read back the new account number')).toBe('safe');
  });

  it('misses a commit disguised as navigation — the documented limit', () => {
    // Recorded as a test so the weakness is visible rather than discovered later. The
    // mitigation is human review of the artifact at promotion, not a longer regex.
    expect(classifyRisk(policy, 'click Continue')).toBe('safe');
  });
});

describe('redaction', () => {
  it('redacts learned secret values wherever they appear', () => {
    const r = new Redactor(policy).learn('hunter2');
    expect(r.text('logging in with hunter2 now')).toBe(`logging in with ${REDACTED} now`);
    expect(r.text('https://host/?pw=hunter2')).toContain(REDACTED);
  });

  it('learns secrets from the environment by name pattern', () => {
    const r = new Redactor(policy).learnFromEnv({
      PARABANK_PASSWORD: 'sup3rsecret',
      HOME: '/home/someone',
    } as NodeJS.ProcessEnv);
    expect(r.text('password was sup3rsecret')).toContain(REDACTED);
    // A non-secret env var is not redacted, or logs become unreadable.
    expect(r.text('home is /home/someone')).toBe('home is /home/someone');
  });

  it('redacts value-shaped data we never held', () => {
    const r = new Redactor(policy);
    expect(r.text('ssn 123-45-6789')).toContain(REDACTED);
    expect(r.text('card 4111 1111 1111 1111')).toContain(REDACTED);
  });

  it('deep-redacts structures, including by key name', () => {
    const r = new Redactor(policy).learn('hunter2');
    const out = r.value({
      step: 'step.enter-password',
      typed: 'hunter2',
      nested: { password: 'anything at all', note: 'typed hunter2' },
      list: ['hunter2', 'fine'],
    });
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(out.nested.password).toBe(REDACTED);
    expect(out.list[1]).toBe('fine');
  });

  it('redacts the longest overlapping secret first', () => {
    const r = new Redactor(policy).learn('secret').learn('supersecret');
    expect(r.text('supersecret')).toBe(REDACTED);
  });

  it('exposes the screenshot mask selectors', () => {
    const r = new Redactor(policy);
    expect(r.maskSelectors).toContain("input[type='password']");
  });
});

describe('budgets', () => {
  it('bounds effort, so a runaway loop cannot become a self-inflicted DoS', () => {
    expect(policy.budgets.maxStepsPerReplay).toBeGreaterThan(0);
    expect(policy.budgets.maxDiscoverySteps).toBeLessThanOrEqual(40);
    expect(policy.budgets.wallClockMs).toBeGreaterThan(0);
    expect(policy.budgets.minDelayBetweenActionsMs).toBeGreaterThan(0);
  });
});

describe('redaction preserves references', () => {
  it('keeps a secretRef intact while still blanking a secret value', () => {
    // The bug this is written from: `secretRef` matches /secret/i, so the key-based
    // blanking reduced { secretRef: "PARABANK_PASSWORD" } to { secretRef: "«redacted»" }
    // in the discovery log. Re-recording from that log produced a capability whose
    // credentials could never resolve, and it failed at replay time — far from the cause.
    const redactor = new Redactor(loadPolicy()).learn('hunter2-actual-password');

    const out = redactor.value({
      action: { type: 'fill', value: { secretRef: 'PARABANK_PASSWORD' } },
      reference: { valueFrom: '$.inputs.accountType' },
      password: 'hunter2-actual-password',
      note: 'logged in with hunter2-actual-password',
    });

    // The reference survives — it is a name, and the whole design depends on names being
    // safe to persist.
    expect(out.action.value.secretRef).toBe('PARABANK_PASSWORD');
    expect(out.reference.valueFrom).toBe('$.inputs.accountType');
    // The actual secret does not, whether it is under a telling key or buried in prose.
    expect(out.password).toBe(REDACTED);
    expect(out.note).not.toContain('hunter2');
  });
});
