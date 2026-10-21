import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { CodexAppServerRuntime, MacRuntimeSwitcher, MacSelectedRuntime, MAC_RUNTIME_LABEL, WINDOWS_RUNTIME_LABEL, runtimeLabel,
  CODEX_NOT_FOUND_MESSAGE, WINDOWS_CODEX_NOT_FOUND_MESSAGE, EXECUTOR_TOOL_RULES,
  LEGACY_LAUNCH_AGENT, APP_SERVER_LAUNCH_AGENT, CHATGPT_CHANNEL_SECURE, CHATGPT_CHANNEL_VPS } from '../src/mac-runtime-switch.mjs';

const MCP_URL = 'http://127.0.0.1:27852/mcp';
const TUNNEL_UI = 'http://127.0.0.1:27853/ui';
const exists = file => fs.access(file).then(() => true, () => false);

async function temporary(t, name) {
  const root = await mkdtemp(path.join(tmpdir(), name));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// A stand-in for CodexAppServerRuntime with a tunnel that really starts and stops.
function fixture(root, { tunnelConfigured = true, tunnelStarts = true, vps = false, vpsReady = true, vpsThrows = false, processTable = null } = {}) {
  const events = [];
  const installedSource = path.join(root, 'state', 'source');
  const state = { tunnelConfigured, tunnelRunning: false };
  const status = () => ({ mcp: { ready: true, owned: true },
    tunnel: { ready: state.tunnelRunning, owned: state.tunnelRunning, running: state.tunnelRunning, configured: state.tunnelConfigured },
    tunnel_target: MCP_URL, tunnel_ui: TUNNEL_UI, mcp_url: MCP_URL });
  const appServerRuntime = {
    installedSource, stateDir: path.join(root, 'state'), lastStatus: null, activated: false, startupRules: EXECUTOR_TOOL_RULES,
    async syncSource() {
      events.push('app.sync');
      await fs.mkdir(installedSource, { recursive: true });
      await fs.writeFile(path.join(installedSource, 'control.py'), '# control\n');
    },
    async control(command, options = {}) {
      events.push('app.' + command + (options.tunnelOnly ? ':tunnel-only' : '') + (options.mcpOnly ? ':mcp-only' : ''));
      if (command === 'stop') { state.tunnelRunning = false; return { ok: true }; }
      if (command === 'start' && !options.mcpOnly && state.tunnelConfigured && tunnelStarts) state.tunnelRunning = true;
      return status();
    },
    async ensureMcpOnly() { events.push('app.ensureMcpOnly'); return status(); },
    async configureSelector(...args) {
      assert.equal(args.length, 0, 'the selector needs nothing from a second runtime');
      events.push('app.configure-selector');
      return { ok: true, configured: true };
    },
    async configureChannel(channel) { events.push('app.channel:' + channel); return { ok: true, chatgpt_channel: channel }; },
    async loadContext() { return { ok: true }; },
  };
  const vpsState = { ready: vpsReady };
  const vpsResult = mcpUrl => ({ configured: true, conflict: false, running: vpsState.ready, ready: vpsState.ready, owned: true,
    mcpPort: Number(new URL(mcpUrl).port), forwardPort: Number(new URL(mcpUrl).port), portMatches: true,
    lastError: vpsState.ready ? null : { message: 'Connection refused', at: '2026-10-04T10:00:00.000Z' },
    connector: 'https://vps.example/mcp/…/mcp' });
  const vpsTunnel = vps || vpsThrows ? {
    async apply(mcpUrl) { events.push('vps.apply:' + mcpUrl); if (vpsThrows) throw new Error('launchctl недоступен'); return vpsResult(mcpUrl); },
    async status(mcpUrl) { events.push('vps.status:' + mcpUrl); return vpsResult(mcpUrl); },
  } : null;
  const switcher = new MacRuntimeSwitcher({ appServerRuntime, vpsTunnel, homeDir: path.join(root, 'home'), uid: 123,
    launchAgentDir: path.join(root, 'LaunchAgents'),
    execute: async (file, args) => {
      if (file === '/bin/ps') {
        if (!processTable) throw new Error('ps is not available');
        return { stdout: processTable(), stderr: '' };
      }
      if (file === '/bin/kill') { events.push('kill:' + args.join(' ')); return { stdout: '', stderr: '' }; }
      events.push('launchctl.' + args[0] + ':' + args[1]);
      return { stdout: '', stderr: '' };
    } });
  return { events, switcher, appServerRuntime, state, vpsState };
}

test('CodexAppServerRuntime copies release source into stable private state', async t => {
  const root = await temporary(t, 'web-pilot-runtime-source-');
  const source = path.join(root, 'resource');
  const state = path.join(root, 'state');
  await fs.mkdir(path.join(source, '__pycache__'), { recursive: true });
  await fs.writeFile(path.join(source, 'control.py'), 'print("control")\n');
  await fs.writeFile(path.join(source, 'server.py'), 'print("server")\n');
  await fs.writeFile(path.join(source, '__pycache__', 'server.pyc'), 'cache');
  const runtime = new CodexAppServerRuntime({
    sourceDir: source, stateDir: state, sessionPlans: { loadContext() {} },
    execute: async () => { throw new Error('not used'); },
  });
  assert.equal(runtime.expectedServerName, MAC_RUNTIME_LABEL);
  const installed = await runtime.syncSource();
  assert.equal(installed, path.join(state, 'source'));
  assert.equal(await fs.readFile(path.join(installed, 'control.py'), 'utf8'), 'print("control")\n');
  await assert.rejects(fs.access(path.join(installed, '__pycache__', 'server.pyc')));
});

test('activation prepares the only macOS backend: login item, selector, channel, MCP and its tunnel', async t => {
  const root = await temporary(t, 'web-pilot-runtime-activate-');
  const f = fixture(root);
  const runtime = f.switcher.createRuntime(CHATGPT_CHANNEL_SECURE);
  assert.ok(runtime instanceof MacSelectedRuntime);
  assert.equal(runtime.activated, false);
  const result = await f.switcher.activate(runtime);
  assert.equal(result.runtime, runtime);
  assert.equal(result.legacyRetired, false, 'no cleanup unless it is asked for');
  assert.equal(runtime.activated, true);
  assert.equal(result.status.stable_tunnel_target, MCP_URL);
  assert.equal(result.status.chatgpt_channel, CHATGPT_CHANNEL_SECURE);
  assert.equal(result.status.tunnel.ready, true);
  assert.deepEqual(f.events, [
    'app.sync',
    'launchctl.disable:gui/123/' + APP_SERVER_LAUNCH_AGENT,
    'app.stop',
    'app.configure-selector',
    'app.channel:secure-tunnel',
    'app.ensureMcpOnly',
    'app.start:tunnel-only',
    'launchctl.enable:gui/123/' + APP_SERVER_LAUNCH_AGENT,
  ]);
  const plist = await fs.readFile(path.join(root, 'LaunchAgents', APP_SERVER_LAUNCH_AGENT + '.plist'), 'utf8');
  assert.match(plist, /RunAtLoad/);
  assert.match(plist, /selector-start/);
  assert.ok(plist.includes(f.appServerRuntime.installedSource));

  f.events.length = 0;
  await runtime.ensure();
  assert.deepEqual(f.events, ['app.ensureMcpOnly', 'app.status']);
  assert.equal(runtime.lastStatus.tunnel.ready, true);
  await assert.rejects(f.switcher.activate({ channel: CHATGPT_CHANNEL_SECURE }), TypeError);
  await assert.rejects(f.switcher.activate(runtime, { chatgptChannel: 'public' }), error => error.code === 'CHATGPT_CHANNEL_INVALID');
  assert.throws(() => f.switcher.createRuntime('public'), error => error.code === 'CHATGPT_CHANNEL_INVALID');
});

test('a Mac without a tunnel is a normal first run: the MCP starts and the tunnel is only reported', async t => {
  const root = await temporary(t, 'web-pilot-runtime-first-run-');
  const f = fixture(root, { tunnelConfigured: false });
  const runtime = f.switcher.createRuntime(CHATGPT_CHANNEL_SECURE);
  const result = await f.switcher.activate(runtime);
  assert.equal(f.events.includes('app.start:tunnel-only'), false);
  assert.equal(f.events.at(-1), 'launchctl.enable:gui/123/' + APP_SERVER_LAUNCH_AGENT);
  assert.equal(result.status.mcp.ready, true);
  assert.equal(result.status.tunnel.configured, false);
  assert.equal(runtime.activated, true);

  // The wizard starts the MCP alone; the full start names the missing tunnel instead of failing vaguely.
  const started = await runtime.control('start', { mcpOnly: true });
  assert.equal(started.mcp.ready, true);
  assert.equal(started.tunnel.ready, false);
  await assert.rejects(runtime.ensure(), error => error.code === 'TUNNEL_NOT_CONFIGURED');

  // Once the wizard has stored the tunnel, the same runtime brings it up.
  f.state.tunnelConfigured = true;
  const ready = await runtime.control('start');
  assert.equal(ready.tunnel.ready, true);
  assert.equal(ready.tunnel.configured, true);
});

test('a failed activation leaves the login item on and can simply be repeated', async t => {
  const root = await temporary(t, 'web-pilot-runtime-activate-fail-');
  const f = fixture(root, { tunnelStarts: false });
  const runtime = f.switcher.createRuntime(CHATGPT_CHANNEL_SECURE);
  await assert.rejects(f.switcher.activate(runtime), error => error.code === 'RUNTIME_NOT_READY');
  assert.equal(runtime.activated, false);
  assert.equal(f.events.at(-1), 'launchctl.enable:gui/123/' + APP_SERVER_LAUNCH_AGENT);
});

test('the services are prepared lazily, once the runtime is really used', async t => {
  const root = await temporary(t, 'web-pilot-runtime-lazy-');
  const f = fixture(root);
  let prepared = 0;
  const runtime = f.switcher.createRuntime(CHATGPT_CHANNEL_SECURE, async () => { prepared++; });
  assert.equal(prepared, 0, 'creating the runtime touches nothing');
  await runtime.control('status');
  assert.equal(prepared, 0, 'a status question installs nothing');
  await runtime.ensure();
  await runtime.control('start', { mcpOnly: true });
  await runtime.loadContext('/Projects/Мой проект');
  await runtime.setChannel(CHATGPT_CHANNEL_SECURE);
  assert.equal(prepared, 4, 'each use asks the idempotent preparation');
  const failing = f.switcher.createRuntime(CHATGPT_CHANNEL_SECURE,
    async () => { throw Object.assign(new Error(CODEX_NOT_FOUND_MESSAGE), { code: 'MAC_CODEX_NOT_FOUND' }); });
  f.events.length = 0;
  await assert.rejects(failing.ensure(), error => error.code === 'MAC_CODEX_NOT_FOUND');
  assert.deepEqual(f.events, [], 'nothing is started when the preparation fails');
});

test('VPS channel never starts tunnel-client and the forward follows the MCP port', async t => {
  const root = await temporary(t, 'web-pilot-channel-vps-');
  const f = fixture(root, { vps: true });
  const runtime = f.switcher.createRuntime(CHATGPT_CHANNEL_SECURE);
  const app = await f.switcher.activate(runtime, { chatgptChannel: CHATGPT_CHANNEL_VPS });
  assert.equal(runtime.channel, CHATGPT_CHANNEL_VPS);
  assert.equal(f.events.includes('app.start:tunnel-only'), false);
  assert.ok(f.events.includes('app.channel:vps'));
  assert.ok(f.events.includes('vps.apply:' + MCP_URL));
  assert.equal(app.status.chatgpt_channel, CHATGPT_CHANNEL_VPS);
  assert.equal(app.status.tunnel.ready, true);
  assert.equal(app.status.tunnel_ui, null);
  assert.equal(app.status.vps.connector, 'https://vps.example/mcp/…/mcp');

  f.events.length = 0;
  await runtime.ensure();
  assert.deepEqual(f.events, ['app.ensureMcpOnly', 'vps.apply:' + MCP_URL]);
  f.events.length = 0;
  assert.equal((await runtime.control('status')).tunnel.ready, true);
  assert.deepEqual(f.events, ['app.status', 'vps.status:' + MCP_URL]);

  // An offline server does not block startup but blocks context delivery with a clear reason.
  f.vpsState.ready = false;
  const offline = await f.switcher.activate(runtime, { chatgptChannel: CHATGPT_CHANNEL_VPS });
  assert.equal(offline.status.tunnel.ready, false);
  await assert.rejects(runtime.ensure(), error => error.code === 'RUNTIME_NOT_READY' && /Connection refused/.test(error.message));
});

test('a failing VPS forward never breaks the Secure Tunnel channel', async t => {
  const root = await temporary(t, 'web-pilot-channel-secure-');
  const f = fixture(root, { vpsThrows: true });
  const runtime = f.switcher.createRuntime(CHATGPT_CHANNEL_SECURE);
  const app = await f.switcher.activate(runtime);
  assert.ok(f.events.includes('app.channel:secure-tunnel'));
  assert.ok(f.events.includes('app.start:tunnel-only'));
  assert.equal(app.status.chatgpt_channel, CHATGPT_CHANNEL_SECURE);
  assert.equal(app.status.tunnel.ready, true);
  assert.equal(app.status.vps.ready, false);
  assert.match(app.status.vps.error, /launchctl недоступен/);
  await runtime.ensure();
});

test('switching the ChatGPT channel stops or starts only tunnel-client', async t => {
  const root = await temporary(t, 'web-pilot-channel-switch-');
  const f = fixture(root, { vps: true });
  const runtime = f.switcher.createRuntime(CHATGPT_CHANNEL_SECURE);
  await f.switcher.activate(runtime);
  f.events.length = 0;
  const vps = await runtime.setChannel(CHATGPT_CHANNEL_VPS);
  assert.deepEqual(f.events, ['app.ensureMcpOnly', 'vps.apply:' + MCP_URL, 'app.channel:vps', 'app.stop:tunnel-only']);
  assert.equal(vps.tunnel.ready, true);
  assert.equal(runtime.channel, CHATGPT_CHANNEL_VPS);

  f.events.length = 0;
  const secure = await runtime.setChannel(CHATGPT_CHANNEL_SECURE);
  assert.deepEqual(f.events, ['app.ensureMcpOnly', 'vps.apply:' + MCP_URL, 'app.channel:secure-tunnel', 'app.status', 'app.start:tunnel-only']);
  assert.equal(secure.chatgpt_channel, CHATGPT_CHANNEL_SECURE);
  assert.equal(secure.tunnel_ui, TUNNEL_UI);
  assert.equal(secure.tunnel.ready, true);

  // VPS is refused while its tunnel is down; the Secure Tunnel stays selected.
  f.vpsState.ready = false;
  f.events.length = 0;
  await assert.rejects(runtime.setChannel(CHATGPT_CHANNEL_VPS), error => error.code === 'VPS_NOT_READY');
  assert.equal(f.events.some(event => event.startsWith('app.channel')), false);
  assert.equal(runtime.channel, CHATGPT_CHANNEL_SECURE);
  await assert.rejects(runtime.setChannel('public'), error => error.code === 'CHATGPT_CHANNEL_INVALID');
});

test('CodexAppServerRuntime passes the channel, the selector and the service scope to control.py', async t => {
  const root = await temporary(t, 'web-pilot-channel-control-');
  const source = path.join(root, 'resource');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'control.py'), '# control\n');
  const calls = [], environments = [];
  const status = { ok: true, mcp: { ready: true, owned: true }, tunnel: { ready: false, owned: false, configured: false }, mcp_url: MCP_URL };
  const runtime = new CodexAppServerRuntime({ sourceDir: source, stateDir: path.join(root, 'state'), sessionPlans: { loadContext() {} },
    uv: path.join(root, 'mac-tools', 'uv'), environment: { PATH: '/usr/bin' },
    execute: async (python, args, options) => {
      assert.equal(python, '/usr/bin/python3');
      assert.deepEqual(args.slice(0, 2), ['-B', path.join(root, 'state', 'source', 'control.py')]);
      calls.push(args.slice(2)); environments.push(options.env);
      if (args[2] === 'configure-channel') return { stdout: JSON.stringify({ ok: true, configured: true, chatgpt_channel: args[4] }) };
      if (args[2] === 'start') return { stdout: JSON.stringify(status) };
      return { stdout: JSON.stringify({ ok: true, services: [{ service: 'tunnel', stopped: true }] }) };
    } });
  runtime.client = { connected: true };
  assert.equal((await runtime.configureChannel(CHATGPT_CHANNEL_VPS)).chatgpt_channel, CHATGPT_CHANNEL_VPS);
  await runtime.control('stop', { tunnelOnly: true });
  assert.deepEqual(runtime.client, { connected: true });
  await runtime.configureSelector();
  assert.equal((await runtime.control('start', { mcpOnly: true })).mcp_url, MCP_URL);
  assert.deepEqual(calls, [['configure-channel', '--channel', 'vps'], ['stop', '--tunnel-only'], ['configure-selector'], ['start', '--mcp-only']]);
  for (const environment of environments) {
    assert.equal(environment.WEB_PILOT_UV, path.join(root, 'mac-tools', 'uv'));
    assert.equal(environment.WEB_PILOT_CODEX_EXECUTOR_STATE_DIR, path.join(root, 'state'));
    assert.equal(environment.PYTHONDONTWRITEBYTECODE, '1');
  }
  await assert.rejects(runtime.configureChannel('public'), error => error.code === 'CHATGPT_CHANNEL_INVALID');
  await assert.rejects(runtime.control('configure-selector'), error => error.code === 'RUNTIME_ACTION_DENIED');
});

