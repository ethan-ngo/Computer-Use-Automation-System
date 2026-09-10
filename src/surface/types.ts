/**
 * The vocabulary shared by perception and actuation.
 *
 * The model sees `textbox "Username"`; the replay engine targets
 * `getByRole('textbox', { name: 'Username' })`. One vocabulary, two consumers — which is
 * also why a desktop adapter slots in behind `Surface` without touching the artifact
 * schema: Windows UIA exposes ControlType + Name, the same two axes.
 */

import type { Locator, Strategy } from '../artifact/schema.js';

/**
 * A normalized UI element. Deliberately NOT raw DOM — the recorded artifact must never
 * reference Playwright, and a desktop adapter must be able to produce this same shape from
 * a UIA tree walk.
 */
export interface UiNode {
  /** Stable within one observation. This is what the discovery model cites. */
  ref: string;
  /** ARIA role on web; ControlType on Windows; AXRole on macOS. */
  role: string;
  /** Accessible name. Often empty on legacy surfaces — hence `labelHint`. */
  name: string;
  value?: string;
  enabled: boolean;
  /**
   * Caption text derived from the surrounding layout when there is no programmatic
   * label association. This is the legacy-surface handling: ParaBank's JSP tables put
   * the caption in an adjacent `<td>`, exactly as legacy WinForms puts it in a sibling
   * static-text control.
   */
  labelHint?: string;
  placeholder?: string;
  testId?: string;
  /** Escape hatch for the `css` strategy and for evidence. Not used for matching by role. */
  cssPath: string;
  siblingIndex: number;
  framePath: string[];
}

export interface Observation {
  url: string;
  title: string;
  nodes: UiNode[];
  /** Full visible text, used by textPresent/textAbsent assertions. */
  text: string;
  /** Fingerprint of the node list; the no-progress detector compares these. */
  ariaHash: string;
  capturedAt: string;
}

/**
 * An action with every value already resolved — secrets fetched, references substituted.
 * The `Surface` never sees a `secretRef`, which keeps secret resolution in exactly one
 * place upstream of the chokepoint.
 */
export type SurfaceAction =
  | { type: 'navigate'; url: string }
  | { type: 'click'; ref: string }
  | { type: 'fill'; ref: string; value: string; sensitive: boolean }
  | { type: 'select'; ref: string; value: string; sensitive: boolean }
  | { type: 'press'; ref: string; key: string }
  | { type: 'wait'; ms: number };

export interface ActionResult {
  ok: boolean;
  /** Populated when the action caused navigation. */
  url: string;
  durationMs: number;
}

/** What `resolve` returns, including the drift telemetry. */
export interface Resolution {
  node: UiNode;
  strategy: Strategy;
  /** -1 when the primary strategy won; 0-based index into `fallbacks` otherwise. */
  fallbackIndex: number;
  /**
   * True when a fallback won. Aggregated across runs and tenants this is the drift signal:
   * one tenant degraded means local customisation, all tenants degraded means the vendor
   * shipped a release.
   */
  degraded: boolean;
}

export interface EvidenceBundle {
  screenshot: Buffer;
  html: string;
  aria: string;
  url: string;
  title: string;
}

/**
 * Who is allowed to act on this session right now.
 *
 * `Surface.act()` hard-gates on this: while the controller is `human`, automation is
 * *incapable* of acting, not merely discouraged from it. Control transfer is enforced by
 * the same chokepoint that enforces policy.
 */
export interface SessionLease {
  sessionId: string;
  controller: 'automation' | 'human' | 'none';
  holder?: string;
  /** Increments on every transfer, which is what makes a stale resume token detectable. */
  epoch: number;
  since: string;
  reason: string;
  expiresAt?: string;
}

/** Thrown by `Surface.act()` when the lease is not held by automation. */
export class LeaseDeniedError extends Error {
  constructor(readonly lease: SessionLease) {
    super(
      `automation cannot act: session ${lease.sessionId} is controlled by "${lease.controller}"` +
        (lease.holder ? ` (${lease.holder})` : '') +
        ` since ${lease.since} — ${lease.reason}`,
    );
    this.name = 'LeaseDeniedError';
  }
}

/** Thrown by `Surface.act()` when policy denies the action. */
export class PolicyDeniedError extends Error {
  constructor(
    readonly rule: string,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyDeniedError';
  }
}
