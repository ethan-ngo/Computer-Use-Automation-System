import { describe, expect, it } from 'vitest';
import { coerce, extractOne, parseDate, parseNumber, DEFAULT_LOCALE } from '../src/replay/extract.js';
import { ExtractSpecSchema } from '../src/artifact/schema.js';
import { node, observation } from './helpers/observation.js';
import { css } from './helpers/capability.js';

const EN = DEFAULT_LOCALE;
const DE = { number: 'de-DE', date: 'dd.MM.yyyy', currency: 'EUR' };

describe('locale-aware parsing', () => {
  it('reads the same string as two different amounts under two locales', () => {
    // This is the silent-corruption case the typed extraction exists to prevent: read
    // under the wrong locale, "1.234,56" is off by a factor of a thousand.
    expect(parseNumber('1.234,56', 'de-DE')).toBe(1234.56);
    expect(parseNumber('1,234.56', 'en-US')).toBe(1234.56);
  });

  it('strips currency decoration', () => {
    expect(parseNumber('$1,234.56', 'en-US')).toBe(1234.56);
    expect(parseNumber('-$45.00', 'en-US')).toBe(-45);
  });

  it('raises rather than guessing at an unreadable number', () => {
    expect(() => parseNumber('n/a', 'en-US')).toThrow(/could not read/);
  });

  it('reads a date under the tenant pattern rather than under Date.parse guesswork', () => {
    expect(parseDate('03/04/2026', 'MM/dd/yyyy')).toBe('2026-03-04');
    expect(parseDate('03.04.2026', 'dd.MM.yyyy')).toBe('2026-04-03');
  });

  it('raises on a date it cannot read', () => {
    expect(() => parseDate('sometime in March', 'MM/dd/yyyy')).toThrow(/could not read/);
  });

  it('coerces by the declared type', () => {
    const spec = (as: string) => ExtractSpecSchema.parse({ name: 'v', from: css('x'), as });
    expect(coerce('12345', spec('string'), EN)).toBe('12345');
    expect(coerce('1.234,56', spec('money'), DE)).toBe(1234.56);
    expect(coerce('yes', spec('boolean'), EN)).toBe(true);
    expect(coerce('off', spec('boolean'), EN)).toBe(false);
  });
});

describe('extraction against an observation', () => {
  const confirmation = observation({
    nodes: [
      node({ role: 'link', name: 'Your new account number is 13566', cssPath: 'a#newAccountId' }),
      node({ role: 'generic', name: 'Balance: $1,250.00', cssPath: 'td#balance' }),
    ],
  });

  it('pulls a value out of surrounding prose with the capture group', async () => {
    const spec = ExtractSpecSchema.parse({
      name: 'newAccountNumber',
      from: css('a#newAccountId'),
      as: 'string',
      pattern: '(\\d{3,})',
    });
    const matchCss = async (selector: string) =>
      confirmation.nodes.filter((n) => n.cssPath === selector);

    expect(await extractOne(spec, confirmation, EN, matchCss)).toBe('13566');
  });

  it('treats an unmatched pattern as a failure, not an empty result', async () => {
    const spec = ExtractSpecSchema.parse({
      name: 'newAccountNumber',
      from: css('a#newAccountId'),
      as: 'string',
      pattern: '^ACCT-(\\w+)$',
    });
    const matchCss = async (selector: string) =>
      confirmation.nodes.filter((n) => n.cssPath === selector);

    // The artifact promised this output to its caller. Not finding it means the capability
    // cannot honour its contract, which is louder than returning undefined.
    await expect(extractOne(spec, confirmation, EN, matchCss)).rejects.toThrow(/did not match/);
  });

  it('parses money through the tenant locale', async () => {
    const spec = ExtractSpecSchema.parse({
      name: 'balance',
      from: css('td#balance'),
      as: 'money',
      pattern: '([\\d.,]+)',
    });
    const matchCss = async (selector: string) =>
      confirmation.nodes.filter((n) => n.cssPath === selector);

    expect(await extractOne(spec, confirmation, EN, matchCss)).toBe(1250);
  });
});
