/**
 * The console page is one inlined string, so nothing compiles its script until a browser
 * loads it. A script that fails to parse renders as an empty shell — "Nothing needs
 * attention" while an escalation is waiting — which is the worst way for it to fail. This
 * was not hypothetical: the page was once built with String.raw, which kept the escaping
 * backslashes on its inner template literals and broke the script outright.
 */

import { describe, expect, it } from 'vitest';
import { PAGE } from '../src/escalation/console/page.js';

describe('console page', () => {
  it('serves a script that parses', () => {
    const script = PAGE.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
  });

  it('serves no leftover template-literal escapes', () => {
    expect(PAGE).not.toContain('\\`');
    expect(PAGE).not.toContain('\\${');
  });
});
