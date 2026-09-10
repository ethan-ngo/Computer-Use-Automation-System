/**
 * An in-memory `Surface`.
 *
 * The engine is deliberately written against the `Surface` interface and nothing else, so
 * every behaviour that matters — outcome precedence, recovery, budgets, the approval gate,
 * resume — is testable with no browser, no network and no clock. That is not a testing
 * convenience bolted on afterwards; it is the same seam that lets a Windows UIA adapter
 * slot in, exercised.
 */

import { createHash } from 'node:crypto';
import type { Surface } from '../../src/surface/surface.js';
import type {
  ActionResult,
  EvidenceBundle,
  Observation,
  Resolution,
  SessionLease,
  SurfaceAction,
  UiNode,
} from '../../src/surface/types.js';
import type { Locator } from '../../src/artifact/schema.js';
import { resolveLocator } from '../../src/replay/locator.js';
import type { Clock } from '../../src/replay/engine.js';

export interface FakePage {
  url?: string;
  title?: string;
  text?: string;
  nodes?: UiNode[];
}

export function page(spec: FakePage): Observation {
  const nodes = spec.nodes ?? [];
  return {
    url: spec.url ?? 'https://parabank.parasoft.com/parabank/index.htm',
    title: spec.title ?? 'ParaBank',
    nodes,
    text: spec.text ?? nodes.map((n) => `${n.labelHint ?? ''} ${n.name} ${n.value ?? ''}`).join(' '),
    ariaHash: createHash('sha1')
      .update(JSON.stringify(nodes.map((n) => [n.role, n.name])))
      .digest('hex'),
    capturedAt: '2026-01-01T00:00:00.000Z',
  };
}

export interface FakeSurfaceOptions {
  start: Observation;
  /** Called after every accepted action; the usual job is to move `surface.current` on. */
  onAct?: (action: SurfaceAction, surface: FakeSurface) => void;
  /** Throw from `act()` to simulate the chokepoint refusing (policy, lease). */
  actThrows?: (action: SurfaceAction) => Error | undefined;
  lease?: Partial<SessionLease>;
}

export class FakeSurface implements Surface {
  current: Observation;
  readonly acted: SurfaceAction[] = [];
  observations = 0;
  closed = false;

  constructor(private readonly opts: FakeSurfaceOptions) {
    this.current = opts.start;
  }

  get lease(): SessionLease {
    return {
      sessionId: 'fake-session',
      controller: 'automation',
      epoch: 0,
      since: '2026-01-01T00:00:00.000Z',
      reason: 'test',
      ...this.opts.lease,
    };
  }

  async observe(): Promise<Observation> {
    this.observations += 1;
    return this.current;
  }

  async matchCss(selector: string): Promise<UiNode[]> {
    return this.current.nodes.filter((n) => n.cssPath === selector);
  }

  async resolve(locator: Locator): Promise<Resolution> {
    return resolveLocator(this.current, locator, (s) => this.matchCss(s));
  }

  async act(action: SurfaceAction): Promise<ActionResult> {
    const failure = this.opts.actThrows?.(action);
    if (failure) throw failure;
    this.acted.push(action);
    this.opts.onAct?.(action, this);
    return { ok: true, url: this.current.url, durationMs: 1 };
  }

  async capture(): Promise<EvidenceBundle> {
    return {
      screenshot: Buffer.from(''),
      html: '<html></html>',
      aria: '',
      url: this.current.url,
      title: this.current.title,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A clock that only moves when the engine sleeps, so timeouts cost no real time. */
export function fakeClock(): Clock & { elapsed: () => number } {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    elapsed: () => t,
  };
}
