/**
 * Filesystem store for capability artifacts and tenant bindings, plus the resolution that
 * turns the two into one executable capability.
 *
 *     artifact step  →  tenant override  →  hard error
 *
 * Deliberately a directory of JSON files. The brief penalises premature scaling
 * infrastructure, and nothing here needs a database to be correct.
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  CapabilityArtifactSchema,
  TenantBindingSchema,
  type CapabilityArtifact,
  type TenantBinding,
  type Step,
  type OutcomeSpec,
} from './schema.js';

export class ArtifactValidationError extends Error {
  constructor(
    readonly file: string,
    readonly issues: string[],
  ) {
    super(`${file} failed validation:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ArtifactValidationError';
  }
}

export class TenantPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantPolicyError';
  }
}

const CAPABILITIES_DIR = 'capabilities';
const TENANTS_DIR = 'tenants';

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export function parseArtifact(raw: unknown, file = '<memory>'): CapabilityArtifact {
  const result = CapabilityArtifactSchema.safeParse(raw);
  if (!result.success) {
    throw new ArtifactValidationError(
      file,
      result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    );
  }
  return result.data;
}

export async function loadArtifact(
  id: string,
  root = process.cwd(),
): Promise<CapabilityArtifact> {
  const file = join(root, CAPABILITIES_DIR, `${id}.json`);
  const raw = JSON.parse(await readFile(file, 'utf-8'));
  return parseArtifact(raw, file);
}

export async function saveArtifact(
  artifact: CapabilityArtifact,
  root = process.cwd(),
): Promise<string> {
  // Validate on write as well as on read. An artifact that cannot be loaded back is worse
  // than one that was never saved.
  const validated = parseArtifact(artifact, artifact.id);
  const dir = join(root, CAPABILITIES_DIR);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${validated.id}.json`);
  await writeFile(file, JSON.stringify(validated, null, 2) + '\n', 'utf-8');
  return file;
}

export async function listArtifacts(root = process.cwd()): Promise<CapabilityArtifact[]> {
  const dir = join(root, CAPABILITIES_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const artifacts: CapabilityArtifact[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const raw = JSON.parse(await readFile(join(dir, name), 'utf-8'));
    artifacts.push(parseArtifact(raw, name));
  }
  return artifacts.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Tenant bindings
// ---------------------------------------------------------------------------

export function parseTenantBinding(raw: unknown, file = '<memory>'): TenantBinding {
  const result = TenantBindingSchema.safeParse(raw);
  if (!result.success) {
    throw new ArtifactValidationError(
      file,
      result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    );
  }
  return result.data;
}

export async function loadTenantBinding(
  tenantId: string,
  root = process.cwd(),
): Promise<TenantBinding> {
  const file = join(root, TENANTS_DIR, `${tenantId}.json`);
  const raw = JSON.parse(await readFile(file, 'utf-8'));
  return parseTenantBinding(raw, file);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolvedCapability {
  artifact: CapabilityArtifact;
  tenant: TenantBinding | undefined;
  /** Steps after override application and `disabledSteps` removal, re-indexed. */
  steps: Step[];
  outcomes: OutcomeSpec[];
  /** Effective allowlist: the artifact's, narrowed by the tenant's if present. */
  allowedDomains: string[];
  requiresApproval: boolean;
  baseUrl: string | undefined;
  /** Which overrides were actually applied — the divergence metric for this tenant. */
  appliedOverrides: string[];
}

/**
 * A tenant may narrow policy but never widen it. Enforced here rather than by convention,
 * because the alternative is a tenant config that quietly re-enables something the
 * product-level artifact forbade.
 */
function narrowAllowedDomains(artifactDomains: string[], tenantDomains?: string[]): string[] {
  if (!tenantDomains) return artifactDomains;
  const widened = tenantDomains.filter((d) => !artifactDomains.includes(d));
  if (widened.length > 0) {
    throw new TenantPolicyError(
      `tenant policy may not widen allowedDomains; these are not in the artifact's allowlist: ${widened.join(', ')}`,
    );
  }
  return tenantDomains;
}

export function resolveCapability(
  artifact: CapabilityArtifact,
  tenant?: TenantBinding,
): ResolvedCapability {
  if (tenant && tenant.app !== artifact.target.app) {
    throw new TenantPolicyError(
      `tenant "${tenant.tenantId}" is bound to app "${tenant.app}" but the artifact targets "${artifact.target.app}"`,
    );
  }

  const appliedOverrides: string[] = [];
  const disabled = new Set(tenant?.disabledSteps ?? []);

  const steps = artifact.steps
    .filter((step) => !disabled.has(step.id))
    .map((step) => {
      const override = tenant?.overrides[step.id];
      if (!override) return step;
      appliedOverrides.push(step.id);
      return {
        ...step,
        locator: override.locator ?? step.locator,
        waitFor: override.waitFor ?? step.waitFor,
        checkpoint: override.checkpoint ?? step.checkpoint,
        timeoutMs: override.timeoutMs ?? step.timeoutMs,
      };
    })
    // Re-index after removals. Ids stay stable; only the ordinal moves.
    .map((step, index) => ({ ...step, index }));

  if (steps.length === 0) {
    throw new TenantPolicyError(
      `tenant "${tenant?.tenantId}" disabled every step of "${artifact.id}"`,
    );
  }

  const outcomes = artifact.outcomes.map((outcome) => {
    const key = `outcome.${outcome.name}`;
    const override = tenant?.overrides[key];
    if (!override?.detect) return outcome;
    appliedOverrides.push(key);
    return { ...outcome, detect: override.detect };
  });

  // An override that names nothing real is a silent no-op waiting to be a bug.
  if (tenant) {
    const known = new Set<string>([
      ...artifact.steps.map((s) => s.id),
      ...artifact.outcomes.map((o) => `outcome.${o.name}`),
    ]);
    const orphans = Object.keys(tenant.overrides).filter((k) => !known.has(k));
    if (orphans.length > 0) {
      throw new TenantPolicyError(
        `tenant "${tenant.tenantId}" has overrides for unknown targets: ${orphans.join(', ')}`,
      );
    }
    const unknownDisabled = tenant.disabledSteps.filter((id) => !known.has(id));
    if (unknownDisabled.length > 0) {
      throw new TenantPolicyError(
        `tenant "${tenant.tenantId}" disables unknown steps: ${unknownDisabled.join(', ')}`,
      );
    }
  }

  return {
    artifact,
    tenant,
    steps,
    outcomes,
    allowedDomains: narrowAllowedDomains(
      artifact.policy.allowedDomains,
      tenant?.policy.allowedDomains,
    ),
    // Approval can be switched on by a tenant, never off.
    requiresApproval: artifact.policy.requiresApproval || tenant?.policy.requiresApproval === true,
    baseUrl: tenant?.baseUrl,
    appliedOverrides,
  };
}

/** Convenience: load both and resolve, given ids. */
export async function loadResolved(
  capabilityId: string,
  tenantId?: string,
  root = resolve(process.cwd()),
): Promise<ResolvedCapability> {
  const artifact = await loadArtifact(capabilityId, root);
  const tenant = tenantId ? await loadTenantBinding(tenantId, root) : undefined;
  return resolveCapability(artifact, tenant);
}
