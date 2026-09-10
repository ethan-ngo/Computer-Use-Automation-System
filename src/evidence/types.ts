/**
 * The run-log event shape.
 *
 * Defined here, next to the evidence writer that will consume it, but *depended on* by the
 * replay engine — the engine emits events and never touches a filesystem. That keeps the
 * engine testable with an in-memory sink, and it is what lets the same event stream feed
 * both the JSONL log and the live operator console.
 */

export type RunPhase =
  | 'run.start'
  | 'run.end'
  | 'step.start'
  | 'step.wait'
  | 'step.resolve'
  | 'step.act'
  | 'step.checkpoint'
  | 'step.extract'
  | 'step.recover'
  | 'step.end'
  | 'outcome.detected'
  | 'approval.requested'
  | 'control.transfer'
  | 'error';

export interface RunEvent {
  ts: string;
  phase: RunPhase;
  runId: string;
  stepId?: string;
  /** The human-readable intent of the step, so a log line is legible without the artifact. */
  intent?: string;
  action?: string;
  url?: string;
  /** Which locator strategy actually resolved, and whether it was a fallback. */
  strategy?: string;
  fallbackIndex?: number;
  degraded?: boolean;
  durationMs?: number;
  outcome?: string;
  errorClass?: string;
  detail?: string;
  data?: Record<string, unknown>;
}

export interface RunLogger {
  event(event: RunEvent): void | Promise<void>;
}

/** Collects events in memory. Used by tests and by the operator console. */
export class MemoryLogger implements RunLogger {
  readonly events: RunEvent[] = [];
  event(event: RunEvent): void {
    this.events.push(event);
  }
  phases(phase: RunEvent['phase']): RunEvent[] {
    return this.events.filter((e) => e.phase === phase);
  }
}
