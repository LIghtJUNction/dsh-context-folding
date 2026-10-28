import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm';
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { foldContent, readPage, textLength } from './content.js';
import { callForResult } from './projection.js';
import { appendReplacement } from './metering.js';
import { PROJECTION_KEY, TOOL_NAME } from './types.js';
import type { Config, FoldState, RecordState } from './types.js';

const refSchema = z.string().regex(/^cf1:\d+:[a-f0-9]{24}$/);
const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional();
const summary = z.string().refine(value => value.trim().length > 0 && Array.from(value).length <= 2000);
const argsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), offset, limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ action: z.literal('read'), ref: refSchema, block: offset, offset, limit: z.number().int().min(1).max(24000).optional() }).strict(),
  z.object({ action: z.literal('fold'), ref: refSchema, summary }).strict(),
  z.object({ action: z.literal('keep'), ref: refSchema }).strict(),
  z.object({ action: z.literal('unmarked'), ref: refSchema }).strict(),
]);

interface Plan { record: RecordState; content: readonly ContentBlock[]; }

/** All authority comes from the live host Agent; a ref is only a locator. */
export class FoldingController {
  definition!: ToolDefinition;
  private readonly busy = new WeakSet<Session>();

  constructor(private readonly ctx: Context, readonly config: Readonly<Config>) {}

  private session(agent: Agent | undefined): Session {
    if (!agent || typeof agent.id !== 'string' || agent.id.length === 0
      || this.ctx.agents.get(agent.id) !== agent
      || this.ctx.sessions.get(agent.id) !== agent.session
      || agent.session.id !== agent.id) {
      throw new Error('A live, host-bound agent session is required.');
    }
    return agent.session;
  }

  private state(session: Session): FoldState {
    const state = this.ctx.sessionProjections.stateOf(session, PROJECTION_KEY);
    if (!state) throw new Error('Context recovery index is unavailable; no content was folded.');
    return state;
  }

  /** schemas(), unlike get(), excludes native tools hidden behind PTC mode. */
  reachable(agent: Agent): boolean {
    return this.ctx.tools.get(TOOL_NAME, agent) === this.definition
      && this.ctx.tools.schemas(agent).some(tool => tool.name === TOOL_NAME && !tool.deferLoading);
  }

  private toolName(state: FoldState, record: RecordState): string | null {
    return callForResult(state, record.original)?.data.name ?? null;
  }

  private active(session: Session, record: RecordState): boolean {
    return session.surface.nodes.some(seq => seq === record.currentSeq);
  }

  private protected(session: Session, record: RecordState): boolean {
    const nodes = session.surface.nodes;
    const index = nodes.findIndex(seq => seq === record.currentSeq);
    return index < 0 || index >= Math.max(0, nodes.length - this.config.keepRecentMessages);
  }

  private unmodified(session: Session, record: RecordState): boolean {
    return isDeepStrictEqual(session.deriveEventMessage(record.current), record.current.data.message);
  }

  private estimate(session: Session, agent: Agent, pending: readonly Message[] = []) {
    const bytes = Buffer.byteLength(JSON.stringify({
      messages: [...session.deriveMessages(), ...pending], tools: this.ctx.tools.schemas(agent),
    }), 'utf8');
    return {
      tokens: Math.ceil(bytes / 4), bytes,
      method: 'UTF-8 JSON bytes / 4; not tokenizer or billing; excludes provider framing and later prompt assembly',
    };
  }

