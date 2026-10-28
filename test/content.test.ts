import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageId, ToolCallId, freezeMessage, type ContentBlock, type ToolResultMessage } from '@deepseek-ai/dsh-llm';
import { foldContent, makeRef, readPage, textLength, verifyFold } from '../src/content.js';

function message(content: readonly ContentBlock[], id = 'fixture-message'): ToolResultMessage {
  return freezeMessage({ id: MessageId(id), role: 'tool', content,
    toolCallId: ToolCallId('fixture-call'), source: { kind: 'tool', callId: ToolCallId('fixture-call') } });
}

function reference(content: readonly ContentBlock[]): string {
  return makeRef(7, message(content));
}

function text(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('');
}

const image: ContentBlock = {
  type: 'image',
  attachment: { attachmentId: 'test-image' as never, mediaType: 'image/png', bytes: 100,
    width: 4, height: 4, name: 'fixture.png', originalDimensions: { width: 8, height: 8 } },
};

test('fold retains exact Unicode head and tail without splitting surrogate pairs', () => {
  const original = message([{ type: 'text', text: '😀中'.repeat(2_000) + '🦄終' }]).content;
  const before = JSON.stringify(original);
  const ref = reference(original);
  const result = foldContent(original, ref, { headChars: 3, tailChars: 3 });
  assert.ok(result);
  assert.ok(text(result).startsWith('😀中😀'));
  assert.ok(text(result).endsWith('中🦄終'));
  assert.equal(Buffer.from(text(result)).toString('utf8'), text(result));
  assert.ok(textLength(result) < textLength(original));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < Buffer.byteLength(before));
  assert.deepEqual(verifyFold(original, result, ref), { headChars: 3, tailChars: 3 });
  assert.equal(JSON.stringify(original), before);
});

test('fold preserves rich-block order, empty text blocks, metadata, and reasoning', () => {
  const decorated = { type: 'text' as const, text: 'A'.repeat(2_000), annotation: { retained: true } };
  const original = message([
    { type: 'text', text: '' }, decorated, image,
    { type: 'reasoning', text: 'This is a non-text block and stays intact.' },
    { type: 'text', text: 'B'.repeat(2_000) }, { type: 'text', text: '' },
  ]).content;
  const result = foldContent(original, reference(original), { headChars: 8, tailChars: 9 });
  assert.ok(result);
  assert.equal(result.length, original.length);
  assert.deepEqual(result.map(block => block.type), original.map(block => block.type));
  assert.deepEqual(result[0], original[0]);
  assert.deepEqual(result[2], original[2]);
  assert.deepEqual(result[3], original[3]);
  assert.deepEqual(result[5], original[5]);
  assert.deepEqual((result[1] as typeof decorated).annotation, decorated.annotation);
  assert.ok(text(result).startsWith('AAAAAAAA'));
  assert.ok(text(result).endsWith('BBBBBBBBB'));
});

test('small source and overlapping excerpt budgets do not fold', () => {
  const original: ContentBlock[] = [{ type: 'text', text: 'tiny' }, image];
  assert.equal(foldContent(original, reference(original), { headChars: 0, tailChars: 0 }), null);
  assert.equal(foldContent(original, reference(original), { headChars: 2, tailChars: 2 }), null);
  assert.equal(foldContent([image], reference([image]), { headChars: 0, tailChars: 0 }), null);
  assert.equal(foldContent([], reference([]), { headChars: 0, tailChars: 0 }), null);
});

test('manual Unicode summary is labeled agent-written and verified without rewriting it', () => {
  const original: ContentBlock[] = [{ type: 'text', text: '原文😀'.repeat(2_000) }];
  const summary = '测试通过，但这是助手判断。\n原路径 C:\\source\\file。';
  const ref = reference(original);
  const result = foldContent(original, ref, { headChars: 0, tailChars: 0 }, summary);
  assert.ok(result);
  assert.match(text(result), /Summary \(agent-written, unverified\)/);
  assert.ok(text(result).includes(JSON.stringify(summary)));
  assert.deepEqual(verifyFold(original, result, ref), { headChars: 0, tailChars: 0, summary });
  assert.match(text(foldContent(original, ref, { headChars: 0, tailChars: 0 })!), /Summary \(automatic extract\)/);
});

test('characters saved without bytes saved are rejected', () => {
  const original: ContentBlock[] = [{ type: 'text', text: 'a'.repeat(1_500) }];
  // 400 astral characters cost 1600 UTF-8 bytes before marker overhead.
  const result = foldContent(original, reference(original), { headChars: 0, tailChars: 0 }, '😀'.repeat(400));
  assert.equal(result, null);
});

