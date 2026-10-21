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


// Windows-specific coverage retained when removing macOS-only tests.
test('Windows: the executor runs control.py with its private Python after the components of the package are prepared', { skip: process.platform !== 'win32' }, async t => {
  const root = await temporary(t, 'web-pilot-win-executor-');
  const source = path.join(root, 'resource'), stateDir = path.join(root, 'Local', 'WebPilotCodexExecutor');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'control.py'), '# control\n');
  await fs.writeFile(path.join(source, 'tunnel_prompt.py'), '# prompt\n');
  const python = path.join(stateDir, 'runtime', 'venv', 'Scripts', 'python.exe');
  const tunnelClient = path.join(stateDir, 'runtime', 'tools', 'tunnel-client', 'tunnel-client.exe');
  const events = [], calls = [];
  let setupComplete = false, codexMissing = false, autostart = true;
  const status = () => ({ ok: true, mcp: { ready: setupComplete, owned: setupComplete, running: setupComplete },
    tunnel: { ready: false, owned: false, configured: false }, mcp_url: MCP_URL, runtime_python: python, tunnel_client: tunnelClient, setup_complete: setupComplete });
  const bootstrap = { async ensure() {
    events.push('bootstrap.ensure');
    for (const file of [python, tunnelClient]) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'binary'); }
  } };
  const runtime = new CodexAppServerRuntime({ sourceDir: source, stateDir, platform: 'win32', bootstrap, sessionPlans: { loadContext() {} },
    environment: { Path: 'C:\\Windows\\System32' },
    execute: async (file, args, options) => {
      events.push('control.' + args.slice(2).join(' ')); calls.push({ file, args, options });
      if (codexMissing) throw Object.assign(new Error('Command failed'), { stdout: JSON.stringify({ ok: false, code: 'CODEX_NOT_FOUND', error: 'Codex is not installed' }) });
      if (args[2] === 'setup') { setupComplete = true; return { stdout: JSON.stringify({ ok: true, installed: true }) }; }
      if (args[2] === 'autostart') return { stdout: JSON.stringify({ ok: true, autostart: { enabled: autostart && args[4] === 'on', current: true } }) };
      return { stdout: JSON.stringify(status()) };
    } });
  assert.equal(runtime.expectedServerName, WINDOWS_RUNTIME_LABEL);
  assert.equal(runtimeLabel('win32'), 'Codex App Server Local Windows');
  assert.equal(runtimeLabel('darwin'), MAC_RUNTIME_LABEL);
  assert.equal(runtime.python, python);
  assert.equal(await runtime.prepared(), false);

  runtime.client = null;
  // Nothing listens on the test port: the lifecycle runs to the end and only the final handshake fails.
  await assert.rejects(runtime.prepareMcpOnly(), { code: 'MCP_UNAVAILABLE' });
  // tunnel-client is there before setup has ever run: control.py itself says that setup is still due.
  assert.deepEqual(events.slice(0, 6), ['bootstrap.ensure', 'control.status', 'bootstrap.ensure', 'control.setup', 'bootstrap.ensure', 'control.status']);
  assert.equal(await runtime.prepared(), true);
  for (const call of calls) {
    assert.equal(call.file, python);
    assert.deepEqual(call.args.slice(0, 2), ['-B', path.join(stateDir, 'source', 'control.py')]);
    assert.equal(call.options.windowsHide, true, 'no console window behind the app');
    assert.equal(call.options.env.PYTHONUTF8, '1');
    assert.equal(call.options.env.WEB_PILOT_CODEX_EXECUTOR_STATE_DIR, stateDir);
    assert.equal(call.options.env.WEB_PILOT_UV, undefined, 'uv comes from the components record, not from the app');
    assert.equal(call.options.env.Path, 'C:\\Windows\\System32');
  }

  events.length = 0;
  assert.deepEqual(await runtime.autostart(true), { enabled: true, current: true });
  assert.deepEqual(await runtime.autostart(false), { enabled: false, current: true });
  assert.deepEqual(events, ['bootstrap.ensure', 'control.autostart --state on', 'bootstrap.ensure', 'control.autostart --state off']);
  autostart = false;
  await assert.rejects(runtime.autostart(true), { code: 'APP_SERVER_AUTOSTART_FAILED' });

  codexMissing = true;
  await assert.rejects(runtime.control('setup'), error => error.code === 'WINDOWS_CODEX_NOT_FOUND'
    && error.publicMessage === WINDOWS_CODEX_NOT_FOUND_MESSAGE && /install\.ps1/.test(error.message));
  codexMissing = false;

  // The forward of the user's server is kept by control.py on Windows.
  events.length = 0;
  runtime.execute = async (file, args) => { events.push('control.' + args.slice(2).join(' ')); return { stdout: JSON.stringify({ ok: true, vps: { running: true } }) }; };
  assert.deepEqual((await runtime.vpsControl(['vps-apply', '--port', '27852'])).vps, { running: true });
  await runtime.vpsControl(['vps-status']); await runtime.vpsControl(['vps-stop']);
  assert.deepEqual(events.filter(event => event.startsWith('control.')), ['control.vps-apply --port 27852', 'control.vps-status', 'control.vps-stop']);
  for (const denied of [['vps-supervise'], ['stop'], [], undefined]) await assert.rejects(runtime.vpsControl(denied), { code: 'RUNTIME_ACTION_DENIED' });
  runtime.execute = async () => { throw Object.assign(new Error('failed'), { stdout: JSON.stringify({ ok: false, error: 'Recorded VPS tunnel PID belongs to another process' }) }); };
  await assert.rejects(runtime.vpsControl(['vps-status']), error => error.code === 'VPS_TUNNEL_COMMAND_FAILED' && /another process/.test(error.message));

  // The tunnel worker gets the same Python, a hidden window and WINDOWS_ codes.
  const helperCalls = [];
  runtime.execute = async (file, args, options) => { helperCalls.push({ file, args, options }); return { stdout: JSON.stringify({ tunnel_id: 'tunnel_fixture1234567890123456' }) }; };
  assert.deepEqual(await runtime.promptTunnelId(), { tunnelId: 'tunnel_fixture1234567890123456' });
  assert.deepEqual([helperCalls[0].file, helperCalls[0].args, helperCalls[0].options.windowsHide],
    [python, ['-B', path.join(stateDir, 'source', 'tunnel_prompt.py'), '--tunnel-id'], true]);
  runtime.execute = async () => { throw { stderr: JSON.stringify({ ok: false, code: 'WINDOWS_TUNNEL_PROMPT_FAILED' }) }; };
  await assert.rejects(runtime.promptTunnelId(), error => error.code === 'WINDOWS_TUNNEL_PROMPT_FAILED' && /окно ввода/.test(error.publicMessage));
  runtime.execute = async () => { throw { stderr: JSON.stringify({ ok: false, code: 'MAC_TUNNEL_PROMPT_FAILED' }) }; };
  await assert.rejects(runtime.promptTunnelId(), { code: 'WINDOWS_TUNNEL_SETUP_FAILED' }, 'a code of another system is not accepted');

  // A failure of the components step keeps its own code for the wizard.
  const broken = new CodexAppServerRuntime({ sourceDir: source, stateDir: path.join(root, 'other'), platform: 'win32', sessionPlans: { loadContext() {} },
    bootstrap: { async ensure() { throw Object.assign(new Error('no archive'), { code: 'WINDOWS_RUNTIME_PAYLOAD_MISSING' }); } },
    execute: async () => { throw new Error('control.py must not run without its Python'); } });
  await assert.rejects(broken.control('status'), { code: 'WINDOWS_RUNTIME_PAYLOAD_MISSING' });
});