  /** Read or stage one command. Only a successful, logged receipt changes marks. */
  execute(input: unknown, exec: ToolRunContext): unknown {
    if (input === null || typeof input !== 'object' || Array.isArray(input)
      || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
      || ['__proto__', 'constructor', 'prototype'].some(key => Object.hasOwn(input, key))) {
      throw new Error('Invalid context_folding arguments.');
    }
    const parsed = argsSchema.safeParse(input);
    if (!parsed.success) throw new Error('Invalid context_folding arguments.');
    const args = parsed.data;
    exec.signal.throwIfAborted();
    const session = this.session(exec.agent);
    const agent = exec.agent!;
    if (exec.name !== TOOL_NAME || !this.reachable(agent)) {
      throw new Error('The native context_folding recovery tool is not available in this agent scope.');
    }
    const state = this.state(session);
    if (args.action === 'list') {
      const records = Object.values(state.records)
        .filter(record => record.paired && this.toolName(state, record) !== TOOL_NAME)
        .sort((a, b) => a.originalSeq - b.originalSeq);
      const start = args.offset ?? 0;
      if (start > records.length) throw new Error('List offset is outside this session index.');
      const end = Math.min(records.length, start + (args.limit ?? 20));
      return {
        ok: true, action: args.action, offset: start, nextOffset: end < records.length ? end : null,
        total: records.length, estimate: this.estimate(session, agent),
        entries: records.slice(start, end).map(record => ({
          ref: record.ref, tool: this.toolName(state, record), originalSeq: record.originalSeq,
          currentSeq: record.currentSeq, folded: record.folded,
          disposition: record.mark?.action ?? 'auto', active: this.active(session, record),
          protected: this.protected(session, record), supported: record.owned && this.unmodified(session, record),
          textChars: textLength(record.original.data.message.content),
          bytes: Buffer.byteLength(JSON.stringify(record.original.data.message.content), 'utf8'),
        })),
      };
    }

    const record = state.records[args.ref!];
    if (!record || !record.paired || this.toolName(state, record) === TOOL_NAME) {
      throw new Error('Unknown context reference in this agent session.');
    }
    if (args.action === 'read') {
      const original = record.original.data.message;
      return {
        ok: true, action: args.action, ref: record.ref,
        sha256: createHash('sha256').update(JSON.stringify(original)).digest('hex'),
        role: original.role, messageId: original.id, source: original.source,
        page: readPage(original.content, args.block ?? 0, args.offset ?? 0, args.limit ?? 4000),
      };
    }

    // Commands must originate from a logged model call. Forged or ad-hoc direct
    // dispatches may read within their host scope, but cannot persist marks.
    const call = Object.hasOwn(state.calls, exec.callId) ? state.calls[exec.callId] : undefined;
    let loggedArgs: unknown;
    try { loggedArgs = call ? JSON.parse(call.data.arguments) : null; } catch { loggedArgs = null; }
    if (!call || call.data.name !== TOOL_NAME || !isDeepStrictEqual(loggedArgs, input)) {
      throw new Error('A matching logged context_folding call is required to change marks.');
    }
    const active = this.active(session, record);
    if (args.action === 'fold') {
      if (!active || this.protected(session, record)) throw new Error('This result is recent or no longer active; it is protected.');
      if (!record.owned || !this.unmodified(session, record)) throw new Error('Another message transformation owns this result; folding is unavailable.');
      if (!foldContent(record.original.data.message.content, record.ref, this.config, args.summary)) {
        throw new Error('The complete replacement would not be strictly shorter.');
      }
    } else if (active && record.folded && (!record.owned || !this.unmodified(session, record))) {
      throw new Error('Another message transformation changed this result; automatic restoration is unavailable.');
    }
    return {
      ok: true, action: args.action, ref: record.ref, status: 'queued', active,
      summary: args.action === 'fold' ? args.summary : null,
      note: active ? 'Applied at the next admitted pre-step after this successful result is logged.'
        : 'Marked for policy only. The original is readable, but an inactive node cannot be reinserted.',
    };
  }

