/**
 * Redaction, applied at every write boundary: the run log, the artifact, extracted
 * outputs, and intervention records.
 *
 * Two sources of truth:
 *   1. Values we resolved ourselves from the environment. We know these exactly, so we can
 *      redact them wherever they appear — including inside a URL or an error message we
 *      did not construct.
 *   2. Value-shaped patterns (SSNs, card numbers) for data we never held but might capture.
 *
 * Known residual, stated rather than hidden: screenshots and DOM captures are the real
 * leak surface. Masking is selector-based, so an account number rendered mid-page is
 * captured in the clear. Evidence bundles inherit the data classification of the app.
 */

import type { Policy } from './policy.js';

export const REDACTED = '«redacted»';

export class Redactor {
  /** Literal secret values, longest first so overlapping secrets redact completely. */
  private readonly secrets: string[] = [];
  private readonly valuePatterns: { name: string; rx: RegExp }[];

  constructor(private readonly policy: Policy) {
    this.valuePatterns = policy.redaction.valuePatterns.map((p) => ({
      name: p.name,
      rx: new RegExp(p.pattern, 'g'),
    }));
  }

  /** Register every environment value whose name matches a secret pattern. */
  learnFromEnv(env: NodeJS.ProcessEnv = process.env): this {
    for (const [name, value] of Object.entries(env)) {
      if (!value || value.length < 3) continue;
      if (this.policy.redaction.secretEnvPatterns.some((p) => new RegExp(`^${p}$`, 'i').test(name))) {
        this.learn(value);
      }
    }
    return this;
  }

  /** Register a specific value as secret (used when a secretRef is resolved). */
  learn(value: string): this {
    if (value && value.length >= 3 && !this.secrets.includes(value)) {
      this.secrets.push(value);
      this.secrets.sort((a, b) => b.length - a.length);
    }
    return this;
  }

  text(input: string): string {
    let out = input;
    for (const secret of this.secrets) out = out.split(secret).join(REDACTED);
    for (const { rx } of this.valuePatterns) out = out.replace(rx, REDACTED);
    return out;
  }

  /** Deep-redacts any JSON-serialisable value. Keys are preserved; values are scrubbed. */
  value<T>(input: T): T {
    if (typeof input === 'string') return this.text(input) as unknown as T;
    if (Array.isArray(input)) return input.map((v) => this.value(v)) as unknown as T;
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        // A key that names a secret gets its value dropped regardless of shape — belt and
        // braces for values we never learned.
        out[k] = /password|secret|token|apikey|api_key/i.test(k) ? REDACTED : this.value(v);
      }
      return out as T;
    }
    return input;
  }

  get maskSelectors(): string[] {
    return this.policy.redaction.maskSelectors;
  }

  /** For tests and diagnostics: how many distinct secrets are being tracked. */
  get trackedCount(): number {
    return this.secrets.length;
  }
}
