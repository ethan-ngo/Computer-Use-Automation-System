/**
 * `npm run discover` — one discovery run, one recorded capability.
 *
 * The wiring here is the whole architecture in one screen: policy and redactor first,
 * then a lease, then a surface that enforces both, then the model loop, then the recorder.
 * The model is the fourth thing constructed, not the first, which is the intended reading.
 *
 *   npm run discover -- \
 *     --goal "open a new savings account and read back the new account number" \
 *     --target https://parabank.parasoft.com/parabank/index.htm
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { relative } from 'node:path';
import { loadPolicy } from '../policy/policy.js';
import { Redactor } from '../policy/redact.js';
import { LeaseManager } from '../escalation/lease.js';
import { PlaywrightWebSurface } from '../surface/playwright-web.js';
import { FileRunLogger } from '../evidence/logger.js';
import { runDiscovery, type EscalationHandler } from '../agent/loop.js';
import { recordArtifact, unverifiedOutcomes } from '../artifact/recorder.js';
import { saveArtifact } from '../artifact/store.js';
import type { DiscoveryLog } from '../agent/tools.js';

interface Args {
  goal: string;
  target: string;
  app: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxSteps: number;
  headless: boolean;
  interactive: boolean;
  inputs: Record<string, string>;
  id?: string;
}

/** Reads a single `--name value` flag ahead of full parsing. */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const inputs: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) continue;
    const key = arg.slice(2);
    // `--headless` and friends are valueless; anything else takes the next token.
    const next = argv[i + 1];
    const value = next && !next.startsWith('--') ? (i++, next) : 'true';
    if (key === 'input') {
      const eq = value.indexOf('=');
      if (eq > 0) inputs[value.slice(0, eq)] = value.slice(eq + 1);
    } else {
      flags.set(key, value);
    }
  }

  const target = flags.get('target') ?? 'https://parabank.parasoft.com/parabank/index.htm';
  const goal = flags.get('goal');
  if (!goal || goal === 'true') {
    throw new Error('--goal is required, e.g. --goal "open a new savings account"');
  }

  return {
    goal,
    target,
    app: flags.get('app') ?? new URL(target).hostname.split('.')[0] ?? 'app',
    model: flags.get('model') ?? 'claude-opus-5',
    effort: (flags.get('effort') as Args['effort']) ?? 'high',
    maxSteps: Number(flags.get('max-steps') ?? 40),
    headless: flags.get('headless') === 'true',
    // Escalations block on a terminal prompt by default; --no-interactive ends the run
    // instead, which is what a CI or batch invocation wants.
    interactive: flags.get('no-interactive') !== 'true',
    inputs,
    ...(flags.get('id') ? { id: flags.get('id') } : {}),
  };
}

/** The stand-in for M8's console: an operator answering at the terminal. */
function terminalEscalation(): EscalationHandler {
  return async ({ reason, question, observation }) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('\n─── the agent is asking for help ───');
      console.log(`  page:     ${observation.url}`);
      console.log(`  blocked:  ${reason}`);
      console.log(`  question: ${question}`);
      const answer = (await rl.question('  your answer (blank to end the run): ')).trim();
      return answer === '' ? undefined : answer;
    } finally {
      rl.close();
    }
  };
}

/**
 * Re-compiles the artifact from a run that already happened.
 *
 * Worth having for a reason that is not convenience: every discovery run against this
 * application opens a real account on somebody's public demo. When the recorder changes —
 * and it changed three times while being built — re-running discovery to see the effect
 * costs another account and another few minutes. Replaying the *log* costs neither, and
 * it tests the recorder against real captured evidence rather than a fixture.
 */
async function rerecord(runId: string): Promise<void> {
  const policy = loadPolicy();
  const file = join(process.cwd(), 'evidence', 'runs', runId, 'discovery.json');
  const log = JSON.parse(await readFile(file, 'utf-8')) as DiscoveryLog;

  const id = arg('id');
  const artifact = await recordArtifact(log, {
    policy,
    evidenceRef: `evidence/runs/${runId}`,
    ...(id ? { id } : {}),
  });
  const out = await saveArtifact(artifact);
  console.log(`re-recorded ${artifact.id}@${artifact.version} from ${runId}`);
  console.log(`  → ${relative(process.cwd(), out)}`);

  const unverified = unverifiedOutcomes(log);
  if (unverified.length > 0) {
    console.log(`  ⚠ unverified outcome detector(s): ${unverified.join(', ')}`);
  }
}

