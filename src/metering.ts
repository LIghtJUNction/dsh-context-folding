import type { Context } from '@deepseek-ai/cordis';
import { freezeMessage, type ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-compaction';
import type {} from '@deepseek-ai/dsh-token-meter';
import type { RecordState } from './types.js';

/**
 * Keep the host's bounded token projections consistent with its actual surface.
 * The standard shadow-price claim must immediately precede the replacement.
 * These are two committed events, not a transaction: a rejected replacement
 * leaves a zero-delta claim that expires on the next ordinary event.
 */
export function appendReplacement(
  ctx: Context,
  session: Session,
  current: RecordState,
  content: readonly ContentBlock[],
): void {
  const event = current.current;
  const message = freezeMessage({ ...event.data.message, content });
  const shadowedTokenCount = ctx.tokenMeter.estimateMessage(event.data.message);
  session.append('compaction/prune', {
    shadowedRange: { start: event.seq, end: event.seq },
    shadowedSeqs: [event.seq],
    shadowedTokenCount,
  });
  // Deliberately synchronous and adjacent; this also prices restores, whose
  // signed delta can be positive. No optional callback or await belongs here.
  session.append('tool/result', { ...event.data, message }, {
    surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq },
    sourceEventSeqs: [...new Set([event.seq, current.original.seq])],
  });
}
