/**
 * `npm run catalog` — show what a calling agent would see.
 *
 * Useful on its own (this is the review surface for a capability before it is promoted),
 * and useful as proof: the tool definitions are printed straight from the artifacts, so
 * what a reviewer reads here is exactly what a model is handed.
 *
 *   npm run catalog            human-readable
 *   npm run catalog -- --json  the raw tool definitions
 */

import { pathToFileURL } from 'node:url';
import { Catalog } from '../catalog/catalog.js';

async function main(): Promise<void> {
  const catalog = await Catalog.load();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(catalog.tools, null, 2));
    return;
  }

  if (catalog.entries.length === 0) {
    console.log('No capabilities in capabilities/. Run `npm run discover` first.');
    return;
  }

  console.log(`${catalog.entries.length} capability tool(s)\n`);
  for (const entry of catalog.entries) {
    const { artifact } = entry;
    console.log(`${entry.toolName}`);
    console.log(`  from        ${artifact.id}@${artifact.version}`);
    console.log(`  risk        ${artifact.policy.riskClass}${
      artifact.policy.requiresApproval ? ' (requires human approval)' : ''
    }`);
    console.log(`  steps       ${artifact.steps.length}`);

    const params = Object.entries(artifact.inputs).filter(([, s]) => !s.sensitive);
    console.log(
      `  parameters  ${
        params.length === 0
          ? '(none — this capability takes no business arguments)'
          : params.map(([n, s]) => `${n}: ${s.type}${s.required ? '' : '?'}`).join(', ')
      }`,
    );

    const secrets = Object.entries(artifact.inputs).filter(([, s]) => s.sensitive);
    if (secrets.length > 0) {
      // Stated explicitly because their *absence* from the tool definition is the design.
      console.log(
        `  secrets     ${secrets.map(([n]) => n).join(', ')} — resolved from the tenant ` +
          `binding at replay time, never exposed to a caller`,
      );
    }

    console.log(
      `  outcomes    ${
        artifact.outcomes.length === 0
          ? '(none declared)'
          : artifact.outcomes.map((o) => o.name).join(', ')
      }`,
    );
    console.log();
  }

  console.log('Run `npm run catalog -- --json` for the tool definitions as a model sees them.');
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  });
}
