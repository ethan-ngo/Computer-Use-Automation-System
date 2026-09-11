/**
 * `npm run operator` — replay a capability with a human in the loop.
 *
 * This is the M8 demo path and the honest one: the same replay engine as `npm run replay`,
 * but every escalation and every approval gate is routed to the console instead of failing
 * the run. When the operator answers, the flow resumes — and the resume re-derives where it
 * is rather than trusting what it was told.
 *
 *   npm run operator -- --capability parabank.open-new-savings-account --tenant demo-bank
 */

import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import { loadPolicy } from '../policy/policy.js';
import { Redactor } from '../policy/redact.js';
import { LeaseManager } from '../escalation/lease.js';
import { PlaywrightWebSurface } from '../surface/playwright-web.js';
import { FileRunLogger } from '../evidence/logger.js';
import { RunEvidence } from '../evidence/capture.js';
import { loadResolved } from '../artifact/store.js';
import { ReplayEngine, type ReplayResult } from '../replay/engine.js';
import {
  InterventionBroker,
  issueResumeToken,
  recogniseResumeState,
  requestFromEscalation,
  verifyResumeToken,
  type InterventionResolution,
} from '../escalation/broker.js';
import { startConsole } from '../escalation/console/server.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value && !value.startsWith('--') ? value : fallback;
}

