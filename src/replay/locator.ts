/**
 * Locator resolution.
 *
 * Three rules, and all three are the point:
 *
 *  1. Try `primary`, then each fallback in order.
 *  2. **Require exactly one match.** Two matches is `LOCATOR_AMBIGUOUS` — a distinct,
 *     surfaced failure class that routes to a human. Never a silent `.nth(0)`, because a
 *     silent wrong pick in a banking flow is the failure mode that does not show up in
 *     testing.
 *  3. **Record which strategy actually resolved.** A fallback winning is a drift signal,
 *     not a success to be forgotten. Aggregated across tenants it distinguishes "this
 *     institution customised the app" from "the vendor shipped a release".
 *
 * Structural strategies resolve against the normalized `Observation`, so this is a pure
 * function and testable with no browser. Only `css`/`nth` need the surface, which is
 * injected as a matcher.
 */

import type { Locator, Strategy } from '../artifact/schema.js';
import type { Observation, Resolution, UiNode } from '../surface/types.js';
import { ReplayError } from './errors.js';

export type CssMatcher = (selector: string) => Promise<UiNode[]>;

export class LocatorNotFoundError extends ReplayError {
  constructor(
    readonly locator: Locator,
    readonly tried: Strategy[],
  ) {
    super(
      'LOCATOR_NOT_FOUND',
      `no element matched "${locator.description}" after trying ${tried.length} ` +
        `strateg${tried.length === 1 ? 'y' : 'ies'}: ${tried.map(describeStrategy).join(', ')}`,
      { locator: locator.description, tried: tried.map(describeStrategy) },
    );
    this.name = 'LocatorNotFoundError';
  }
}

export class LocatorAmbiguousError extends ReplayError {
  constructor(
    readonly locator: Locator,
    readonly strategy: Strategy,
    readonly candidates: UiNode[],
  ) {
    super(
      'LOCATOR_AMBIGUOUS',
      `"${locator.description}" matched ${candidates.length} elements via ` +
        `${describeStrategy(strategy)}; refusing to guess. Candidates: ` +
        candidates.map((c) => `${c.role} "${c.name || c.labelHint || c.cssPath}"`).join(' | '),
      {
        locator: locator.description,
        strategy: describeStrategy(strategy),
        // The candidate list is what the operator needs to disambiguate, so it is carried
        // into the escalation payload rather than only into the log line.
        candidates: candidates.map((c) => ({ role: c.role, name: c.name, cssPath: c.cssPath })),
      },
    );
    this.name = 'LocatorAmbiguousError';
  }
}

export function describeStrategy(s: Strategy): string {
  switch (s.kind) {
    case 'role':
      return `role=${s.role} name="${s.name}"`;
    case 'label':
      return `label="${s.text}"`;
    case 'placeholder':
      return `placeholder="${s.text}"`;
    case 'nearbyText':
      return `nearbyText="${s.text}" role=${s.role}`;
    case 'text':
      return `text="${s.text}"`;
    case 'testId':
      return `testId="${s.id}"`;
    case 'css':
      return `css="${s.selector}"`;
    case 'nth':
      return `nth(${s.index}) of css="${s.within.selector}"`;
  }
}

/** Accessible-name comparison: trimmed, whitespace-collapsed, case-insensitive. */
function normalize(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function contains(haystack: string | undefined, needle: string): boolean {
  return normalize(haystack).includes(normalize(needle));
}

/**
 * Nodes matching one strategy. Structural strategies only; css/nth handled by the caller.
 *
 * Exported because the recorder checks candidate locators for uniqueness *before* writing
 * them into an artifact, and it must use this exact function to do it. A recorder with its
 * own notion of "matches" would happily record locators that the replay engine then fails
 * to resolve — the two would drift apart silently, and only in production.
 */
export function matchStrategy(nodes: UiNode[], strategy: Strategy): UiNode[] | undefined {
  switch (strategy.kind) {
    case 'role':
      return nodes.filter(
        (n) => normalize(n.role) === normalize(strategy.role) && normalize(n.name) === normalize(strategy.name),
      );
    case 'label':
      return nodes.filter(
        (n) => normalize(n.labelHint) === normalize(strategy.text) || normalize(n.name) === normalize(strategy.text),
      );
    case 'placeholder':
      return nodes.filter((n) => normalize(n.placeholder) === normalize(strategy.text));
    case 'nearbyText':
      // Substring rather than equality: a caption cell often carries trailing punctuation
      // or a whole prompt sentence ("What type of account would you like to open?").
      return nodes.filter(
        (n) => normalize(n.role) === normalize(strategy.role) && contains(n.labelHint, strategy.text),
      );
    case 'text':
      return nodes.filter((n) => contains(n.name, strategy.text));
    case 'testId':
      return nodes.filter((n) => n.testId === strategy.id);
    case 'css':
    case 'nth':
      return undefined; // needs the surface
  }
}

async function candidatesFor(
  observation: Observation,
  strategy: Strategy,
  matchCss?: CssMatcher,
): Promise<UiNode[]> {
  const structural = matchStrategy(observation.nodes, strategy);
  if (structural) return structural;

  if (!matchCss) return [];

  if (strategy.kind === 'css') return matchCss(strategy.selector);

  if (strategy.kind === 'nth') {
    const within = await matchCss(strategy.within.selector);
    const picked = within[strategy.index];
    // `nth` is an explicit, recorded decision to take the Nth match. That is different
    // from silently taking the first when a strategy is ambiguous, which is what rule 2
    // forbids — here the index was reviewed and written into the artifact.
    return picked ? [picked] : [];
  }

  return [];
}

/**
 * Resolve a locator against an observation.
 *
 * @throws {LocatorAmbiguousError} when a strategy matches more than one element.
 * @throws {LocatorNotFoundError} when no strategy matches anything.
 */
export async function resolveLocator(
  observation: Observation,
  locator: Locator,
  matchCss?: CssMatcher,
): Promise<Resolution> {
  const chain: Strategy[] = [locator.primary, ...locator.fallbacks];
  const tried: Strategy[] = [];

  for (const [i, strategy] of chain.entries()) {
    tried.push(strategy);
    const candidates = await candidatesFor(observation, strategy, matchCss);

    if (candidates.length === 1) {
      const fallbackIndex = i - 1; // -1 when the primary won
      return {
        node: candidates[0]!,
        strategy,
        fallbackIndex,
        degraded: fallbackIndex >= 0,
      };
    }

    if (candidates.length > 1) {
      // Ambiguity stops the chain rather than falling through. Falling through would let a
      // later, weaker strategy paper over a genuine "which one did you mean?" — and the
      // human is the right place to resolve that, once, into the artifact.
      throw new LocatorAmbiguousError(locator, strategy, candidates);
    }
  }

  throw new LocatorNotFoundError(locator, tried);
}
