/**
 * Business-outcome detection.
 *
 * The central claim of the design: "the loan was denied" is a *result*, not a failure. The
 * system that treats it as a failure retries it, escalates it to a human, and eventually
 * reports an outage — for an application that answered correctly the first time.
 *
 * So outcomes are declared in the artifact, compiled here into detectors, and evaluated on
 * every observation the engine takes. The engine races them against the step checkpoint
 * and gives them precedence, which is what stops a denial page from timing out as
 * CHECKPOINT_FAILED.
 */

import type { OutcomeSpec } from '../artifact/schema.js';
import type { Observation } from '../surface/types.js';
import { evaluate } from './assertions.js';
import { extractAll, DEFAULT_LOCALE, type ExtractedValue, type Locale } from './extract.js';
import type { CssMatcher } from './locator.js';

export interface OutcomeHit {
  name: string;
  description: string;
  terminal: boolean;
  /** Why the detector fired, taken verbatim into the run log and the caller's result. */
  detail: string;
  /** Detail pulled off the outcome page — a denial reason, a required minimum. */
  data: Record<string, ExtractedValue>;
}

/**
 * First matching outcome, or undefined.
 *
 * Declaration order is precedence order. That is a real decision: two detectors can both
 * match a page (a generic "an error occurred" and a specific "insufficient funds"), and
 * the artifact author orders them so the specific one is declared first.
 */
export async function detectOutcome(
  outcomes: OutcomeSpec[],
  observation: Observation,
  locale: Locale = DEFAULT_LOCALE,
  matchCss?: CssMatcher,
): Promise<OutcomeHit | undefined> {
  for (const outcome of outcomes) {
    let result;
    try {
      result = await evaluate(outcome.detect, observation, matchCss);
    } catch {
      // A detector that cannot be evaluated (an ambiguous locator inside it) must not take
      // down the run: the page is then simply "not this outcome", and the step's own
      // checkpoint or error handling decides what happens. Suppressing here is safe
      // precisely because it can only ever cause us to miss an outcome, never invent one.
      continue;
    }
    if (!result.ok) continue;

    let data: Record<string, ExtractedValue> = {};
    if (outcome.extract.length > 0) {
      try {
        data = await extractAll(outcome.extract, observation, locale, matchCss);
      } catch {
        // The outcome is still the outcome even if its optional detail could not be read.
        data = {};
      }
    }

    return {
      name: outcome.name,
      description: outcome.description,
      terminal: outcome.terminal,
      detail: result.detail,
      data,
    };
  }
  return undefined;
}
