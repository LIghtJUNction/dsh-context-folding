import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ToolCallId, type RequestMessage, type ToolResultMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import plugin from '../src/index.js';
import type { Config, ContentPage, ToolArgs } from '../src/types.js';
import { createHost, produceFixture, prompt, registerFixture, textResponse, toolResponse, type Host } from './host.js';

const originalText = '头部😀e\u0301\n' + '逐字恢复：🧪𐐷中文 café\n'.repeat(600) + '尾部✅';
const otherBlock = { type: 'reasoning' as const, text: 'Opaque non-text block remains byte-for-byte equivalent.' };
const blocks = [{ type: 'text' as const, text: originalText }, otherBlock];
const testConfig: Config = {
  auto: true, keepRecentMessages: 2, minTextChars: 512,
  headChars: 32, tailChars: 16, triggerTokens: 1, maxFoldsPerStep: 2,
};

interface Entry {
  ref: string;
  originalSeq: number;
  currentSeq: number;
  folded: boolean;
  active: boolean;
  protected: boolean;
  disposition: string;
}
interface Listing { ok: true; entries: Entry[]; nextOffset: number | null; total: number }

async function setup(t: TestContext, config: Partial<Config> = {}, root?: string): Promise<Host> {
  const actualRoot = root ?? await mkdtemp(join(tmpdir(), 'dsh-fold-host-'));
  const host = await createHost(actualRoot);
  t.after(async () => {
    await host.close();
    if (!root) await rm(actualRoot, { recursive: true, force: true });
  });
  await host.ctx.plugin(plugin, { ...testConfig, ...config });
  registerFixture(host.ctx, blocks);
  return host;
}

let serial = 0;
async function execute(host: Host, agent: Agent | undefined, args: ToolArgs, signal = new AbortController().signal) {
  return host.ctx.tools.execute({
    callId: ToolCallId(`direct-${++serial}`), name: 'context_folding', arguments: args,
    ...(agent ? { agent } : {}), signal,
  });
}

async function value<T>(host: Host, agent: Agent, args: ToolArgs): Promise<T> {
  const result = await execute(host, agent, args);
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.ok('value' in result);
  return result.value as T;
}

async function list(host: Host, agent: Agent): Promise<Listing> {
  return value<Listing>(host, agent, { action: 'list', offset: 0, limit: 100 });
}

async function age(host: Host, agent: Agent, turns = 3): Promise<void> {
  for (let index = 0; index < turns; index++) {
    host.model.responses.push(textResponse(`Acknowledged ${index}.`));
    await prompt(agent, `Preserve this current user instruction ${index}.`);
  }
  assert.deepEqual(host.errors, []);
}

function replacements(agent: Agent): SessionEvent<'tool/result'>[] {
  return agent.session.snapshotEvents().filter((event): event is SessionEvent<'tool/result'> =>
    event.type === 'tool/result' && typeof event.surfaceOp === 'object');
}

function fixtureMessage(messages: readonly RequestMessage[]): ToolResultMessage {
  const message = messages.find((item): item is ToolResultMessage =>
    item.role === 'tool' && item.toolCallId === 'fixture-1');
  assert.ok(message, 'fixture tool result remains in model-visible history');
  return message;
}

async function modelCommand(host: Host, agent: Agent, args: ToolArgs): Promise<void> {
  host.model.responses.push(toolResponse('context_folding', args, `command-${++serial}`), textResponse('Command complete.'));
  await prompt(agent, 'Use the context_folding tool as requested.');
  assert.deepEqual(host.errors, []);
}

test('real rc.2 model/tool loop folds old outputs, preserves log/roles/pairing, and restores exact Unicode pages', async (t) => {
  const host = await setup(t);
  const { agent } = await host.create('integration-auto');
  await produceFixture(host, agent);
  const originalEvents = agent.session.snapshotEvents();
  const prefix = JSON.stringify(originalEvents);
  const first = (await list(host, agent)).entries[0];
  assert.ok(first);
  assert.equal(first.protected, true);
  assert.equal(first.folded, false);
  await age(host, agent);

  assert.equal(JSON.stringify(agent.session.snapshotEvents().slice(0, originalEvents.length)), prefix);
  const entry = (await list(host, agent)).entries.find((item) => item.ref === first.ref);
  assert.ok(entry?.folded);
  assert.equal(replacements(agent).length, 1);
  const request = host.model.requests.at(-1);
  assert.ok(request);
  assert.ok(Object.isFrozen(request));
  assert.ok(request.tools?.some((tool) => tool.name === 'context_folding'));
  const folded = fixtureMessage(request.messages);
  assert.ok(JSON.stringify(folded.content).length < JSON.stringify(blocks).length);
  assert.deepEqual(folded.content[1], otherBlock);
  assert.ok(request.messages.some((message) => message.role === 'assistant' &&
    message.content.some((block) => block.type === 'tool-call' && block.id === folded.toolCallId)));
  assert.ok(request.messages.some((message) => message.role === 'system'));
  assert.ok(request.messages.some((message) => message.role === 'user' &&
    message.content.some((block) => block.type === 'text' && block.text.includes('current user instruction'))));

  let recovered = '';
  let offset: number | null = 0;
  while (offset !== null) {
    const read: { page: ContentPage } = await value<{ page: ContentPage }>(host, agent, {
      action: 'read', ref: first.ref, block: 0, offset, limit: 997,
    });
    assert.equal(read.page.encoding, 'text');
    assert.equal(read.page.offset, offset);
    recovered += read.page.data;
    offset = read.page.nextOffset;
  }
  assert.equal(recovered, originalText);
  const rich = await value<{ page: ContentPage }>(host, agent, { action: 'read', ref: first.ref, block: 1, limit: 1000 });
  assert.equal(rich.page.encoding, 'json');
  assert.deepEqual(JSON.parse(rich.page.data), otherBlock);
  await modelCommand(host, agent, { action: 'read', ref: first.ref, block: 0, limit: 2000 });
  await age(host, agent);
  assert.equal(replacements(agent).length, 1, 'recovery tool output never recursively folds itself');
  assert.deepEqual(host.errors, []);
});

