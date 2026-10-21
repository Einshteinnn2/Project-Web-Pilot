import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPackage } from '@electron/asar';
import { execFileSync } from 'node:child_process';
import { assertCommittedSources, buildPlatforms, PACKAGED_ROOTS, recordReleasePreflight, releaseAssetNames, sourceSnapshot, verifyPackagedSources } from '../scripts/release-all.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-paired-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'input'), resources = path.join(root, 'package/resources');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'resources/runtime-control'), { recursive: true });
  await fs.mkdir(path.join(root, 'tools/codex-app-server-mcp'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'project-web-pilot', version: '1.0.0' }));
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}');
  await fs.writeFile(path.join(root, 'src/startup.mjs'), 'export const platform = "win32";');
  await fs.writeFile(path.join(root, 'resources/runtime-control/windows-first-run.py'), 'print("fixture")');
  await fs.writeFile(path.join(root, 'tools/codex-app-server-mcp/control.py'), 'print("codex executor fixture")');
  await fs.mkdir(input, { recursive: true });
  await fs.mkdir(resources, { recursive: true });
  await fs.mkdir(path.join(resources, 'codex-app-server-mcp'), { recursive: true });
  await fs.cp(path.join(root, 'src'), path.join(input, 'src'), { recursive: true });
  await fs.copyFile(path.join(root, 'package.json'), path.join(input, 'package.json'));
  await fs.cp(path.join(root, 'resources'), path.join(resources, 'resources'), { recursive: true });
  await fs.copyFile(path.join(root, 'tools/codex-app-server-mcp/control.py'),
    path.join(resources, 'codex-app-server-mcp/control.py'));
  await createPackage(input, path.join(resources, 'app.asar'));
  return { root, input, resources, version: '1.0.0' };
}
test('release refuses mismatched versions, omitted helper and stale source despite a valid asar', async t => {
  const f = await fixture(t);
  const proof = await verifyPackagedSources(f);
  assert.equal(proof.version, '1.0.0'); assert.match(proof.asarSha256, /^[a-f0-9]{64}$/);
  const executor = path.join(f.resources, 'codex-app-server-mcp/control.py');
  await fs.rm(executor);
  await assert.rejects(verifyPackagedSources(f), { code: 'ENOENT' });
  await fs.copyFile(path.join(f.root, 'tools/codex-app-server-mcp/control.py'), executor);
  await assert.rejects(verifyPackagedSources({ ...f, version: '1.0.1' }), /version mismatch/);
  const helper = path.join(f.resources, 'resources/runtime-control/windows-first-run.py');
  await fs.rm(helper);
  await assert.rejects(verifyPackagedSources(f), { code: 'ENOENT' });
  await fs.copyFile(path.join(f.root, 'resources/runtime-control/windows-first-run.py'), helper);
  await fs.writeFile(path.join(f.root, 'src/startup.mjs'), 'export const platform = "changed";');
  await assert.rejects(verifyPackagedSources(f), /Packaged source mismatch: src/);
});
test('release snapshots detect a changed external helper and rejects nested macOS app', async t => {
  const f = await fixture(t), before = await sourceSnapshot(f.root);
  await fs.writeFile(path.join(f.root, 'resources/runtime-control/windows-first-run.py'), 'print("changed")');
  assert.notDeepEqual(await sourceSnapshot(f.root), before);
  await assert.rejects(verifyPackagedSources(f), /Packaged source mismatch: resources/);
  await fs.writeFile(path.join(f.root, 'resources/runtime-control/windows-first-run.py'), 'print("fixture")');
  await fs.mkdir(path.join(f.input, 'Project Web Pilot.app'), { recursive: true });
  await fs.writeFile(path.join(f.input, 'Project Web Pilot.app/foreign'), 'old');
  await createPackage(f.input, path.join(f.resources, 'app.asar'));
  await assert.rejects(verifyPackagedSources(f), /Nested app/);
});
test('paired build is sequential and propagates failure before the next platform', async () => {
  const calls = [];
  await buildPlatforms('/fixture', async (command, args, cwd) => { calls.push([command, args[1], cwd]); });
  assert.deepEqual(calls, [['npm', 'build:mac', '/fixture'], ['npm', 'build:win', '/fixture']]);
  const failed = [];
  await assert.rejects(buildPlatforms('/fixture', async (_, args) => { failed.push(args[1]); throw new Error('fixture failure'); }), /fixture failure/);
  assert.deepEqual(failed, ['build:mac']);
});

test('packager prunes development metadata while preserving every runtime field', async t => {
  const f = await fixture(t);
  const production = { name: 'project-web-pilot', version: '1.0.0', main: 'src/startup.mjs', type: 'module' };
  await fs.writeFile(path.join(f.root, 'package.json'), JSON.stringify({ ...production, private: true, scripts: { build: 'fixture' }, devDependencies: { fixture: '1.0.0' } }));
  await fs.writeFile(path.join(f.input, 'package.json'), JSON.stringify(production));
  await createPackage(f.input, path.join(f.resources, 'app.asar'));
  assert.equal((await verifyPackagedSources(f)).version, '1.0.0');
  await fs.writeFile(path.join(f.input, 'package.json'), JSON.stringify({ ...production, main: 'wrong.mjs' }));
  await createPackage(f.input, path.join(f.resources, 'app.asar'));
  await assert.rejects(verifyPackagedSources(f), /runtime manifest mismatch/);
});

