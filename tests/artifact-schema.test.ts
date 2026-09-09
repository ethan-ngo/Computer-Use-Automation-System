import { describe, it, expect } from 'vitest';
import { parseArtifact, loadArtifact, ArtifactValidationError } from '../src/artifact/store.js';
import { compileInputs, inputsJsonSchema, compileOutputs } from '../src/artifact/params.js';
import type { CapabilityArtifact } from '../src/artifact/schema.js';

/** A minimal valid artifact, cloned and mutated per test. */
function seed(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    id: 'demo.do-thing',
    version: '1.0.0',
    name: 'Do a thing',
    description: 'Does a thing.',
    target: { app: 'demo', surfaceKind: 'legacy-web', entryPoint: '/index.htm' },
    inputs: {
      amount: { type: 'money', description: 'How much', required: true, sensitive: false },
    },
    outputs: {},
    steps: [
      {
        id: 'step.enter-amount',
        index: 0,
        intent: 'enter the amount',
        action: { type: 'fill', value: { valueFrom: '$.inputs.amount' } },
        locator: {
          primary: { kind: 'role', role: 'textbox', name: 'Amount' },
          fallbacks: [],
          description: 'amount field',
          rationale: 'has an accessible name',
          confidence: 0.9,
        },
        risk: 'safe',
      },
    ],
    outcomes: [],
    postcondition: { kind: 'textPresent', text: 'Done' },
    policy: { riskClass: 'safe', requiresApproval: false, allowedDomains: ['example.test'] },
    provenance: {
      discoveredAt: '2026-01-01T00:00:00Z',
      model: 'hand-written',
      runId: 'r1',
      evidenceRef: 'n/a',
      humanEdits: [],
    },
  };
}

describe('artifact schema', () => {
  it('accepts the seed artifact', () => {
    expect(() => parseArtifact(seed())).not.toThrow();
  });

  it('rejects duplicate step ids, because overrides are keyed by step id', () => {
    const raw = seed();
    const steps = raw.steps as Record<string, unknown>[];
    steps.push({ ...steps[0], index: 1 });
    expect(() => parseArtifact(raw)).toThrow(/duplicate step id/);
  });

  it('rejects a value reference to an undeclared input', () => {
    const raw = seed();
    const steps = raw.steps as Record<string, unknown>[];
    steps[0]!.action = { type: 'fill', value: { valueFrom: '$.inputs.nonexistent' } };
    expect(() => parseArtifact(raw)).toThrow(/undeclared input/);
  });

  it('rejects a literal value on a step whose intent looks sensitive', () => {
    // Decision 1 enforced: credentials must be references, which is also what makes an
    // artifact safe to share across institutions.
    const raw = seed();
    const steps = raw.steps as Record<string, unknown>[];
    steps[0]!.id = 'step.enter-password';
    steps[0]!.intent = 'enter the account password';
    steps[0]!.action = { type: 'fill', value: { literal: 'hunter2' } };
    expect(() => parseArtifact(raw)).toThrow(/use \{ secretRef \}/);
  });

  it('rejects an action that needs a target but has no locator', () => {
    const raw = seed();
    const steps = raw.steps as Record<string, unknown>[];
    delete steps[0]!.locator;
    expect(() => parseArtifact(raw)).toThrow(/no locator/);
  });

  it('rejects an irreversible step when the capability does not require approval', () => {
    const raw = seed();
    const steps = raw.steps as Record<string, unknown>[];
    steps[0]!.risk = 'irreversible';
    expect(() => parseArtifact(raw)).toThrow(/requiresApproval/);
  });

  it('rejects a declared output that nothing extracts', () => {
    const raw = seed();
    raw.outputs = { confirmationNumber: { type: 'string', description: 'the number' } };
    expect(() => parseArtifact(raw)).toThrow(/never extracted/);
  });

  it('reports every issue rather than only the first', () => {
    const raw = seed();
    raw.id = 'NOT A VALID ID';
    raw.version = 'v1';
    try {
      parseArtifact(raw, 'demo.json');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactValidationError);
      expect((err as ArtifactValidationError).issues.length).toBeGreaterThan(1);
    }
  });
});

