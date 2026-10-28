import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ToolCallId, freezeMessage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import plugin from '../src/index.js';
import { resolveConfig } from '../src/config.js';
import { FoldingController } from '../src/controller.js';
import { foldContent, makeRef, verifyFold } from '../src/content.js';
import { PROJECTION_KEY, TOOL_NAME, type Config, type RecordState } from '../src/types.js';
import { createHost, produceFixture, prompt, registerFixture, textResponse, toolResponse } from './host.js';

const originalText = 'Exact original 😀\n'.repeat(600);
const settings = resolveConfig({
  auto: true, keepRecentMessages: 1, minTextChars: 512,
  headChars: 20, tailChars: 12, triggerTokens: 1, maxFoldsPerStep: 4,
});
let serial = 0;

async function setup(t: TestContext, persistent = true, options: Partial<Config> = {}, fixture = originalText) {
  const root = persistent ? await mkdtemp(join(tmpdir(), 'dsh-fold-failure-')) : undefined;
  const host = await createHost(root);
  t.after(async () => {
    await host.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  registerFixture(host.ctx, [{ type: 'text', text: fixture }]);
  const { agent } = await host.create(`failure-${++serial}`);
  await produceFixture(host, agent);
  assert.deepEqual(host.errors, []);
  const config = resolveConfig({ ...settings, ...options });
  await host.ctx.plugin(plugin, config);
  const controller = new FoldingController(host.ctx, config);
  const definition = host.ctx.tools.get(TOOL_NAME, agent);
  assert.ok(definition);
  controller.definition = definition;
  const record = () => {
    const state = host.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY);
    const found = Object.values(state?.records ?? {}).find(item => item.original.data.message.source.callId === 'fixture-1');
    assert.ok(found);
    return found;
  };
  return { host, agent, controller, record };
}

const signal = () => new AbortController().signal;
function visibleText(session: Session, record: RecordState): string {
  const message = session.deriveEventMessage(record.current);
  assert.ok(message);
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('');
}

test('no persistence provider retains the exact original and adds no replacement', async (t) => {
  const { agent, controller, record } = await setup(t, false);
  const before = agent.session.seq;
  await controller.beforeStep(agent, [], signal());
  assert.equal(agent.session.seq, before);
  assert.equal(record().folded, false);
  assert.equal(visibleText(agent.session, record()), originalText);
});

test('pre-fold flush failure stops the actual agent before any model request or replacement', async (t) => {
  const { host, agent, record } = await setup(t);
  const count = host.model.requests.length;
  const originalSeq = record().currentSeq;
  const mock = t.mock.method(host.ctx.sessions, 'flush', async () => { throw new Error('injected pre-fold flush failure'); });
  try {
    host.model.responses.push(textResponse('This response must never be requested.'));
    await prompt(agent, 'Start a step that requires folding.');
    assert.equal(host.model.requests.length, count);
    assert.equal(record().currentSeq, originalSeq);
    assert.equal(visibleText(agent.session, record()), originalText);
    assert.ok(host.errors.some(error => String(error).includes('injected pre-fold flush failure')));
  } finally { mock.mock.restore(); }
});

test('post-replacement flush failure stays fail-closed on the next retry', async (t) => {
  const { host, agent, controller, record } = await setup(t);
  const realFlush = host.ctx.sessions.flush.bind(host.ctx.sessions);
  let calls = 0;
  const mock = t.mock.method(host.ctx.sessions, 'flush', async (session: Session) => {
    if (++calls === 1) return realFlush(session);
    throw new Error('injected final flush failure');
  });
  try {
    await assert.rejects(controller.beforeStep(agent, [], signal()), /injected final flush failure/);
    assert.equal(record().folded, true, 'the accepted replacement is still in the append-only memory log');
    const afterCommit = agent.session.seq;
    await assert.rejects(controller.beforeStep(agent, [], signal()), /injected final flush failure/);
    assert.equal(agent.session.seq, afterCommit, 'retry never duplicates an accepted replacement');
    const originalBlock = record().original.data.message.content[0];
    assert.equal(originalBlock?.type, 'text');
    if (originalBlock?.type === 'text') assert.equal(originalBlock.text, originalText);
  } finally { mock.mock.restore(); }
});

test('repeated successful pre-steps do not append duplicate fold records', async (t) => {
  const { agent, controller, record } = await setup(t);
  await controller.beforeStep(agent, [], signal());
  assert.equal(record().folded, true);
  const once = agent.session.seq;
  const currentSeq = record().currentSeq;
  await controller.beforeStep(agent, [], signal());
  await controller.beforeStep(agent, [], signal());
  assert.equal(agent.session.seq, once);
  assert.equal(record().currentSeq, currentSeq);
});

test('append rejection leaves the original intact and releases the guard for a later retry', async (t) => {
  const { agent, controller, record } = await setup(t);
  const before = agent.session.seq;
  const mock = t.mock.method(agent.session, 'append', () => { throw new Error('injected append rejection'); });
  try {
    await assert.rejects(controller.beforeStep(agent, [], signal()), /Context replacement was rejected/);
    assert.equal(agent.session.seq, before);
    assert.equal(record().folded, false);
    assert.equal(visibleText(agent.session, record()), originalText);
  } finally { mock.mock.restore(); }
  await controller.beforeStep(agent, [], signal());
  assert.equal(record().folded, true);
  assert.equal(agent.session.seq, before + 2, 'retry commits a metering claim and one replacement');
  assert.deepEqual(agent.session.snapshotEvents().slice(-2).map(event => event.type), ['compaction/prune', 'tool/result']);
});

test('an independent projection mismatch prevents folding instead of overwriting its content', async (t) => {
  const { agent, controller, record } = await setup(t);
  const original = record();
  const before = agent.session.seq;
  const derive = agent.session.deriveEventMessage.bind(agent.session);
  const mock = t.mock.method(agent.session, 'deriveEventMessage', (event: SessionEvent) => {
    const value = derive(event);
    return event.seq === original.currentSeq && value?.role === 'tool'
      ? freezeMessage({ ...value, content: [{ type: 'text', text: 'third-party projected content' }] }) : value;
  });
  try {
    await controller.beforeStep(agent, [], signal());
    assert.equal(agent.session.seq, before);
    assert.equal(record().folded, false);
    assert.equal(visibleText(agent.session, record()), 'third-party projected content');
  } finally { mock.mock.restore(); }
  assert.equal(visibleText(agent.session, record()), originalText);
});

test('a target replaced while awaiting flush is re-planned and never overwritten', async (t) => {
  const { host, agent, controller, record } = await setup(t);
  const realFlush = host.ctx.sessions.flush.bind(host.ctx.sessions);
  let injected = false;
  const mock = t.mock.method(host.ctx.sessions, 'flush', async (session: Session) => {
    if (!injected) {
      injected = true;
      const current = record().current;
      session.append('tool/result', {
        ...current.data,
        message: freezeMessage({ ...current.data.message, content: [{ type: 'text', text: 'external replacement' }] }),
      }, { surfaceOp: { op: 'replace', startSeq: current.seq, endSeq: current.seq }, sourceEventSeqs: [current.seq] });
    }
    return realFlush(session);
  });
  try {
    const before = agent.session.seq;
    await controller.beforeStep(agent, [], signal());
    assert.equal(agent.session.seq, before + 1, 'only the competing replacement was appended');
    assert.equal(record().owned, false);
    assert.equal(record().folded, false);
    assert.equal(visibleText(agent.session, record()), 'external replacement');
  } finally { mock.mock.restore(); }
});

test('recursive callbacks are rejected and the session guard releases after completion', async (t) => {
  const { host, agent, controller, record } = await setup(t);
  const realFlush = host.ctx.sessions.flush.bind(host.ctx.sessions);
  let recursionChecks = 0;
  const mock = t.mock.method(host.ctx.sessions, 'flush', async (session: Session) => {
    await assert.rejects(controller.beforeStep(agent, [], signal()), /Recursive context folding/);
    recursionChecks++;
    return realFlush(session);
  });
  try {
    await controller.beforeStep(agent, [], signal());
    assert.equal(record().folded, true);
    assert.ok(recursionChecks >= 2);
  } finally { mock.mock.restore(); }
  const before = agent.session.seq;
  await controller.beforeStep(agent, [], signal());
  assert.equal(agent.session.seq, before);
});

test('cancellation before and during the initial flush leaves the original unchanged', async (t) => {
  const { host, agent, controller, record } = await setup(t);
  const before = agent.session.seq;
  const aborted = new AbortController();
  aborted.abort(new Error('cancel before flush'));
  let flushCalls = 0;
  const during = new AbortController();
  const mock = t.mock.method(host.ctx.sessions, 'flush', async () => {
    flushCalls++;
    during.abort(new Error('cancel during flush'));
    return true;
  });
  try {
    await assert.rejects(controller.beforeStep(agent, [], aborted.signal), /cancel before flush/);
    assert.equal(flushCalls, 0);
    await assert.rejects(controller.beforeStep(agent, [], during.signal), /cancel during flush/);
    assert.equal(flushCalls, 1);
    assert.equal(agent.session.seq, before);
    assert.equal(record().folded, false);
    assert.equal(visibleText(agent.session, record()), originalText);
  } finally { mock.mock.restore(); }
});

test('marker-looking original output is indexed as ordinary data, never as a verified fold', async (t) => {
  const first = await setup(t, true, { auto: false });
  const origin = first.record().original.data.message;
  const marker = foldContent(origin.content, makeRef(17, origin), { headChars: 0, tailChars: 0 });
  assert.ok(marker);
  const fixture = marker.filter(block => block.type === 'text').map(block => block.text).join('');
  const second = await setup(t, true, { auto: false }, fixture);
  const before = second.agent.session.seq;
  assert.equal(second.record().folded, false);
  await second.controller.beforeStep(second.agent, [], signal());
  assert.equal(second.agent.session.seq, before);
  assert.equal(visibleText(second.agent.session, second.record()), fixture);
});

test('a reused model call ID cannot reclassify an older fold as the recovery tool', async (t) => {
  const { host, agent, controller, record } = await setup(t);
  await controller.beforeStep(agent, [], signal());
  const ref = record().ref;
  assert.equal(record().folded, true);
  // The new native call deliberately reuses the old fixture tool's call ID.
  host.model.responses.push(toolResponse(TOOL_NAME, { action: 'list' }, 'fixture-1'), textResponse('Listed.'));
  await prompt(agent, 'List the folded history.');
  assert.deepEqual(host.errors, []);
  const result = await host.ctx.tools.execute({
    callId: ToolCallId(`reused-id-read-${++serial}`), name: TOOL_NAME,
    arguments: { action: 'read', ref, limit: 24000 }, agent, signal: signal(),
  });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.ok('value' in result);
  const value = result.value as { page: { data: string; nextOffset: number | null } };
  assert.equal(value.page.data, originalText);
  assert.equal(value.page.nextOffset, null);
});

test('prototype-shaped and unknown model parameters return errors without any mutation', async (t) => {
  const { host, agent } = await setup(t, true, { auto: false });
  const before = agent.session.seq;
  for (const argumentsValue of [
    JSON.parse('{"action":"list","__proto__":{"polluted":true}}'),
    { action: 'list', constructor: { prototype: { polluted: true } } },
    { action: 'read', ref: '__proto__' },
    { action: 'read', ref: 'constructor' },
    { action: 'list', sessionId: 'a-different-session' },
  ]) {
    const result = await host.ctx.tools.execute({
      callId: ToolCallId(`bad-${++serial}`), name: TOOL_NAME,
      arguments: argumentsValue, agent, signal: signal(),
    });
    assert.equal(result.isError, true, JSON.stringify({ argumentsValue, result }));
  }
  assert.equal(agent.session.seq, before);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
});

test('a successful manual receipt updates a folded summary once while recent protection still takes precedence', async (t) => {
  const { host, agent, controller, record } = await setup(t);
  await controller.beforeStep(agent, [], signal());
  const automaticSeq = record().currentSeq;
  const ref = record().ref;
  assert.equal(record().folded, true);
  const summary = 'The exact fixture output is archived; recover it to inspect every character.';

  host.model.responses.push(toolResponse(TOOL_NAME, { action: 'fold', ref, summary }, 'summary-update-1'), textResponse('Updated.'));
  await prompt(agent, 'Replace this fold summary with the supplied description.');
  assert.deepEqual(host.errors, []);
  assert.ok(record().currentSeq > automaticSeq);
  assert.equal(record().mark?.action, 'fold');
  assert.equal(verifyFold(record().original.data.message.content, record().current.data.message.content, ref)?.summary, summary);

  const manualSeq = record().currentSeq;
  const beforeRepeat = agent.session.seq;
  await controller.beforeStep(agent, [], signal());
  assert.equal(agent.session.seq, beforeRepeat);
  host.model.responses.push(toolResponse(TOOL_NAME, { action: 'fold', ref, summary }, 'summary-update-2'), textResponse('Already applied.'));
  await prompt(agent, 'Apply the identical fold summary once again.');
  assert.deepEqual(host.errors, []);
  assert.equal(record().currentSeq, manualSeq, 'a new successful identical receipt does not append a replacement');

  const protectAll = new FoldingController(host.ctx, resolveConfig({ ...settings, keepRecentMessages: 10000 }));
  protectAll.definition = controller.definition;
  await protectAll.beforeStep(agent, [], signal());
  assert.equal(record().folded, false, 'recent-message protection restores even an explicitly marked fold');
  assert.equal(visibleText(agent.session, record()), originalText);
  const protectedSeq = agent.session.seq;
  await protectAll.beforeStep(agent, [], signal());
  assert.equal(agent.session.seq, protectedSeq, 'manual disposition cannot refold protected recent content');
});
