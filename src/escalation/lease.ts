/**
 * The session lease — the mechanism that makes control transfer *enforced* rather than
 * conventional.
 *
 * `Surface.act()` gates on this. While the controller is `human`, automation is incapable
 * of acting; it does not politely refrain. That check lives at the same chokepoint as the
 * policy check, so there is exactly one place in the codebase where an action can happen
 * and it enforces both.
 *
 * `epoch` increments on every transfer, which is what makes a stale resume token
 * detectable rather than replayable.
 */

import { randomUUID } from 'node:crypto';
import type { SessionLease } from '../surface/types.js';

export class LeaseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseConflictError';
  }
}

export class LeaseManager {
  private state: SessionLease;
  private readonly listeners = new Set<(lease: SessionLease) => void>();

  constructor(sessionId = randomUUID()) {
    this.state = {
      sessionId,
      controller: 'automation',
      epoch: 0,
      since: new Date().toISOString(),
      reason: 'session started under automation control',
    };
  }

  get current(): SessionLease {
    return { ...this.state };
  }

  get heldByAutomation(): boolean {
    return this.state.controller === 'automation';
  }

  onChange(listener: (lease: SessionLease) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private transition(next: Omit<SessionLease, 'sessionId' | 'epoch' | 'since'>): SessionLease {
    this.state = {
      ...next,
      sessionId: this.state.sessionId,
      epoch: this.state.epoch + 1,
      since: new Date().toISOString(),
    };
    for (const listener of this.listeners) listener(this.current);
    return this.current;
  }

  /** Automation cedes control because it is stuck, or because a step needs approval. */
  cedeToHuman(reason: string, expiresInMs?: number): SessionLease {
    return this.transition({
      controller: 'none',
      reason,
      expiresAt: expiresInMs ? new Date(Date.now() + expiresInMs).toISOString() : undefined,
    });
  }

  /**
   * An operator takes control. Compare-and-swap on a single holder: a second operator is
   * denied rather than interleaved, because two humans driving one browser session is a
   * genuine hazard.
   */
  takeControl(holder: string, expectedEpoch?: number): SessionLease {
    if (expectedEpoch !== undefined && expectedEpoch !== this.state.epoch) {
      throw new LeaseConflictError(
        `lease moved on: expected epoch ${expectedEpoch}, current is ${this.state.epoch}`,
      );
    }
    if (this.state.controller === 'human') {
      throw new LeaseConflictError(
        `session is already controlled by ${this.state.holder ?? 'another operator'}`,
      );
    }
    return this.transition({
      controller: 'human',
      holder,
      reason: `taken by ${holder}`,
    });
  }

  /** The operator hands the session back. */
  releaseToAutomation(note = 'released by operator'): SessionLease {
    if (this.state.controller !== 'human') {
      throw new LeaseConflictError('only a human-held lease can be released to automation');
    }
    return this.transition({ controller: 'automation', reason: note });
  }

  /**
   * An unclaimed intervention must resolve into a definite terminal state rather than
   * pinning a browser session open forever.
   */
  expireIfDue(now = Date.now()): SessionLease | undefined {
    if (!this.state.expiresAt) return undefined;
    if (this.state.controller === 'human') return undefined;
    if (Date.parse(this.state.expiresAt) > now) return undefined;
    return this.transition({
      controller: 'none',
      reason: 'intervention expired unclaimed',
    });
  }
}
