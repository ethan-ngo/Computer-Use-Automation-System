/**
 * The load-bearing seam.
 *
 * Everything the system knows about "how to perceive and act on a UI" lives behind this
 * one interface. The recorded artifact never references Playwright, so a Windows UIA
 * adapter can be added by implementing this interface and widening the `Strategy` union —
 * no change to the schema, the replay engine, the policy layer, or the evidence format.
 *
 * `act()` is the single chokepoint. Both discovery and replay pass through it, and it
 * enforces *both* the policy allowlist and the session lease. There is no second path by
 * which an action can reach the application, which is the strongest structural guarantee
 * in the design — and it is testable: acting under a denied policy or a human-held lease
 * throws.
 */

import type {
  ActionResult,
  EvidenceBundle,
  Observation,
  Resolution,
  SessionLease,
  SurfaceAction,
  UiNode,
} from './types.js';
import type { Locator } from '../artifact/schema.js';

export interface Surface {
  /** Normalized UI graph plus url/title. Never raw DOM. */
  observe(): Promise<Observation>;

  /** The one place an action can happen. Enforces policy and the lease. */
  act(action: SurfaceAction): Promise<ActionResult>;

  /** Exactly-one-match or a distinct ambiguity error. Never a silent `.nth(0)`. */
  resolve(locator: Locator): Promise<Resolution>;

  /** Screenshot + DOM + aria snapshot, with credential fields masked. */
  capture(): Promise<EvidenceBundle>;

  /** Who currently controls this session. */
  readonly lease: SessionLease;

  /** Resolve a css selector to normalized nodes; used by the `css`/`nth` strategies. */
  matchCss(selector: string): Promise<UiNode[]>;

  /**
   * Write an execution trace to `path`, returning false when this surface has none.
   *
   * Optional rather than required: a Playwright context records one, a Windows UIA adapter
   * has nothing equivalent, and making every adapter implement a stub would turn a real
   * capability difference into a silently empty file.
   */
  saveTrace?(path: string): Promise<boolean>;

  close(): Promise<void>;
}
