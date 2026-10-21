import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareMacNode, NODE_ARCHIVE } from '../scripts/prepare-mac-toolchain.mjs';
import { bundledMacNode } from '../src/platform.mjs';

test('Mac Node is resolved inside resources, including spaces', () => {
  assert.equal(bundledMacNode('/Applications/Project Web Pilot.app/Contents/Resources'), '/Applications/Project Web Pilot.app/Contents/Resources/mac-tools/node/bin/node');
});
test('untrusted download cannot be extracted or replace an existing Node', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-mac-node-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const node = path.join(root, '.harness/runtime/mac-tools/node/bin/node');
  await fs.mkdir(path.dirname(node), { recursive: true }); await fs.writeFile(node, 'existing');
  let executed = false;
  await assert.rejects(prepareMacNode({ root, download: async (_url, file) => fs.writeFile(file, 'wrong archive'),
    run: async () => { executed = true; } }), /SHA-256 mismatch/);
  assert.equal(executed, false);
  assert.equal(await fs.readFile(node, 'utf8'), 'existing');
  const files = await fs.readdir(path.join(root, '.harness/runtime/mac-node-cache'));
  assert.equal(files.includes(NODE_ARCHIVE + '.download'), false);
});
