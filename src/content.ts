import { createHash } from 'node:crypto';
import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm';
import type { Blocks, ContentPage, FoldOptions, VerifiedFold } from './types.js';

const PREFIX = '\n[[dsh-context-folding:';
const MAX_EXCERPT = 1_000_000;
const MAX_SUMMARY = 2_000;
const MAX_PAGE = 24_000;
const MAX_DESCRIPTOR = 16_384;
const MAX_CANDIDATES = 32;

interface Descriptor {
  v: 1;
  ref: string;
  head: number;
  tail: number;
  summary?: string;
}

function validInteger(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function pointLength(text: string): number {
  let count = 0;
  for (const _point of text) count++;
  return count;
}

/** Code-point slicing bounds memory by the returned page, not the original text. */
function pointSlice(text: string, start: number, end: number): string {
  // @context-fold begin code-point-slice
  let index = 0;
  const points: string[] = [];
  for (const point of text) {
    if (index >= end) break;
    if (index >= start) points.push(point);
    index++;
  }
  return points.join('');
  // @context-fold end code-point-slice
}

export function textLength(blocks: Blocks): number {
  let total = 0;
  for (const block of blocks) if (block.type === 'text') total += pointLength(block.text);
  return total;
}

/** A content identity, never a credential: the caller must bind it to a live session. */
export function makeRef(seq: number, message: ToolResultMessage): string {
  if (!validInteger(seq, Number.MAX_SAFE_INTEGER)) throw new RangeError('Invalid source sequence');
  const digest = createHash('sha256').update(JSON.stringify(message)).digest('hex').slice(0, 24);
  return `cf1:${seq}:${digest}`;
}

function validDescriptor(value: unknown, ref: string): value is Descriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some(key => !['v', 'ref', 'head', 'tail', 'summary'].includes(key))) return false;
  return candidate.v === 1 && candidate.ref === ref
    && typeof candidate.head === 'number' && validInteger(candidate.head, MAX_EXCERPT)
    && typeof candidate.tail === 'number' && validInteger(candidate.tail, MAX_EXCERPT)
    && (candidate.summary === undefined || (typeof candidate.summary === 'string'
      && candidate.summary.trim().length > 0 && pointLength(candidate.summary) <= MAX_SUMMARY));
}

function renderMarker(descriptor: Descriptor): string {
  const source = descriptor.summary === undefined
    ? 'Summary (automatic extract): retained head/tail are verbatim; the middle is archived.'
    : 'Summary (agent-written, unverified): see the JSON summary field below.';
  return `\n${source}${PREFIX}${JSON.stringify(descriptor)}]]\n`
    + `Recover exact original with context_folding {"action":"read","ref":"${descriptor.ref}"}.\n`;
}

function renderFold(blocks: Blocks, descriptor: Descriptor): ContentBlock[] | null {
  const total = textLength(blocks);
  const removedStart = descriptor.head;
  const removedEnd = total - descriptor.tail;
  if (removedEnd <= removedStart) return null;

  let consumed = 0;
  let inserted = false;
  const result = blocks.map(block => {
    if (block.type !== 'text') return block;
    const length = pointLength(block.text);
    const headEnd = Math.min(length, Math.max(0, removedStart - consumed));
    const tailStart = Math.min(length, Math.max(0, removedEnd - consumed));
    const intersects = consumed < removedEnd && consumed + length > removedStart;
    const marker = intersects && !inserted ? renderMarker(descriptor) : '';
    if (marker) inserted = true;
    consumed += length;
    return { ...block, text: pointSlice(block.text, 0, headEnd) + marker + pointSlice(block.text, tailStart, length) };
  });

  // Count the complete JSON, including marker overhead and unchanged rich blocks.
  if (!inserted || textLength(result) >= total
    || Buffer.byteLength(JSON.stringify(result)) >= Buffer.byteLength(JSON.stringify(blocks))) return null;
  return result;
}

/**
 * Replace text only, retaining every block, property and position. Code points
 * preserve surrogate pairs, but can split grapheme clusters such as combining marks.
 */
export function foldContent(blocks: Blocks, ref: string, options: FoldOptions, summary?: string): ContentBlock[] | null {
  if (!/^cf1:(0|[1-9][0-9]*):[a-f0-9]{24}$/.test(ref)
    || !validInteger(options.headChars, MAX_EXCERPT) || !validInteger(options.tailChars, MAX_EXCERPT)) {
    throw new RangeError('Invalid fold descriptor');
  }
  if (summary !== undefined && (typeof summary !== 'string' || !summary.trim() || pointLength(summary) > MAX_SUMMARY)) {
    throw new RangeError('Summary must contain 1–2000 Unicode code points');
  }
  const descriptor: Descriptor = { v: 1, ref, head: options.headChars, tail: options.tailChars,
    ...(summary === undefined ? {} : { summary }) };
  const result = renderFold(blocks, descriptor);
  // Pathological source text containing many apparent descriptors also fails closed.
  return result && verifyFold(blocks, result, ref) ? result : null;
}

/**
 * Recognize only an exact deterministic rendering of these original blocks.
 * This proves content consistency, not event provenance or authorization; the
 * projection must additionally validate the replacement and source-event chain.
 */
export function verifyFold(original: Blocks, current: Blocks, ref: string): VerifiedFold | null {
  let candidates = 0;
  for (const block of current) {
    if (block.type !== 'text') continue;
    let from = 0;
    while (true) {
      const start = block.text.indexOf(PREFIX, from);
      if (start < 0) break;
      from = start + PREFIX.length;
      const end = block.text.indexOf('\n', from);
      if (end < 0 || end - from > MAX_DESCRIPTOR || !block.text.slice(from, end).endsWith(']]')) continue;
      let descriptor: unknown;
      try { descriptor = JSON.parse(block.text.slice(from, end - 2)); } catch { continue; }
      if (!validDescriptor(descriptor, ref)) continue;
      if (++candidates > MAX_CANDIDATES) return null;
      const expected = renderFold(original, descriptor);
      if (expected && JSON.stringify(expected) === JSON.stringify(current)) {
        return { headChars: descriptor.head, tailChars: descriptor.tail,
          ...(descriptor.summary === undefined ? {} : { summary: descriptor.summary }) };
      }
    }
  }
  return null;
}

/** Exact original text or a serialized non-text block; reassemble JSON pages before parsing. */
export function readPage(blocks: Blocks, block: number, offset: number, limit: number): ContentPage {
  if (!validInteger(block, blocks.length - 1)) throw new RangeError('Invalid block index');
  if (!validInteger(offset, Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    throw new RangeError('Invalid page range');
  }
  const value = blocks[block]!;
  const encoding = value.type === 'text' ? 'text' : 'json';
  const text = value.type === 'text' ? value.text : JSON.stringify(value);
  const total = pointLength(text);
  if (offset > total) throw new RangeError('Offset exceeds block length');
  const end = Math.min(total, offset + limit);
  return { encoding, data: pointSlice(text, offset, end), blockIndex: block, offset,
    nextOffset: end < total ? end : null,
    nextBlock: end === total && block + 1 < blocks.length ? block + 1 : null,
    totalCodePoints: total, totalBlocks: blocks.length };
}
