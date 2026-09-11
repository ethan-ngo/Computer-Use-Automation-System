/**
 * The evidence writer.
 *
 * Every event passes through the redactor on the way to disk. That is the whole reason
 * this is a class wrapping a file handle rather than a `console.log`: there is one write
 * boundary, and redaction is applied at it, so no caller has to remember to scrub.
 *
 * JSONL rather than a structured log service, deliberately: a run log has to be readable
 * by a human doing an incident review with nothing but a text editor.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Redactor } from '../policy/redact.js';
import type { RunEvent, RunLogger } from './types.js';

export class FileRunLogger implements RunLogger {
  readonly dir: string;
  private readonly file: string;

  constructor(
    readonly runId: string,
    private readonly redactor: Redactor,
    root = process.cwd(),
  ) {
    this.dir = join(root, 'evidence', 'runs', runId);
    mkdirSync(join(this.dir, 'steps'), { recursive: true });
    this.file = join(this.dir, 'run.jsonl');
  }

  event(event: RunEvent): void {
    appendFileSync(this.file, JSON.stringify(this.redactor.value(event)) + '\n', 'utf-8');
  }

  /** Where a run-scoped file lives, for writers that produce the file themselves. */
  path(name: string): string {
    return join(this.dir, name);
  }

  /** Any run-scoped document — the discovery log, the recorded artifact, a failure page. */
  write(name: string, content: string | Buffer): string {
    const path = join(this.dir, name);
    writeFileSync(path, typeof content === 'string' ? this.redactor.text(content) : content);
    return path;
  }

  /**
   * Any run-scoped JSON document.
   *
   * Redaction happens on the *structure*, then the result is serialised — never the other
   * way round. Scrubbing serialised JSON as text treats numbers as candidate secrets, and
   * the card-number pattern (13-19 digits) matches the mantissa of an ordinary float:
   * a step `confidence` of `0.8500000000000001` was written as `0.«redacted»`, which is
   * not JSON at all. The recorded artifact is the deliverable of a discovery run, so an
   * artifact that no longer parses is the whole run lost.
   */
  writeJson(name: string, value: unknown): string {
    const path = join(this.dir, name);
    writeFileSync(path, JSON.stringify(this.redactor.value(value), null, 2), 'utf-8');
    return path;
  }

  /** Screenshots are bytes, not text: masking happens at capture, not here. */
  screenshot(name: string, png: Buffer): string {
    const path = join(this.dir, 'steps', name);
    writeFileSync(path, png);
    return path;
  }
}
