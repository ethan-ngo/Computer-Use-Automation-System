/**
 * `npm run agent-demo` — the loop closed.
 *
 * A production agent is asked, in natural language, to do a piece of banking work. It is
 * given the capability catalog and nothing else: no browser, no page text, no screenshots,
 * no locators, no knowledge that ParaBank exists. It picks a tool, supplies typed
 * arguments, and the capability replays deterministically underneath it.
 *
 * This is the argument the whole system makes, executable:
 *
 *   discovery is expensive and happens once, with a model in the loop;
 *   invocation is cheap and happens forever, with no model in the decision path.
 *
 * The model here spends a few hundred tokens choosing a tool. It never sees the six steps,
 * the fallback locator chains, or the bank. If the capability returns a declared business
 * outcome, the agent is told in the tool result that it is a result and must not be
 * retried — which is the distinction the catalog description advertises up front.
 *
 *   npm run agent-demo -- --ask "open me a new savings account"
 *   npm run agent-demo -- --fixtures        # offline: reaches LOGIN_REJECTED, no live bank
 *   npm run agent-demo -- --dry-run         # choose the tool, do not execute it
 */

import { pathToFileURL } from 'node:url';
import { newClient } from '../agent/loop.js';
import { Catalog } from '../catalog/catalog.js';
import { invoke, type InvocationResult } from '../catalog/invoke.js';

const MODEL = 'claude-opus-5';

const SYSTEM = `You are an operations agent at a bank. You accomplish work by calling the
capability tools you have been given. Each tool is a flow that was recorded once against a
real banking application and now replays deterministically.

Rules:
- Choose exactly one tool, or answer plainly that no tool fits. Never invent a tool.
- Supply only the arguments the tool's schema declares. You are never given credentials and
  must never ask for them; they are resolved from the tenant's vault when the flow runs.
- A tool may return a business outcome (the bank declining, a form refusing). That is a
  RESULT, not a malfunction. Report it and stop — do not retry it.
- When a tool result comes back, reply to the user in one or two plain sentences.`;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function summarise(result: InvocationResult): string {
  switch (result.status) {
    case 'success':
      return `success — ${JSON.stringify(result.outputs)}`;
    case 'business_outcome':
      return `business outcome ${result.outcome} (a result, not a failure): ${result.detail}`;
    case 'escalated':
      return `escalated at "${result.atStep}" — a human is needed`;
    case 'failed':
      return `failed: ${result.errorClass} — ${result.message}`;
    case 'rejected':
      return `rejected: ${result.reason}`;
  }
}

async function main(): Promise<void> {
  const ask =
    flag('ask') ?? 'Please open a new savings account for me and tell me the account number.';

  const catalog = await Catalog.load();
  if (catalog.entries.length === 0) {
    throw new Error('the catalog is empty — run `npm run discover` first');
  }

  console.log(`user: ${ask}\n`);
  console.log(`catalog: ${catalog.entries.map((e) => e.toolName).join(', ')}\n`);

  const client = newClient();
  const messages: Parameters<typeof client.messages.create>[0]['messages'] = [
    { role: 'user', content: ask },
  ];

  const first = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    tools: catalog.tools,
    messages,
  });

  const call = first.content.find((block) => block.type === 'tool_use');
  if (!call || call.type !== 'tool_use') {
    const text = first.content.find((b) => b.type === 'text');
    console.log(`agent chose no capability: ${text?.type === 'text' ? text.text : '(no answer)'}`);
    process.exitCode = 1;
    return;
  }

  console.log(`agent chose: ${call.name}`);
  console.log(`  arguments: ${JSON.stringify(call.input)}\n`);

  if (has('dry-run')) {
    console.log('--dry-run: stopping before execution.');
    return;
  }

  const result = await invoke({
    catalog,
    toolName: call.name,
    args: call.input,
    headless: !has('headed'),
    ...(has('fixtures') ? { baseUrl: 'http://127.0.0.1:8787' } : {}),
    // No approval hook: an irreversible step escalates to a human rather than being
    // authorised by the agent that requested it. That is the demo's most important line.
  });

  console.log(`capability: ${summarise(result)}`);
  console.log(`evidence:   ${'evidence' in result ? result.evidence : '(none)'}\n`);

  messages.push({ role: 'assistant', content: first.content });
  messages.push({
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(result),
        ...(result.ok ? {} : { is_error: true }),
      },
    ],
  });

  const second = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    tools: catalog.tools,
    messages,
  });

  const reply = second.content.find((b) => b.type === 'text');
  console.log(`agent: ${reply?.type === 'text' ? reply.text : '(no answer)'}`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  });
}
