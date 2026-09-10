/**
 * Records what a human did while holding the session.
 *
 * The purpose is not surveillance and not replay. It is three specific things:
 * an audit trail for a regulated flow ("who did what to this account, and when"),
 * the raw material for turning a repeated intervention into a recorded step, and the
 * evidence a reviewer needs to decide whether the resume that followed was legitimate.
 *
 * **Values are redacted at capture time, inside the page.** The listener that fires on an
 * input event never sends the characters anywhere — it sends a shape (`"14 characters"`).
 * This is stronger than redacting on the way to disk: a redact-on-write design still holds
 * plaintext in memory and in every intermediate structure between the event and the file,
 * and each new write path is another chance to forget. Here there is no plaintext to
 * forget about, because it never left the page.
 *
 * The one thing this deliberately does not do is capture keystroke *content* for a
 * password field, even in shape form beyond its length — see `describeValue`.
 */

import type { Page } from 'playwright';
import type { HumanAction } from './broker.js';

const BINDING = '__recordHumanAction';

/** Runs in the page. Reports a shape, never the characters. */
const INSTALL = String(`(() => {
  const describe = (el) => {
    const bits = [];
    if (el.tagName) bits.push(el.tagName.toLowerCase());
    const type = el.getAttribute && el.getAttribute('type');
    if (type) bits.push('[' + type + ']');
    const name = (el.getAttribute && (el.getAttribute('name') || el.getAttribute('id'))) || '';
    if (name) bits.push('"' + name + '"');
    const text = (el.value && el.type === 'submit') ? el.value
      : (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    if (text) bits.push('(' + text + ')');
    return bits.join(' ');
  };

  // The redaction boundary. A password is reported as present and nothing else; every
  // other field gets a length, which is enough to tell "they typed something" from
  // "they cleared it" without ever carrying the content.
  const shape = (el) => {
    const type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return 'a password';
    const v = typeof el.value === 'string' ? el.value : '';
    if (v === '') return 'cleared';
    if (type === 'checkbox' || type === 'radio') return el.checked ? 'checked' : 'unchecked';
    return v.length + ' characters';
  };

  const send = (kind, target, value) => {
    try { window.${BINDING}({ kind, target, value, url: location.href }); } catch (e) {}
  };

  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('a,button,input,select,[role]') : null;
    if (el) send('click', describe(el));
  }, true);

  // 'change' rather than 'input': one record per field the operator finished editing,
  // instead of one per keystroke. A per-keystroke log of a redacted value is noise.
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || !el.tagName) return;
    send('input', describe(el), shape(el));
  }, true);

  document.addEventListener('submit', (e) => {
    if (e.target) send('submit', describe(e.target));
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') send('key', e.key);
  }, true);
})()`);

export interface HumanRecording {
  actions: HumanAction[];
  /** Screenshots either side of the intervention, so a reviewer can see the delta. */
  before?: Buffer;
  after?: Buffer;
  stop: () => Promise<{ actions: HumanAction[]; before?: Buffer; after?: Buffer }>;
}

/**
 * Starts recording. Call `stop()` when the operator releases the session.
 *
 * `addInitScript` plus a re-install on `framenavigated` is what makes this survive the
 * operator navigating: an init script alone covers new documents, and the explicit
 * re-install covers the case where the binding is installed mid-page.
 */
export async function recordHumanSession(page: Page): Promise<HumanRecording> {
  const actions: HumanAction[] = [];
  let before: Buffer | undefined;

  try {
    before = await page.screenshot({ fullPage: false });
  } catch {
    // A screenshot failing is not a reason to refuse to record the actions.
  }

  await page.exposeBinding(BINDING, (source, payload: Omit<HumanAction, 'at'>) => {
    actions.push({
      at: new Date().toISOString(),
      kind: payload.kind,
      target: payload.target,
      ...(payload.value ? { value: payload.value } : {}),
      url: payload.url || source.page.url(),
    });
  });

  await page.addInitScript(INSTALL);
  await page.evaluate(INSTALL).catch(() => {});

  const onNavigated = () => {
    // Fire-and-forget: the page may already have moved on again, and a failed re-install
    // must not become an unhandled rejection in the middle of a handoff.
    void page.evaluate(INSTALL).catch(() => {});
  };
  page.on('framenavigated', onNavigated);

  const recording: HumanRecording = {
    actions,
    before,
    stop: async () => {
      page.off('framenavigated', onNavigated);
      let after: Buffer | undefined;
      try {
        after = await page.screenshot({ fullPage: false });
      } catch {
        /* see above */
      }
      recording.after = after;
      return { actions: [...actions], before, after };
    },
  };
  return recording;
}
