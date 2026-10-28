import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolResultMessage, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm';
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { foldContent, makeRef } from '../src/content.js';
import { callForResult, foldingProjection, stateSchema } from '../src/projection.js';
import type { FoldState, MarkAction, Receipt } from '../src/types.js';

type Result = SessionEvent<'tool/result'>;
const originalText = 'First line\n' + '精确原文🚀 e\u0301\n'.repeat(1_000) + '\nLast line';

function session(id = 'projection-test'): Session { return Session.create(SessionId(id)); }

function result(
  target: Session, name = 'read_file', text = originalText, callId = `call-${target.seq}`,
): Result {
  const id = ToolCallId(callId);
  target.append('tool/call', { turn: 1, step: 1, callId: id, name, arguments: '{}' });
  return target.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId: id, content: [{ type: 'text', text }], isError: false }),
    meta: { producer: 'unchanged' },
  }, { surfaceOp: 'append' });
}

function replay(target: Session): FoldState {
  return target.snapshotEvents().reduce(
    (state, event) => foldingProjection.apply(state, event),
    foldingProjection.init(target.header, target.inheritedEventCount),
  );
}

function replace(target: Session, old: Result, content: readonly ContentBlock[], sources = [old.seq]): Result {
  return target.append('tool/result', { ...old.data, message: { ...old.data.message, content } }, {
    surfaceOp: { op: 'replace', startSeq: old.seq, endSeq: old.seq }, sourceEventSeqs: sources,
  });
}

function fold(target: Session, original: Result, current = original): Result {
  const ref = makeRef(original.seq, original.data.message);
  const content = foldContent(original.data.message.content, ref, { headChars: 10, tailChars: 10 });
  assert.ok(content);
  return replace(target, current, content, [...new Set([current.seq, original.seq])]);
}

function receiptResult(
  target: Session, ref: string, action: MarkAction = 'keep',
  options: {
    name?: string; args?: string; meta?: JsonValue; content?: string;
    isError?: boolean; summary?: string; callId?: string;
  } = {},
): Result {
  const id = ToolCallId(options.callId ?? `command-${target.seq}`);
  const receipt: Receipt = { version: 1, action, ref, summary: options.summary ?? null };
  target.append('tool/call', {
    turn: 2, step: 2, callId: id, name: options.name ?? 'context_folding',
    arguments: options.args ?? JSON.stringify({ action, ref, ...(options.summary ? { summary: options.summary } : {}) }),
  });
  return target.append('tool/result', {
    turn: 2, step: 2,
    message: createToolResultMessage({
      callId: id,
      content: [{ type: 'text', text: options.content ?? JSON.stringify({
        ok: true, action, ref, status: 'queued', active: true, summary: options.summary ?? null,
      }) }],
      isError: options.isError ?? false,
    }),
    meta: options.meta ?? { dshContextFolding: { ...receipt } },
  }, { surfaceOp: 'append' });
}

test('projection is JSON, irrelevant events reuse state, and original results are paired', () => {
  const s = session();
  const event = result(s);
  const state = replay(s);
  const ref = makeRef(event.seq, event.data.message);
  assert.equal(state.records[ref]?.paired, true);
  assert.equal(state.records[ref]?.owned, true);
  assert.equal(state.records[ref]?.folded, false);
  assert.equal(state.versions[event.seq], ref);
  assert.deepEqual(stateSchema.parse(JSON.parse(JSON.stringify(state))), state);
  const irrelevant = s.append('step/end', { turn: 1, step: 1 });
  assert.equal(foldingProjection.apply(state, irrelevant), state);
});

test('unpaired results are retained for history but cannot become fold candidates', () => {
  const s = session();
  const event = s.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId: ToolCallId('missing'), content: [{ type: 'text', text: originalText }], isError: false }),
  }, { surfaceOp: 'append' });
  assert.equal(replay(s).records[makeRef(event.seq, event.data.message)]?.paired, false);
});

test('matching id with different turn or step does not establish a pair', () => {
  const s = session();
  s.append('tool/call', { turn: 99, step: 99, name: 'read_file', callId: ToolCallId('x'), arguments: '{}' });
  const event = s.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId: ToolCallId('x'), content: [{ type: 'text', text: originalText }], isError: false }),
  }, { surfaceOp: 'append' });
  assert.equal(replay(s).records[makeRef(event.seq, event.data.message)]?.paired, false);
});