test('release refuses a package that carries anything but the application', async t => {
  const f = await fixture(t);
  await verifyPackagedSources(f);
  // 0.6.90: an untracked folder next to the sources was packed into app.asar.
  await fs.mkdir(path.join(f.input, 'Claude outputs'), { recursive: true });
  await fs.writeFile(path.join(f.input, 'Claude outputs', 'draft.mp4'), 'private');
  await fs.writeFile(path.join(f.input, 'notes.txt'), 'stray');
  await createPackage(f.input, path.join(f.resources, 'app.asar'));
  await assert.rejects(verifyPackagedSources(f), /Unexpected files in package: (Claude outputs, notes\.txt|notes\.txt, Claude outputs)/);
});

test('packager ignore of both platforms lets through only the application roots', async () => {
  const { scripts } = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of ['build:mac:package', 'build:win:package']) {
    const match = scripts[name].match(/--ignore="([^"]+)"/);
    assert.ok(match, name + ' has --ignore');
    // npm hands the script to sh, where "\\." inside double quotes becomes "\.".
    const ignore = new RegExp(match[1].replaceAll('\\\\', '\\'));
    for (const kept of ['', '/src', '/src/main.mjs', '/src/ui/index.html', '/node_modules', '/node_modules/@webpilot/workflow-kit/cli.mjs', '/package.json', '/LICENSE'])
      assert.equal(ignore.test(kept), false, name + ' keeps ' + kept);
    for (const dropped of ['/Claude outputs', '/Claude outputs/draft.mp4', '/docs', '/tests/a.test.mjs', '/.harness/runtime', '/.git', '/.codex/hooks.json',
      '/Project Web Pilot.app', '/resources', '/tools/codex-app-server-mcp/server.py', '/scripts', '/AGENTS.md', '/README.md', '/package-lock.json',
      '/src-old', '/src-old/main.mjs', '/package.json.bak', '/LICENSE.txt', '/node_modules_backup', '/windows-app',
      '/packages', '/packages/workflow-kit/src/cli.mjs'])
      assert.equal(ignore.test(dropped), true, name + ' drops ' + dropped);
    for (const root of PACKAGED_ROOTS) assert.equal(ignore.test('/' + root), false, name + ' allows the verified root ' + root);
  }
});

test('a release has six files: both packages, the pinned Windows runtime and three records', () => {
  assert.deepEqual(releaseAssetNames('1.2.3'), ['Project-Web-Pilot-1.2.3-macOS-arm64.zip', 'Project-Web-Pilot-1.2.3-Windows-x64.zip',
    'Windows-Codex-Local-2026-09-10.zip', 'SHA256SUMS.txt', 'INSTALL.txt', 'release-manifest.json']);
});

test('paired release refuses uncommitted packaged sources but ignores the plan and documents', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'release-committed-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'R', GIT_AUTHOR_EMAIL: 'r@example.invalid', GIT_COMMITTER_NAME: 'R', GIT_COMMITTER_EMAIL: 'r@example.invalid' };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  await fs.mkdir(path.join(root, 'src')); await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'src/main.mjs'), 'export {};\n'); await fs.writeFile(path.join(root, 'package.json'), '{}\n');
  git('add', '.'); git('commit', '-q', '-m', 'baseline');
  await fs.writeFile(path.join(root, 'docs/plan.md'), '# Plan change during the task\n');
  assert.doesNotThrow(() => assertCommittedSources(root));
  await fs.writeFile(path.join(root, 'src/main.mjs'), 'export const changed = true;\n');
  assert.throws(() => assertCommittedSources(root), /uncommitted changes/);
  git('checkout', '--', 'src/main.mjs');
  await fs.writeFile(path.join(root, 'src/new.mjs'), 'export {};\n');
  assert.throws(() => assertCommittedSources(root), /src\/new\.mjs/);
});

test('release preflight is recorded once by the script for existing app copies', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'release-preflight-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.harness/runtime'), { recursive: true });
  const present = path.join(root, 'Project Web Pilot.app'), missing = path.join(root, 'absent', 'Project Web Pilot.app');
  await fs.mkdir(present);
  let calls = 0;
  const identity = async app => { calls++; return { path: app, device: 1, inode: 2, volumeUUID: 'V', bootSessionUUID: 'B' }; };
  const file = await recordReleasePreflight({ root, version: '9.9.9', apps: [present, missing], identity });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), [{ path: present, device: 1, inode: 2, volumeUUID: 'V', bootSessionUUID: 'B' }]);
  await recordReleasePreflight({ root, version: '9.9.9', apps: [present], identity: async () => { throw new Error('must not re-record'); } });
  assert.equal(calls, 1);
});
