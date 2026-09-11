/**
 * Per-step and failure evidence capture.
 *
 * Split from the run logger deliberately. The logger owns *structured events* and is
 * synchronous, cheap, and always on; this owns *artefacts of the page* — screenshots, the
 * DOM, the aria tree, the Playwright trace — which are expensive, asynchronous, and
 * sometimes unavailable. Keeping them apart is what lets the replay engine emit a complete
 * event stream while running against an in-memory fake surface in tests.
 *
 * Two rules govern everything here:
 *
 *  1. **Capture never breaks a run.** A screenshot that fails because the page navigated
 *     out from under it is a lost screenshot, not a lost transaction. Every method here
 *     swallows its own errors and records the miss in the event log instead.
 *  2. **Redaction happens on the way in, not on the way out.** Text goes through the
 *     logger's redactor at its write boundary; screenshots are masked by the surface at
 *     capture time, because pixels cannot be scrubbed afterwards.
 */

import type { Surface } from '../surface/surface.js';
import type { RunEvent, RunLogger } from './types.js';

/** What the engine needs. Narrow on purpose: the engine must not depend on a filesystem. */
export interface StepCapture {
  before(step: { id: string; index: number; intent: string }): Promise<void>;
  after(step: { id: string; index: number; intent: string }): Promise<void>;
}

/** The subset of `FileRunLogger` this needs, so tests can pass a fake. */
export interface EvidenceSink {
  screenshot(name: string, png: Buffer): string;
  write(name: string, content: string | Buffer): string;
  /** Absolute path a run-scoped file would occupy. Needed by writers that write themselves. */
  path(name: string): string;
}

function pad(index: number): string {
  return String(index).padStart(3, '0');
}

export class RunEvidence implements StepCapture {
  private captured = 0;

  constructor(
    private readonly surface: Surface,
    private readonly sink: EvidenceSink,
    private readonly runId: string,
    private readonly logger?: RunLogger,
    /** Off for fixture/CI runs where hundreds of PNGs are noise, on for the demo. */
    private readonly enabled = true,
  ) {}

  get screenshotCount(): number {
    return this.captured;
  }

  before(step: { id: string; index: number; intent: string }): Promise<void> {
    return this.step(step, 'before');
  }

  after(step: { id: string; index: number; intent: string }): Promise<void> {
    return this.step(step, 'after');
  }

  private async step(
    step: { id: string; index: number; intent: string },
    phase: 'before' | 'after',
  ): Promise<void> {
    if (!this.enabled) return;
    const name = `${pad(step.index)}-${phase}.png`;
    try {
      const bundle = await this.surface.capture();
      this.sink.screenshot(name, bundle.screenshot);
      this.captured += 1;
    } catch (error) {
      // A missing screenshot is worth a log line and nothing more.
      this.note({
        phase: 'error',
        stepId: step.id,
        intent: step.intent,
        detail: `capture ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * The failure bundle: everything needed to reconstruct what the page looked like at the
   * moment the run stopped, for someone who was not watching.
   *
   * `failure.png` is what a human looks at first; `failure.html` is what they diff against
   * the next release; `failure.aria.yaml` is the view the *locators* had, which is the one
   * that explains a LOCATOR_NOT_FOUND. All three, because each answers a different
   * question and the cheap moment to take them is this one.
   */
  async failure(detail?: string): Promise<string[]> {
    const written: string[] = [];
    try {
      const bundle = await this.surface.capture();
      written.push(this.sink.screenshot('failure.png', bundle.screenshot));
      written.push(this.sink.write('failure.html', bundle.html));
      written.push(this.sink.write('failure.aria.yaml', bundle.aria));
    } catch (error) {
      this.note({
        phase: 'error',
        detail: `failure capture failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    const trace = await this.trace();
    if (trace) written.push(trace);

    this.note({
      phase: 'run.end',
      detail: detail ? `failure evidence: ${detail}` : 'failure evidence written',
      data: { files: written.map((p) => p.split(/[\/]/).pop()) },
    });
    return written;
  }

  /**
   * The Playwright trace, when the surface has one.
   *
   * Optional on the interface rather than required: a Windows UIA adapter has no such
   * thing, and forcing every surface to pretend would be a worse lie than a missing file.
   */
  async trace(): Promise<string | undefined> {
    const save = this.surface.saveTrace?.bind(this.surface);
    if (!save) return undefined;
    try {
      const path = this.sink.path('trace.zip');
      return (await save(path)) ? path : undefined;
    } catch (error) {
      this.note({
        phase: 'error',
        detail: `trace save failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
  }

  private note(event: Omit<RunEvent, 'ts' | 'runId'>): void {
    void this.logger?.event({ ts: new Date().toISOString(), runId: this.runId, ...event });
  }
}

/** A capture that does nothing. Used by tests and by headless fixture runs. */
export const NO_CAPTURE: StepCapture = {
  async before() {},
  async after() {},
};
