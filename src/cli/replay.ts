/**
 * `npm run replay` — execute a recorded capability. No model, no network to Anthropic,
 * nothing but the artifact and the page.
 *
 * This is the half of the system that matters in production, and the whole point of the
 * artifact format is that this file is boring: load, validate the caller's inputs, put the
 * browser on the entry point, hand the steps to the engine.
 *
 * The exit code encodes the distinction the design is built around:
 *
 *     0  success            the flow completed
 *     0  business_outcome   the application answered "no" — a RESULT, not a failure
 *     2  escalated          a human is needed
 *     1  failed             the automation broke
 *
 * `business_outcome` exiting 0 is deliberate and is the point. A loan denial is the
 * application working correctly; a scheduler that retries it, or an on-call rota that
 * pages someone for it, is the failure mode this whole design exists to avoid.
 *
 *   npm run replay -- --capability parabank.open-parabank-savings-account --approve auto
 */

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { relative } from 'node:path';
import { loadPolicy } from '../policy/policy.js';
import { Redactor } from '../policy/redact.js';
import { LeaseManager } from '../escalation/lease.js';
import { PlaywrightWebSurface } from '../surface/playwright-web.js';
import { FileRunLogger } from '../evidence/logger.js';
import { loadResolved } from '../artifact/store.js';
import { compileInputs } from '../artifact/params.js';
import { replay, type ApprovalHook, type ReplayResult } from '../replay/engine.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Repeated `--input name=value`. */
function collectInputs(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== '--input') continue;
    const pair = process.argv[i + 1] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    // Numbers and booleans arrive from a shell as strings; the compiled Zod schema is
    // typed, so coerce the two unambiguous cases and leave everything else alone.
    out[key] = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}

/**
 * The approval gate for irreversible steps.
 *
 * `ask` is the default and blocks on a terminal prompt. `auto` exists for the demo and for
 * CI, and it announces itself on every use — an approval gate that can be silently
 * disabled is not a gate, so the least this can do is be loud about it.
 */
function approvalHook(mode: string): ApprovalHook {
  if (mode === 'deny') {
    return (step) => {
      console.log(`  approval DENIED by --approve deny: ${step.intent}`);
      return false;
    };
  }
  if (mode === 'auto') {
    return (step) => {
      console.log(`  ⚠ auto-approving an irreversible step (--approve auto): ${step.intent}`);
      return true;
    };
  }
  return async (step, observation) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('\n─── approval required ───');
      console.log(`  step: ${step.intent}`);
      console.log(`  page: ${observation.title} — ${observation.url}`);
      console.log('  This step cannot be undone.');
      const answer = (await rl.question('  proceed? [y/N] ')).trim().toLowerCase();
      return answer === 'y' || answer === 'yes';
    } finally {
      rl.close();
    }
  };
}

const EXIT: Record<ReplayResult['kind'], number> = {
  success: 0,
  business_outcome: 0,
  escalated: 2,
  failed: 1,
};

