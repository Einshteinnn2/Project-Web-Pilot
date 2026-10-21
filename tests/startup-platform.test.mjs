import test from 'node:test';
import assert from 'node:assert/strict';
import { StartupReadiness } from '../src/startup-readiness.mjs';
import { startupPlatformOptions, startupSupported } from '../src/startup-platform.mjs';
function fixture(platform = 'win32') {
  const calls = [], updates = [];
  let installed = false, componentsReady = false, failPreparation = false;
  let service = { mcp: { ready: false }, tunnel: { ready: false, configured: false } };
  const input = {
    platform,
    setup: { node: async () => 'bundled-node', setRuntimeEnvironment: value => calls.push(['environment', value]) },
    // Windows only: the tools and the private Python that the package unpacks before control.py can run.
    components: platform === 'win32' ? {
      ensure: async () => {
        calls.push(['components']);
        if (failPreparation) throw Object.assign(new Error('private-command'), { code: 'WINDOWS_RUNTIME_SETUP_FAILED' });
        componentsReady = true;
      },
      inspect: async () => ({ toolsReady: componentsReady, installed: componentsReady }),
      workflowEnvironment: async () => { assert.ok(componentsReady); return { WORKFLOW_GIT_BIN: 'portable-git' }; },
    } : null,
    // The executor runtime of both systems: installed means its services were activated in this app run.
    bootstrap: {
      inspect: async () => ({ installed }),
      configureTunnel: async credentials => {
        calls.push(['configure', !!credentials]);
        service = { mcp: { ready: false }, tunnel: { configured: true, ready: false } };
        return { configured: true };
      },
    },
    ensureRuntime: async () => {
      calls.push(['ensure']);
      installed = true;
    },
    inspectGit: async () => { calls.push(['apple-probe']); return true; },
    installGit: async () => { calls.push(['apple-install']); },
    control: async (command, options) => {
      calls.push([command, options]);
      if (command === 'start') service = { mcp: { ready: true }, tunnel: { configured: service.tunnel.configured, ready: !options.mcpOnly } };
      return service;
    },
  };
  const flow = new StartupReadiness({ ...startupPlatformOptions(input), onChange: s => updates.push(s) });
  return { flow, calls, updates, input, fail: value => { failPreparation = value; } };
}
test('real startup selection enables Windows and macOS while fixture mode is isolated', () => {
  assert.equal(startupSupported('win32'), true);
  assert.equal(startupSupported('darwin'), true);
  assert.equal(startupSupported('linux'), false);
  assert.equal(startupSupported('win32', true), false);
});
test('clean Windows unpacks the components of the package before Git, then activates the executor like macOS, without Apple', async () => {
  const f = fixture();
  await f.flow.check({ prepare: true });
  assert.equal(f.flow.snapshot().platform, 'win32');
  assert.equal(f.flow.snapshot().phase, 'tunnel');
  assert.equal(f.flow.snapshot().runtime, true);
  assert.equal(f.flow.snapshot().tunnel, false);
  assert.deepEqual(f.calls.map(([command]) => command), ['components', 'environment', 'ensure', 'status', 'start'],
    'components first, then the Git environment of Workflow Kit, then the same activation and start as on macOS');
  assert.deepEqual(f.calls[1], ['environment', { WORKFLOW_GIT_BIN: 'portable-git' }]);
  assert.deepEqual(f.calls.at(-1), ['start', { mcpOnly: true }]);
  await f.flow.configure({ tunnelId: 'fixture', key: 'fixture' });
  assert.equal(f.flow.snapshot().phase, 'connected');
  assert.equal(f.flow.snapshot().tunnel, true);
  assert.equal(f.flow.snapshot().account, 'unknown');
  assert.ok(!JSON.stringify(f.calls).includes('apple'));
  f.calls.length = 0;
  await f.flow.check({ prepare: true });
  assert.ok(!f.calls.some(([command]) => command === 'start' || command === 'configure'));
  assert.throws(() => startupPlatformOptions({ ...f.input, components: null }), /components of the package/);
});
test('Windows without Codex shows the message of the executor and keeps Git usable for projects', async () => {
  const f = fixture();
  let failed = true;
  f.input.ensureRuntime = async () => {
    f.calls.push(['ensure']);
    if (failed) throw Object.assign(new Error('private-command'), { code: 'WINDOWS_CODEX_NOT_FOUND', publicMessage: 'На этом компьютере не найден Codex.' });
  };
  f.input.bootstrap.inspect = async () => ({ installed: !failed });
  const flow = new StartupReadiness(startupPlatformOptions(f.input));
  await flow.check({ prepare: true });
  assert.equal(flow.snapshot().phase, 'error');
  assert.equal(flow.snapshot().error, 'На этом компьютере не найден Codex.');
  assert.equal(flow.snapshot().git, true, 'the components and Git are ready although the services are not');
  assert.equal(flow.snapshot().runtime, false);
  failed = false;
  await flow.check({ prepare: true });
  assert.equal(flow.snapshot().error, null);
  assert.equal(flow.snapshot().phase, 'tunnel');
  flow.dispose();
});
test('Windows preparation errors remain actionable and retry resumes the same coordinator', async () => {
  const f = fixture(); f.fail(true);
  await f.flow.check({ prepare: true });
  assert.equal(f.flow.snapshot().phase, 'error');
  assert.equal(f.flow.snapshot().runtime, false);
  assert.match(f.flow.snapshot().error, /WINDOWS_RUNTIME_SETUP_FAILED/);
  assert.doesNotMatch(f.flow.snapshot().error, /private-command/);
  f.fail(false); await f.flow.check({ prepare: true });
  assert.equal(f.flow.snapshot().phase, 'tunnel');
  assert.equal(f.flow.snapshot().error, null);
});
test('Windows inspection is read-only and package failure does not install components', async () => {
  const f = fixture(); await f.flow.check();
  assert.equal(f.calls.length, 0);
  const input = { ...f.input, setup: { ...f.input.setup, node: async () => { throw new Error('missing'); } } };
  const flow = new StartupReadiness(startupPlatformOptions(input));
  await flow.check({ prepare: true });
  assert.equal(f.calls.length, 0);
  assert.match(flow.snapshot().error, /Windows ZIP/);
  assert.doesNotMatch(flow.snapshot().error, /Apple|Applications/);
});