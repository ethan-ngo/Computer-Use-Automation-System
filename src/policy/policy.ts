/**
 * Policy loading and the three guardrail decisions: may we navigate there, may we perform
 * that kind of action, and is this step irreversible.
 *
 * Everything here is called from `Surface.act()` and nowhere else.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const PolicyFileSchema = z.object({
  allowedOrigins: z.array(z.string()).min(1),
  allowedPaths: z.array(z.string()).min(1),
  allowedSchemes: z.array(z.string()).min(1),
  allowedActions: z.array(z.string()).min(1),
  deniedCapabilities: z.array(z.string()).default([]),
  irreversiblePatterns: z.array(z.string()).default([]),
  redaction: z.object({
    secretEnvPatterns: z.array(z.string()).default([]),
    valuePatterns: z.array(z.object({ name: z.string(), pattern: z.string() })).default([]),
    maskSelectors: z.array(z.string()).default([]),
  }),
  budgets: z.object({
    maxStepsPerReplay: z.number().int().positive(),
    maxDiscoverySteps: z.number().int().positive(),
    wallClockMs: z.number().int().positive(),
    maxRetriesPerStep: z.number().int().nonnegative(),
    minDelayBetweenActionsMs: z.number().int().nonnegative(),
  }),
});

export type Policy = z.infer<typeof PolicyFileSchema>;

export function loadPolicy(root = process.cwd()): Policy {
  return PolicyFileSchema.parse(parse(readFileSync(join(root, 'policy.yaml'), 'utf-8')));
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export interface NavigationVerdict {
  allowed: boolean;
  rule: string;
  reason: string;
}

/** Glob with `**` (any remainder, including `/`) and `*` (one path segment). */
function pathMatches(glob: string, path: string): boolean {
  const rx = new RegExp(
    '^' +
      glob
        .split('**')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
        .join('.*') +
      '$',
  );
  return rx.test(path);
}

/**
 * Navigation check.
 *
 * Parsed-origin matching, never string prefix. Prefix matching is defeated by
 * `https://parabank.parasoft.com.evil.tld/`, which shares the prefix but is a wholly
 * different origin — and by `https://parabank.parasoft.com@evil.tld/`, where the real
 * host is the part after the `@`. `new URL()` resolves both correctly.
 */
export function checkNavigation(policy: Policy, rawUrl: string, extraOrigins: string[] = []): NavigationVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, rule: 'url.parse', reason: `"${rawUrl}" is not an absolute URL` };
  }

  const scheme = url.protocol.replace(/:$/, '');
  if (!policy.allowedSchemes.includes(scheme)) {
    return {
      allowed: false,
      rule: 'scheme.allowlist',
      reason: `scheme "${scheme}" is not allowed (allowed: ${policy.allowedSchemes.join(', ')})`,
    };
  }

  // Compare normalized origins, so scheme, host and port must all agree.
  const origins = [...policy.allowedOrigins, ...extraOrigins].map((o) => {
    try {
      return new URL(o).origin;
    } catch {
      return o;
    }
  });
  if (!origins.includes(url.origin)) {
    return {
      allowed: false,
      rule: 'origin.allowlist',
      reason: `origin "${url.origin}" is not in the allowlist (allowed: ${origins.join(', ')})`,
    };
  }

  if (!policy.allowedPaths.some((glob) => pathMatches(glob, url.pathname))) {
    return {
      allowed: false,
      rule: 'path.allowlist',
      reason: `path "${url.pathname}" does not match any allowed route`,
    };
  }

  return { allowed: true, rule: 'origin.allowlist', reason: `${url.origin}${url.pathname} allowed` };
}

// ---------------------------------------------------------------------------
// Action vocabulary
// ---------------------------------------------------------------------------

export function checkAction(policy: Policy, actionType: string): NavigationVerdict {
  if (!policy.allowedActions.includes(actionType)) {
    return {
      allowed: false,
      rule: 'action.vocabulary',
      reason: `action "${actionType}" is not in the allowed vocabulary`,
    };
  }
  return { allowed: true, rule: 'action.vocabulary', reason: `action "${actionType}" allowed` };
}

export function isCapabilityDenied(policy: Policy, capability: string): boolean {
  return policy.deniedCapabilities.includes(capability);
}

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

/**
 * Heuristic, and honestly so. It exists to make human review of an artifact cheap and
 * focused; the review itself is the real control. A step this misses — "Continue" that
 * commits a wire — is a classification failure with a serious consequence, which is why
 * the recorder also defaults to `irreversible` when the post-action state looks like a
 * commit confirmation.
 */
export function classifyRisk(policy: Policy, intent: string): 'safe' | 'irreversible' {
  const text = intent.toLowerCase();
  return policy.irreversiblePatterns.some((p) => new RegExp(p, 'i').test(text))
    ? 'irreversible'
    : 'safe';
}
