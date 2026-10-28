import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

export const TOOL_NAME = 'context_folding';
export const PROJECTION_KEY = 'contextFolding';

export interface Config {
  auto: boolean;
  keepRecentMessages: number;
  minTextChars: number;
  headChars: number;
  tailChars: number;
  triggerTokens: number;
  maxFoldsPerStep: number;
}

export interface FoldOptions {
  headChars: number;
  tailChars: number;
}

export interface VerifiedFold extends FoldOptions {
  summary?: string;
}

/** Text pages use Unicode code-point offsets. Other blocks are paged JSON. */
export interface ContentPage {
  encoding: 'text' | 'json';
  data: string;
  blockIndex: number;
  offset: number;
  nextOffset: number | null;
  nextBlock: number | null;
  totalCodePoints: number;
  totalBlocks: number;
}

export interface ToolArgs {
  action: 'list' | 'read' | 'fold' | 'keep' | 'unmarked';
  ref?: string;
  block?: number;
  offset?: number;
  limit?: number;
  summary?: string;
}

export type MarkAction = 'fold' | 'keep' | 'unmarked';

export interface Receipt {
  version: 1;
  ref: string;
  action: MarkAction;
  summary: string | null;
}

export interface Mark extends Receipt {
  receiptSeq: number;
}

export interface RecordState {
  ref: string;
  originalSeq: number;
  currentSeq: number;
  original: SessionEvent<'tool/result'>;
  current: SessionEvent<'tool/result'>;
  /** A matching original tool/call exists in this session. */
  paired: boolean;
  /** False after another plugin makes a replacement we cannot verify. */
  owned: boolean;
  folded: boolean;
  mark: Mark | null;
}

/** Plain JSON only: the host can checkpoint and reconstruct this state. */
export interface FoldState {
  records: Record<string, RecordState>;
  versions: Record<string, string>;
  calls: Record<string, SessionEvent<'tool/call'>>;
  /** Historical calls by event sequence; needed when a provider reuses a call id. */
  callHistory: Record<string, SessionEvent<'tool/call'>>;
}

export type Blocks = readonly ContentBlock[];
