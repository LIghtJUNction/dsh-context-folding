/**
 * Copy this file to FRESH/scripts/packed-smoke.ts and test/host.ts to
 * FRESH/test/host.ts. Install the npm tarball and the rc.2 test dependencies
 * there, including @deepseek-ai/dsh-app-boot@0.2.1-rc.2. Run from FRESH:
 *   node --import tsx scripts/packed-smoke.ts
 * Its package.json must select dsh.profile.bundles: ['dsh-context-folding'].
 * All imports deliberately resolve inside that fresh installation.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot';
import { isAgentLoopRequest, ToolCallId } from '@deepseek-ai/dsh-llm';
import plugin from 'dsh-context-folding';
import { createHost, produceFixture, prompt, registerFixture, textResponse } from '../test/host.js';

const freshDir = dirname(dirname(fileURLToPath(import.meta.url)));
const installedEntry = await realpath(fileURLToPath(import.meta.resolve('dsh-context-folding')));
assert.match(installedEntry.replaceAll('\\', '/'), /\/node_modules\/dsh-context-folding\/dist\/index\.js$/,
  'smoke must load an installed tarball, never the source checkout self-reference');
const pluginRequire = createRequire(installedEntry);
const peerPaths: Record<string, string> = {};
for (const peer of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session']) {
  const harnessCopy = await realpath(fileURLToPath(import.meta.resolve(peer)));
  assert.equal(await realpath(pluginRequire.resolve(peer)), harnessCopy, `${peer} must have one runtime identity`);
  peerPaths[peer] = harnessCopy;
}

// This is the published rc.2 profile loader and patch composer, not our own
// parser of the shape we happen to have written in package.json.
const profile = loadProfileDirectory('dsh', freshDir, join(freshDir, 'package.json'), { userLayer: false });
assert.deepEqual(profile.skippedBundles, []);
assert.equal(profile.layers.length, 1);
assert.equal(profile.layers[0]?.packageName, 'dsh-context-folding');
const entries = composeEntries(profile.layers.map((layer) => layer.patches));
assert.equal(entries.length, 1);
const entry = entries[0];
assert.ok(entry);
assert.equal(entry.id, 'context-folding');
assert.equal(entry.name, 'dsh-context-folding');
assert.ok(entry.config && typeof entry.config === 'object' && !Array.isArray(entry.config));
const manifestPath = fileURLToPath(import.meta.resolve('dsh-context-folding/package.json'));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.engines.dsh, '0.2.1-rc.2');
assert.ok(manifest.keywords.includes('dsh-plugin'));

const root = await mkdtemp(join(tmpdir(), 'dsh-packed-smoke-'));
const host = await createHost(root);
let checkedRequests = 0;
try {
  await host.ctx.plugin(plugin, {
    ...entry.config, auto: true, keepRecentMessages: 2,
    minTextChars: 512, headChars: 32, tailChars: 16,
    triggerTokens: 1, maxFoldsPerStep: 2,
  });
  host.ctx.on('llm/stream', async function* (options, next) {
    assert.equal(isAgentLoopRequest(options), true, 'the real agent-loop request brand must be recognized');
    assert.ok(options.sessionId);
    const agent = host.ctx.agents.get(options.sessionId);
    assert.ok(agent);
    assert.ok(Object.isFrozen(options));
    assert.ok(Object.isFrozen(options.messages));
    assert.deepEqual(options.messages, agent.session.deriveMessages(), 'wire input matches the logged surface at dispatch');
    const before = JSON.stringify(options.messages);
    yield* next();
    assert.equal(JSON.stringify(options.messages), before, 'the frozen input remains unchanged after dispatch');
    checkedRequests++;
  });
  const original = 'Packed Unicode fixture 😀 中文\n'.repeat(900);
  registerFixture(host.ctx, [{ type: 'text', text: original }]);
  const handle = await host.create('packed-install-smoke');
  assert.ok(host.ctx.tools.schemas(handle.agent).some((tool) => tool.name === 'context_folding'));
  await produceFixture(host, handle.agent);
  const prefix = handle.agent.session.snapshotEvents();
  const originalPrefix = JSON.stringify(prefix);
  for (let index = 0; index < 3; index++) {
    host.model.responses.push(textResponse(`Packed follow-up ${index}.`));
    await prompt(handle.agent, `Keep this new requirement ${index}.`);
  }
  assert.deepEqual(host.errors, []);
  assert.equal(JSON.stringify(handle.agent.session.snapshotEvents().slice(0, prefix.length)), originalPrefix);
  const replacements = handle.agent.session.snapshotEvents().filter((event) =>
    event.type === 'tool/result' && typeof event.surfaceOp === 'object');
  assert.equal(replacements.length, 1);
  const listed = await host.ctx.tools.execute({
    callId: ToolCallId('packed-list'), name: 'context_folding',
    arguments: { action: 'list' }, agent: handle.agent, signal: new AbortController().signal,
  });
  assert.equal(listed.isError, false, JSON.stringify(listed));
  const listing = listed.value as unknown as { entries: { ref: string; folded: boolean }[] };
  const folded = listing.entries[0];
  assert.ok(folded?.folded);
  let recovered = '';
  let offset: number | null = 0;
  while (offset !== null) {
    const read = await host.ctx.tools.execute({
      callId: ToolCallId(`packed-read-${offset}`), name: 'context_folding',
      arguments: { action: 'read', ref: folded.ref, block: 0, offset, limit: 4000 },
      agent: handle.agent, signal: new AbortController().signal,
    });
    assert.equal(read.isError, false, JSON.stringify(read));
    const result = read.value as unknown as { page: { data: string; nextOffset: number | null } };
    recovered += result.page.data;
    offset = result.page.nextOffset;
  }
  assert.equal(recovered, original);
  assert.ok(checkedRequests >= 5);
  assert.equal(checkedRequests, host.model.requests.length);
  await host.ctx.sessions.flush(handle.agent.session);
  await handle.dispose();
  console.log(JSON.stringify({
    result: 'PASS', package: `${manifest.name}@${manifest.version}`, host: '0.2.1-rc.2',
    installedEntry, peerPaths, bundleLoader: 'real rc.2 loadProfileDirectory + composeEntries',
    bundleEntries: entries.length, checkedFrozenRequests: checkedRequests,
    surfaceReplacements: replacements.length, exactRecoveryCodePoints: Array.from(recovered).length,
    remoteModelCalls: 0,
  }, null, 2));
} finally {
  await host.close();
  await rm(root, { recursive: true, force: true });
}
