/**
 * The agent-facing catalog.
 *
 * The catalog is where a mistake is most expensive, because it is the only part of the
 * system a calling agent ever reads. Two properties are non-negotiable:
 *
 *  1. **A credential can never be passed by a caller**, because the tool definition never
 *     admits one exists. Tested by declaring a sensitive input and looking for it.
 *  2. **A declared business outcome is advertised as a result**, not left for the caller to
 *     infer. An agent that reads `LOAN_DENIED` as a malfunction retries a loan denial.
 *
 * Plus the argument gate: a calling agent is an untrusted source of arguments like any
 * other, and bad ones must be rejected before a browser opens.
 */

import { describe, expect, it } from 'vitest';
import { Catalog, entryFor, toolNameFor } from '../src/catalog/catalog.js';
import { invoke } from '../src/catalog/invoke.js';
import { parseArtifact } from '../src/artifact/store.js';
import type { CapabilityArtifact } from '../src/artifact/schema.js';

function artifact(patch: Record<string, unknown> = {}): CapabilityArtifact {
  return parseArtifact({
    schemaVersion: '1.0',
    id: 'parabank.request-loan',
    version: '2.1.0',
    name: 'Request a loan',
    description: 'Apply for a loan against an existing ParaBank account.',
    target: { app: 'parabank', surfaceKind: 'legacy-web', entryPoint: '/parabank/index.htm' },
    inputs: {
      amount: { type: 'money', description: 'How much to borrow.', required: true },
      password: {
        type: 'string',
        description: 'Online banking password.',
        required: true,
        sensitive: true,
      },
    },
    outputs: {
      loanApplicationId: { type: 'string', description: 'The application reference.' },
    },
    steps: [
      {
        id: 'step.apply',
        index: 0,
        intent: 'submit the loan application',
        action: { type: 'click' },
        locator: {
          primary: { kind: 'role', role: 'button', name: 'Apply Now' },
          fallbacks: [],
          description: 'the apply button',
          rationale: 'stable accessible name',
          confidence: 0.9,
        },
        // Declared outputs must actually be extracted somewhere — the schema enforces it,
        // which is why a tool definition can promise a return value honestly.
        extract: [
          {
            name: 'loanApplicationId',
            from: {
              primary: { kind: 'css', selector: '#loanApplicationId' },
              fallbacks: [],
              description: 'the application reference on the confirmation page',
              rationale: 'only id on the page',
              confidence: 0.6,
            },
            as: 'string',
          },
        ],
        risk: 'irreversible',
        timeoutMs: 15_000,
      },
    ],
    outcomes: [
      {
        name: 'LOAN_DENIED',
        description: 'ParaBank declined the application.',
        detect: { kind: 'textPresent', text: 'has been denied' },
        terminal: true,
      },
    ],
    postcondition: { kind: 'textPresent', text: 'Loan Request Processed' },
    policy: {
      riskClass: 'irreversible',
      requiresApproval: true,
      allowedDomains: ['parabank.parasoft.com'],
    },
    provenance: {
      discoveredAt: '2026-01-01T00:00:00Z',
      model: 'claude-opus-5',
      runId: 'test-run',
      evidenceRef: 'n/a',
    },
    ...patch,
  });
}

describe('tool definitions derived from artifacts', () => {
  it('never lets a caller pass a credential, because it never admits one exists', () => {
    const { tool } = entryFor(artifact());
    const properties = (tool.input_schema.properties ?? {}) as Record<string, unknown>;

    expect(Object.keys(properties)).toEqual(['amount']);
    expect(JSON.stringify(tool)).not.toContain('password');
  });

  it('advertises declared business outcomes as results that must not be retried', () => {
    const { tool } = entryFor(artifact());

    expect(tool.description).toContain('LOAN_DENIED');
    expect(tool.description).toContain('must NOT be retried');
  });

  it('advertises irreversibility and the approval requirement', () => {
    const { tool } = entryFor(artifact());
    expect(tool.description).toContain('IRREVERSIBLE');
    expect(tool.description).toContain('requires human approval');
  });

  it('says what a success returns, so the caller knows what it is waiting for', () => {
    const { tool } = entryFor(artifact());
    expect(tool.description).toContain('loanApplicationId');
  });

  it('pins the artifact version into the description, so a stale tool is visible', () => {
    const { tool } = entryFor(artifact());
    expect(tool.description).toContain('parabank.request-loan@2.1.0');
  });

  it('translates dotted capability ids into API-legal tool names', () => {
    expect(toolNameFor('parabank.open-savings-account')).toBe('parabank_open-savings-account');
    expect(toolNameFor('core.v2.transfer funds')).toBe('core_v2_transfer_funds');
  });
});

describe('invocation', () => {
  const catalog = () => new Catalog([entryFor(artifact())]);

  it('rejects a tool that is not in the catalog rather than guessing at one', async () => {
    const result = await invoke({
      catalog: catalog(),
      toolName: 'parabank_drain_the_vault',
      args: {},
    });
    expect(result).toMatchObject({ ok: false, status: 'rejected' });
    if (result.status === 'rejected') expect(result.reason).toContain('no capability named');
  });

  it('validates arguments against the capability contract before a browser opens', async () => {
    const result = await invoke({
      catalog: catalog(),
      toolName: 'parabank_request-loan',
      args: { amount: 'a lot, please' },
    });

    // A calling agent is an untrusted source of arguments like any other.
    expect(result).toMatchObject({ ok: false, status: 'rejected' });
    if (result.status === 'rejected') expect(result.reason).toContain('amount');
  });

  it('refuses a credential even when the schema declares one', async () => {
    const result = await invoke({
      catalog: catalog(),
      toolName: 'parabank_request-loan',
      args: { amount: 500, password: 'hunter2' },
    });

    // The tool definition omits sensitive inputs, so a well-behaved agent cannot ask to
    // pass one. This is the enforcement behind that omission — "the schema does not
    // mention it" is a description, not a control.
    expect(result).toMatchObject({ ok: false, status: 'rejected' });
    if (result.status === 'rejected') {
      expect(result.reason).toContain('password');
      expect(result.reason).toContain('resolved from the tenant binding');
    }
  });
});

describe('the catalog on disk', () => {
  it('loads every committed capability and gives each a distinct tool name', async () => {
    const loaded = await Catalog.load();

    expect(loaded.entries.length).toBeGreaterThan(0);
    const names = loaded.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('round-trips a tool name back to the capability it came from', async () => {
    const loaded = await Catalog.load();
    for (const entry of loaded.entries) {
      expect(loaded.lookup(entry.toolName)?.capabilityId).toBe(entry.capabilityId);
    }
  });
});
