import { z } from 'zod';
import type { Config } from './types.js';

export const DEFAULTS: Readonly<Config> = Object.freeze({
  auto: true,
  keepRecentMessages: 12,
  minTextChars: 4096,
  headChars: 192,
  tailChars: 96,
  triggerTokens: 64000,
  maxFoldsPerStep: 4,
});

const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const configSchema = z.object({
  auto: z.boolean().default(DEFAULTS.auto),
  keepRecentMessages: integer(1, 10000).default(DEFAULTS.keepRecentMessages),
  minTextChars: integer(1, 10_000_000).default(DEFAULTS.minTextChars),
  headChars: integer(0, 10000).default(DEFAULTS.headChars),
  tailChars: integer(0, 10000).default(DEFAULTS.tailChars),
  triggerTokens: integer(1, 1_000_000_000).default(DEFAULTS.triggerTokens),
  maxFoldsPerStep: integer(1, 100).default(DEFAULTS.maxFoldsPerStep),
}).strict();

export function resolveConfig(input: unknown = {}): Readonly<Config> {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid context-folding configuration. Check the documented keys and integer ranges.');
  return Object.freeze(parsed.data);
}
