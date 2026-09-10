/**
 * Builds small, *valid* capability artifacts for tests.
 *
 * Deliberately routed through `parseArtifact` rather than hand-constructing the parsed
 * type: a test fixture that could not survive being written to disk and loaded back would
 * prove nothing about the real path.
 */

import { parseArtifact, resolveCapability, type ResolvedCapability } from '../../src/artifact/store.js';
import { parseTenantBinding } from '../../src/artifact/store.js';
import type { Locator } from '../../src/artifact/schema.js';
import { loadPolicy, type Policy } from '../../src/policy/policy.js';

export interface CapabilityPatch {
  steps: unknown[];
  outcomes?: unknown[];
  postcondition?: unknown;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  requiresApproval?: boolean;
  riskClass?: 'safe' | 'irreversible';
  tenant?: Record<string, unknown>;
}

export function capability(patch: CapabilityPatch): ResolvedCapability {
  const artifact = parseArtifact({
    schemaVersion: '1.0',
    id: 'parabank.test-flow',
    version: '1.0.0',
    name: 'Test flow',
    description: 'A capability built for a unit test.',
    target: { app: 'parabank', surfaceKind: 'legacy-web', entryPoint: '/parabank/index.htm' },
    inputs: patch.inputs ?? {},
    outputs: patch.outputs ?? {},
    steps: patch.steps,
    outcomes: patch.outcomes ?? [],
    postcondition: patch.postcondition ?? { kind: 'textPresent', text: 'Done' },
    policy: {
      riskClass: patch.riskClass ?? 'safe',
      requiresApproval: patch.requiresApproval ?? false,
      allowedDomains: ['parabank.parasoft.com'],
    },
    provenance: {
      discoveredAt: '2026-01-01T00:00:00Z',
      model: 'test',
      runId: 'test-run',
      evidenceRef: 'n/a',
    },
  });

  const tenant = patch.tenant
    ? parseTenantBinding({
        schemaVersion: '1.0',
        tenantId: 'test-tenant',
        app: 'parabank',
        baseUrl: 'https://parabank.parasoft.com',
        ...patch.tenant,
      })
    : undefined;

  return resolveCapability(artifact, tenant);
}

/** A locator that matches by css path — the fake surface's cheapest handle. */
export function css(selector: string, description = selector): Locator {
  return {
    primary: { kind: 'css', selector },
    fallbacks: [],
    description,
    rationale: 'test fixture',
    confidence: 0.5,
  };
}

/** The real policy, optionally with tightened budgets. */
export function policy(budgets: Partial<Policy['budgets']> = {}): Policy {
  const base = loadPolicy();
  return { ...base, budgets: { ...base.budgets, ...budgets } };
}