async function main(): Promise<void> {
  const capabilityId = arg('capability');
  if (!capabilityId) throw new Error('--capability is required');
  const tenantId = arg('tenant');
  const runId = randomUUID();
  const headless = process.argv.includes('--headless');

  const policy = loadPolicy();
  const redactor = new Redactor(policy).learnFromEnv();
  const logger = new FileRunLogger(runId, redactor);
  // The control-transfer timeline is the deliverable this CLI exists to produce, so the
  // lease logs itself from the moment the session opens.
  const leases = new LeaseManager(runId).attachLogger(logger, runId);
  const broker = new InterventionBroker({ logger, redactor, ttlMs: Number(arg('ttl', '900000')) });

  const capability = await loadResolved(capabilityId, tenantId);
  const baseUrl = capability.baseUrl ?? arg('base-url', 'https://parabank.parasoft.com')!;

  const surface = await PlaywrightWebSurface.launch({
    policy,
    redactor,
    leases,
    extraOrigins: [baseUrl],
    // Headed by default. The whole point of a handoff is that the operator gets *this*
    // session, with its cookies and its half-filled form — not a fresh one.
    headless,
    // Opt-in: see the note in replay.ts. A trace of an *intervention* is the worst case —
    // it would capture what the human typed, which the human-action recorder goes out of
    // its way to reduce to a shape before it ever leaves the page.
    trace: process.argv.includes('--trace'),
  });

  // The surface is already open, and the `finally` that closes it only covers the loop
  // below — so a console that cannot bind has to clean up the browser on its way out.
  const ui = await startConsole({
    broker,
    leases,
    surface,
    port: Number(arg('port', '8788')),
  }).catch(async (error) => {
    await surface.close();
    throw error;
  });

  console.log(`run ${runId}`);
  console.log(`  capability: ${capability.artifact.id}@${capability.artifact.version}`);
  console.log(`  tenant:     ${tenantId ?? '(none)'}`);
  console.log(`  console:    ${ui.url}`);
  console.log(`  logs:       ${relative(process.cwd(), logger.dir)}\n`);

  const evidence = new RunEvidence(surface, logger, runId, logger);

  const inputs = Object.fromEntries(
    process.argv
      .filter((a, i) => process.argv[i - 1] === '--input')
      .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
  );

  const goal = capability.artifact.description;
  const completedSteps: string[] = [];
  let startAtStepId: string | undefined;

  try {
    for (let attempt = 1; ; attempt++) {
      const engine = new ReplayEngine({
        capability,
        surface,
        policy,
        redactor,
        inputs,
        baseUrl,
        runId,
        logger,
        capture: evidence,
        completedSteps: [...completedSteps],
        ...(startAtStepId ? { startAtStepId } : {}),
        // The approval gate routes through the same broker as an error escalation, so an
        // operator sees one queue rather than two mechanisms that happen to both need them.
        approve: async (step, observation) => {
          const request = broker.open(
            requestFromEscalation({
              runId,
              sessionId: leases.current.sessionId,
              goal,
              artifact: capability.artifact,
              ...(tenantId ? { tenantId } : {}),
              evidencePath: logger.dir,
              escalation: {
                atStepId: step.id,
                intent: step.intent,
                reason: 'approval_required',
                expected: `approval to perform an irreversible step: ${step.intent}`,
                observed: `page is "${observation.title}" at ${observation.url}`,
                url: observation.url,
              },
              ...(await evidenceFor(surface)),
            }),
          );
          console.log(`  approval needed for "${step.intent}" → ${ui.url} (${request.id})`);
          const resolution = await broker.wait(request.id);
          return resolution.kind === 'approved' || resolution.kind === 'completed';
        },
      });

      const result: ReplayResult = await engine.run();

      if (result.kind !== 'escalated') {
        report(result, logger);
        if (result.kind === 'failed') await evidence.failure(`failed at ${result.atStepId}`);
        return;
      }

      // ---- the handoff -------------------------------------------------
      const request = broker.open(
        requestFromEscalation({
          runId,
          sessionId: leases.current.sessionId,
          goal,
          artifact: capability.artifact,
          ...(tenantId ? { tenantId } : {}),
          evidencePath: logger.dir,
          escalation: result,
          ...(await evidenceFor(surface)),
        }),
      );
      console.log(`\n  escalated at "${result.intent}" → ${ui.url} (intervention ${request.id})`);
      console.log(`    expected: ${result.expected}`);
      console.log(`    observed: ${result.observed}`);

      const resolution: InterventionResolution = await broker.wait(request.id);
      console.log(`  operator: ${resolution.kind}${resolution.note ? ` — ${resolution.note}` : ''}`);

      if (resolution.kind === 'declined' || resolution.kind === 'abandoned') {
        console.log('\nrun ended by the operator.');
        return;
      }

      // ---- the resume ----------------------------------------------------
      /*
       * The token is issued *here*, once control is back with automation — not when the
       * intervention opened.
       *
       * Issuing it earlier looks more careful and is in fact useless: the handoff itself
       * moves the lease twice (take, release), so a token pinned to the pre-handoff epoch
       * is guaranteed stale by the time it is used, and the check would have to be
       * weakened to nothing to let a legitimate resume through. Pinned at the point of
       * return, the epoch means something precise and falsifiable: *no further transfer
       * has happened between the operator handing this session back and the automation
       * picking it up*. A second operator grabbing the session in that window moves the
       * epoch and the resume is refused.
       */
      const token = issueResumeToken({
        runId,
        sessionId: leases.current.sessionId,
        stepId: result.atStepId,
        artifactId: capability.artifact.id,
        artifactVersion: capability.artifact.version,
        leaseEpoch: leases.current.epoch,
      });

      const step = verifyResumeToken(token, {
        runId,
        lease: leases.current,
        artifact: capability.artifact,
        steps: capability.steps,
      });

      const state = await recogniseResumeState(step, surface, capability.outcomes, (s) =>
        surface.matchCss(s),
      );
      await logger.event({
        ts: new Date().toISOString(),
        phase: 'control.transfer',
        runId,
        stepId: step.id,
        intent: step.intent,
        detail: `resume state: ${state.kind}`,
        data: { detail: 'detail' in state ? state.detail : undefined },
      });

      if (state.kind === 'completed_by_human') {
        console.log(`  resume: ${state.detail} — advancing past "${step.intent}"`);
        completedSteps.push(step.id);
        startAtStepId = step.id;
        continue;
      }
      if (state.kind === 'outcome') {
        console.log(`\nbusiness outcome after handoff: ${state.hit.name} — ${state.hit.description}`);
        return;
      }
      if (state.kind === 'retry') {
        console.log(`  resume: ${state.detail} — retrying "${step.intent}"`);
        startAtStepId = step.id;
        continue;
      }

      console.log(`\nRESUME_STATE_UNRECOGNIZED: ${state.detail}`);
      console.log('Refusing to guess where the flow is. The run ends here; evidence is on disk.');
      return;
    }
  } finally {
    await ui.close();
    await surface.close();
  }
}

async function evidenceFor(surface: Parameters<typeof startConsole>[0]['surface']) {
  try {
    const bundle = await surface.capture();
    return { screenshot: bundle.screenshot.toString('base64'), aria: bundle.aria };
  } catch {
    return {};
  }
}

function report(result: ReplayResult, logger: FileRunLogger): void {
  console.log(`\n${result.kind}`);
  for (const step of result.steps) {
    const strategy = step.strategy ? ` [${step.strategy}${step.degraded ? ' — degraded' : ''}]` : '';
    console.log(`  ${step.status.padEnd(18)} ${step.intent}${strategy}`);
  }
  if (result.kind === 'business_outcome') {
    console.log(`\n  ${result.outcome.name}: ${result.outcome.description}`);
  }
  if (Object.keys(result.outputs).length > 0) {
    console.log(`\n  outputs: ${JSON.stringify(result.outputs)}`);
  }
  logger.writeJson('result.json', result);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
