/**
 * The console has to bind a port before the operator can be handed anything, and that bind
 * is the one part of the startup that depends on the machine rather than on the artifact.
 * A leftover `npm run operator` from an earlier session is the ordinary case — so a busy
 * port must fail as a rejected promise the CLI can explain, not as an unhandled 'error'
 * event that takes the process (and the browser it already launched) down with it.
 */

import { describe, expect, it } from 'vitest';
import { startConsole } from '../src/escalation/console/server.js';
import { InterventionBroker } from '../src/escalation/broker.js';
import { LeaseManager } from '../src/escalation/lease.js';
import { MemoryLogger } from '../src/evidence/types.js';
import { loadPolicy } from '../src/policy/policy.js';
import { Redactor } from '../src/policy/redact.js';
import { FakeSurface, page } from './helpers/fake-surface.js';
import type { Surface } from '../src/surface/surface.js';

function options(port: number) {
  const logger = new MemoryLogger();
  return {
    broker: new InterventionBroker({ logger, redactor: new Redactor(loadPolicy()) }),
    leases: new LeaseManager(),
    surface: new FakeSurface({ start: page({}) }) as unknown as Surface,
    port,
  };
}

describe('console server startup', () => {
  it('rejects with an actionable message when the port is already taken', async () => {
    const first = await startConsole(options(0));
    const port = Number(new URL(first.url).port);

    try {
      await expect(startConsole(options(port))).rejects.toThrow(
        new RegExp(`port ${port} is already in use`, 'i'),
      );
    } finally {
      await first.close();
    }
  });

  it('reports the port it actually bound', async () => {
    const running = await startConsole(options(0));
    expect(Number(new URL(running.url).port)).toBeGreaterThan(0);
    await running.close();
  });
});
