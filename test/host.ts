/** Real published DSH 0.2.1-rc.2 services with a deterministic, offline model. */
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  ToolCallId,
  type ContentBlock,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import TokenMeter from '@deepseek-ai/dsh-token-meter';

export type ResponseFactory = (
  request: GenerateOptions,
) => readonly StreamChunk[] | Promise<readonly StreamChunk[]>;

export class OfflineModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  readonly responses: (readonly StreamChunk[] | ResponseFactory)[] = [];

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('Offline model response script exhausted');
    const chunks = typeof response === 'function' ? await response(request) : response;
    for (const chunk of chunks) {
      request.signal?.throwIfAborted();
      yield chunk;
    }
  }
}

export function textResponse(text = 'Done.'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

export function toolResponse(name: string, args: object, callId: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: ToolCallId(callId), name, arguments: JSON.stringify(args) },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}

export interface Host {
  ctx: Context;
  model: OfflineModel;
  errors: unknown[];
  create(id: string): Promise<AgentHandle>;
  resume(id: string): Promise<AgentHandle>;
  close(): Promise<void>;
}

export async function createHost(root?: string): Promise<Host> {
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(TokenMeter);
    await ctx.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      personaPrefix: 'Offline DSH context-folding integration test.',
    });
    await ctx.plugin(ToolRuntime, { mode: 'native' });
    await ctx.plugin(AgentRegistry);
    if (root) await ctx.plugin(JsonlPersistence, { root, compression: 'none' });
    await ctx.plugin(AgentLoop, { agents: [] });
    const model = new OfflineModel();
    const errors: unknown[] = [];
    ctx.on('agent/error', ({ error }) => { errors.push(error); });
    ctx.llm.registerAdapter(['offline'], model);
    const agentOptions = { provider: 'offline', model: 'fixture' };
    return {
      ctx, model, errors,
      create: (id) => ctx.agents.create({
        sessionId: SessionId(id), agentOptions, ...(root ? { meta: { cwd: root } } : {}),
      }),
      resume: (id) => ctx.agents.resume({ resumeSessionId: SessionId(id), agentOptions }),
      close: () => ctx.fiber.dispose(),
    };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

export async function prompt(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await agent.whenIdle();
}

export function registerFixture(ctx: Context, blocks: readonly ContentBlock[]): () => void {
  return ctx.tools.register(defineTool({
    name: 'large_fixture',
    description: 'Return an offline fixture for integration testing.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: () => structuredClone([...blocks]),
    },
    async execute() { return 'fixture'; },
  }));
}

export async function produceFixture(host: Host, agent: Agent, callId = 'fixture-1'): Promise<void> {
  host.model.responses.push(toolResponse('large_fixture', {}, callId), textResponse('Fixture inspected.'));
  await prompt(agent, 'Inspect the large fixture and keep my requirements intact.');
}
