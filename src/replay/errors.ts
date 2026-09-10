/**
 * The replay error taxonomy.
 *
 * The taxonomy is the contract between the engine and everything downstream of it: the
 * recovery specs in the artifact match on `when`, the escalation broker routes on the
 * class, and the evidence log aggregates on it. So the classes are closed and named here
 * rather than being ad-hoc strings raised at the point of failure.
 *
 * The distinction the whole design turns on is *not* expressed here: a business outcome
 * ("insufficient funds") is not an error at all and never becomes one. It is declared in
 * the artifact and returned as a result. Everything in this file is the automation, the
 * session, or the app misbehaving.
 */

export type ReplayErrorClass =
  /** No strategy in the chain matched. Usually drift; routes to a human. */
  | 'LOCATOR_NOT_FOUND'
  /** A strategy matched more than one element. Never guessed at; routes to a human. */
  | 'LOCATOR_AMBIGUOUS'
  /** We acted, but the state we asserted afterwards never arrived. */
  | 'CHECKPOINT_FAILED'
  /** A precondition, a checkpoint, or a budget ran out of time. */
  | 'TIMEOUT'
  /** The app bounced us back to a login screen mid-flow. Recoverable exactly once. */
  | 'SESSION_EXPIRED'
  /** A modal we did not declare appeared. Blocking, so it is surfaced rather than dismissed. */
  | 'UNEXPECTED_DIALOG'
  /** The guardrail layer refused the action. Never retried. */
  | 'POLICY_DENIED'
  /** Navigation left the allowlisted origin or route. Never retried. */
  | 'NAVIGATION_BLOCKED'
  /** The application itself reported a fault (a 500, a stack trace on the page). */
  | 'APP_ERROR'
  /** The page is neither what we expected nor any declared outcome. The drift signal. */
  | 'STRUCTURAL_DIVERGENCE'
  /** After a human handoff, the state we resumed into matches nothing we can act on. */
  | 'RESUME_STATE_UNRECOGNIZED';

/**
 * How the engine treats each class when no `onError` spec matches.
 *
 *  - `escalate` — a human can plausibly fix this in the live session (drift, ambiguity,
 *    an unrecognised page). The session stays open and the lease is offered up.
 *  - `fail` — a human in the browser cannot help. A denied policy is a decision, not a
 *    puzzle; a budget exhaustion needs a smaller job, not a person.
 */
export const DISPOSITION: Record<ReplayErrorClass, 'escalate' | 'fail'> = {
  LOCATOR_NOT_FOUND: 'escalate',
  LOCATOR_AMBIGUOUS: 'escalate',
  CHECKPOINT_FAILED: 'escalate',
  TIMEOUT: 'escalate',
  SESSION_EXPIRED: 'escalate',
  UNEXPECTED_DIALOG: 'escalate',
  STRUCTURAL_DIVERGENCE: 'escalate',
  RESUME_STATE_UNRECOGNIZED: 'escalate',
  POLICY_DENIED: 'fail',
  NAVIGATION_BLOCKED: 'fail',
  APP_ERROR: 'fail',
};

export class ReplayError extends Error {
  readonly class: ReplayErrorClass;
  /** Redacted before it is written anywhere. Carried into the escalation payload. */
  readonly context: Record<string, unknown>;

  constructor(cls: ReplayErrorClass, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.class = cls;
    this.name = `ReplayError[${cls}]`;
    this.context = context;
  }
}

/** Budget exhaustion. Separate constructor so the budget name is always recorded. */
export class BudgetExceededError extends ReplayError {
  constructor(
    readonly budget: 'steps' | 'wallClock' | 'retries',
    message: string,
  ) {
    super('TIMEOUT', message, { budget });
    this.name = 'BudgetExceededError';
  }
}

/**
 * Normalises anything thrown beneath the engine into the taxonomy.
 *
 * Errors that already carry a class keep it. Everything else becomes `APP_ERROR` rather
 * than being silently swallowed or re-raised untyped — an unclassified failure is still a
 * failure, and it should show up in the aggregates as one.
 */
export function asReplayError(err: unknown): ReplayError {
  if (err instanceof ReplayError) return err;

  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);

  if (name === 'PolicyDeniedError') {
    const rule = (err as { rule?: string }).rule ?? '';
    return new ReplayError(
      rule.startsWith('origin') || rule.startsWith('path') || rule.startsWith('scheme')
        ? 'NAVIGATION_BLOCKED'
        : 'POLICY_DENIED',
      message,
      { rule },
    );
  }
  if (name === 'LeaseDeniedError') {
    // Automation tried to act while a human held the session. That is the lease doing its
    // job, and it is a policy decision, not a puzzle for another human to solve.
    return new ReplayError('POLICY_DENIED', message, { lease: (err as { lease?: unknown }).lease });
  }

  return new ReplayError('APP_ERROR', message, { originalName: name });
}