test('Windows activation: no LaunchAgent, the previous bridge is retired first, start at sign-in is written after the services are up', { skip: process.platform !== 'win32' }, async t => {
  const root = await temporary(t, 'web-pilot-win-activate-');
  const f = fixture(root);
  f.appServerRuntime.platform = 'win32';
  f.appServerRuntime.autostart = async enabled => { f.events.push('app.autostart:' + enabled); return { enabled, current: true }; };
  const executed = [];
  const switcher = new MacRuntimeSwitcher({ appServerRuntime: f.appServerRuntime, homeDir: path.join(root, 'home'), launchAgentDir: path.join(root, 'LaunchAgents'),
    legacyWindows: { controlFile: '/app/resources/runtime-control/windows-control.py', legacyStateDir: path.join(root, 'no-legacy-state'), environment: { SystemRoot: '/Windows' } },
    execute: async (file, args) => { executed.push([path.basename(file), args[0]]); f.events.push('exec.' + path.basename(file)); return { stdout: '', stderr: '' }; } });
  assert.equal(switcher.platform, 'win32');
  const dataDir = path.join(root, 'data'), old = path.join(dataDir, 'runtime', 'Windows-Codex-Local');
  await fs.mkdir(path.join(old, '.venv', 'Scripts'), { recursive: true });
  await fs.writeFile(path.join(old, '.venv', 'Scripts', 'python.exe'), 'python');
  const runtime = switcher.createRuntime(CHATGPT_CHANNEL_SECURE);
  const result = await switcher.activate(runtime, { retireLegacy: { dataDir, runtimeRoots: [] } });
  assert.equal(result.legacyRetired, true);
  assert.equal(runtime.activated, true);
  assert.equal(result.status.tunnel.ready, true);
  assert.deepEqual(f.events, ['exec.python.exe', 'exec.reg.exe', 'app.stop', 'app.configure-selector', 'app.channel:secure-tunnel',
    'app.ensureMcpOnly', 'app.start:tunnel-only', 'app.autostart:true'], 'the old bridge stops before the tunnel is carried over and started');
  assert.deepEqual(executed, [['python.exe', '-B'], ['reg.exe', 'delete']]);
  assert.equal(await exists(old), false);
  assert.equal(await exists(path.join(root, 'LaunchAgents')), false, 'nothing of macOS is installed');

  // A failed start leaves an earlier sign-in entry alone; a failed cleanup is retried and never blocks the start.
  f.events.length = 0;
  f.appServerRuntime.ensureMcpOnly = async () => { throw Object.assign(new Error('no Codex'), { code: 'WINDOWS_CODEX_NOT_FOUND' }); };
  await assert.rejects(switcher.activate(switcher.createRuntime(CHATGPT_CHANNEL_SECURE)), { code: 'WINDOWS_CODEX_NOT_FOUND' });
  assert.deepEqual(f.events, ['app.stop', 'app.configure-selector', 'app.channel:secure-tunnel']);
  const noLegacy = new MacRuntimeSwitcher({ appServerRuntime: fixture(root).appServerRuntime, platform: 'win32', execute: async () => ({ stdout: '' }) });
  await assert.rejects(noLegacy.retireLegacyRuntime({ dataDir }), TypeError);
});
