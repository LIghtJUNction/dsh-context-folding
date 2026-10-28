import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { snapshotSessionEvent, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
import { isJsonValue } from '@deepseek-ai/dsh-util-values';
import { makeRef, verifyFold } from './content.js';
import {
  PROJECTION_KEY, TOOL_NAME,
  type FoldState, type Receipt, type RecordState,
} from './types.js';

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    contextFolding: FoldState;
  }
}

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const refSchema = z.string().regex(/^cf1:(0|[1-9][0-9]*):[a-f0-9]{24}$/);
const markAction = z.enum(['fold', 'keep', 'unmarked']);
const summary = z.string().refine(value => value.trim().length > 0 && [...value].length <= 2_000);
export const receiptSchema = z.object({
  version: z.literal(1), ref: refSchema, action: markAction, summary: summary.nullable(),
}).strict().refine(value => value.action === 'fold' || value.summary === null);

const mutationArgsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('fold'), ref: refSchema, summary }).strict(),
  z.object({ action: z.literal('keep'), ref: refSchema }).strict(),
  z.object({ action: z.literal('unmarked'), ref: refSchema }).strict(),
]);

const queuedSchema = z.object({
  ok: z.literal(true), action: markAction, ref: refSchema,
  status: z.literal('queued'), active: z.boolean(), summary: summary.nullable(),
  note: z.string().optional(),
}).strict();

const envelopeSchema = {
  seq: integer, time: integer, ignorable: z.literal(true).optional(),
};
const callShape = z.object({
  ...envelopeSchema, type: z.literal('tool/call'),
  data: z.object({
    turn: integer, step: integer, callId: z.string().min(1),
    name: z.string().min(1), arguments: z.string(),
  }).strict(),
}).strict();
const resultShape = z.object({
  ...envelopeSchema, type: z.literal('tool/result'),
  surfaceOp: z.union([
    z.literal('append'),
    z.object({ op: z.literal('replace'), startSeq: integer, endSeq: integer }).strict(),
  ]),
  sourceEventSeqs: z.array(integer).nonempty().optional(),
  data: z.object({
    turn: integer, step: integer,
    message: z.object({
      id: z.string().min(1), role: z.literal('tool'),
      source: z.object({ kind: z.literal('tool'), callId: z.string().min(1) }).strict(),
      toolCallId: z.string().min(1), isError: z.boolean().optional(),
      // Content vocabulary is merge-extensible. The host validates its message;
      // the index requires lossless JSON and never interprets unknown blocks.
      content: z.array(z.object({ type: z.string().min(1) }).loose()),
    }).strict(),
    error: z.object({ name: z.string(), code: z.string(), reason: z.string().optional() }).strict().optional(),
    meta: z.json().optional(),
  }).strict(),
}).strict();

function validEvent<T extends 'tool/call' | 'tool/result'>(
  value: unknown, type: T,
): value is SessionEvent<T> {
  if (!isJsonValue(value)) return false;
  const parsed = (type === 'tool/call' ? callShape : resultShape).safeParse(value);
  if (!parsed.success) return false;
  try {
    // Shared host validation covers source identities, surface metadata and
    // rich-block invariants. Snapshotting does not mutate checkpoint input.
    snapshotSessionEvent(value as SessionEvent<T>);
    return true;
  } catch { return false; }
}

const callSchema = z.custom<SessionEvent<'tool/call'>>(value => validEvent(value, 'tool/call'));
const resultSchema = z.custom<SessionEvent<'tool/result'>>(value => validEvent(value, 'tool/result'));
const recordSchema = z.object({
  ref: refSchema, originalSeq: integer, currentSeq: integer,
  original: resultSchema, current: resultSchema,
  paired: z.boolean(), owned: z.boolean(), folded: z.boolean(),
  mark: receiptSchema.safeExtend({ receiptSeq: integer }).nullable(),
}).strict();

