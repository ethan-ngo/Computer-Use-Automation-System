/**
 * The web implementation of `Surface`.
 *
 * Two things here are worth reading closely:
 *
 *  1. `act()` is the chokepoint. Lease check, then policy check, then the action. Both
 *     discovery and replay call it, and there is no other way to reach the page.
 *  2. `observe()` runs an enrichment pass over the DOM to synthesise `labelHint` from the
 *     surrounding layout. ParaBank's JSP has no `<label for>` — the caption is an adjacent
 *     table cell — so without this pass most controls have no handle at all. This is not
 *     incidental plumbing; it *is* the legacy-surface handling, and it is the same problem
 *     a Windows UIA adapter faces with sibling static-text labels.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import type { Surface } from './surface.js';
import {
  LeaseDeniedError,
  PolicyDeniedError,
  type ActionResult,
  type EvidenceBundle,
  type Observation,
  type Resolution,
  type SessionLease,
  type SurfaceAction,
  type UiNode,
} from './types.js';
import type { Locator } from '../artifact/schema.js';
import { resolveLocator } from '../replay/locator.js';
import { checkAction, checkNavigation, type Policy } from '../policy/policy.js';
import type { Redactor } from '../policy/redact.js';
import type { LeaseManager } from '../escalation/lease.js';

/** Injected into the page to build the normalized node list. */
const COLLECT = String(`() => {
  const ROLE_BY_TAG = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox',
                        H1: 'heading', H2: 'heading', H3: 'heading', TABLE: 'table', FORM: 'form' };
  const INPUT_ROLES = { text: 'textbox', password: 'textbox', email: 'textbox', tel: 'textbox',
                        search: 'searchbox', number: 'spinbutton', checkbox: 'checkbox',
                        radio: 'radio', submit: 'button', button: 'button', reset: 'button' };

  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (el.tagName === 'OPTION') return true;
    return r.width > 0 && r.height > 0;
  };

  const cssPath = (el) => {
    if (el.id) return el.tagName.toLowerCase() + '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(part + '#' + CSS.escape(cur.id)); break; }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    if (el.tagName === 'INPUT') return INPUT_ROLES[(el.getAttribute('type') || 'text').toLowerCase()] || 'textbox';
    return ROLE_BY_TAG[el.tagName] || null;
  };

  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref) return (ref.textContent || '').trim();
    }
    if (el.id) {
      const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lbl) return (lbl.textContent || '').trim();
    }
    const wrapping = el.closest('label');
    if (wrapping) return (wrapping.textContent || '').trim();
    // Submit inputs take their accessible name from the value attribute — which is what
    // makes role+name work on this legacy form at all.
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        return (el.getAttribute('value') || '').trim();
      }
      return '';
    }
    if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return '';
    return (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  };

  /**
   * The legacy enrichment pass. Walks outward from a control looking for the caption a
   * sighted user would read as its label, in the places legacy markup actually puts it:
   * the preceding table cell, a preceding <b>/<strong>, or a preceding text node.
   */
  const labelHint = (el) => {
    const cell = el.closest('td, th');
    if (cell) {
      const row = cell.parentElement;
      if (row) {
        const cells = [...row.children];
        const idx = cells.indexOf(cell);
        for (let i = idx - 1; i >= 0; i--) {
          const t = (cells[i].textContent || '').replace(/\\s+/g, ' ').trim();
          if (t) return t.replace(/[:*]\\s*$/, '');
        }
      }
      // Caption may be in the cell itself, before the control.
      const own = (cell.textContent || '').replace(/\\s+/g, ' ').trim();
      if (own) return own.replace(/[:*]\\s*$/, '');
    }
    let prev = el.previousElementSibling;
    let hops = 0;
    while (prev && hops++ < 3) {
      const t = (prev.textContent || '').replace(/\\s+/g, ' ').trim();
      if (t) return t.replace(/[:*]\\s*$/, '');
      prev = prev.previousElementSibling;
    }
    const parentText = (el.parentElement?.textContent || '').replace(/\\s+/g, ' ').trim();
    if (parentText) return parentText.replace(/[:*]\\s*$/, '').slice(0, 120);
    // Last resort: the name attribute is a machine label, but on this kind of app it is
    // often the only thing that survives.
    return el.getAttribute('name') || undefined;
  };

  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll('a, button, input, select, textarea, h1, h2, h3, [role]')) {
    if (!visible(el)) continue;
    const role = roleOf(el);
    if (!role) continue;
    out.push({
      ref: 'e' + (++i),
      role,
      name: accessibleName(el),
      value: 'value' in el ? String(el.value ?? '') : undefined,
      enabled: !el.disabled,
      labelHint: labelHint(el),
      placeholder: el.getAttribute ? (el.getAttribute('placeholder') || undefined) : undefined,
      testId: el.getAttribute ? (el.getAttribute('data-testid') || undefined) : undefined,
      cssPath: cssPath(el),
      siblingIndex: el.parentElement ? [...el.parentElement.children].indexOf(el) : 0,
      framePath: [],
    });
  }
  return { nodes: out, text: document.body ? document.body.innerText : '', title: document.title };
}`);