async function main(): Promise<void> {
  const fromRun = arg('from-run');
  if (fromRun) return rerecord(fromRun);

  const args = parseArgs(process.argv.slice(2));
  const runId = randomUUID();

  const policy = loadPolicy();
  // Learn every secret in the environment *before* anything can be written, so a
  // credential cannot reach the log even if it appears somewhere we did not anticipate.
  const redactor = new Redactor(policy).learnFromEnv();
  const logger = new FileRunLogger(runId, redactor);
  const leases = new LeaseManager(runId);

  const base = new URL(args.target);
  const baseUrl = base.origin;

  const surface = await PlaywrightWebSurface.launch({
    policy,
    redactor,
    leases,
    extraOrigins: [baseUrl],
    headless: args.headless,
  });

  console.log(`run ${runId}`);
  console.log(`  goal:  ${args.goal}`);
  console.log(`  model: ${args.model} (effort: ${args.effort})`);
  console.log(`  logs:  ${relative(process.cwd(), logger.dir)}\n`);

  try {
    const { log, usage } = await runDiscovery({
      surface,
      goal: args.goal,
      app: args.app,
      baseUrl,
      entryPoint: base.pathname + base.search,
      redactor,
      logger,
      model: args.model,
      effort: args.effort,
      maxSteps: args.maxSteps,
      inputs: args.inputs,
      runId,
      onEscalation: args.interactive ? terminalEscalation() : undefined,
      onProgress: (note) => console.log(`  ${note}`),
    });

    logger.write('discovery.json', JSON.stringify(redactor.value(log), null, 2));

    // The final page, whatever it is. A run that stopped on no-progress is exactly the
    // one whose last screenshot is worth having.
    const evidence = await surface.capture();
    logger.screenshot('final.png', evidence.screenshot);
    logger.write('final.html', evidence.html);

    console.log(
      `\nstopped: ${log.stoppedBecause} — ${log.actions.length} actions, ` +
        `${log.outcomes.length} outcomes, ${log.escalations.length} escalations`,
    );
    console.log(
      `tokens: ${usage.inputTokens} in / ${usage.outputTokens} out, ` +
        `${usage.cacheReadTokens} read from cache`,
    );

    if (log.actions.length === 0) {
      console.error('\nno actions were recorded — nothing to compile.');
      process.exitCode = 1;
      return;
    }

    const artifact = await recordArtifact(log, {
      policy,
      evidenceRef: `evidence/runs/${runId}`,
      ...(args.id ? { id: args.id } : {}),
    });
    const file = await saveArtifact(artifact);
    logger.write('artifact.json', JSON.stringify(artifact, null, 2));

    console.log(`\nrecorded ${artifact.id}@${artifact.version} → ${relative(process.cwd(), file)}`);
    console.log(`  ${artifact.steps.length} steps, ${Object.keys(artifact.outputs).length} outputs`);
    const weak = artifact.steps.filter((s) => (s.locator?.confidence ?? 1) < 0.5);
    if (weak.length > 0) {
      console.log(
        `  ${weak.length} step(s) recorded a CSS-only locator and need review: ` +
          weak.map((s) => s.id).join(', '),
      );
    }
    if (artifact.policy.requiresApproval) {
      console.log('  contains irreversible steps — replay will require approval');
    }

    // Outcome detectors are the one part of the artifact discovery cannot verify: the run
    // took the happy path, so the wording of a denial page was inferred, not read. Getting
    // it wrong turns a business outcome back into a false alarm, so it is said out loud.
    const unverified = unverifiedOutcomes(log);
    if (unverified.length > 0) {
      console.log(
        `
  ⚠ ${unverified.length} outcome detector(s) reference text this run never ` +
          `observed — the wording was inferred and needs checking against the real page: ` +
          unverified.join(', '),
      );
    }

    // A run that did not reach `finish` still records what it managed to do, because a
    // partial capability plus a clear warning beats losing the evidence. But it must not
    // read as a success: this artifact covers part of a goal and has not been reviewed.
    if (log.stoppedBecause !== 'finished') {
      console.log(
        `\n  ⚠ this run ended as "${log.stoppedBecause}", not "finished" — the capability ` +
          `is PARTIAL and needs review before use.`,
      );
      for (const escalation of log.escalations) {
        console.log(`    the agent asked: ${escalation.question}`);
      }
      process.exitCode = 2;
    } else if (Object.keys(artifact.outputs).length === 0) {
      console.log(
        '\n  ⚠ this capability declares no outputs — it performs the flow but returns ' +
          'nothing to its caller. Check that the goal did not ask for a value back.',
      );
    }
  } finally {
    await surface.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
