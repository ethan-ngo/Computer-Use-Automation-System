/**
 * Evaluates the declarative assertion language from the artifact schema.
 *
 * Used for step preconditions (`waitFor`), step checkpoints, the capability postcondition,
 * and outcome detectors — deliberately the same evaluator for all four, so an outcome
 * detector can never express something a checkpoint cannot, and a reviewer only has to
 * learn one language.
 *
 * No LLM, by construction: this is the hot path of replay.
 */

import type { Assertion } from '../artifact/schema.js';
import type { Observation } from '../surface/types.js';
import { resolveLocator, LocatorAmbiguousError, type CssMatcher } from './locator.js';

export interface AssertionOutcome {
  ok: boolean;
  /** Human-readable, used verbatim in escalation payloads and failure evidence. */
  detail: string;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

export async function evaluate(
  assertion: Assertion,
  observation: Observation,
  matchCss?: CssMatcher,
): Promise<AssertionOutcome> {
  switch (assertion.kind) {
    case 'urlMatches': {
      const ok = new RegExp(assertion.pattern).test(observation.url);
      return { ok, detail: `url "${observation.url}" ${ok ? 'matches' : 'does not match'} /${assertion.pattern}/` };
    }

    case 'titleMatches': {
      const ok = new RegExp(assertion.pattern).test(observation.title);
      return { ok, detail: `title "${observation.title}" ${ok ? 'matches' : 'does not match'} /${assertion.pattern}/` };
    }

    case 'textPresent': {
      const ok = normalize(observation.text).includes(normalize(assertion.text));
      return { ok, detail: `text "${assertion.text}" ${ok ? 'present' : 'absent'}` };
    }

    case 'textAbsent': {
      const ok = !normalize(observation.text).includes(normalize(assertion.text));
      return { ok, detail: `text "${assertion.text}" ${ok ? 'absent' : 'present'}` };
    }

    case 'elementVisible': {
      try {
        const resolution = await resolveLocator(observation, assertion.locator, matchCss);
        return {
          ok: true,
          detail: `"${assertion.locator.description}" visible${resolution.degraded ? ' (via fallback)' : ''}`,
        };
      } catch (err) {
        // Ambiguity is not "absent". Two matching elements means the assertion cannot be
        // evaluated honestly, so it propagates rather than quietly reading as false.
        if (err instanceof LocatorAmbiguousError) throw err;
        return { ok: false, detail: `"${assertion.locator.description}" not found` };
      }
    }

    case 'elementAbsent': {
      try {
        await resolveLocator(observation, assertion.locator, matchCss);
        return { ok: false, detail: `"${assertion.locator.description}" is present but should be absent` };
      } catch (err) {
        if (err instanceof LocatorAmbiguousError) throw err;
        return { ok: true, detail: `"${assertion.locator.description}" absent` };
      }
    }

    case 'all': {
      const details: string[] = [];
      for (const sub of assertion.of) {
        const result = await evaluate(sub, observation, matchCss);
        details.push(result.detail);
        if (!result.ok) return { ok: false, detail: `all(...) failed: ${result.detail}` };
      }
      return { ok: true, detail: `all(${details.join('; ')})` };
    }

    case 'any': {
      const details: string[] = [];
      for (const sub of assertion.of) {
        const result = await evaluate(sub, observation, matchCss);
        details.push(result.detail);
        if (result.ok) return { ok: true, detail: `any(...) satisfied by: ${result.detail}` };
      }
      return { ok: false, detail: `any(...) failed: none of ${details.join('; ')}` };
    }
  }
}