describe('the shipped ParaBank artifact', () => {
  it('loads and validates from disk', async () => {
    const artifact = await loadArtifact('parabank.open-new-account');
    expect(artifact.target.surfaceKind).toBe('legacy-web');
    expect(artifact.steps.length).toBeGreaterThan(5);
  });

  it('keeps credentials out of the artifact entirely', async () => {
    const artifact = await loadArtifact('parabank.open-new-account');
    const serialized = JSON.stringify(artifact);
    // No literal credential values, and no credential-shaped inputs.
    expect(serialized).not.toMatch(/"literal"\s*:\s*"[^"]*(demo|hunter|pass)/i);
    for (const spec of Object.values(artifact.inputs)) {
      expect(spec.sensitive).toBe(false);
    }
    // Credentials are referenced by name only.
    expect(serialized).toContain('"secretRef":"PARABANK_PASSWORD"');
  });

  it('declares business outcomes so replay never has to infer them', async () => {
    const artifact = await loadArtifact('parabank.open-new-account');
    expect(artifact.outcomes.map((o) => o.name)).toContain('LOGIN_FAILED');
    expect(artifact.outcomes.every((o) => o.terminal)).toBe(true);
  });

  it('flags the irreversible step and gates the capability on approval', async () => {
    const artifact = await loadArtifact('parabank.open-new-account');
    const irreversible = artifact.steps.filter((s) => s.risk === 'irreversible');
    expect(irreversible.map((s) => s.id)).toEqual(['step.submit-open-account']);
    expect(artifact.policy.requiresApproval).toBe(true);
  });

  it('records low confidence where only a css strategy was available', async () => {
    const artifact = await loadArtifact('parabank.open-new-account');
    const cssOnly = artifact.steps.filter(
      (s) => s.locator && s.locator.primary.kind === 'css' && s.locator.fallbacks.length === 0,
    );
    expect(cssOnly.length).toBeGreaterThan(0);
    for (const step of cssOnly) {
      expect(step.locator!.confidence).toBeLessThanOrEqual(0.6);
    }
  });
});

describe('typed inputs and outputs', () => {
  it('validates caller arguments against the declared inputs', async () => {
    const artifact = await loadArtifact('parabank.open-new-account');
    const inputs = compileInputs(artifact);
    expect(inputs.safeParse({ accountType: 'SAVINGS', fromAccountId: '12345' }).success).toBe(true);
    expect(inputs.safeParse({ accountType: 'CRYPTO', fromAccountId: '12345' }).success).toBe(false);
    expect(inputs.safeParse({ accountType: 'SAVINGS' }).success).toBe(false);
  });

  it('rejects unknown arguments rather than silently ignoring them', async () => {
    const artifact = await loadArtifact('parabank.open-new-account');
    const inputs = compileInputs(artifact);
    const result = inputs.safeParse({
      accountType: 'SAVINGS',
      fromAccountId: '12345',
      transferTo: 'attacker',
    });
    expect(result.success).toBe(false);
  });

  it('emits JSON Schema for the catalog', async () => {
    const artifact = await loadArtifact('parabank.open-new-account');
    const schema = inputsJsonSchema(artifact) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual(['accountType', 'fromAccountId']);
    expect(schema.required).toContain('accountType');
  });

  it('omits sensitive inputs from the agent-facing schema', () => {
    const raw = seed() as unknown as CapabilityArtifact;
    (raw.inputs as Record<string, unknown>).apiKey = {
      type: 'string',
      description: 'a credential a calling agent must never supply',
      required: true,
      sensitive: true,
    };
    const artifact = parseArtifact(raw);
    const schema = inputsJsonSchema(artifact) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).not.toContain('apiKey');
  });

  it('compiles the declared outputs', async () => {
    const artifact = await loadArtifact('parabank.open-new-account');
    const outputs = compileOutputs(artifact);
    expect(outputs.safeParse({ newAccountNumber: '13566' }).success).toBe(true);
  });
});
