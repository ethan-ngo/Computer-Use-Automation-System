/**
 * The agent-facing capability catalog.
 *
 * This is the point of the whole artifact format, stated in one file: a capability that was
 * discovered once by a model becomes a **typed tool** that any production agent can call,
 * with no model in the execution path. The tool definition is not written by hand and is
 * not maintained alongside the artifact — it is *derived* from it, so a capability cannot
 * drift out of sync with its own contract.
 *
 * Three decisions are load-bearing:
 *
 *  1. **Sensitive inputs never appear in the tool definition.** A calling agent supplies
 *     business parameters; credentials are resolved from the tenant's vault at replay time.
 *     The agent cannot pass a password because it is never told one exists. That is not a
 *     filter applied to the schema afterwards — `inputsJsonSchema()` builds it that way.
 *  2. **Declared business outcomes are advertised in the description.** An agent that does
 *     not know `LOAN_DENIED` is a possible answer will treat it as a malfunction and retry
 *     it. Putting the outcomes in the contract is what lets the caller distinguish "the
 *     bank said no" from "the automation broke" — the same distinction the replay result
 *     type enforces, surfaced one level up.
 *  3. **Irreversibility is advertised too.** An agent choosing between capabilities should
 *     be able to see that one of them opens a real bank account.
 */

import { inputsJsonSchema } from '../artifact/params.js';
import { listArtifacts } from '../artifact/store.js';
import type { CapabilityArtifact } from '../artifact/schema.js';

/**
 * A Claude tool definition, shaped for the Messages API.
 *
 * `input_schema` is typed as an object schema rather than a bare record so that a
 * definition built here satisfies the SDK's `Tool` without a cast at the call site — the
 * derivation is supposed to be trustworthy, and a cast at the boundary would hide the one
 * place where it could stop being.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties?: Record<string, unknown>; [key: string]: unknown };
}

export interface CatalogEntry {
  /** The API-legal tool name. */
  toolName: string;
  /** The capability id it maps back to. */
  capabilityId: string;
  artifact: CapabilityArtifact;
  tool: ToolDefinition;
}

/**
 * Capability ids are dotted (`parabank.open-savings-account`) because that is what reads
 * well in a repository; tool names must match `^[a-zA-Z0-9_-]{1,64}$`. Translating here,
 * rather than constraining the id format to whatever one API happens to accept, keeps the
 * artifact independent of the caller — the same artifact has to be addressable from a
 * queue, a CLI and an HTTP route as well.
 */
export function toolNameFor(capabilityId: string): string {
  return capabilityId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function describe(artifact: CapabilityArtifact): string {
  const lines = [artifact.description.trim()];

  const outputs = Object.entries(artifact.outputs);
  if (outputs.length > 0) {
    lines.push(
      'Returns on success: ' +
        outputs.map(([name, spec]) => `${name} (${spec.type}) — ${spec.description}`).join('; '),
    );
  }

  if (artifact.outcomes.length > 0) {
    // The single most important sentence in the catalog. An agent that reads a declared
    // business outcome as a failure will retry a loan denial.
    lines.push(
      'May instead return one of these business outcomes, which are legitimate results ' +
        'and must NOT be retried: ' +
        artifact.outcomes.map((o) => `${o.name} — ${o.description}`).join('; '),
    );
  }

  if (artifact.policy.riskClass === 'irreversible') {
    lines.push(
      'This capability performs an IRREVERSIBLE action against a real banking application' +
        (artifact.policy.requiresApproval ? ' and requires human approval before it runs.' : '.'),
    );
  }

  lines.push(
    `Runs deterministically from a recorded capability artifact ` +
      `(${artifact.id}@${artifact.version}); no model is in the execution path.`,
  );

  return lines.join('\n\n');
}

export function entryFor(artifact: CapabilityArtifact): CatalogEntry {
  return {
    toolName: toolNameFor(artifact.id),
    capabilityId: artifact.id,
    artifact,
    tool: {
      name: toolNameFor(artifact.id),
      description: describe(artifact),
      input_schema: { ...inputsJsonSchema(artifact), type: 'object' },
    },
  };
}

export class Catalog {
  private readonly byToolName = new Map<string, CatalogEntry>();

  constructor(readonly entries: CatalogEntry[]) {
    for (const entry of entries) this.byToolName.set(entry.toolName, entry);
  }

  /** Everything in `capabilities/`, as tool definitions. */
  static async load(root = process.cwd()): Promise<Catalog> {
    return new Catalog((await listArtifacts(root)).map(entryFor));
  }

  get tools(): ToolDefinition[] {
    return this.entries.map((e) => e.tool);
  }

  lookup(toolName: string): CatalogEntry | undefined {
    return this.byToolName.get(toolName);
  }
}
