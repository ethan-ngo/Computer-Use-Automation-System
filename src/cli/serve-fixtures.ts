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
import { pathToFileURL } from 'node:url';

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
export type Routes = Record<string, string>;

async function loadRoutes(): Promise<Routes> {
  try {
    return JSON.parse(await readFile(join(ROOT, 'routes.json'), 'utf-8')) as Routes;
  } catch {
    return {};
  }
}

/**
 * ParaBank puts the session in the *path* (`login.htm;jsessionid=AB6C…`), so the captured
 * HTML has one particular session frozen into every form action. A replay server must not
 * care which session a capture was taken in — the alternative is re-capturing fixtures
 * whenever a session id changes, which defeats the point of having them.
 */
export function canonicalPath(path: string): string {
  return path.replace(/;[^/]*/g, '');
}

async function fileFor(routes: Routes, method: string, rawPath: string): Promise<string | undefined> {
  const path = canonicalPath(rawPath);
  const exact = routes[`${method} ${path}`] ?? routes[`* ${path}`];
  if (exact) return exact;

  // Fall back to the basename, so a capture saved as `openaccount.htm` answers
  // `/parabank/openaccount.htm` without needing a route entry at all.
  const base = path.split('/').filter(Boolean).pop();
  if (!base) return undefined;
  const names = await readdir(ROOT).catch(() => [] as string[]);
  return names.find((n) => n === base || n === `${base}.html` || n.replace(/\.html$/, '') === base);
}

/**
 * `overrides` is how the offline suite reaches an exceptional state: point `POST
 * /parabank/login.htm` at the captured rejection page instead of the overview, and the
 * *same artifact*, unedited, returns its declared business outcome. The app under test
 * does not change; the world it is replayed against does.
 */
export async function createFixtureApp(overrides: Routes = {}): Promise<express.Express> {
  const routes = { ...(await loadRoutes()), ...overrides };
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

// pathToFileURL rather than a hand-built string: on Windows a path is "C:\…", so the
// concatenated URL comes out with two slashes where import.meta.url has three. The guard
// then silently never fires and the server starts nothing, with no error to show for it.
// The same bug was already fixed in capture-fixtures.ts; this copy had been missed, which
// is why `npm run fixtures:serve` exited 0 and served nothing.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  /*
   * `--reject-login` serves the captured rejection page for the login POST, which is how
   * the documented offline demo reaches a business outcome. A flag rather than the default
   * because the two worlds should be chosen deliberately: a reviewer running the offline
   * path needs to know which one they are in.
   */
  const rejectLogin = process.argv.includes('--reject-login');
  const app = await createFixtureApp(
    rejectLogin ? { 'POST /parabank/login.htm': 'login-rejected.htm' } : {},
  );
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`fixtures for ${ROOT}`);
    console.log(`serving on http://127.0.0.1:${PORT}/parabank/index.htm`);
    if (rejectLogin) console.log('login POSTs answer with the captured rejection page');
  });
}