  private plans(session: Session, agent: Agent, pending: readonly Message[], canRecover: boolean): Plan[] {
    const state = this.state(session);
    const records = Object.values(state.records).filter(record => this.active(session, record));
    const restore: Plan[] = [];
    const fold: Plan[] = [];
    const budget = this.estimate(session, agent, pending).tokens >= this.config.triggerTokens;
    for (const record of records) {
      if (!record.paired || this.toolName(state, record) === TOOL_NAME) continue;
      const protectedResult = this.protected(session, record);
      const mustRestore = record.folded && (!canRecover || protectedResult
        || record.mark?.action === 'keep' || record.mark?.action === 'unmarked');
      if (mustRestore) {
        if (!record.owned || !this.unmodified(session, record)) {
          throw new Error('A folded result cannot be safely restored after another transformation; request stopped.');
        }
        restore.push({ record, content: record.original.data.message.content });
        continue;
      }
      if (!canRecover || protectedResult || !record.owned || !this.unmodified(session, record)) continue;
      // Existing automatic folds stay stable. A new explicit fold receipt can
      // update its summary, but an identical command never appends a copy.
      if (record.folded && record.mark?.action !== 'fold') continue;
      if (record.mark && record.mark.action !== 'fold') continue;
      if (!record.mark && (!this.config.auto || !budget
        || textLength(record.original.data.message.content) < this.config.minTextChars)) continue;
      const content = foldContent(record.original.data.message.content, record.ref, this.config, record.mark?.summary ?? undefined);
      if (content && !isDeepStrictEqual(content, record.current.data.message.content)) fold.push({ record, content });
    }
    // Restoring takes precedence and is never capped by the fold rate limit.
    return [...restore, ...fold.sort((a, b) => a.record.originalSeq - b.record.originalSeq).slice(0, this.config.maxFoldsPerStep)];
  }

  /** One-node atomic replacements, with original and final durability barriers. */
  async beforeStep(agent: Agent, pending: readonly Message[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const session = this.session(agent);
    if (this.busy.has(session)) throw new Error('Recursive context folding is not allowed.');
    this.busy.add(session);
    try {
      const hasFoldedHistory = Object.values(this.state(session).records)
        .some(record => record.folded && this.active(session, record));
      // A prior append may have committed while its final flush failed. An
      // idempotent retry must still cross the durability barrier before any
      // request can reuse that folded history.
      if (this.plans(session, agent, pending, this.reachable(agent)).length === 0 && !hasFoldedHistory) return;
      const persisted = await this.ctx.sessions.flush(session);
      signal.throwIfAborted();
      this.session(agent);
      if (!persisted) {
        if (Object.values(this.state(session).records).some(record => record.folded && this.active(session, record))) {
          throw new Error('Session durability is unavailable for folded history; request stopped.');
        }
        return; // No persistence provider: retain originals and do not fold.
      }
      // The async barrier may admit unrelated work. Re-plan from the new cut.
      const plans = this.plans(session, agent, pending, this.reachable(agent));
      for (const plan of plans) {
        signal.throwIfAborted();
        this.session(agent);
        const current = this.state(session).records[plan.record.ref];
        if (!current || current.currentSeq !== plan.record.currentSeq || !this.active(session, current)
          || !this.unmodified(session, current)) {
          throw new Error('Context changed during folding; request stopped and committed replacements remain recoverable.');
        }
        if (!isDeepStrictEqual(plan.content, current.original.data.message.content) && !this.reachable(agent)) {
          throw new Error('Recovery tool became unavailable; request stopped.');
        }
        try {
          appendReplacement(this.ctx, session, current, plan.content);
        } catch (cause) {
          throw new Error('Context replacement was rejected; earlier committed replacements remain recoverable.', { cause });
        }
      }
      if (plans.length > 0 && !(await this.ctx.sessions.flush(session))) {
        throw new Error('Context replacement durability could not be confirmed; request stopped.');
      }
      signal.throwIfAborted();
      this.session(agent);
    } finally {
      this.busy.delete(session);
    }
  }

  /** Read-only final gate: never mutate frozen LOOP options or messages. */
  guardRequest(options: GenerateOptions): void {
    if (!isAgentLoopRequest(options)) return;
    const agent = options.sessionId ? this.ctx.agents.get(options.sessionId) : undefined;
    const session = this.session(agent);
    if (!Object.values(this.state(session).records).some(record => record.folded && this.active(session, record))) return;
    if (!agent || !this.reachable(agent) || !options.tools?.some(tool => tool.name === TOOL_NAME && !tool.deferLoading)) {
      throw new Error('Folded context has no native recovery tool in this request; request stopped.');
    }
  }
}
