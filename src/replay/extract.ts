/**
 * Typed extraction.
 *
 * Reading a value off a page is the point at which an automation quietly becomes wrong:
 * "1.234,56" is a thousand times "1.234" if you guess the locale, and "03/04/2026" is two
 * different days depending on the institution. So extraction is declared with a type in
 * the artifact, and the *tenant* supplies the locale — the vendor product knows the field
 * is money, the institution knows how money is written there.
 */

import type { ExtractSpec, TenantBinding } from '../artifact/schema.js';
import type { Observation } from '../surface/types.js';
import { resolveLocator, type CssMatcher } from './locator.js';
import { ReplayError } from './errors.js';

export type Locale = TenantBinding['locale'];

export const DEFAULT_LOCALE: Locale = { number: 'en-US', date: 'MM/dd/yyyy', currency: 'USD' };

export type ExtractedValue = string | number | boolean;

/** The raw text a node contributes: its value if it has one, else its accessible name. */
function textOf(node: { value?: string; name: string; labelHint?: string }): string {
  const raw = node.value && node.value.length > 0 ? node.value : node.name;
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Whether this locale writes numbers as 1.234,56 rather than 1,234.56. Derived from the
 * locale tag via `Intl` rather than from a hand-maintained list, so a tenant can name any
 * locale and get the right separators.
 */
function decimalSeparator(locale: string): '.' | ',' {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1.1);
    const decimal = parts.find((p) => p.type === 'decimal');
    return decimal?.value === ',' ? ',' : '.';
  } catch {
    return '.';
  }
}

export function parseNumber(raw: string, locale: string): number {
  const separator = decimalSeparator(locale);
  // Strip currency symbols, spaces and grouping marks, then normalise the decimal mark.
  const cleaned =
    separator === ','
      ? raw.replace(/[^\d,\-]/g, '').replace(',', '.')
      : raw.replace(/[^\d.\-]/g, '');
  // `Number('')` is 0, so an empty result must be rejected explicitly. Silently reading an
  // unreadable field as zero is the exact class of corruption this module exists to
  // prevent — a balance of "n/a" is not a balance of nothing.
  const value = /\d/.test(cleaned) ? Number(cleaned) : Number.NaN;
  if (!Number.isFinite(value)) {
    throw new ReplayError('APP_ERROR', `could not read "${raw}" as a number in locale ${locale}`);
  }
  return value;
}

/**
 * Parses a date under the tenant's declared pattern into an ISO date.
 *
 * Deliberately pattern-driven and deliberately strict: an unparseable date raises rather
 * than falling back to `Date.parse`, whose guesses are exactly the silent locale bug this
 * exists to prevent.
 */
export function parseDate(raw: string, pattern: string): string {
  const order = (pattern.match(/MM|dd|yyyy/g) ?? []) as ('MM' | 'dd' | 'yyyy')[];
  const digits = raw.match(/\d+/g) ?? [];
  if (order.length !== 3 || digits.length < 3) {
    throw new ReplayError('APP_ERROR', `could not read "${raw}" as a date in format ${pattern}`);
  }
  const field: Record<string, string> = {};
  order.forEach((part, i) => (field[part] = digits[i]!));
  const year = (field.yyyy ?? '').padStart(4, '20');
  return `${year}-${(field.MM ?? '').padStart(2, '0')}-${(field.dd ?? '').padStart(2, '0')}`;
}

export function coerce(raw: string, spec: ExtractSpec, locale: Locale): ExtractedValue {
  switch (spec.as) {
    case 'string':
      return raw;
    case 'number':
      return parseNumber(raw, locale.number);
    case 'money':
      // Money is a number here, not a decimal type. Stated as a known simplification in
      // REPORT.md rather than pretended away: a real ledger integration wants minor units.
      return parseNumber(raw, locale.number);
    case 'date':
      return parseDate(raw, locale.date);
    case 'boolean':
      return /^(true|yes|y|1|on|checked)$/i.test(raw.trim());
  }
}

/**
 * Runs one extraction against an observation.
 *
 * The locator failing here is a real failure, not an empty result: the artifact declares
 * this value as part of its contract, so not finding it means the capability cannot honour
 * what it promised the caller.
 */
export async function extractOne(
  spec: ExtractSpec,
  observation: Observation,
  locale: Locale = DEFAULT_LOCALE,
  matchCss?: CssMatcher,
): Promise<ExtractedValue> {
  const resolution = await resolveLocator(observation, spec.from, matchCss);
  let raw = textOf(resolution.node);

  if (spec.pattern) {
    const match = new RegExp(spec.pattern).exec(raw);
    if (!match) {
      throw new ReplayError(
        'APP_ERROR',
        `extraction "${spec.name}" found "${spec.from.description}" but its text ` +
          `"${raw}" did not match /${spec.pattern}/`,
        { extract: spec.name },
      );
    }
    // Capture group 1 when the pattern has one, else the whole match — so a pattern can
    // either pull a value out of prose or simply validate the shape of the whole field.
    raw = match[1] ?? match[0];
  }

  return coerce(raw, spec, locale);
}

/** Runs a list of extractions, returning them keyed by name. */
export async function extractAll(
  specs: ExtractSpec[],
  observation: Observation,
  locale: Locale = DEFAULT_LOCALE,
  matchCss?: CssMatcher,
): Promise<Record<string, ExtractedValue>> {
  const out: Record<string, ExtractedValue> = {};
  for (const spec of specs) {
    out[spec.name] = await extractOne(spec, observation, locale, matchCss);
  }
  return out;
}
