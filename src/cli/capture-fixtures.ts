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
import { pathToFileURL } from 'node:url';

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

/**
 * Most of the interesting pages are behind the session.
 *
 * Without this, `openaccount.htm` and `overview.htm` capture as ParaBank's generic error
 * page — byte-identical to each other, which is the tell — and the offline fixtures would
 * cover only the two pages the flow does not actually need. Credentials come from the
 * environment and are never written into a fixture; the captured pages are post-login
 * HTML, so review what lands on disk before committing it.
 */
async function login(page: import('playwright').Page, origin: string): Promise<void> {
  const username = process.env.PARABANK_USERNAME;
  const password = process.env.PARABANK_PASSWORD;
  if (!username || !password) {
    throw new Error(
      '--login needs PARABANK_USERNAME and PARABANK_PASSWORD in the environment',
    );
  }
  await page.goto(`${origin}/parabank/index.htm`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('input[type="submit"][value="Log In"]');
  await page.waitForLoadState('domcontentloaded');
  if (await page.locator('text=Accounts Overview').count() === 0) {
    throw new Error('login did not reach the accounts overview — check the credentials');
  }
}

async function capture(page: import('playwright').Page, url: string, name: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const file = join(ROOT, name.endsWith('.html') || name.endsWith('.htm') ? name : `${name}.html`);
  await writeFile(file, inertify(await page.content()), 'utf-8');
  console.log(`captured ${url} → ${file}`);

  // Keep routes.json in step with what has been captured, so the fixture server can
  // answer the request that produced this page without hand-editing.
  const routesFile = join(ROOT, 'routes.json');
  const routes = JSON.parse(await readFile(routesFile, 'utf-8').catch(() => '{}')) as Record<string, string>;
  routes[`* ${new URL(url).pathname}`] = name;
  await writeFile(routesFile, JSON.stringify(routes, null, 2) + '\n', 'utf-8');
}

async function main(): Promise<void> {
  const start = arg('url', 'https://parabank.parasoft.com/parabank/index.htm')!;
  const name = arg('name', new URL(start).pathname.split('/').pop() || 'page.html')!;
  // Comma-separated, so one authenticated session captures the whole flow. Logging in
  // once per page would be both slower and a worse citizen on a public demo instance.
  const also = (arg('also') ?? '').split(',').filter(Boolean);
  const wantsLogin = process.argv.includes('--login');

  await mkdir(ROOT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    if (wantsLogin) await login(page, new URL(start).origin);
    await capture(page, start, name);
    for (const path of also) {
      const url = new URL(path, start).toString();
      await capture(page, url, url.split('/').pop() || 'page.html');
    }
  } finally {
    await browser.close();
  }
}

// pathToFileURL rather than hand-built string: on Windows a path is "C:\…", so the
// concatenated URL comes out with two slashes where import.meta.url has three. The guard
// then silently never fires and the CLI does nothing at all, with no error to show for it.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