async function main(): Promise<void> {
  const capabilityId = flag('capability');
  if (!capabilityId) {
    throw new Error('--capability is required, e.g. --capability parabank.open-new-account');
  }
  const tenantId = flag('tenant');
  const runId = randomUUID();

  const policy = loadPolicy();
  const redactor = new Redactor(policy).learnFromEnv();
  const logger = new FileRunLogger(runId, redactor);
  const leases = new LeaseManager(runId);

  const capability = await loadResolved(capabilityId, tenantId);
  const { artifact } = capability;

  // Fixtures give the offline path: the same artifact, a local origin, no live bank.
  const baseUrl =
    flag('base-url') ??
    (has('fixtures') ? 'http://127.0.0.1:8787' : undefined) ??
    capability.baseUrl ??
    `https://${artifact.policy.allowedDomains[0]}`;

  // Validated before the browser opens, so a typo in an argument costs nothing.
  const parsed = compileInputs(artifact).safeParse(collectInputs());
  if (!parsed.success) {
    throw new Error(
      `inputs do not satisfy ${artifact.id}:\n  - ` +
        parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('\n  - '),
    );
  }

  const surface = await PlaywrightWebSurface.launch({
    policy,
    redactor,
    leases,
    extraOrigins: [baseUrl],
    headless: has('headless'),
  });

  console.log(`run ${runId}`);
  console.log(`  capability: ${artifact.id}@${artifact.version} — ${artifact.name}`);
  console.log(`  tenant:     ${tenantId ?? '(none)'}`);
  console.log(`  base:       ${baseUrl}`);
  console.log(`  steps:      ${capability.steps.length}${
    capability.appliedOverrides.length > 0
      ? ` (${capability.appliedOverrides.length} tenant override(s))`
      : ''
  }`);
  console.log(`  logs:       ${relative(process.cwd(), logger.dir)}\n`);

  try {
    /*
     * Getting to the entry point is the harness's job, not the engine's.
     *
     * No recorded step covers it: during discovery the loop navigates to the entry point
     * before the model is given the page, so there is no model action to record. The
     * artifact carries the destination in `target.entryPoint` instead, and it is relative
     * — the tenant binding supplies the origin — which is exactly what makes one artifact
     * replayable against a fixture server and a live bank without editing it.
     */
    await surface.act({
      type: 'navigate',
      url: new URL(artifact.target.entryPoint, baseUrl).toString(),
    });

    const result = await replay({
      capability,
      surface,
      policy,
      redactor,
      inputs: parsed.data,
      baseUrl,
      runId,
      logger,
      approve: approvalHook(flag('approve') ?? 'ask'),
    });

    report(result);
    logger.write('result.json', JSON.stringify(redactor.value(result), null, 2));

    const evidence = await surface.capture();
    logger.screenshot('final.png', evidence.screenshot);
    if (result.kind === 'failed' || result.kind === 'escalated') {
      logger.write('failure.html', evidence.html);
      logger.write('failure.aria.yaml', evidence.aria);
    }

    process.exitCode = EXIT[result.kind];
  } finally {
    await surface.close();
  }
}

function report(result: ReplayResult): void {
  console.log(`${result.kind}  (${result.durationMs}ms)\n`);

  for (const step of result.steps) {
    const strategy = step.strategy
      ? `  [${step.strategy}${step.degraded ? ' — FALLBACK, drift' : ''}]`
      : '';
    const detail = step.detail ? `  ${step.detail}` : '';
    console.log(`  ${step.status.padEnd(18)} ${step.intent}${strategy}${detail}`);
  }

  if (result.kind === 'business_outcome') {
    console.log(`\n  ${result.outcome.name}: ${result.outcome.description}`);
    console.log(`  detected at ${result.atStepId} — ${result.outcome.detail}`);
    console.log('  This is a result, not a failure. Exit code 0.');
  }
  if (result.kind === 'escalated') {
    console.log(`\n  escalated at "${result.intent}" (${result.errorClass ?? result.reason})`);
    console.log(`    expected: ${result.expected}`);
    console.log(`    observed: ${result.observed}`);
    console.log('  Run `npm run operator` to handle this with a human in the loop.');
  }
  if (result.kind === 'failed') {
    console.log(`\n  ${result.errorClass} at ${result.atStepId}: ${result.error.message}`);
  }

  if (Object.keys(result.outputs).length > 0) {
    console.log('\n  outputs:');
    for (const [name, value] of Object.entries(result.outputs)) {
      console.log(`    ${name} = ${JSON.stringify(value)}`);
    }
  }

  // The drift signal, surfaced rather than buried in the log. One tenant degraded means
  // local customisation; every tenant degraded means the vendor shipped a release.
  const degraded = result.steps.filter((s) => s.degraded);
  if (degraded.length > 0) {
    console.log(
      `\n  ${degraded.length} step(s) resolved on a fallback strategy — the application ` +
        `has moved under this artifact: ${degraded.map((s) => s.id).join(', ')}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