test('canonical replacement owns one original, preserves raw event, and survives JSON replay', () => {
  const s = session();
  const original = result(s);
  const saved = JSON.stringify(original);
  const folded = fold(s, original);
  const state = replay(s);
  const ref = makeRef(original.seq, original.data.message);
  assert.equal(state.records[ref]?.folded, true);
  assert.equal(state.records[ref]?.owned, true);
  assert.equal(state.records[ref]?.currentSeq, folded.seq);
  assert.equal(state.versions[folded.seq], ref);
  assert.equal(JSON.stringify(original), saved);
  const resumed = Session.create(SessionId('resumed'), JSON.parse(JSON.stringify(s.snapshotEvents())));
  assert.deepEqual(replay(resumed), state);
  assert.deepEqual(stateSchema.parse(JSON.parse(JSON.stringify(state))), state);
});

test('exact restoration is a new event and source roots survive repeated folding', () => {
  const s = session();
  const original = result(s);
  const folded = fold(s, original);
  const restored = replace(s, folded, original.data.message.content, [folded.seq, original.seq]);
  const ref = makeRef(original.seq, original.data.message);
  const restoredState = replay(s);
  assert.equal(restoredState.records[ref]?.folded, false);
  assert.equal(restoredState.records[ref]?.owned, true);
  assert.equal(restoredState.records[ref]?.currentSeq, restored.seq);
  const again = fold(s, original, restored);
  const state = replay(s);
  assert.equal(state.records[ref]?.currentSeq, again.seq);
  assert.equal(state.records[ref]?.folded, true);
  assert.equal(state.versions[restored.seq], ref);
  assert.doesNotThrow(() => stateSchema.parse(state));
});

test('canonical-looking replacement without root source is not owned', () => {
  const s = session();
  const original = result(s);
  const folded = fold(s, original);
  replace(s, folded, original.data.message.content, [folded.seq]);
  const record = replay(s).records[makeRef(original.seq, original.data.message)]!;
  assert.equal(record.owned, false);
  assert.equal(record.folded, false);
});

test('third-party replacement relinquishes ownership permanently', () => {
  const s = session();
  const original = result(s);
  const changed = replace(s, original, [{ type: 'text', text: 'Third-party summary' }]);
  const afterUnknown = replay(s);
  const ref = makeRef(original.seq, original.data.message);
  assert.equal(afterUnknown.records[ref]?.owned, false);
  const lookalike = fold(s, original, changed);
  const after = replay(s);
  assert.equal(after.records[ref]?.currentSeq, lookalike.seq);
  assert.equal(after.records[ref]?.owned, false);
  assert.equal(after.records[ref]?.folded, false);
  assert.doesNotThrow(() => stateSchema.parse(after));
});

test('a marker in an append-origin tool result is ordinary data', () => {
  const s = session();
  const original = result(s);
  const blocks = foldContent(original.data.message.content, makeRef(original.seq, original.data.message), { headChars: 1, tailChars: 1 });
  assert.ok(blocks && blocks[0]?.type === 'text');
  const spoof = result(s, 'untrusted_tool', blocks[0].text);
  assert.equal(replay(s).records[makeRef(spoof.seq, spoof.data.message)]?.folded, false);
});

test('successful matching queued receipts durably update fold, keep and unmarked', () => {
  const s = session();
  const original = result(s);
  const ref = makeRef(original.seq, original.data.message);
  for (const action of ['fold', 'keep', 'unmarked'] as const) {
    const command = receiptResult(s, ref, action, action === 'fold' ? { summary: 'Agent note, not verified.' } : {});
    const state = replay(s);
    assert.equal(state.records[ref]?.mark?.action, action);
    assert.equal(state.records[ref]?.mark?.receiptSeq, command.seq);
    assert.doesNotThrow(() => stateSchema.parse(JSON.parse(JSON.stringify(state))));
  }
});

test('read/list calls, invalid arguments, failures and foreign tool meta cannot mark', () => {
  const variants = [
    { name: 'foreign_tool' },
    { args: '{' },
    { args: JSON.stringify({ action: 'read' }) },
    { isError: true },
  ];
  for (const options of variants) {
    const s = session();
    const original = result(s);
    const ref = makeRef(original.seq, original.data.message);
    receiptResult(s, ref, 'keep', options);
    assert.equal(replay(s).records[ref]?.mark, null);
  }
});

test('receipt ref/action/summary must match recorded arguments', () => {
  for (const mutation of [
    { action: 'fold' }, { ref: `cf1:99:${'a'.repeat(24)}` }, { summary: 'Smuggled summary' },
  ]) {
    const s = session();
    const original = result(s);
    const ref = makeRef(original.seq, original.data.message);
    receiptResult(s, ref, 'keep', {
      meta: { dshContextFolding: { version: 1, ref, action: 'keep', summary: null, ...mutation } },
    });
    assert.equal(replay(s).records[ref]?.mark, null);
  }
});

