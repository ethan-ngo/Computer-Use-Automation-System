/**
 * JSON evidence has to survive redaction as JSON.
 *
 * `write()` scrubs a *string*, which is right for an HTML capture and wrong for a
 * serialised document: the card-number pattern matches any run of 13–19 digits, and a
 * float like `0.8500000000000001` is exactly that. It produced `0.«redacted»` — an
 * artifact on disk that no longer parses. Structure first, then serialise.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRunLogger } from '../src/evidence/logger.js';
import { Redactor } from '../src/policy/redact.js';
import { loadPolicy } from '../src/policy/policy.js';

function logger() {
  const root = mkdtempSync(join(tmpdir(), 'evidence-json-'));
  const redactor = new Redactor(loadPolicy());
  redactor.learn('hunter2secret');
  return { log: new FileRunLogger('11111111-2222-3333-4444-555555555555', redactor, root), root };
}

describe('JSON evidence', () => {
  it('keeps a float with a card-length mantissa intact', () => {
    const { log } = logger();
    const path = log.writeJson('artifact.json', { steps: [{ confidence: 0.8500000000000001 }] });
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    expect(parsed.steps[0].confidence).toBe(0.8500000000000001);
  });

  it('still redacts secret values inside the document', () => {
    const { log } = logger();
    const path = log.writeJson('artifact.json', { note: 'the password is hunter2secret' });
    const text = readFileSync(path, 'utf-8');
    expect(text).not.toContain('hunter2secret');
    expect(JSON.parse(text).note).toContain('«redacted»');
  });

  it('still redacts a real card number written as a string', () => {
    const { log } = logger();
    const path = log.writeJson('artifact.json', { pan: '4111111111111111' });
    expect(JSON.parse(readFileSync(path, 'utf-8')).pan).toBe('«redacted»');
  });
});
