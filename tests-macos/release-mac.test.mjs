import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createPackage, extractFile, uncache } from '@electron/asar';
import { installMacBundle, publishMacRelease } from '../scripts/release-mac.mjs';

const mac = { skip: process.platform !== 'darwin' };
// These small bundles test installation mechanics, with an explicit fixture signature verifier.
const verifySignature = async () => ({ identity: 'fixture', identifier: 'com.oleynik.ProjectWebPilot', cdhash: 'fixture', requirement: 'fixture' });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-pilot-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function bundle(root, version, marker) {
  const source = path.join(root, '.harness/runtime/build/Project Web Pilot-darwin-arm64/Project Web Pilot.app');
  await fs.rm(source, { recursive: true, force: true });
  const resources = path.join(source, 'Contents/Resources');
  await fs.mkdir(resources, { recursive: true });
  await fs.writeFile(path.join(source, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.oleynik.ProjectWebPilot</string><key>CFBundleShortVersionString</key><string>' + version + '</string></dict></plist>');
  const input = path.join(root, 'input');
  await fs.mkdir(input, { recursive: true });
  await fs.writeFile(path.join(input, 'package.json'), JSON.stringify({ name: 'project-web-pilot', version }));
  await fs.writeFile(path.join(input, 'marker.txt'), marker);
  await createPackage(input, path.join(resources, 'app.asar'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version }));
  return source;
}
function marker(app) {
  const archive = path.join(app, 'Contents/Resources/app.asar');
  uncache(archive);
  return extractFile(archive, 'marker.txt').toString();
}

test('two releases keep the permanent app identity, back up old contents and publish a separate ZIP', mac, async t => {
  const root = await fixture(t), delivery = path.join(root, 'downloads');
  await bundle(root, '1.0.0', 'first');
  const first = await publishMacRelease({ root, deliveryDirectory: delivery, verifySignature });
  const original = await fs.stat(first.installation.target);
  await fs.writeFile(path.join(first.installation.target, 'Contents/obsolete.txt'), 'old file');
  await bundle(root, '1.0.1', 'second');
  const second = await publishMacRelease({ root, deliveryDirectory: delivery, verifySignature });
  const updated = await fs.stat(second.installation.target);
  assert.equal(updated.ino, original.ino);
  assert.equal(updated.dev, original.dev);
  assert.equal(marker(second.installation.target), 'second');
  assert.equal(marker(second.installation.backup), 'first');
  await assert.rejects(fs.stat(path.join(second.installation.target, 'Contents/obsolete.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(second.installation.backup, 'Contents/obsolete.txt'), 'utf8'), 'old file');
  const extracted = path.join(root, 'unpacked');
  execFileSync('/usr/bin/ditto', ['-x', '-k', second.zip, extracted]);
  assert.equal(marker(path.join(extracted, 'Project Web Pilot.app')), 'second');
  assert.ok((await fs.stat(path.join(delivery, path.basename(second.zip)))).size > 0);
  assert.equal((await fs.readFile(second.zip + '.sha256', 'utf8')).split(' ')[0], second.sha256);
  assert.ok(!second.zip.startsWith(second.installation.target + path.sep));
  // Backups: one slot per target outside Spotlight; the next release replaces it with the then-previous version.
  const backupRoot = path.dirname(second.installation.backup);
  assert.equal(path.basename(backupRoot), 'release-backups.noindex');
  const thirdSource = await bundle(root, '1.0.2', 'third');
  const third = await publishMacRelease({ root, deliveryDirectory: delivery, verifySignature });
  assert.equal(third.installation.backup, second.installation.backup, 'the same target keeps one slot');
  assert.equal(marker(third.installation.backup), 'second');
  assert.equal(third.installation.backupError, undefined);
  assert.deepEqual(await fs.readdir(backupRoot), [path.basename(third.installation.backup)]);
  const other = path.join(root, 'Applications', 'Project Web Pilot.app');
  const options = { source: thirdSource, target: other, backupRoot, version: '1.0.2', verifySignature };
  assert.equal((await installMacBundle(options)).backup, null, 'a first installation has nothing to back up');
  const otherAgain = await installMacBundle(options);
  assert.notEqual(otherAgain.backup, third.installation.backup, 'another target gets its own slot');
  assert.equal(marker(otherAgain.backup), 'third');
  assert.equal(marker(third.installation.backup), 'second', 'other targets keep their backups');
  assert.equal((await fs.readdir(backupRoot)).length, 2);
});

test('invalid source version and unexpected target files preserve the installed app', mac, async t => {
  const root = await fixture(t);
  const source = await bundle(root, '1.0.0', 'safe');
  const options = { source, target: path.join(root, 'Project Web Pilot.app'), backupRoot: path.join(root, 'backups'), version: '1.0.0', verifySignature };
  await installMacBundle(options);
  const before = await fs.stat(options.target);
  await assert.rejects(installMacBundle({ ...options, version: '9.9.9' }), /version mismatch/);
  await fs.writeFile(path.join(options.target, 'foreign.txt'), 'preserve');
  await assert.rejects(installMacBundle(options), /Unexpected app entries/);
  assert.equal((await fs.stat(options.target)).ino, before.ino);
  assert.equal(marker(options.target), 'safe');
  assert.equal(await fs.readFile(path.join(options.target, 'foreign.txt'), 'utf8'), 'preserve');
});

test('symlink target is refused without changing its destination', mac, async t => {
  const root = await fixture(t);
  const source = await bundle(root, '1.0.0', 'safe');
  const target = path.join(root, 'alias.app');
  await fs.symlink(source, target);
  await assert.rejects(installMacBundle({ source, target, backupRoot: path.join(root, 'backups'), version: '1.0.0', verifySignature }), /real app directory/);
  assert.equal(marker(source), 'safe');
  assert.ok((await fs.lstat(target)).isSymbolicLink());
});

test('a signature failure refuses the source before altering the installed app', mac, async t => {
  const root = await fixture(t), source = await bundle(root, '1.0.0', 'safe');
  const target = path.join(root, 'Project Web Pilot.app');
  const options = { source, target, backupRoot: path.join(root, 'backups'), version: '1.0.0', verifySignature };
  await installMacBundle(options);
  const before = await fs.stat(target);
  await assert.rejects(installMacBundle({ ...options, verifySignature: async () => { throw new Error('Invalid signature'); } }), /Invalid signature/);
  assert.equal((await fs.stat(target)).ino, before.ino);
  assert.equal(marker(target), 'safe');
});

test('a verification failure after installation restores the previous Contents', mac, async t => {
  const root = await fixture(t), source = await bundle(root, '1.0.0', 'safe');
  const target = path.join(root, 'Project Web Pilot.app');
  const options = { source, target, backupRoot: path.join(root, 'backups'), version: '1.0.0', verifySignature };
  await installMacBundle(options);
  const before = await fs.stat(target);
  await bundle(root, '1.0.1', 'new');
  await assert.rejects(installMacBundle({ ...options, version: '1.0.1', verifySignature: async ({ bundle }) => {
    if (bundle === target) throw new Error('Copied signature failed');
    return verifySignature();
  } }), /Copied signature failed/);
  assert.equal((await fs.stat(target)).ino, before.ino);
  assert.equal(marker(target), 'safe');
});
