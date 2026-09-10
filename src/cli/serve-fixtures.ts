/**
 * The offline replay path.
 *
 * A capability that can only be demonstrated against somebody's live public demo instance
 * is not a demonstrable capability — the site goes down, the data changes, and the reviewer
 * gets nothing. So the captured HTML is served back from here on the origin the policy file
 * already allowlists (`http://127.0.0.1:8787`), and the same artifact replays against it
 * with no code path changed.
 *
 * It is a *replay* server, not an emulator. It knows two things: which file answers which
 * request, and how a POST advances the flow. Anything more would be re-implementing
 * ParaBank, which proves nothing about the automation.
 *
 *     npm run fixtures:serve
 */

import express from 'express';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PORT = Number(process.env.FIXTURE_PORT ?? 8787);
const ROOT = resolve(process.cwd(), 'fixtures', 'parabank');

/**
 * Maps a request to the fixture that answers it. Keys are `"<METHOD> <path>"`; the value
 * is a filename under `fixtures/parabank/`.
 *
 * Written by `fixtures:capture` and editable by hand — an exceptional-path fixture (a
 * refusal page, say) is added by pointing a second route at a different capture, which is
 * how the offline suite exercises a business outcome without needing the live app to be
 * in an unhappy state.
 */
type Routes = Record<string, string>;

async function loadRoutes(): Promise<Routes> {
  try {
    return JSON.parse(await readFile(join(ROOT, 'routes.json'), 'utf-8')) as Routes;
  } catch {
    return {};
  }
}

async function fileFor(routes: Routes, method: string, path: string): Promise<string | undefined> {
  const exact = routes[`${method} ${path}`] ?? routes[`* ${path}`];
  if (exact) return exact;

  // Fall back to the basename, so a capture saved as `openaccount.htm` answers
  // `/parabank/openaccount.htm` without needing a route entry at all.
  const base = path.split('/').filter(Boolean).pop();
  if (!base) return undefined;
  const names = await readdir(ROOT).catch(() => [] as string[]);
  return names.find((n) => n === base || n === `${base}.html` || n.replace(/\.html$/, '') === base);
}

export async function createFixtureApp(): Promise<express.Express> {
  const routes = await loadRoutes();
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.all(/.*/, async (req, res) => {
    const name = await fileFor(routes, req.method, req.path);
    if (!name) {
      res.status(404).type('html').send(`<html><body>No fixture for ${req.method} ${req.path}</body></html>`);
      return;
    }
    try {
      res.type('html').send(await readFile(join(ROOT, name), 'utf-8'));
    } catch {
      res.status(404).type('html').send(`<html><body>Fixture "${name}" is missing</body></html>`);
    }
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const app = await createFixtureApp();
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`fixtures for ${ROOT}`);
    console.log(`serving on http://127.0.0.1:${PORT}/parabank/index.htm`);
  });
}
