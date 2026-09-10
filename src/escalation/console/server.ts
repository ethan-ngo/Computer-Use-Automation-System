/**
 * The operator console.
 *
 * One page, a screenshot poll, and three buttons. That is not minimalism for its own
 * sake — it is the shape the problem actually has. The operator already has a real browser
 * window in front of them (the session is headed, and the handoff gives them the *same*
 * session rather than a fresh one), so the console's job is not to be a remote desktop.
 * Its job is to say what the automation wanted, take custody of the lease, and take the
 * answer back.
 *
 * The lease is the enforcement, not the UI. Pressing "Take control" moves the lease to
 * `human`, and from that moment `Surface.act()` throws for automation — it is *incapable*
 * of acting, not merely discouraged. The button is a view onto that state machine.
 */

import express, { type Express } from 'express';
import { createServer, type Server } from 'node:http';
import type { InterventionBroker, InterventionRequest } from '../broker.js';
import type { LeaseManager } from '../lease.js';
import type { Surface } from '../../surface/surface.js';
import { recordHumanSession, type HumanRecording } from '../human-recorder.js';
import { PAGE } from './page.js';

export interface ConsoleOptions {
  broker: InterventionBroker;
  leases: LeaseManager;
  surface: Surface;
  port?: number;
}

export interface RunningConsole {
  url: string;
  close: () => Promise<void>;
}

export async function startConsole(opts: ConsoleOptions): Promise<RunningConsole> {
  const app: Express = express();
  app.use(express.json({ limit: '256kb' }));

  // At most one recording at a time, because at most one human can hold the lease —
  // `takeControl` enforces that with a compare-and-swap, so this mirrors it rather than
  // inventing a second notion of "who is driving".
  let recording: HumanRecording | undefined;

  app.get('/', (_req, res) => {
    res.type('html').send(PAGE);
  });

  app.get('/api/state', (_req, res) => {
    res.json({
      lease: opts.leases.current,
      interventions: opts.broker.list().map(summarise),
    });
  });

  app.get('/api/interventions/:id', (req, res) => {
    const request = opts.broker.get(req.params.id);
    if (!request) {
      res.status(404).json({ error: 'no such intervention' });
      return;
    }
    res.json(request);
  });

  /** Live view. Polled rather than streamed: a screenshot every second is not a video. */
  app.get('/api/screenshot', async (_req, res) => {
    try {
      const evidence = await opts.surface.capture();
      res.type('png').send(evidence.screenshot);
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/interventions/:id/claim', async (req, res) => {
    const operator = String(req.body?.operator ?? 'operator');
    try {
      const request = opts.broker.claim(req.params.id, operator);
      // Compare-and-swap on the epoch the operator's page last saw, so two operators
      // racing on the same intervention produce a refusal rather than an interleaving.
      const expected = req.body?.epoch;
      opts.leases.takeControl(operator, typeof expected === 'number' ? expected : undefined);
      recording = await startRecording(opts.surface);
      res.json({ request, lease: opts.leases.current });
    } catch (error) {
      // A lease conflict is a normal outcome here, not a server fault: somebody else got
      // there first, and the page should say so rather than show a 500.
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/interventions/:id/resolve', async (req, res) => {
    const kind = String(req.body?.kind ?? 'completed');
    const note = String(req.body?.note ?? '');
    try {
      const captured = recording ? await recording.stop() : { actions: [] };
      recording = undefined;

      const resolution =
        kind === 'completed'
          ? ({ kind: 'completed' as const, note, actions: captured.actions })
          : kind === 'approved'
            ? ({ kind: 'approved' as const, note })
            : kind === 'declined'
              ? ({ kind: 'declined' as const, note })
              : ({ kind: 'abandoned' as const, note });

      const request = opts.broker.resolve(req.params.id, resolution);
      // Release before answering, so the automation that is waiting on `wait()` finds the
      // lease already back in its hands rather than racing the HTTP response.
      if (opts.leases.current.controller === 'human') {
        opts.leases.releaseToAutomation(`resolved by ${request.claimedBy ?? 'operator'}: ${kind}`);
      }
      res.json({ request, lease: opts.leases.current });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  const server: Server = createServer(app);
  const port = opts.port ?? 8788;
  await new Promise<void>((resolve) => server.listen(port, resolve));

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function startRecording(surface: Surface): Promise<HumanRecording | undefined> {
  // The recorder needs a Playwright page. A surface that does not expose one (the fake
  // used in tests, a future desktop adapter) simply is not recorded — the handoff itself
  // must still work, so this degrades rather than throws.
  const page = (surface as { page?: unknown }).page;
  if (!page) return undefined;
  return recordHumanSession(page as Parameters<typeof recordHumanSession>[0]);
}

/** The list view needs the headline, not the whole evidence bundle. */
function summarise(request: InterventionRequest) {
  const { screenshot: _screenshot, aria: _aria, ...rest } = request;
  return rest;
}