test('a Mac without Codex gets its own actionable message; other failures stay bounded', async t => {
  const root = await temporary(t, 'web-pilot-runtime-codex-');
  const source = path.join(root, 'resource');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'control.py'), '# control\n');
  let failure = { stdout: JSON.stringify({ ok: false, code: 'CODEX_NOT_FOUND', error: 'Codex executable not found' }), stderr: 'private stderr' };
  const runtime = new CodexAppServerRuntime({ sourceDir: source, stateDir: path.join(root, 'state'), sessionPlans: { loadContext() {} },
    execute: async () => { throw Object.assign(new Error('Command failed: private argv'), failure); } });
  await assert.rejects(runtime.control('setup'), error => error.code === 'MAC_CODEX_NOT_FOUND'
    && error.publicMessage === CODEX_NOT_FOUND_MESSAGE && error.message === CODEX_NOT_FOUND_MESSAGE);
  failure = { stdout: '', stderr: 'Traceback: private' };
  await assert.rejects(runtime.control('status'), error => error.code === 'APP_SERVER_RUNTIME_COMMAND_FAILED'
    && !/private/.test(error.message) && error.publicMessage === undefined);
});

test('the first-run wizard sees the executor as installed only after activation and setup', async t => {
  const root = await temporary(t, 'web-pilot-runtime-inspect-');
  const state = path.join(root, 'state');
  const runtime = new CodexAppServerRuntime({ sourceDir: path.join(root, 'resource'), stateDir: state,
    sessionPlans: { loadContext() {} }, execute: async () => { throw new Error('not used'); } });
  assert.deepEqual(await runtime.inspect(), { installed: false, attempted: false, folder: state });
  assert.equal(await runtime.prepared(), false);
  await fs.mkdir(path.join(state, 'runtime', 'venv', 'bin'), { recursive: true });
  await fs.writeFile(path.join(state, 'runtime', 'venv', 'bin', 'python'), '');
  assert.equal(await runtime.prepared(), false, 'tunnel-client is part of the setup');
  await fs.writeFile(path.join(state, 'runtime', 'tunnel-client'), '');
  assert.equal(await runtime.prepared(), true);
  assert.equal((await runtime.inspect()).installed, false, 'installed files alone do not mean running services');
  runtime.activationAttempted = true;
  assert.equal((await runtime.inspect()).attempted, true, 'a failed activation still lets the wizard read the status');
  runtime.activated = true;
  assert.equal((await runtime.inspect()).installed, true);
});