export interface WebSurfaceOptions {
  policy: Policy;
  redactor: Redactor;
  leases: LeaseManager;
  /** Origins allowed in addition to policy.yaml — e.g. a tenant's own baseUrl. */
  extraOrigins?: string[];
  headless?: boolean;
  /** Pacing between actions. Also ParaBank hygiene: it is somebody's public demo. */
  paceMs?: number;
}

export class PlaywrightWebSurface implements Surface {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly opts: WebSurfaceOptions,
  ) {}

  static async launch(opts: WebSurfaceOptions): Promise<PlaywrightWebSurface> {
    // Headed and long-lived by default: a handoff must give the operator the *same*
    // session, not a fresh one. The context is never torn down across an intervention.
    const browser = await chromium.launch({ headless: opts.headless ?? false });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

    // Denied capabilities, enforced at the browser rather than by asking nicely.
    await context.route('**/*', (route) => route.continue());
    context.on('page', async (extra) => {
      // An unconstrained new tab is how automation escapes the surface it was scoped to.
      if (extra !== page) await extra.close().catch(() => {});
    });

    const page = await context.newPage();
    page.on('dialog', (d) => void d.dismiss().catch(() => {}));
    page.on('download', (d) => void d.cancel().catch(() => {}));

    return new PlaywrightWebSurface(browser, context, page, opts);
  }

  get lease(): SessionLease {
    return this.opts.leases.current;
  }

  // -------------------------------------------------------------------------
  // Perceive
  // -------------------------------------------------------------------------

  async observe(): Promise<Observation> {
    const collected = (await this.page.evaluate(COLLECT)) as {
      nodes: UiNode[];
      text: string;
      title: string;
    };
    const nodes = collected.nodes;
    const observation = {
      url: this.page.url(),
      title: collected.title,
      nodes,
      text: collected.text,
      ariaHash: createHash('sha1')
        .update(JSON.stringify(nodes.map((n) => [n.role, n.name, n.labelHint])))
        .digest('hex'),
      capturedAt: new Date().toISOString(),
    };
    // Refs are per-observation, so registration happens here rather than being something a
    // caller must remember to do. Forgetting it would make every subsequent action throw.
    this.registerRefs(observation);
    return observation;
  }

  async matchCss(selector: string): Promise<UiNode[]> {
    const observation = await this.observe();
    const handles = await this.page.$$(selector);
    if (handles.length === 0) return [];
    const paths = await Promise.all(
      handles.map((h) =>
        h.evaluate((el) => {
          const e = el as HTMLElement;
          return e.id ? e.tagName.toLowerCase() + '#' + e.id : null;
        }),
      ),
    );
    // Prefer nodes we already normalized, so the caller always gets a UiNode with a ref.
    const matched = observation.nodes.filter(
      (n) => paths.includes(n.cssPath) || n.cssPath === selector,
    );
    if (matched.length > 0) return matched;

    // Selector matched something we did not classify as interactive (a link target, a
    // read-only cell). Synthesise minimal nodes so extraction still works.
    return Promise.all(
      handles.map(async (h, i) => ({
        ref: `css${i}`,
        role: 'generic',
        name: ((await h.textContent()) ?? '').replace(/\s+/g, ' ').trim(),
        enabled: true,
        cssPath: selector,
        siblingIndex: i,
        framePath: [],
      })),
    );
  }

  async resolve(locator: Locator): Promise<Resolution> {
    const observation = await this.observe();
    return resolveLocator(observation, locator, (s) => this.matchCss(s));
  }

  // -------------------------------------------------------------------------
  // Act — the single chokepoint
  // -------------------------------------------------------------------------

  async act(action: SurfaceAction): Promise<ActionResult> {
    // 1. Lease. Automation is *incapable* of acting while a human holds the session.
    if (!this.opts.leases.heldByAutomation) {
      throw new LeaseDeniedError(this.opts.leases.current);
    }

    // 2. Policy: is this kind of action in the vocabulary at all?
    const vocabulary = checkAction(this.opts.policy, action.type);
    if (!vocabulary.allowed) {
      throw new PolicyDeniedError(vocabulary.rule, vocabulary.reason);
    }

    // 3. Policy: navigation scope.
    if (action.type === 'navigate') {
      const verdict = checkNavigation(this.opts.policy, action.url, this.opts.extraOrigins);
      if (!verdict.allowed) {
        throw new PolicyDeniedError(verdict.rule, verdict.reason);
      }
    }

    const started = Date.now();
    const pace = this.opts.paceMs ?? this.opts.policy.budgets.minDelayBetweenActionsMs;
    if (pace > 0) await this.page.waitForTimeout(pace);

    switch (action.type) {
      case 'navigate':
        await this.page.goto(action.url, { waitUntil: 'domcontentloaded' });
        break;
      case 'click':
        await this.locatorFor(action.ref).click();
        break;
      case 'fill':
        if (action.sensitive) this.opts.redactor.learn(action.value);
        await this.locatorFor(action.ref).fill(action.value);
        break;
      case 'select':
        if (action.sensitive) this.opts.redactor.learn(action.value);
        await this.selectOption(action.ref, action.value);
        break;
      case 'press':
        await this.locatorFor(action.ref).press(action.key);
        break;
      case 'wait':
        await this.page.waitForTimeout(action.ms);
        break;
    }

    return { ok: true, url: this.page.url(), durationMs: Date.now() - started };
  }

  /**
   * Refs are per-observation, so an action carries the ref and we re-derive the element
   * from the current DOM by its recorded css path. Re-deriving rather than caching a
   * handle is deliberate: a stale handle silently acts on a detached element.
   */
  private refPaths = new Map<string, string>();

  private locatorFor(ref: string) {
    const path = this.refPaths.get(ref);
    if (!path) throw new Error(`unknown element ref "${ref}" — re-observe before acting`);
    return this.page.locator(path).first();
  }

  private async selectOption(ref: string, value: string) {
    const locator = this.locatorFor(ref);
    try {
      await locator.selectOption({ value });
    } catch {
      // Legacy selects frequently use the label as the value, or vice versa.
      await locator.selectOption({ label: value });
    }
  }

  /** Called by `observe()` itself, so refs are always resolvable for the latest snapshot. */
  private registerRefs(observation: Observation): void {
    this.refPaths.clear();
    for (const node of observation.nodes) this.refPaths.set(node.ref, node.cssPath);
  }

  // -------------------------------------------------------------------------
  // Evidence
  // -------------------------------------------------------------------------

  async capture(): Promise<EvidenceBundle> {
    const masks = this.opts.redactor.maskSelectors.map((s) => this.page.locator(s));
    const screenshot = await this.page.screenshot({ mask: masks, fullPage: false });
    const html = this.opts.redactor.text(await this.page.content());
    let aria = '';
    try {
      aria = this.opts.redactor.text(await this.page.locator('body').ariaSnapshot());
    } catch {
      aria = '(aria snapshot unavailable)';
    }
    return { screenshot, html, aria, url: this.page.url(), title: await this.page.title() };
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}

export function newSessionId(): string {
  return randomUUID();
}
