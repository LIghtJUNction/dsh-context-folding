import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { foldContent, makeRef } from '../src/content.js';
import { appendReplacement } from '../src/metering.js';
import { foldingProjection } from '../src/projection.js';
import { PROJECTION_KEY } from '../src/types.js';

function fixture(t: TestContext) {
  const ctx = new Context();
  new SessionProjectionRegistry(ctx);
  new TokenMeter(ctx);
  ctx.sessionProjections.register(foldingProjection);
  t.after(() => ctx.fiber.dispose());
  const session = Session.create(SessionId('metering-fixture'));
  const callId = ToolCallId('fixture-1');
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'read_file', arguments: '{}' });
  const original = session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({
      callId, isError: false, content: [{ type: 'text', text: 'Exact 原文🚀\n'.repeat(1_000) }],
    }),
  }, { surfaceOp: 'append' });
  const ref = makeRef(original.seq, original.data.message);
  const content = foldContent(original.data.message.content, ref, { headChars: 10, tailChars: 10 });
  assert.ok(content);
  const record = () => {
    const value = ctx.sessionProjections.stateOf(session, PROJECTION_KEY)?.records[ref];
    assert.ok(value);
    return value;
  };
  const counts = () => ({
    measure: ctx.tokenMeter.measure(session).surfaceTokens,
    pressure: ctx.sessionProjections.stateOf(session, 'contextPressure')?.surfaceTokens,
    breakdown: ctx.sessionProjections.stateOf(session, 'contextBreakdown')?.breakdown.messageTokens,
  });
  return { ctx, session, original, content, record, counts };
}

test('real rc2 token measure and bounded projections agree after fold and restore', async (t) => {
  const { ctx, session, original, content, record, counts } = fixture(t);
  const before = counts();
  assert.deepEqual(before, { measure: before.measure, pressure: before.measure, breakdown: before.measure });
  appendReplacement(ctx, session, record(), content);
  const folded = counts();
  assert.ok(folded.measure < before.measure);
  assert.deepEqual(folded, { measure: folded.measure, pressure: folded.measure, breakdown: folded.measure });
  assert.equal(record().folded, true);
  const events = session.snapshotEvents();
  assert.equal(events.at(-2)?.type, 'compaction/prune');
  assert.equal(events.at(-1)?.type, 'tool/result');

  appendReplacement(ctx, session, record(), original.data.message.content);
  assert.deepEqual(counts(), before);
  assert.equal(record().folded, false);
  assert.deepEqual(session.deriveMessages().at(-1)?.content, original.data.message.content);

  const replay = Session.create(SessionId('metering-replayed'), JSON.parse(JSON.stringify(session.snapshotEvents())));
  assert.equal(ctx.tokenMeter.measure(replay).surfaceTokens, before.measure);
  assert.equal(ctx.sessionProjections.stateOf(replay, 'contextPressure')?.surfaceTokens, before.measure);
  assert.equal(ctx.sessionProjections.stateOf(replay, 'contextBreakdown')?.breakdown.messageTokens, before.measure);
});

test('claim succeeds but rejected replacement changes neither surface nor token totals; retry works after expiry', async (t) => {
  const { ctx, session, original, content, record, counts } = fixture(t);
  const before = counts();
  const length = session.seq;
  const mock = t.mock.method(session, 'append', new Proxy(session.append, {
    apply(target, receiver, args) {
      if (args[0] === 'tool/result') throw new Error('Injected replacement rejection');
      return Reflect.apply(target, receiver, args);
    },
  }));
  try {
    assert.throws(() => appendReplacement(ctx, session, record(), content), /Injected replacement rejection/);
  } finally { mock.mock.restore(); }

  assert.equal(session.seq, length + 1, 'only the log-only shadow claim committed');
  assert.equal(session.snapshotEvents().at(-1)?.type, 'compaction/prune');
  assert.deepEqual(session.surface.nodes, [original.seq]);
  assert.deepEqual(session.deriveMessages().at(-1)?.content, original.data.message.content);
  assert.deepEqual(counts(), before, 'an unconsumed claim has zero token delta');
  assert.ok(ctx.sessionProjections.stateOf(session, 'contextPressure')?.claim);

  session.append('turn/start', { turn: 2 });
  assert.equal(ctx.sessionProjections.stateOf(session, 'contextPressure')?.claim, undefined);
  assert.equal(ctx.sessionProjections.stateOf(session, 'contextBreakdown')?.claim, undefined);
  assert.deepEqual(counts(), before);

  appendReplacement(ctx, session, record(), content);
  const after = counts();
  assert.ok(after.measure < before.measure);
  assert.deepEqual(after, { measure: after.measure, pressure: after.measure, breakdown: after.measure });
  assert.equal(record().folded, true);
});