test('the tunnel is entered through the executor helper and its key never reaches argv', async t => {
  const root = await temporary(t, 'web-pilot-runtime-tunnel-');
  const source = path.join(root, 'resource');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'control.py'), '# control\n');
  await fs.writeFile(path.join(source, 'tunnel_prompt.py'), '# prompt\n');
  const helper = path.join(root, 'state', 'source', 'tunnel_prompt.py');
  const calls = [];
  const tunnelId = 'tunnel_' + 'a'.repeat(24);
  const runtime = new CodexAppServerRuntime({ sourceDir: source, stateDir: path.join(root, 'state'), sessionPlans: { loadContext() {} },
    execute: async (python, args) => { calls.push(['execute', python, ...args]); return { stdout: JSON.stringify({ ok: true, tunnel_id: tunnelId }) }; },
    executeInput: async (python, args, _options, input) => {
      calls.push(['input', python, ...args]);
      assert.deepEqual(JSON.parse(input), { tunnel_id: tunnelId, api_key: 'sk-fixture-secret' });
      return { stdout: JSON.stringify({ ok: true, configured: true }) };
    } });
  assert.deepEqual(await runtime.promptTunnelId(), { tunnelId });
  assert.deepEqual(await runtime.configureTunnel({ tunnelId, key: 'sk-fixture-secret' }), { configured: true });
  assert.deepEqual(calls, [['execute', '/usr/bin/python3', '-B', helper, '--tunnel-id'], ['input', '/usr/bin/python3', '-B', helper, '--stdin']]);
  assert.equal(JSON.stringify(calls).includes('sk-fixture-secret'), false);
  await assert.rejects(runtime.configureTunnel({ tunnelId: 5 }), error => error.code === 'MAC_TUNNEL_INVALID_DATA' && !!error.publicMessage);
});

