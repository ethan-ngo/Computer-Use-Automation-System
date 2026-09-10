import { createHash } from 'node:crypto';
import type { Observation, UiNode } from '../../src/surface/types.js';

let counter = 0;

export function node(patch: Partial<UiNode> & { role: string }): UiNode {
  counter += 1;
  return {
    ref: patch.ref ?? `e${counter}`,
    role: patch.role,
    name: patch.name ?? '',
    value: patch.value,
    enabled: patch.enabled ?? true,
    labelHint: patch.labelHint,
    placeholder: patch.placeholder,
    testId: patch.testId,
    cssPath: patch.cssPath ?? `body > *:nth-child(${counter})`,
    siblingIndex: patch.siblingIndex ?? 0,
    framePath: patch.framePath ?? [],
  };
}

export function observation(patch: Partial<Observation> & { nodes: UiNode[] }): Observation {
  const nodes = patch.nodes;
  return {
    url: patch.url ?? 'https://parabank.parasoft.com/parabank/index.htm',
    title: patch.title ?? 'ParaBank',
    nodes,
    text: patch.text ?? nodes.map((n) => `${n.labelHint ?? ''} ${n.name}`).join(' '),
    ariaHash:
      patch.ariaHash ??
      createHash('sha1').update(JSON.stringify(nodes.map((n) => [n.role, n.name]))).digest('hex'),
    capturedAt: patch.capturedAt ?? '2026-01-01T00:00:00.000Z',
  };
}
