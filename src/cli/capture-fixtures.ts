/**
 * Captures the pages of a flow while the live application is up, so the demo, the offline
 * replay and the exceptional-path test all keep working when it is not.
 *
 * Captures are *inertified* on the way to disk: external scripts, stylesheets and images
 * are stripped and `<base>` is rewritten. What replay needs from these files is the
 * structure the locators target, and leaving live third-party script in a checked-in
 * fixture is both a supply-chain surface and a source of flakiness.
 *
 *     npm run fixtures:capture -- --url https://parabank.parasoft.com/parabank/index.htm
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd(), 'fixtures', 'parabank');

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** Strips anything that would reach the network when the fixture is replayed offline. */
export function inertify(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, '')
    .replace(/<img\b([^>]*?)\ssrc=(["'])[^"']*\2/gi, '<img$1 src="data:,"')
    .replace(/<base\b[^>]*>/gi, '');
}

async function main(): Promise<void> {
  const start = arg('url', 'https://parabank.parasoft.com/parabank/index.htm')!;
  const name = arg('name', new URL(start).pathname.split('/').pop() || 'page.html')!;

  await mkdir(ROOT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(start, { waitUntil: 'domcontentloaded' });
    const file = join(ROOT, name.endsWith('.html') || name.endsWith('.htm') ? name : `${name}.html`);
    await writeFile(file, inertify(await page.content()), 'utf-8');
    console.log(`captured ${start} → ${file}`);

    // Keep routes.json in step with what has been captured, so the fixture server can
    // answer the request that produced this page without hand-editing.
    const routesFile = join(ROOT, 'routes.json');
    const routes = JSON.parse(await readFile(routesFile, 'utf-8').catch(() => '{}')) as Record<string, string>;
    routes[`* ${new URL(start).pathname}`] = name;
    await writeFile(routesFile, JSON.stringify(routes, null, 2) + '\n', 'utf-8');
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  await main();
}