test('the executor runtime adds its tool rules to the start message and no longer records the open project', async t => {
  const root = await temporary(t, 'web-pilot-start-rules-');
  const state = path.join(root, 'state');
  const runtime = new CodexAppServerRuntime({ sourceDir: path.join(root, 'resource'), stateDir: state,
    sessionPlans: { loadContext() {} }, execute: async () => { throw new Error('not used'); } });
  assert.equal(runtime.startupRules, EXECUTOR_TOOL_RULES);
  assert.equal(EXECUTOR_TOOL_RULES.length, 3);
  assert.match(EXECUTOR_TOOL_RULES[0], /rg в exec_command.*apply_patch/);
  assert.match(EXECUTOR_TOOL_RULES[1], /заблокировал вызов инструмента до выполнения.*один раз без изменений/);
  assert.match(EXECUTOR_TOOL_RULES[2], /не уводи в фон через & или nohup.*write_stdin.*не запускай команду повторно/);
  for (const name of ['contextDelivery', 'setActiveWorkspace', 'activeWorkspace']) assert.equal(runtime[name], undefined, name);
  await assert.rejects(fs.access(path.join(state, 'active-workspace.json')), { code: 'ENOENT' });

  const f = fixture(root);
  const selected = f.switcher.createRuntime(CHATGPT_CHANNEL_SECURE);
  assert.equal(selected.startupRules, EXECUTOR_TOOL_RULES);
  assert.equal(selected.contextDelivery, undefined);
  assert.equal(selected.setActiveWorkspace, undefined);
  const source = await fs.readFile(new URL('../src/mac-runtime-switch.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /active-workspace|workflow_context_recover/);
  assert.match(source, /requiredTools: EXECUTOR_REQUIRED_TOOLS/);
});

test('only processes named exactly by a retired runtime folder are stopped', async t => {
  const root = await temporary(t, 'web-pilot-runtime-legacy-processes-');
  const legacy = path.join(root, 'home', 'VSCODE', 'Codex Local Mac', 'mac-codex-local');
  const other = path.join(root, 'elsewhere', 'mac-codex-local');
  const executor = path.join(root, 'state', 'runtime', 'tunnel-client');
  const bridge = folder => `${path.join(folder, '.venv', 'bin', 'python3')} -B ${path.join(folder, 'mcp', 'bridge_mcp.py')} --config /tmp/bridge.json --port 17842`;
  const tunnel = folder => `${path.join(folder, 'tools', 'tunnel-client')} run --profile mac-local --profile-dir /tmp/profile`;
  let readings = 0;
  const f = fixture(root, { processTable: () => {
    readings++;
    return [
      `    1 /sbin/launchd`,
      ` 4201 ${bridge(legacy)}`,
      ` 4202 /usr/bin/python3 -m http.server 17843`,
      ` 4203 ${tunnel(legacy)}`,
      ` 4204 ${executor} run --profile codex-executor --profile-dir /tmp/profile`,
      ` 4205 ${tunnel(other)}`,
      // A PID reused between the two readings is never signalled.
      ` 4206 ${readings === 1 ? bridge(legacy) : '/usr/bin/vim notes.txt'}`,
      ` 4207 /bin/cat ${path.join(legacy, 'mcp', 'bridge_mcp.py')}`,
    ].join('\n') + '\n';
  } });
  assert.deepEqual(await f.switcher.stopLegacyProcesses([legacy]), [4201, 4203]);
  assert.deepEqual(f.events, ['kill:-TERM -4201', 'kill:-TERM -4203']);
  assert.equal(readings, 2);
  f.events.length = 0; readings = 0;
  assert.deepEqual(await f.switcher.stopLegacyProcesses([path.join(root, 'nothing-here')]), []);
  assert.equal(readings, 1, 'no candidates: no second reading and no signals');
  assert.deepEqual(f.events, []);
});

test('one-time cleanup removes what Web Pilot installed and keeps the folders of the user', async t => {
  const root = await temporary(t, 'web-pilot-runtime-legacy-cleanup-');
  const home = path.join(root, 'home'), dataDir = path.join(root, 'data');
  const installed = path.join(dataDir, 'runtime', 'Codex-Local-Mac');
  const userFolder = path.join(home, 'VSCODE', 'Codex Local Mac', 'mac-codex-local');
  const oldKey = path.join(home, 'Library', 'Application Support', 'CodexLocalMac', 'private', 'tunnel-key');
  const custom = path.join(root, 'custom-runtime');
  const plist = path.join(root, 'LaunchAgents', LEGACY_LAUNCH_AGENT + '.plist');
  const files = [path.join(installed, 'control.py'), path.join(dataDir, 'runtime', 'mac-runtime.json'),
    path.join(dataDir, 'runtime', '.mac-runtime-staging', 'part'), path.join(dataDir, 'settings.json'),
    path.join(userFolder, 'control.py'), oldKey, path.join(custom, 'control.py'), plist];
  for (const file of files) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'fixture\n'); }
  const customTunnel = `${path.join(custom, 'tools', 'tunnel-client')} run --profile mac-local`;
  const f = fixture(root, { processTable: () => ` 5101 ${customTunnel}\n` });

  const runtime = f.switcher.createRuntime(CHATGPT_CHANNEL_SECURE);
  const result = await f.switcher.activate(runtime, { retireLegacy: { dataDir, runtimeRoots: [custom, 'relative/ignored', null] } });
  assert.equal(result.legacyRetired, true);
  assert.deepEqual(f.events.slice(0, 5), [
    'app.sync',
    'launchctl.disable:gui/123/' + APP_SERVER_LAUNCH_AGENT,
    'kill:-TERM -5101',
    'launchctl.bootout:gui/123/' + LEGACY_LAUNCH_AGENT,
    'app.stop',
  ]);
  for (const removed of [installed, path.join(dataDir, 'runtime', 'mac-runtime.json'), path.join(dataDir, 'runtime', '.mac-runtime-staging'), plist])
    assert.equal(await exists(removed), false, removed);
  for (const kept of [path.join(dataDir, 'settings.json'), path.join(userFolder, 'control.py'), oldKey, path.join(custom, 'control.py')])
    assert.equal(await exists(kept), true, kept);
  await assert.rejects(f.switcher.retireLegacyRuntime({ dataDir: 'relative' }), TypeError);
});

test('a cleanup that cannot run never blocks the backend and is tried again', async t => {
  const root = await temporary(t, 'web-pilot-runtime-legacy-retry-');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(path.join(dataDir, 'runtime', 'Codex-Local-Mac'), { recursive: true });
  const f = fixture(root); // ps is not available here
  const runtime = f.switcher.createRuntime(CHATGPT_CHANNEL_SECURE);
  const result = await f.switcher.activate(runtime, { retireLegacy: { dataDir } });
  assert.equal(result.legacyRetired, false);
  assert.equal(result.status.tunnel.ready, true);
  assert.equal(runtime.activated, true);
  assert.equal(await exists(path.join(dataDir, 'runtime', 'Codex-Local-Mac')), true, 'nothing is removed while its processes may run');
});