test('manual folding waits for a successful durable tool receipt; keep restores and persists', async (t) => {
  const host = await setup(t, { auto: false });
  const { agent } = await host.create('integration-manual');
  await produceFixture(host, agent);
  await age(host, agent);
  const entry = (await list(host, agent)).entries[0];
  assert.ok(entry);
  const args: ToolArgs = { action: 'fold', ref: entry.ref, summary: 'Agent-authored summary of the offline fixture.' };
  const direct = await execute(host, agent, args);
  assert.equal(direct.isError, true, 'mutation requires a matching logged model call');
  await age(host, agent, 1);
  assert.equal(replacements(agent).length, 0, 'an unlogged direct dispatch is not a durable command');

  await modelCommand(host, agent, args);
  assert.ok((await list(host, agent)).entries[0]?.folded);
  assert.equal(replacements(agent).length, 1);
  const foldedText = JSON.stringify(fixtureMessage(agent.session.deriveMessages()).content);
  assert.match(foldedText, /Agent-authored summary/);
  await modelCommand(host, agent, { action: 'keep', ref: entry.ref });
  assert.deepEqual(fixtureMessage(agent.session.deriveMessages()).content, blocks);
  assert.equal((await list(host, agent)).entries[0]?.disposition, 'keep');
  await age(host, agent, 2);
  assert.deepEqual(fixtureMessage(agent.session.deriveMessages()).content, blocks);
});

test('a post-execute policy rejection cannot leave behind a successful fold command', async (t) => {
  const host = await setup(t, { auto: false });
  const { agent } = await host.create('integration-post-policy');
  await produceFixture(host, agent);
  await age(host, agent);
  const entry = (await list(host, agent)).entries[0];
  assert.ok(entry);
  host.ctx.on('tools/post-execute', async (execution, _result, next) => {
    if (execution.name === 'context_folding') {
      return { kind: 'block', feedback: [{ type: 'text', text: 'Blocked by the integration policy.' }] };
    }
    return next();
  });
  await modelCommand(host, agent, { action: 'fold', ref: entry.ref, summary: 'Must not commit.' });
  await age(host, agent, 2);
  assert.equal(replacements(agent).length, 0);
  assert.deepEqual(fixtureMessage(agent.session.deriveMessages()).content, blocks);
  const results = agent.session.snapshotEvents().filter((event) => event.type === 'tool/result');
  assert.ok(results.some((event) => event.type === 'tool/result' && event.data.message.isError === true));
});

test('duplicate model commands are idempotent; unmarked explicitly restores an unfolded item', async (t) => {
  const host = await setup(t);
  const { agent } = await host.create('integration-duplicate');
  await produceFixture(host, agent);
  await age(host, agent);
  const entry = (await list(host, agent)).entries[0];
  assert.ok(entry?.folded);
  await modelCommand(host, agent, { action: 'keep', ref: entry.ref });
  const count = replacements(agent).length;
  await modelCommand(host, agent, { action: 'keep', ref: entry.ref });
  assert.equal(replacements(agent).length, count);
  await modelCommand(host, agent, { action: 'unmarked', ref: entry.ref });
  assert.equal((await list(host, agent)).entries[0]?.folded, false);
  assert.equal((await list(host, agent)).entries[0]?.disposition, 'unmarked');
  assert.equal(replacements(agent).length, count);
  await age(host, agent);
  assert.deepEqual(fixtureMessage(agent.session.deriveMessages()).content, blocks);
});

