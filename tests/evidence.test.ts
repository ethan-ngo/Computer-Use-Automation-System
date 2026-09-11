/**
 * Evidence capture.
 *
 * Two properties matter here and neither is about file formats:
 *
 *  1. **Capture never breaks a run.** Evidence is instrumentation. A screenshot that fails
 *     because the page navigated mid-capture must cost a log line, not a transaction — and
 *     the only way to know that is to make capture throw and watch the run finish anyway.
 *  2. **The before/after pair brackets the action and nothing else.** A pair taken either
 *     side of half a step is worse than no pair, because it looks authoritative.
 *
 * Plus the control-transfer timeline, which is tested where it is produced: the lease.
 */

import { describe, expect, it } from 'vitest';
import { replay } from '../src/replay/engine.js';
import { RunEvidence, NO_CAPTURE, type EvidenceSink } from '../src/evidence/capture.js';
import { Redactor } from '../src/policy/redact.js';
import { MemoryLogger } from '../src/evidence/types.js';
import { LeaseManager } from '../src/escalation/lease.js';
import { node } from './helpers/observation.js';
import { capability, css, policy } from './helpers/capability.js';
import { FakeSurface, fakeClock, page } from './helpers/fake-surface.js';
import type { Surface } from '../src/surface/surface.js';

const BASE = 'https://parabank.parasoft.com';

/** Records what was written, in order, without touching a disk. */
class MemorySink implements EvidenceSink {
  readonly written: string[] = [];
  screenshot(name: string): string {
    this.written.push(`steps/${name}`);
    return `/evidence/steps/${name}`;
  }
  write(name: string): string {
    this.written.push(name);
    return `/evidence/${name}`;
  }
  path(name: string): string {
    return `/evidence/${name}`;
  }
}

const BUTTON = node({ role: 'button', name: 'Continue', cssPath: '#continue' });

const LANDING = page({ url: `${BASE}/parabank/index.htm`, text: 'Welcome', nodes: [BUTTON] });
const NEXT = page({ url: `${BASE}/parabank/overview.htm`, text: 'Accounts Overview', nodes: [] });

function flow() {
  return capability({
    steps: [
      {
        id: 'step.continue',
        index: 0,
        intent: 'press continue',
        action: { type: 'click' },
        locator: css('#continue', 'the continue button'),
        checkpoint: { kind: 'textPresent', text: 'Accounts Overview' },
        timeoutMs: 5_000,
      },
    ],
    postcondition: { kind: 'textPresent', text: 'Accounts Overview' },
  });
}

function surfaceThatNavigates(): FakeSurface {
  return new FakeSurface({
    start: LANDING,
    onAct: (_action, surface) => {
      surface.current = NEXT;
    },
  });
}

/** Re-expose a `FakeSurface` through the interface, with one method swapped out. */
function wrap(surface: FakeSurface, override: Partial<Surface>): Surface {
  return {
    lease: surface.lease,
    observe: () => surface.observe(),
    matchCss: (s) => surface.matchCss(s),
    resolve: (l) => surface.resolve(l),
    act: (a) => surface.act(a),
    capture: () => surface.capture(),
    close: () => surface.close(),
    ...override,
  };
}

