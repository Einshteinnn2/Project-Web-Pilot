import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveMacSigning, signMacBundle } from '../scripts/sign-mac-bundle.mjs';

const first = '1'.repeat(40), second = '2'.repeat(40), distribution = '3'.repeat(40);
const listing = '  1) ' + first + ' "Apple Development: First (FIRSTTEAM1)"\n'
  + '  2) ' + second + ' "Apple Development: Second (OTHERTEAM2)"\n'
  + '  3) ' + distribution + ' "Developer ID Application: Distribution (THIRDTEAM3)"\n'
  + '     3 valid identities found\n';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webpilot-signing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const resolve = options => resolveMacSigning({ platform: 'darwin', execute: () => listing, ...options });

test('missing, empty and ambiguous identity never select a certificate automatically', async t => {
  const root = await fixture(t);
  let queries = 0;
  const execute = () => { queries++; return listing; };
  for (const identity of [undefined, '', '-', 'Apple Development: First']) {
    await assert.rejects(resolve({ root, identity, execute }), { code: 'MAC_SIGNING_IDENTITY_REQUIRED' });
  }
  assert.equal(queries, 0);
});

test('the exact valid development identity is selected, not the first identity', async () => {
  const result = await resolve({ identity: second });
  assert.deepEqual(result, { identity: second, name: 'Apple Development: Second (OTHERTEAM2)' });
  await assert.rejects(resolve({ identity: 'f'.repeat(40) }), { code: 'MAC_SIGNING_IDENTITY_UNKNOWN' });
  await assert.rejects(resolve({ identity: distribution }), { code: 'MAC_SIGNING_IDENTITY_TYPE' });
});

test('local config is required to be valid and explicit; an explicit identity takes precedence', async t => {
  const root = await fixture(t), config = path.join(root, '.harness/runtime/mac-signing.json');
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.writeFile(config, '{"identity":"' + first + '"}');
  assert.equal((await resolve({ root })).identity, first);
  assert.equal((await resolve({ root, identity: second })).identity, second);
  await fs.writeFile(config, 'invalid JSON');
  await assert.rejects(resolve({ root }), { code: 'MAC_SIGNING_CONFIG_INVALID' });
  await fs.rm(config);
  const other = path.join(root, 'other.json');
  await fs.writeFile(other, '{"identity":"' + first + '"}');
  await fs.symlink(other, config);
  await assert.rejects(resolve({ root }), { code: 'MAC_SIGNING_CONFIG_INVALID' });
});

test('unsupported platforms refuse before accessing identities', async () => {
  let queries = 0;
  await assert.rejects(resolve({ platform: 'win32', identity: first, execute: () => { queries++; } }), { code: 'MAC_SIGNING_PLATFORM' });
  assert.equal(queries, 0);
});

async function appFixture(t) {
  const root = await fixture(t), app = path.join(root, 'Project Web Pilot.app');
  await fs.mkdir(path.join(app, 'Contents'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3', devDependencies: { electron: '44.5.1' } }));
  const execute = (command, args) => command === '/usr/bin/security' ? listing
    : args[1] === 'Print :CFBundleIdentifier' ? 'com.oleynik.ProjectWebPilot\n' : '1.2.3\n';
  return { root, app, execute, platform: 'darwin', identity: second };
}

test('signing passes a validated identity and disables profile automation for local development', async t => {
  const f = await appFixture(t);
  let options;
  const result = await signMacBundle({ ...f, signBundle: async value => { options = value; } });
  assert.equal(result.identity, second);
  assert.equal(result.version, '1.2.3');
  assert.equal(options.identity, second);
  assert.equal(options.platform, 'darwin');
  assert.equal(options.type, 'development');
  assert.equal(options.identityValidation, true);
  assert.equal(options.strictVerify, true);
  assert.equal(options.preAutoEntitlements, false);
  assert.equal(options.preEmbedProvisioningProfile, false);
  assert.equal(options.optionsForFile(f.app).hardenedRuntime, false);
  assert.equal(options.optionsForFile(f.app).timestamp, 'none');
});

test('wrong identity, bundle id, version or symlink never call the signer', async t => {
  const f = await appFixture(t);
  let calls = 0;
  const signBundle = async () => { calls++; };
  await assert.rejects(signMacBundle({ ...f, identity: 'f'.repeat(40), signBundle }), { code: 'MAC_SIGNING_IDENTITY_UNKNOWN' });
  await assert.rejects(signMacBundle({ ...f, execute: (command, args) => command === '/usr/bin/security' ? listing
    : args[1] === 'Print :CFBundleIdentifier' ? 'other.bundle' : '1.2.3', signBundle }), { code: 'MAC_SIGNING_BUNDLE_INVALID' });
  await assert.rejects(signMacBundle({ ...f, execute: (command, args) => command === '/usr/bin/security' ? listing
    : args[1] === 'Print :CFBundleIdentifier' ? 'com.oleynik.ProjectWebPilot' : '9.9.9', signBundle }), { code: 'MAC_SIGNING_BUNDLE_INVALID' });
  const alias = path.join(f.root, 'Alias.app');
  await fs.symlink(f.app, alias);
  await assert.rejects(signMacBundle({ ...f, app: alias, signBundle }), { code: 'MAC_SIGNING_BUNDLE_INVALID' });
  assert.equal(calls, 0);
});

test('signer failures propagate without a success result or fallback identity', async t => {
  const f = await appFixture(t);
  const expected = new Error('fixture signing failed');
  await assert.rejects(signMacBundle({ ...f, signBundle: async () => { throw expected; } }), error => error === expected);
});

test('CLI refuses an unset certificate before any signing operation', { skip: process.platform !== 'darwin' }, () => {
  const result = spawnSync(process.execPath, ['scripts/sign-mac-bundle.mjs', '--check'], { encoding: 'utf8', env: { ...process.env, WEBPILOT_MAC_SIGNING_IDENTITY: '' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SHA-1/);
  assert.equal(result.stdout, '');
});