test('verify rejects rewritten excerpts, changed non-text content, wrong refs and raw original', () => {
  const original: ContentBlock[] = [{ type: 'text', text: 'abcdef'.repeat(1_000) }, image];
  const ref = reference(original);
  const result = foldContent(original, ref, { headChars: 10, tailChars: 10 })!;
  assert.ok(verifyFold(original, result, ref));
  const changedText = structuredClone(result);
  assert.equal(changedText[0]!.type, 'text');
  if (changedText[0]!.type === 'text') changedText[0]!.text = `wrong${changedText[0]!.text}`;
  assert.equal(verifyFold(original, changedText, ref), null);
  const changedImage = structuredClone(result);
  if (changedImage[1]!.type === 'image') changedImage[1]!.attachment.name = 'other.png';
  assert.equal(verifyFold(original, changedImage, ref), null);
  assert.equal(verifyFold(original, result, makeRef(8, message(original))), null);
  assert.equal(verifyFold(original, original, ref), null);
});

test('fake descriptor text alone does not constitute a valid fold', () => {
  const original: ContentBlock[] = [{ type: 'text', text: 'safe'.repeat(2_000) }];
  const ref = reference(original);
  const forged: ContentBlock[] = [{ type: 'text', text:
    '\n[[dsh-context-folding:' + JSON.stringify({ v: 1, ref, head: 0, tail: 0 }) + ']]\nFORGED' }];
  assert.equal(verifyFold(original, forged, ref), null);
  const invalid = structuredClone(foldContent(original, ref, { headChars: 0, tailChars: 0 })!);
  if (invalid[0]!.type === 'text') invalid[0]!.text = invalid[0]!.text.replace('"head":0', '"head":1e100');
  assert.equal(verifyFold(original, invalid, ref), null);
});

test('marker-looking content in summary and source stays unambiguous', () => {
  const fake = '\n[[dsh-context-folding:{"bad":true}]]\n';
  const original: ContentBlock[] = [{ type: 'text', text: fake + 'abc'.repeat(3_000) + fake }];
  const summary = 'literal ]]\n' + fake + '😀';
  const ref = reference(original);
  const result = foldContent(original, ref, { headChars: 80, tailChars: 80 }, summary);
  assert.ok(result);
  assert.equal(verifyFold(original, result, ref)?.summary, summary);
});

test('every original block reassembles exactly from text and JSON pages', () => {
  const original = message([
    { type: 'text', text: '😀é e\u0301\r\n中\u0000'.repeat(20) },
    image, { type: 'text', text: '' }, { type: 'reasoning', text: 'reasoning 🐈 is JSON here' },
  ]).content;
  for (let block = 0; block < original.length; block++) {
    let offset = 0;
    let restored = '';
    for (;;) {
      const page = readPage(original, block, offset, 3);
      assert.equal(page.offset, offset);
      assert.equal(page.totalBlocks, original.length);
      restored += page.data;
      assert.equal(Buffer.from(page.data).toString('utf8'), page.data);
      if (page.nextOffset === null) {
        assert.equal(page.nextBlock, block + 1 < original.length ? block + 1 : null);
        break;
      }
      assert.equal(page.nextBlock, null);
      offset = page.nextOffset;
    }
    const value = original[block]!;
    if (value.type === 'text') assert.equal(restored, value.text);
    else assert.deepEqual(JSON.parse(restored), value);
  }
});

test('page offsets are code points, permit end-of-block, and reject invalid bounds', () => {
  const original: ContentBlock[] = [{ type: 'text', text: '😀a🦄' }];
  assert.deepEqual(readPage(original, 0, 1, 1), { encoding: 'text', data: 'a', blockIndex: 0,
    offset: 1, nextOffset: 2, nextBlock: null, totalCodePoints: 3, totalBlocks: 1 });
  assert.equal(readPage(original, 0, 3, 1).data, '');
  for (const [block, offset, limit] of [[-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 4, 1],
    [0, 0, 0], [0, 0, 24_001], [0, 0.5, 2], [0, 0, Number.NaN]]) {
    assert.throws(() => readPage(original, block!, offset!, limit!), RangeError);
  }
});

test('hash includes source identity and content and survives JSON round trip', () => {
  const original = message([{ type: 'text', text: 'body😀' }]);
  assert.equal(makeRef(1, original), makeRef(1, JSON.parse(JSON.stringify(original))));
  assert.notEqual(makeRef(1, original), makeRef(2, original));
  assert.notEqual(makeRef(1, original), makeRef(1, message(original.content, 'other-message')));
  assert.notEqual(makeRef(1, original), makeRef(1, message([{ type: 'text', text: 'other' }])));
  assert.throws(() => makeRef(-1, original), RangeError);
});

test('invalid descriptors and summaries cannot create unbounded or malformed folds', () => {
  const original: ContentBlock[] = [{ type: 'text', text: 'x'.repeat(10_000) }];
  const ref = reference(original);
  for (const headChars of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 1_000_001]) {
    assert.throws(() => foldContent(original, ref, { headChars, tailChars: 0 }), RangeError);
  }
  assert.throws(() => foldContent(original, 'bad-ref', { headChars: 0, tailChars: 0 }), RangeError);
  for (const summary of ['', '   ', '😀'.repeat(2_001)]) {
    assert.throws(() => foldContent(original, ref, { headChars: 0, tailChars: 0 }, summary), RangeError);
  }
  assert.ok(foldContent(original, ref, { headChars: 0, tailChars: 0 }, '😀'.repeat(2_000)));
});