describe('per-step capture', () => {
  it('brackets the action: before, the act itself, then after', async () => {
    const surface = surfaceThatNavigates();
    const sink = new MemorySink();
    const order: string[] = [];

    const observed = wrap(surface, {
      act: async (action) => {
        order.push(`act:${action.type}`);
        return surface.act(action);
      },
    });

    const evidence = new RunEvidence(observed, sink, 'run-1');
    const capture = {
      before: async (step: { id: string; index: number; intent: string }) => {
        order.push('before');
        await evidence.before(step);
      },
      after: async (step: { id: string; index: number; intent: string }) => {
        order.push('after');
        await evidence.after(step);
      },
    };

    const result = await replay({
      capability: flow(),
      surface: observed,
      policy: policy(),
      redactor: new Redactor(policy()),
      baseUrl: BASE,
      clock: fakeClock(),
      pollMs: 100,
      capture,
    });

    expect(result.kind).toBe('success');
    expect(order).toEqual(['before', 'act:click', 'after']);
    expect(sink.written).toEqual(['steps/000-before.png', 'steps/000-after.png']);
  });

  it('lets the run finish when capture itself fails', async () => {
    const surface = surfaceThatNavigates();
    const sink = new MemorySink();
    const logger = new MemoryLogger();

    // The realistic failure: the page navigated out from under the screenshot.
    const broken = wrap(surface, {
      capture: () => Promise.reject(new Error('Target page, context or browser has been closed')),
    });

    const result = await replay({
      capability: flow(),
      surface: broken,
      policy: policy(),
      redactor: new Redactor(policy()),
      baseUrl: BASE,
      clock: fakeClock(),
      pollMs: 100,
      logger,
      capture: new RunEvidence(broken, sink, 'run-1', logger),
    });

    // Evidence is instrumentation. Losing it must not lose the run.
    expect(result.kind).toBe('success');
    expect(sink.written).toEqual([]);
    const complaints = logger.phases('error').map((e) => e.detail ?? '');
    expect(complaints.some((d) => d.includes('capture 000-before.png failed'))).toBe(true);
  });

  it('writes the whole failure bundle: the picture, the DOM, and the locators own view', async () => {
    const sink = new MemorySink();
    const evidence = new RunEvidence(surfaceThatNavigates(), sink, 'run-1');

    const files = await evidence.failure('CHECKPOINT_FAILED at step.continue');

    expect(sink.written).toEqual(['steps/failure.png', 'failure.html', 'failure.aria.yaml']);
    expect(files).toHaveLength(3);
  });

  it('reports no trace rather than an empty archive when the surface has none', async () => {
    const evidence = new RunEvidence(surfaceThatNavigates(), new MemorySink(), 'run-1');
    // A `FakeSurface` has no `saveTrace`, which is the honest state of a UIA adapter too.
    await expect(evidence.trace()).resolves.toBeUndefined();
  });

  it('saves the trace alongside the bundle when the surface records one', async () => {
    const sink = new MemorySink();
    const saved: string[] = [];
    const traced = wrap(surfaceThatNavigates(), {
      saveTrace: async (path: string) => {
        saved.push(path);
        return true;
      },
    });

    const files = await new RunEvidence(traced, sink, 'run-1').failure();

    expect(saved).toEqual(['/evidence/trace.zip']);
    expect(files).toContain('/evidence/trace.zip');
  });

  it('NO_CAPTURE is a real no-op, so a fixture run costs nothing', async () => {
    const result = await replay({
      capability: flow(),
      surface: surfaceThatNavigates(),
      policy: policy(),
      redactor: new Redactor(policy()),
      baseUrl: BASE,
      clock: fakeClock(),
      pollMs: 100,
      capture: NO_CAPTURE,
    });
    expect(result.kind).toBe('success');
  });
});

describe('the control-transfer timeline', () => {
  it('records every change of controller, because a sampled timeline is not a timeline', () => {
    const logger = new MemoryLogger();
    const leases = new LeaseManager('11111111-1111-4111-8111-111111111111').attachLogger(logger, 'run-1');

    leases.cedeToHuman('LOCATOR_AMBIGUOUS at step.pick-account');
    leases.takeControl('operator@bank', 1);
    leases.releaseToAutomation('step completed by hand');

    const transfers = logger.phases('control.transfer');
    expect(transfers.map((e) => (e.data as { controller: string }).controller)).toEqual([
      'automation', // session opened
      'none', // automation stuck, waiting for a human
      'human', // operator claimed it
      'automation', // handed back
    ]);
    // The epoch is what makes a stale resume token detectable, so it has to be in the log.
    expect(transfers.map((e) => (e.data as { epoch: number }).epoch)).toEqual([0, 1, 2, 3]);
    expect(transfers[1]?.detail).toContain('LOCATOR_AMBIGUOUS');
  });

  it('logs nothing when no logger is attached, so the lease still works in tests', () => {
    const leases = new LeaseManager('22222222-2222-4222-8222-222222222222');
    expect(() => leases.cedeToHuman('stuck')).not.toThrow();
    expect(leases.current.epoch).toBe(1);
  });
});
