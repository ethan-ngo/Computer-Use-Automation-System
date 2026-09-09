import { describe, it, expect } from 'vitest';
import {
  loadArtifact,
  loadTenantBinding,
  parseTenantBinding,
  resolveCapability,
  TenantPolicyError,
} from '../src/artifact/store.js';

const artifact = () => loadArtifact('parabank.open-new-account');

function binding(patch: Record<string, unknown> = {}) {
  return parseTenantBinding({
    schemaVersion: '1.0',
    tenantId: 'test-tenant',
    app: 'parabank',
    baseUrl: 'https://parabank.parasoft.com',
    secrets: {},
    policy: {},
    overrides: {},
    disabledSteps: [],
    ...patch,
  });
}

describe('tenant binding resolution', () => {
  it('resolves an artifact with no tenant at all', async () => {
    const resolved = resolveCapability(await artifact());
    expect(resolved.steps.length).toBe((await artifact()).steps.length);
    expect(resolved.appliedOverrides).toEqual([]);
  });

  it('applies a per-step override and records that it was applied', async () => {
    const tenant = await loadTenantBinding('first-national');
    const resolved = resolveCapability(await artifact(), tenant);

    const step = resolved.steps.find((s) => s.id === 'step.choose-account-type')!;
    expect(step.locator!.primary).toEqual({ kind: 'css', selector: "select[name='type']" });
    // The set of applied overrides is the divergence metric for this tenant.
    expect(resolved.appliedOverrides).toEqual(['step.choose-account-type']);
  });

  it('leaves un-overridden steps exactly as the product-level artifact defines them', async () => {
    const base = await artifact();
    const tenant = await loadTenantBinding('first-national');
    const resolved = resolveCapability(base, tenant);

    const before = base.steps.find((s) => s.id === 'step.submit-login')!;
    const after = resolved.steps.find((s) => s.id === 'step.submit-login')!;
    expect(after.locator).toEqual(before.locator);
  });

  it('re-indexes steps after a disabled step is removed but keeps ids stable', async () => {
    const tenant = binding({ disabledSteps: ['step.choose-funding-account'] });
    const resolved = resolveCapability(await artifact(), tenant);

    expect(resolved.steps.map((s) => s.id)).not.toContain('step.choose-funding-account');
    expect(resolved.steps.map((s) => s.index)).toEqual(resolved.steps.map((_, i) => i));
    // Ids are index-independent, which is what keeps overrides from being orphaned.
    expect(resolved.steps.find((s) => s.id === 'step.submit-open-account')).toBeDefined();
  });

  it('overrides an outcome detector', async () => {
    const tenant = binding({
      overrides: {
        'outcome.LOGIN_FAILED': {
          detect: { kind: 'textPresent', text: 'Anmeldung fehlgeschlagen' },
        },
      },
    });
    const resolved = resolveCapability(await artifact(), tenant);
    const outcome = resolved.outcomes.find((o) => o.name === 'LOGIN_FAILED')!;
    expect(outcome.detect).toEqual({ kind: 'textPresent', text: 'Anmeldung fehlgeschlagen' });
    expect(resolved.appliedOverrides).toContain('outcome.LOGIN_FAILED');
  });

  it('lets a tenant narrow the allowlist', async () => {
    const base = await artifact();
    const tenant = binding({ policy: { allowedDomains: [] } });
    // Narrowing to nothing is legal (and useless) — the point is that it is a subset.
    expect(resolveCapability(base, tenant).allowedDomains).toEqual([]);
  });

  it('refuses to let a tenant widen the allowlist', async () => {
    const tenant = binding({
      policy: { allowedDomains: ['parabank.parasoft.com', 'evil.example'] },
    });
    await expect(async () => resolveCapability(await artifact(), tenant)).rejects.toThrow(
      TenantPolicyError,
    );
  });

  it('lets a tenant require approval but never waive it', async () => {
    const base = await artifact();
    expect(base.policy.requiresApproval).toBe(true);
    const tenant = binding({ policy: { requiresApproval: false } });
    // The artifact said approval is required; a tenant cannot switch that off.
    expect(resolveCapability(base, tenant).requiresApproval).toBe(true);
  });

  it('rejects a binding for a different vendor product', async () => {
    const tenant = binding({ app: 'some-other-core' });
    await expect(async () => resolveCapability(await artifact(), tenant)).rejects.toThrow(
      /bound to app/,
    );
  });

  it('rejects an override that names a step which does not exist', async () => {
    // A silent no-op override is a bug waiting to happen after a step is renamed.
    const tenant = binding({
      overrides: { 'step.does-not-exist': { timeoutMs: 5000 } },
    });
    await expect(async () => resolveCapability(await artifact(), tenant)).rejects.toThrow(
      /unknown targets/,
    );
  });

  it('rejects disabling every step', async () => {
    const base = await artifact();
    const tenant = binding({ disabledSteps: base.steps.map((s) => s.id) });
    await expect(async () => resolveCapability(base, tenant)).rejects.toThrow(/disabled every step/);
  });
});