function own<T>(values: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

function paired(call: SessionEvent<'tool/call'> | undefined, result: SessionEvent<'tool/result'>): boolean {
  return call !== undefined && call.seq < result.seq
    && call.data.callId === result.data.message.source.callId
    && call.data.callId === result.data.message.toolCallId
    && call.data.turn === result.data.turn && call.data.step === result.data.step;
}

/** Resolve the call at this result's historical boundary, even after id reuse. */
export function callForResult(state: FoldState, result: SessionEvent<'tool/result'>): SessionEvent<'tool/call'> | undefined {
  const latest = own(state.calls, result.data.message.source.callId);
  if (paired(latest, result)) return latest;
  let found: SessionEvent<'tool/call'> | undefined;
  for (const candidate of Object.values(state.callHistory)) {
    if (paired(candidate, result) && (!found || candidate.seq > found.seq)) found = candidate;
  }
  return found;
}

function sameDataExceptContent(a: SessionEvent<'tool/result'>, b: SessionEvent<'tool/result'>): boolean {
  return isDeepStrictEqual(
    { ...a.data, message: { ...a.data.message, content: null } },
    { ...b.data, message: { ...b.data.message, content: null } },
  );
}

function receiptFrom(
  state: FoldState, result: SessionEvent<'tool/result'>,
): Receipt | null {
  if (result.surfaceOp !== 'append' || result.data.message.isError || result.data.error) return null;
  const call = callForResult(state, result);
  if (!paired(call, result) || call?.data.name !== TOOL_NAME) return null;
  const metadata = result.data.meta;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const receipt = receiptSchema.safeParse(metadata.dshContextFolding);
  if (!receipt.success) return null;
  try {
    const args = mutationArgsSchema.safeParse(JSON.parse(call.data.arguments));
    if (!args.success || args.data.action !== receipt.data.action || args.data.ref !== receipt.data.ref
      || (args.data.action === 'fold' ? args.data.summary : null) !== receipt.data.summary) return null;
    // A post-policy content replacement must not silently apply leftover meta.
    const blocks = result.data.message.content;
    if (blocks.length !== 1 || blocks[0]?.type !== 'text') return null;
    const queued = queuedSchema.safeParse(JSON.parse(blocks[0].text));
    if (!queued.success || queued.data.action !== receipt.data.action || queued.data.ref !== receipt.data.ref
      || queued.data.summary !== receipt.data.summary) return null;
    const target = own(state.records, receipt.data.ref);
    return target && target.originalSeq < call.seq ? receipt.data : null;
  } catch { return null; }
}

/** Checkpoints are an optimization, not a second authority for recovery data. */
export const stateSchema: z.ZodType<FoldState> = z.object({
  records: z.record(z.string(), recordSchema),
  versions: z.record(z.string().regex(/^(0|[1-9][0-9]*)$/), refSchema),
  calls: z.record(z.string(), callSchema),
  callHistory: z.record(z.string().regex(/^(0|[1-9][0-9]*)$/), callSchema),
}).strict().superRefine((state, context) => {
  const reject = (message: string) => context.addIssue({ code: 'custom', message });
  for (const [id, call] of Object.entries(state.calls)) {
    if (id !== call.data.callId || !isDeepStrictEqual(own(state.callHistory, String(call.seq)), call)) {
      reject('Call index key does not match its historical event');
    }
  }
  for (const [seq, call] of Object.entries(state.callHistory)) {
    if (String(call.seq) !== seq) reject('Historical call key does not match its event');
  }
  for (const [ref, record] of Object.entries(state.records)) {
    if (ref !== record.ref || makeRef(record.originalSeq, record.original.data.message) !== ref
      || record.originalSeq !== record.original.seq || record.currentSeq !== record.current.seq
      || record.originalSeq > record.currentSeq || record.original.surfaceOp !== 'append'
      || own(state.versions, String(record.originalSeq)) !== ref
      || own(state.versions, String(record.currentSeq)) !== ref) reject('Invalid recovery index identity');
    if (record.paired && !paired(callForResult(state, record.original), record.original)) {
      reject('Recovery entry has no matching tool call');
    }
    if (record.owned) {
      const unchanged = isDeepStrictEqual(record.original, record.current);
      const op = record.current.surfaceOp;
      const linked = op !== 'append' && op.startSeq === op.endSeq
        && own(state.versions, String(op.startSeq)) === ref
        && record.current.sourceEventSeqs?.includes(op.startSeq)
        && record.current.sourceEventSeqs.includes(record.original.seq);
      const originalContent = isDeepStrictEqual(record.original.data.message.content, record.current.data.message.content);
      if (!sameDataExceptContent(record.original, record.current)
        || (!unchanged && !linked)
        || (record.folded ? !verifyFold(record.original.data.message.content, record.current.data.message.content, ref) : !originalContent)) {
        reject('Owned recovery entry has an unverifiable replacement');
      }
    } else if (record.folded) reject('Unowned recovery entry cannot claim a verified fold');
    if (record.mark) {
      const receiptRef = own(state.versions, String(record.mark.receiptSeq));
      const source = receiptRef === undefined ? undefined : own(state.records, receiptRef)?.original;
      const receipt = source === undefined ? null : receiptFrom(state, source);
      if (!receipt || source?.seq !== record.mark.receiptSeq || record.mark.ref !== ref
        || !isDeepStrictEqual(receipt, {
          version: record.mark.version, ref: record.mark.ref,
          action: record.mark.action, summary: record.mark.summary,
        })) reject('Mark does not match its successful durable tool receipt');
    }
  }
  for (const [seq, ref] of Object.entries(state.versions)) {
    const record = own(state.records, ref);
    if (!Number.isSafeInteger(Number(seq)) || !record || Number(seq) < record.originalSeq
      || Number(seq) > record.currentSeq) reject('Invalid result-version index');
  }
});

/** Pure index over standard events; no custom required session vocabulary. */
export const foldingProjection: ProjectionDefinition<'contextFolding'> = {
  key: PROJECTION_KEY,
  stateVersion: 1,
  stateSchema,
  init: () => ({ records: {}, versions: {}, calls: {}, callHistory: {} }),
  apply(state, event) {
    if (event.type === 'tool/call') {
      const callId = event.data.callId;
      return { ...state, calls: { ...state.calls, [callId]: event },
        callHistory: { ...state.callHistory, [event.seq]: event } };
    }
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      const ref = makeRef(event.seq, event.data.message);
      const entry: RecordState = {
        ref, originalSeq: event.seq, currentSeq: event.seq, original: event, current: event,
        paired: paired(own(state.calls, event.data.message.source.callId), event),
        owned: true, folded: false, mark: null,
      };
      const receipt = receiptFrom(state, event);
      const records = { ...state.records, [ref]: entry };
      if (receipt) {
        const target = own(state.records, receipt.ref)!;
        records[receipt.ref] = { ...target, mark: { ...receipt, receiptSeq: event.seq } };
      }
      return { ...state, records, versions: { ...state.versions, [event.seq]: ref } };
    }
    if (!('surfaceOp' in event) || event.surfaceOp === undefined || event.surfaceOp === 'append') return state;
    const op = event.surfaceOp;
    let records = state.records;
    let versions = state.versions;
    for (const sourceSeq of event.sourceEventSeqs ?? []) {
      const ref = own(state.versions, String(sourceSeq));
      const previous = ref === undefined ? undefined : own(state.records, ref);
      if (!previous || previous.currentSeq !== sourceSeq) continue;
      if (records === state.records) records = { ...records };
      if (event.type === 'tool/result' && op.startSeq === sourceSeq && op.endSeq === sourceSeq) {
        const linked = event.sourceEventSeqs?.includes(previous.original.seq);
        const verified = linked && previous.owned && sameDataExceptContent(previous.original, event)
          ? verifyFold(previous.original.data.message.content, event.data.message.content, previous.ref) : null;
        const restored = linked && previous.owned && sameDataExceptContent(previous.original, event)
          && isDeepStrictEqual(previous.original.data.message.content, event.data.message.content);
        records[previous.ref] = {
          ...previous, currentSeq: event.seq, current: event,
          owned: Boolean(verified || restored), folded: verified !== null,
        };
        if (versions === state.versions) versions = { ...versions };
        versions[String(event.seq)] = previous.ref;
      } else {
        records[previous.ref] = { ...previous, owned: false, folded: false };
      }
    }
    return records === state.records ? state : { ...state, records, versions };
  },
};