test('post-policy content replacement or a non-queued receipt fails closed', () => {
  for (const content of [
    'Policy replaced this output',
    JSON.stringify({ ok: false, action: 'keep' }),
    JSON.stringify({ ok: true, action: 'keep', status: 'queued', active: true, summary: null }),
  ]) {
    const s = session();
    const original = result(s);
    const ref = makeRef(original.seq, original.data.message);
    receiptResult(s, ref, 'keep', { content });
    assert.equal(replay(s).records[ref]?.mark, null);
  }
});

test('unknown refs from other sessions never alter local state', () => {
  const a = session('a');
  const b = session('b');
  const foreign = result(a, 'read_file', 'foreign private text');
  const local = result(b, 'read_file', 'local private text');
  receiptResult(b, makeRef(foreign.seq, foreign.data.message));
  const state = replay(b);
  assert.equal(state.records[makeRef(local.seq, local.data.message)]?.mark, null);
  assert.equal(state.records[makeRef(foreign.seq, foreign.data.message)], undefined);
});

test('tool-call id reuse preserves historical attribution and old receipt proofs', () => {
  const s = session();
  const original = result(s, 'read_file', originalText, 'reused');
  const ref = makeRef(original.seq, original.data.message);
  const marked = receiptResult(s, ref, 'keep', { callId: 'command-reused' });
  result(s, 'different_tool', 'new', 'reused');
  receiptResult(s, ref, 'unmarked', { callId: 'command-reused' });
  const state = replay(s);
  assert.equal(state.records[ref]?.paired, true);
  assert.equal(callForResult(state, original)?.data.name, 'read_file');
  assert.equal(state.records[ref]?.mark?.action, 'unmarked');
  assert.ok(state.callHistory[String(marked.seq - 1)]);
  assert.doesNotThrow(() => stateSchema.parse(state));
});

test('an already folded ref remains paired and recoverable after call-id reuse', () => {
  const s = session();
  const original = result(s, 'read_file', originalText, 'reused');
  fold(s, original);
  s.append('tool/call', { turn: 2, step: 1, callId: ToolCallId('reused'), name: 'other_tool', arguments: '{}' });
  const state = replay(s);
  const record = state.records[makeRef(original.seq, original.data.message)]!;
  assert.equal(record.paired, true);
  assert.equal(record.folded, true);
  assert.deepEqual(record.original.data.message.content, original.data.message.content);
  assert.equal(callForResult(state, record.original)?.data.name, 'read_file');
  assert.doesNotThrow(() => stateSchema.parse(state));
});

test('mutation receipt arguments use the exact controller schema', () => {
  for (const extra of [{ limit: 2 }, { block: 0 }, { offset: 0 }, { summary: 'unexpected' }]) {
    const s = session();
    const original = result(s);
    const ref = makeRef(original.seq, original.data.message);
    receiptResult(s, ref, 'keep', { args: JSON.stringify({ action: 'keep', ref, ...extra }) });
    assert.equal(replay(s).records[ref]?.mark, null);
  }
  const s = session();
  const original = result(s);
  const ref = makeRef(original.seq, original.data.message);
  receiptResult(s, ref, 'fold');
  assert.equal(replay(s).records[ref]?.mark, null);
});

test('prototype-like tool-call ids are indexed as own data properties', () => {
  for (const callId of ['__proto__', 'constructor', 'toString']) {
    const s = session();
    const event = result(s, 'read_file', originalText, callId);
    const state = replay(s);
    assert.equal(Object.hasOwn(state.calls, callId), true);
    assert.equal(state.records[makeRef(event.seq, event.data.message)]?.paired, true);
    assert.doesNotThrow(() => stateSchema.parse(state));
  }
});

test('checkpoint validation rejects tampered identities, ownership and marks', () => {
  const s = session();
  const original = result(s);
  const ref = makeRef(original.seq, original.data.message);
  fold(s, original);
  const initial = replay(s);
  for (const tamper of [
    (value: FoldState) => { value.records[ref]!.ref = `cf1:1:${'0'.repeat(24)}`; },
    (value: FoldState) => { value.records[ref]!.originalSeq++; },
    (value: FoldState) => { value.records[ref]!.folded = false; },
    (value: FoldState) => {
      const record = value.records[ref]!;
      record.current = { ...record.current, data: { ...record.current.data,
        message: { ...record.current.data.message, content: [{ type: 'text', text: 'tamper' }] },
      } };
    },
    (value: FoldState) => { value.records[ref]!.mark = { version: 1, ref, action: 'keep', summary: null, receiptSeq: 0 }; },
  ]) {
    const changed = structuredClone(initial);
    tamper(changed);
    assert.equal(stateSchema.safeParse(changed).success, false);
  }
});