test('session binding rejects absent/stale/foreign callers, foreign refs and aborted operations', async (t) => {
  const host = await setup(t, { auto: false });
  const a = await host.create('integration-scope-a');
  const b = await host.create('integration-scope-b');
  await produceFixture(host, a.agent);
  await age(host, a.agent);
  const ref = (await list(host, a.agent)).entries[0]?.ref;
  assert.ok(ref);
  assert.equal((await execute(host, undefined, { action: 'list' })).isError, true);
  const impostor = { id: a.agent.id, session: a.agent.session, ctx: a.agent.ctx } as Agent;
  assert.equal((await execute(host, impostor, { action: 'list' })).isError, true);
  assert.equal((await execute(host, b.agent, { action: 'read', ref })).isError, true);
  const controller = new AbortController();
  controller.abort();
  assert.equal((await execute(host, a.agent, { action: 'fold', ref, summary: 'Canceled' }, controller.signal)).isError, true);
  assert.equal(replacements(a.agent).length, 0);
  assert.equal((await list(host, b.agent)).total, 0);
  await a.dispose();
  assert.equal((await execute(host, a.agent, { action: 'read', ref })).isError, true);
});

test('a scoped hidden recovery tool disables automatic folding and restores owned folds', async (t) => {
  const host = await setup(t);
  const { agent } = await host.create('integration-hidden');
  await produceFixture(host, agent);
  await age(host, agent);
  assert.ok((await list(host, agent)).entries[0]?.folded);
  const lift = agent.ctx.tools.restrict({ deny: ['context_folding'] });
  await age(host, agent, 2);
  assert.deepEqual(fixtureMessage(agent.session.deriveMessages()).content, blocks);
  assert.equal((await execute(host, agent, { action: 'list' })).isError, true);
  lift();
  await age(host, agent, 1);
  assert.ok((await list(host, agent)).entries[0]?.folded);
});

test('a recovery tool removed after pre-step stops the frozen model request before adapter dispatch', async (t) => {
  const host = await setup(t);
  const { agent } = await host.create('integration-recovery-race');
  await produceFixture(host, agent);
  await age(host, agent);
  assert.ok((await list(host, agent)).entries[0]?.folded);
  const calls = host.model.requests.length;
  let restricted = false;
  agent.ctx.on('agent/request', async (_payload, next) => {
    const config = await next();
    if (!restricted) {
      agent.ctx.tools.restrict({ deny: ['context_folding'] });
      restricted = true;
    }
    return config;
  });
  host.model.responses.push(textResponse('This response must never be requested.'));
  await prompt(agent, 'A request with unreachable recovery must fail closed.');
  assert.equal(restricted, true);
  assert.equal(host.model.requests.length, calls, 'the adapter never receives an unrecoverable folded request');
});

test('without a persistence provider the host keeps every original output', async (t) => {
  const host = await createHost();
  t.after(() => host.close());
  await host.ctx.plugin(plugin, testConfig);
  registerFixture(host.ctx, blocks);
  const { agent } = await host.create('integration-no-persistence');
  await produceFixture(host, agent);
  await age(host, agent, 4);
  assert.equal(replacements(agent).length, 0);
  assert.deepEqual(fixtureMessage(agent.session.deriveMessages()).content, blocks);
});

test('real JSONL shutdown/resume preserves folded history, exact recovery and marks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fold-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let host = await createHost(root);
  try {
    await host.ctx.plugin(plugin, testConfig);
    registerFixture(host.ctx, blocks);
    let handle = await host.create('integration-resume');
    await produceFixture(host, handle.agent);
    await age(host, handle.agent);
    const before = (await list(host, handle.agent)).entries[0];
    assert.ok(before?.folded);
    const count = replacements(handle.agent).length;
    assert.equal(await host.ctx.sessions.flush(handle.agent.session), true);
    await handle.dispose();
    await host.close();

    host = await createHost(root);
    await host.ctx.plugin(plugin, testConfig);
    handle = await host.resume('integration-resume');
    const after = (await list(host, handle.agent)).entries[0];
    assert.equal(after?.ref, before.ref);
    assert.equal(after?.folded, true);
    assert.equal(replacements(handle.agent).length, count);
    const read = await value<{ page: ContentPage }>(host, handle.agent, { action: 'read', ref: before.ref, limit: 111 });
    assert.equal(read.page.data, Array.from(originalText).slice(0, 111).join(''));
    await modelCommand(host, handle.agent, { action: 'keep', ref: before.ref });
    await host.ctx.sessions.flush(handle.agent.session);
    await handle.dispose();
    await host.close();

    host = await createHost(root);
    await host.ctx.plugin(plugin, testConfig);
    handle = await host.resume('integration-resume');
    await age(host, handle.agent, 2);
    assert.equal((await list(host, handle.agent)).entries[0]?.disposition, 'keep');
    assert.deepEqual(fixtureMessage(handle.agent.session.deriveMessages()).content, blocks);
    assert.deepEqual(host.errors, []);
    await handle.dispose();
  } finally {
    await host.close();
  }
});
