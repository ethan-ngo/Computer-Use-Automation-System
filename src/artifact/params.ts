/**
 * Compiles an artifact's declared `inputs` into (a) a Zod object for validating caller
 * arguments at replay time and (b) JSON Schema for the agent-facing catalog.
 *
 * The artifact is persisted as JSON, so inputs are declared as a small parameter DSL
 * rather than as an inline Zod object. Compiling that DSL once here is what lets the
 * *same* declaration serve both the runtime validator and the tool definition handed to a
 * calling agent — the typed contract exists exactly once.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { CapabilityArtifact, ParamSpec } from './schema.js';

/** ISO-ish date, deliberately strict — a silently mis-parsed date is worse than an error. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function compileOne(name: string, spec: ParamSpec): z.ZodTypeAny {
  let base: z.ZodTypeAny;

  switch (spec.type) {
    case 'string':
      base = z.string().min(1);
      break;
    case 'number':
      base = z.number();
      break;
    case 'boolean':
      base = z.boolean();
      break;
    case 'money':
      // Accept a number or a plain decimal string; the tenant locale governs *rendering*,
      // not what the caller may pass. Callers pass canonical values.
      base = z.union([z.number(), z.string().regex(/^-?\d+(\.\d{1,2})?$/)]);
      break;
    case 'date':
      base = z.string().regex(DATE_RE, `${name} must be YYYY-MM-DD`);
      break;
    case 'enum': {
      const values = spec.enum ?? [];
      if (values.length === 0) {
        throw new Error(`input "${name}" is type "enum" but declares no enum values`);
      }
      base = z.enum(values as [string, ...string[]]);
      break;
    }
  }

  base = base.describe(spec.description);

  if (spec.default !== undefined) return base.default(spec.default);
  if (!spec.required) return base.optional();
  return base;
}

/** Zod object validating a caller's `inputs` for this capability. */
export function compileInputs(artifact: CapabilityArtifact): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};
  for (const [name, spec] of Object.entries(artifact.inputs)) {
    shape[name] = compileOne(name, spec);
  }
  return z.object(shape).strict();
}

/** Zod object describing what a successful replay returns. */
export function compileOutputs(artifact: CapabilityArtifact): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};
  for (const [name, spec] of Object.entries(artifact.outputs)) {
    const base =
      spec.type === 'number' || spec.type === 'money'
        ? z.number()
        : spec.type === 'boolean'
          ? z.boolean()
          : z.string();
    shape[name] = base.describe(spec.description);
  }
  return z.object(shape);
}

/**
 * JSON Schema for the catalog. Sensitive inputs are excluded from the agent-facing tool
 * definition entirely — a calling agent supplies business parameters, never credentials,
 * which are resolved from the tenant's vault at replay time.
 */
export function inputsJsonSchema(artifact: CapabilityArtifact): Record<string, unknown> {
  const shape: z.ZodRawShape = {};
  for (const [name, spec] of Object.entries(artifact.inputs)) {
    if (spec.sensitive) continue;
    shape[name] = compileOne(name, spec);
  }
  const schema = zodToJsonSchema(z.object(shape).strict(), {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** The names of every sensitive input, used to drive redaction. */
export function sensitiveInputNames(artifact: CapabilityArtifact): string[] {
  return Object.entries(artifact.inputs)
    .filter(([, spec]) => spec.sensitive)
    .map(([name]) => name);
}
