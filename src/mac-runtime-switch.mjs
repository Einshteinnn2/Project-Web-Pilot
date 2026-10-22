import { exists } from './common.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalMcpClient, RuntimeError, validateContextPacket } from './mcp-runtime.mjs';
import { executePrivateInput, runTunnelHelper } from './tunnel-setup.mjs';
import { defaultRuntimeFolder } from './platform.mjs';
import { retireLegacyWindowsRuntime } from './windows-runtime.mjs';

const execFile = promisify(execFileCallback);
// The only local MCP backend: the Codex App Server executor. Its MCP server names the system it runs on.
export const MAC_RUNTIME_LABEL = 'Codex App Server Local Mac';
export const WINDOWS_RUNTIME_LABEL = 'Codex App Server Local Windows';
export function runtimeLabel(platform = process.platform) {
  return platform === 'win32' ? WINDOWS_RUNTIME_LABEL : MAC_RUNTIME_LABEL;
}
export const APP_SERVER_LAUNCH_AGENT = 'com.oleynik.WebPilotCodexExecutor';
// The local runtime retired in 0.6.91. These names exist only to remove what earlier versions installed.
export const LEGACY_LAUNCH_AGENT = 'com.oleynik.CodexLocalMac';
const LEGACY_RUNTIME_FOLDER = 'Codex-Local-Mac';
// How ChatGPT reaches the MCP. The VPS tunnel itself runs whenever it is
// configured (Claude uses it too); the channel only decides whether tunnel-client runs.
export const CHATGPT_CHANNEL_SECURE = 'secure-tunnel';
export const CHATGPT_CHANNEL_VPS = 'vps';
export const CHATGPT_CHANNELS = Object.freeze([CHATGPT_CHANNEL_SECURE, CHATGPT_CHANNEL_VPS]);
// Session rules of the executor tools. They go into the start message next to the project context:
// the MCP server carries tools only and delivers neither rules nor context.
export const EXECUTOR_TOOL_RULES = Object.freeze([
  'Работа с инструментами: ищи через rg в exec_command; текстовые файлы правь через apply_patch и не перечитывай их после успешного патча.',
  'Если OpenAI заблокировал вызов инструмента до выполнения, повтори тот же вызов один раз без изменений; меняй или дроби его, только если повтор тоже заблокирован.',
  // Codex App Server ends the processes of a command when it returns: a shell background job dies at once.
  'Долгую команду не уводи в фон через & или nohup: исполнитель завершает процессы команды, когда она возвращается. Запускай её обычным exec_command; если вернулся session ID, опрашивай эту сессию через write_stdin с пустым вводом (до 60 с за опрос) и не запускай команду повторно.',
]);
// The executor catalogue has no context tool: Web Pilot needs only the status tool to recognise its own server.
const EXECUTOR_REQUIRED_TOOLS = Object.freeze(['bridge_status']);
export const CODEX_NOT_FOUND_MESSAGE = 'На этом Mac не найден Codex. Установите Codex CLI или приложение ChatGPT и нажмите «Проверить и продолжить».';
// The command is the one the Codex README gives for Windows.
export const WINDOWS_CODEX_NOT_FOUND_MESSAGE = 'На этом компьютере не найден Codex. Установите Codex CLI: откройте PowerShell и выполните команду  powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"  — затем нажмите «Проверить и продолжить».';

// The worker reports MAC_… or WINDOWS_… codes; the texts are the same on both systems.
const TUNNEL_SETUP_MESSAGES = {
  TUNNEL_ID_INVALID: 'Вставьте полный ID туннеля, начинающийся с tunnel_, и подтвердите ввод ещё раз.',
  TUNNEL_PROMPT_FAILED: 'Не удалось открыть окно ввода подключения. Обновите Web Pilot и повторите ввод. Данные подключения не сохранены.',
  TUNNEL_INVALID_DATA: 'Проверьте формат tunnel_id и ключа и повторите ввод. Данные подключения не сохранены.',
  TUNNEL_SETUP_FAILED: 'Не удалось завершить настройку подключения. Повторите ввод. Если ошибка повторяется, сообщите разработчику. Действующее подключение автоматически не заменяется.',
};
const tunnelSetupErrors = prefix => Object.fromEntries(Object.entries(TUNNEL_SETUP_MESSAGES).map(([code, message]) => [prefix + '_' + code, message]));

function vpsProblem(vps) {
  if (!vps?.configured) return 'Свой сервер для канала VPS не настроен.';
  if (vps.conflict) return 'В ~/.ssh/config у vps-mcp-tunnel остался RemoteForward: обновите настройку сервера.';
  if (vps.error) return vps.error;
  if (!vps.portMatches) return 'Туннель VPS ещё не переключён на текущий порт MCP.';
  return 'Туннель VPS не запущен' + (vps.lastError?.message ? ': ' + vps.lastError.message : '.');
}

function vpsAsTunnel(vps) {
  return { ready: !!vps?.ready, owned: true, configured: !!vps?.configured, running: !!vps?.running };
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export class CodexAppServerRuntime {
  // macOS runs control.py with the system Python and control.py builds the runtime environment itself.
  // Windows has no system Python: `bootstrap` (WindowsExecutorBootstrap) unpacks the tools of the package and
  // creates the private environment first, and its Python runs control.py.
  constructor({ sourceDir, platform = process.platform, stateDir = defaultRuntimeFolder(os.homedir(), platform),
    python = platform === 'win32' ? path.join(stateDir, 'runtime', 'venv', 'Scripts', 'python.exe') : '/usr/bin/python3',
    execute = execFile, executeInput = executePrivateInput, sessionPlans, environment = process.env,
    uv = null, bootstrap = null } = {}) {
    if (!sourceDir || !path.isAbsolute(sourceDir)) throw new TypeError('CodexAppServerRuntime requires an absolute sourceDir');
    if (!sessionPlans) throw new TypeError('CodexAppServerRuntime requires sessionPlans');
    this.sourceDir = sourceDir;
    this.platform = platform;
    this.windows = platform === 'win32';
    this.bootstrap = bootstrap;
    this.stateDir = stateDir;
    this.installedSource = path.join(stateDir, 'source');
    this.python = python;
    this.execute = execute;
    this.executeInput = executeInput;
    this.sessionPlans = sessionPlans;
    this.environment = { ...environment };
    this.uv = uv;
    this.expectedServerName = runtimeLabel(platform);
    this.client = null;
    this.pending = null;
    this.mcpOnlyPending = null;
    this.configurePending = null;
    this.lastStatus = null;
    // Set by MacRuntimeSwitcher.activate: until then nothing here may be assumed installed or running.
    this.activated = false;
    // Set when an activation has run its course, even unsuccessfully: the services may then be up
    // while tunnel-client is not (revoked key), and the wizard reads their status to offer the tunnel step.
    this.activationAttempted = false;
  }

  // The start message carries the full project context; these lines add the rules of the executor tools to it.
  get startupRules() { return EXECUTOR_TOOL_RULES; }

  // First-run wizard: the services may be asked for their status only after activation.
  async inspect() { return { installed: this.activated, attempted: this.activationAttempted, folder: this.stateDir }; }

  // True once setup has completed on this computer: the services then start in seconds, without downloads.
  async prepared() {
    const runtime = path.join(this.stateDir, 'runtime');
    if (this.windows) {
      return await exists(path.join(runtime, 'venv', 'Scripts', 'python.exe'))
        && await exists(path.join(runtime, 'tools', 'tunnel-client', 'tunnel-client.exe'));
    }
    return await exists(path.join(runtime, 'venv', 'bin', 'python')) && await exists(path.join(runtime, 'tunnel-client'));
  }

  async syncSource() {
    const stage = this.installedSource + '.stage-' + process.pid;
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await fs.rm(stage, { recursive: true, force: true });
    await fs.cp(this.sourceDir, stage, { recursive: true, filter: file => path.basename(file) !== '__pycache__' });
    await fs.rm(this.installedSource, { recursive: true, force: true });
    await fs.rename(stage, this.installedSource);
    return this.installedSource;
  }

  controlEnvironment() {
    return {
      ...this.environment,
      PYTHONDONTWRITEBYTECODE: '1',
      // Windows: the JSON of control.py may carry paths with non-ASCII user names.
      ...(this.windows ? { PYTHONUTF8: '1' } : {}),
      WEB_PILOT_CODEX_EXECUTOR_STATE_DIR: this.stateDir,
      // The packaged uv builds the venv on a Mac that has only the system Python.
      ...(this.uv ? { WEB_PILOT_UV: this.uv } : {}),
    };
  }

  #system() { return this.windows ? 'WINDOWS' : 'MAC'; }
  // Windows: no console window flashes behind the app.
  #hidden() { return this.windows ? { windowsHide: true } : {}; }

  // Runs one control.py command and returns its JSON; a failure carries the bounded message of control.py.
  async #controlCommand(args, { timeout = 20_000, code, fallback }) {
    const control = path.join(this.installedSource, 'control.py');
    // Idempotent and fast once done; its own errors carry the codes the first-run wizard explains.
    if (this.bootstrap) await this.bootstrap.ensure();
    let output;
    try {
      output = await this.execute(this.python, ['-B', control, ...args],
        { cwd: this.installedSource, timeout, maxBuffer: 2 * 1024 * 1024, env: this.controlEnvironment(), ...this.#hidden() });
    } catch (error) {
      let report = null;
      try { report = JSON.parse(error.stdout || error.stderr); } catch { /* bounded public error */ }
      if (report?.code === 'CODEX_NOT_FOUND') {
        const message = this.windows ? WINDOWS_CODEX_NOT_FOUND_MESSAGE : CODEX_NOT_FOUND_MESSAGE;
        throw Object.assign(new RuntimeError(this.#system() + '_CODEX_NOT_FOUND', message), { publicMessage: message });
      }
      throw new RuntimeError(code, report?.error ?? fallback);
    }
    let result;
    try { result = JSON.parse(output.stdout); } catch {
      throw new RuntimeError('RUNTIME_STATUS_INVALID', 'Codex App Server runtime вернул непонятный результат.');
    }
    if (result?.ok === false) throw new RuntimeError(code, String(result.error ?? fallback));
    return result;
  }

  async configureChannel(channel) {
    if (!CHATGPT_CHANNELS.includes(channel)) throw new RuntimeError('CHATGPT_CHANNEL_INVALID', 'Неизвестный канал ChatGPT.');
    if (!await exists(path.join(this.installedSource, 'control.py'))) await this.syncSource();
    const result = await this.#controlCommand(['configure-channel', '--channel', channel],
      { code: 'CHATGPT_CHANNEL_CONFIG_FAILED', fallback: 'Не удалось сохранить канал ChatGPT.' });
    if (result?.chatgpt_channel !== channel) throw new RuntimeError('CHATGPT_CHANNEL_CONFIG_FAILED', 'Канал ChatGPT не сохранён.');
    return result;
  }

  // Also carries the tunnel of the retired local runtime over once; control.py never prints its key.
  async configureSelector() {
    await this.syncSource();
    return this.#controlCommand(['configure-selector'],
      { code: 'APP_SERVER_SELECTOR_CONFIG_FAILED', fallback: 'Не удалось настроить стабильный MCP connector.' });
  }

  // Windows: the services start when the user signs in (a per-user Run entry written by control.py).
  // macOS keeps its LaunchAgent, which MacRuntimeSwitcher installs.
  async autostart(enabled) {
    if (!this.windows) throw new RuntimeError('RUNTIME_ACTION_DENIED', 'Эта операция не поддерживается оболочкой.');
    if (!await exists(path.join(this.installedSource, 'control.py'))) await this.syncSource();
    const result = await this.#controlCommand(['autostart', '--state', enabled ? 'on' : 'off'],
      { code: 'APP_SERVER_AUTOSTART_FAILED', fallback: 'Не удалось настроить запуск служб при входе в Windows.' });
    if (!!result?.autostart?.enabled !== !!enabled) throw new RuntimeError('APP_SERVER_AUTOSTART_FAILED', 'Запуск служб при входе в Windows не сохранён.');
    return result.autostart;
  }

  // Windows: the SSH forward of the user's server is kept by control.py; macOS keeps it with a LaunchAgent.
  async vpsControl(args) {
    if (!this.windows || !['vps-status', 'vps-apply', 'vps-stop'].includes(args?.[0])) {
      throw new RuntimeError('RUNTIME_ACTION_DENIED', 'Эта операция не поддерживается оболочкой.');
    }
    if (!await exists(path.join(this.installedSource, 'control.py'))) await this.syncSource();
    return this.#controlCommand(args, { timeout: 30_000, code: 'VPS_TUNNEL_COMMAND_FAILED', fallback: 'Не удалось выполнить команду туннеля VPS.' });
  }

  async control(command, { mcpOnly = false, tunnelOnly = false } = {}) {
    if (!['setup', 'status', 'start', 'stop', 'selector-start'].includes(command)) throw new RuntimeError('RUNTIME_ACTION_DENIED', 'Эта операция не поддерживается оболочкой.');
    if (!await exists(path.join(this.installedSource, 'control.py')) || command === 'setup') await this.syncSource();
    const result = await this.#controlCommand([command,
      ...(command === 'start' && mcpOnly ? ['--mcp-only'] : []),
      ...(['start', 'stop'].includes(command) && tunnelOnly ? ['--tunnel-only'] : [])],
    { timeout: command === 'setup' ? 10 * 60_000 : command === 'start' ? 90_000 : 20_000,
      code: 'APP_SERVER_RUNTIME_COMMAND_FAILED', fallback: 'Не удалось выполнить Codex App Server runtime.' });
    if (command === 'stop' || command === 'setup') {
      if (command === 'stop' && !tunnelOnly) { this.client = null; this.lastStatus = null; }
      return result;
    }
    if (!result?.mcp || !result?.tunnel || !result.mcp_url) throw new RuntimeError('RUNTIME_STATUS_INVALID', 'Codex App Server runtime вернул неполный status.');
    for (const service of [result.mcp, result.tunnel]) {
      if (service.running && !service.owned) throw new RuntimeError('RUNTIME_FOREIGN_PROCESS', 'Порт или процесс занят другой службой; автоматический запуск остановлен.');
    }
    this.lastStatus = result;
    return result;
  }

  promptTunnelId() { return this.configureTunnel(undefined, { idOnly: true }); }

  // Native dialogs or values from the wizard; the key reaches the worker only through its stdin.
  configureTunnel(credentials, { idOnly = false } = {}) {
    if (this.configurePending) return this.configurePending;
    this.configurePending = this.#configureTunnel(credentials, idOnly).finally(() => { this.configurePending = null; });
    return this.configurePending;
  }

  async #configureTunnel(credentials, idOnly) {
    const helper = path.join(this.installedSource, 'tunnel_prompt.py');
    if (!await exists(helper)) await this.syncSource();
    if (this.bootstrap) await this.bootstrap.ensure();
    return runTunnelHelper({
      python: this.python, helper, credentials, idOnly, execute: this.execute, executeInput: this.executeInput,
      options: { cwd: this.installedSource, timeout: 16 * 60 * 1000, maxBuffer: 64 * 1024, env: this.controlEnvironment(), ...this.#hidden() },
      errorPrefix: this.#system(), ErrorType: RuntimeError, errorMessages: tunnelSetupErrors(this.#system()),
    });
  }

  ensure() {
    if (this.pending) return this.pending;
    this.pending = this.prepare().finally(() => { this.pending = null; });
    return this.pending;
  }

  ensureMcpOnly() {
    if (this.mcpOnlyPending) return this.mcpOnlyPending;
    this.mcpOnlyPending = this.prepareMcpOnly().finally(() => { this.mcpOnlyPending = null; });
    return this.mcpOnlyPending;
  }

  // control.py says so itself where the files alone cannot tell (Windows: tunnel-client is there before setup).
  async #needsSetup(status) {
    return status.setup_complete === false || !await exists(status.runtime_python) || !await exists(status.tunnel_client);
  }

  async prepareMcpOnly() {
    let status = await this.control('status');
    if (await this.#needsSetup(status)) {
      await this.control('setup');
      status = await this.control('status');
    }
    if (!status.mcp.ready) status = await this.control('start', { mcpOnly: true });
    if (!status.mcp.ready || !status.mcp.owned) {
      throw new RuntimeError('RUNTIME_NOT_READY', 'Codex App Server MCP ещё не готов.');
    }
    this.client = new LocalMcpClient(status.mcp_url, { expectedServerName: this.expectedServerName, requiredTools: EXECUTOR_REQUIRED_TOOLS });
    const connection = await this.client.initialize();
    this.lastStatus = status;
    return { ...status, connection };
  }

  async prepare() {
    let status = await this.control('status');
    if (await this.#needsSetup(status)) {
      await this.control('setup');
      status = await this.control('status');
    }
    if (!status.tunnel.configured) {
      if (!status.mcp.ready) status = await this.control('start', { mcpOnly: true });
      throw new RuntimeError('TUNNEL_NOT_CONFIGURED', 'Codex App Server MCP готов, но его Secure MCP Tunnel ещё не настроен.');
    }
    if (!status.mcp.ready || !status.tunnel.ready) status = await this.control('start');
    if (!status.mcp.ready || !status.mcp.owned || !status.tunnel.ready || !status.tunnel.owned) {
      throw new RuntimeError('RUNTIME_NOT_READY', 'Codex App Server MCP или его tunnel ещё не готовы.');
    }
    this.client = new LocalMcpClient(status.mcp_url, { expectedServerName: this.expectedServerName, requiredTools: EXECUTOR_REQUIRED_TOOLS });
    const connection = await this.client.initialize();
    return { ...status, connection };
  }

  async loadContext(workspace) {
    return validateContextPacket(await this.sessionPlans.loadContext(workspace), workspace);
  }
}

// The runtime the rest of Web Pilot talks to: the App Server MCP plus the selected ChatGPT channel.
export class MacSelectedRuntime {
  constructor({ appServerRuntime, vpsTunnel = null, channel = CHATGPT_CHANNEL_SECURE, prepare = null }) {
    if (!appServerRuntime) throw new TypeError('MacSelectedRuntime requires appServerRuntime');
    this.appServerRuntime = appServerRuntime;
    this.vpsTunnel = vpsTunnel;
    this.channel = channel;
    // Idempotent one-time preparation (MacRuntimeSwitcher.activate). The object itself costs nothing to create,
    // so the app can start before the services are installed or even installable.
    this.prepare = typeof prepare === 'function' ? prepare : null;
    this.lastStatus = null;
  }

  get startupRules() { return this.appServerRuntime.startupRules ?? []; }
  get activated() { return !!this.appServerRuntime.activated; }

  // In the VPS channel the status "tunnel" is the VPS forward, so every readiness
  // check (startup, sidebar, settings) keeps working without a separate branch.
  combine(status, vps = null) {
    const viaVps = this.channel === CHATGPT_CHANNEL_VPS;
    const combined = {
      ...status,
      tunnel: viaVps ? vpsAsTunnel(vps) : status.tunnel,
      tunnel_ui: viaVps ? null : status.tunnel_ui ?? null,
      stable_tunnel_target: status.tunnel_target ?? null,
      chatgpt_channel: this.channel,
      vps,
    };
    this.lastStatus = combined;
    this.appServerRuntime.lastStatus = combined;
    return combined;
  }

  // The VPS forward must never break the Secure Tunnel channel.
  async applyVps(mcpUrl) {
    if (!this.vpsTunnel) return null;
    try { return await this.vpsTunnel.apply(mcpUrl); } catch (error) {
      return { configured: true, conflict: false, running: false, ready: false, owned: true, portMatches: false,
        error: String(error?.message ?? error).slice(0, 200), lastError: null, connector: null };
    }
  }

  async vpsStatus(mcpUrl) {
    if (!this.vpsTunnel) return null;
    try { return await this.vpsTunnel.status(mcpUrl); } catch { return null; }
  }

  async startStable() {
    let stable = await this.appServerRuntime.control('status');
    if (!stable.tunnel?.configured) throw new RuntimeError('TUNNEL_NOT_CONFIGURED', 'Локальный MCP готов, но Secure MCP Tunnel ещё не настроен.');
    if (!stable.tunnel?.ready) stable = await this.appServerRuntime.control('start', { tunnelOnly: true });
    if (!stable.tunnel?.ready || !stable.tunnel?.owned || !stable.tunnel?.configured) {
      throw new RuntimeError('RUNTIME_NOT_READY', 'Стабильный Secure MCP Tunnel ещё не готов.');
    }
    return stable;
  }

  async ready() { if (this.prepare) await this.prepare(); }

  async ensure() {
    await this.ready();
    const backend = await this.appServerRuntime.ensureMcpOnly();
    const vps = await this.applyVps(backend.mcp_url);
    if (this.channel === CHATGPT_CHANNEL_VPS) {
      const status = this.combine(backend, vps);
      if (!vps?.ready) throw new RuntimeError('RUNTIME_NOT_READY', vpsProblem(vps));
      return status;
    }
    return this.combine({ ...backend, ...await this.startStable() }, vps);
  }

  // First run: bring the MCP up and report the tunnel as it is, configured or not.
  async startMcpOnly() {
    await this.ready();
    const backend = await this.appServerRuntime.ensureMcpOnly();
    return this.combine(backend, await this.applyVps(backend.mcp_url));
  }

  async setChannel(channel) {
    if (!CHATGPT_CHANNELS.includes(channel)) throw new RuntimeError('CHATGPT_CHANNEL_INVALID', 'Неизвестный канал ChatGPT.');
    await this.ready();
    const backend = await this.appServerRuntime.ensureMcpOnly();
    const vps = await this.applyVps(backend.mcp_url);
    if (channel === CHATGPT_CHANNEL_VPS) {
      if (!vps?.ready) throw new RuntimeError('VPS_NOT_READY', vpsProblem(vps));
      await this.appServerRuntime.configureChannel(CHATGPT_CHANNEL_VPS);
      await this.appServerRuntime.control('stop', { tunnelOnly: true });
      this.channel = CHATGPT_CHANNEL_VPS;
      return this.combine(backend, vps);
    }
    await this.appServerRuntime.configureChannel(CHATGPT_CHANNEL_SECURE);
    this.channel = CHATGPT_CHANNEL_SECURE;
    return this.combine({ ...backend, ...await this.startStable() }, vps);
  }

  async control(command, { mcpOnly = false } = {}) {
    if (command === 'status') {
      const status = await this.appServerRuntime.control('status');
      return this.combine(status, await this.vpsStatus(status.mcp_url));
    }
    if (command === 'start') return mcpOnly ? this.startMcpOnly() : this.ensure();
    if (command === 'stop') {
      const stopped = await this.appServerRuntime.control('stop');
      this.lastStatus = null;
      return { ok: true, stable: stopped, backend: stopped };
    }
    throw new RuntimeError('RUNTIME_ACTION_DENIED', 'Эта операция не поддерживается оболочкой.');
  }

  async loadContext(workspace) {
    await this.ensure();
    return this.appServerRuntime.loadContext(workspace);
  }
}

export class MacRuntimeSwitcher {
  // legacyWindows: { controlFile, legacyStateDir, environment } — how to stop the bridge of Web Pilot before 0.6.96.
  constructor({ appServerRuntime, vpsTunnel = null, homeDir = os.homedir(), uid = typeof process.getuid === 'function' ? process.getuid() : 501,
    execute = execFile, launchAgentDir = null, platform = appServerRuntime?.platform ?? process.platform, legacyWindows = null } = {}) {
    if (!appServerRuntime) throw new TypeError('MacRuntimeSwitcher requires appServerRuntime');
    this.platform = platform;
    this.legacyWindows = legacyWindows;
    this.appServerRuntime = appServerRuntime;
    this.vpsTunnel = vpsTunnel;
    this.homeDir = homeDir;
    this.uid = uid;
    this.execute = execute;
    this.launchAgentDir = launchAgentDir ?? path.join(homeDir, 'Library/LaunchAgents');
    this.appServerLabel = APP_SERVER_LAUNCH_AGENT;
  }

  createRuntime(channel = CHATGPT_CHANNEL_SECURE, prepare = null) {
    if (!CHATGPT_CHANNELS.includes(channel)) throw new RuntimeError('CHATGPT_CHANNEL_INVALID', 'Неизвестный канал ChatGPT.');
    return new MacSelectedRuntime({ appServerRuntime: this.appServerRuntime, vpsTunnel: this.vpsTunnel, channel, prepare });
  }

  async ensureAppServerLaunchAgent() {
    await this.appServerRuntime.syncSource();
    await fs.mkdir(this.launchAgentDir, { recursive: true });
    const file = path.join(this.launchAgentDir, this.appServerLabel + '.plist');
    const control = path.join(this.appServerRuntime.installedSource, 'control.py');
    const stdout = path.join(this.appServerRuntime.stateDir, 'autostart.out.log');
    const stderr = path.join(this.appServerRuntime.stateDir, 'autostart.err.log');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(this.appServerLabel)}</string>
<key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>-B</string><string>${xml(control)}</string><string>selector-start</string></array>
<key>WorkingDirectory</key><string>${xml(this.appServerRuntime.installedSource)}</string>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>RunAtLoad</key><true/>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(stdout)}</string>
<key>StandardErrorPath</key><string>${xml(stderr)}</string>
</dict></plist>
`;
    await fs.writeFile(file + '.tmp', plist, { mode: 0o600 });
    await fs.rename(file + '.tmp', file);
    return file;
  }

  async setLaunchAgentEnabled(label, enabled) {
    const action = enabled ? 'enable' : 'disable';
    await this.execute('/bin/launchctl', [action, `gui/${this.uid}/${label}`], { timeout: 10_000, maxBuffer: 64 * 1024 });
  }

  async #processTable() {
    const { stdout = '' } = await this.execute('/bin/ps', ['-axo', 'pid=,command='],
      { timeout: 5_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
    const table = new Map();
    for (const line of stdout.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (match) table.set(Number(match[1]), match[2]);
    }
    return table;
  }

  // Signals only processes whose command line names the files of a retired runtime folder exactly,
  // and only when two consecutive readings agree (a recycled PID never matches twice).
  async stopLegacyProcesses(roots) {
    const matches = command => roots.some(root => {
      const python = path.join(root, '.venv', 'bin', 'python');
      const bridge = path.join(root, 'mcp', 'bridge_mcp.py');
      const tunnel = path.join(root, 'tools', 'tunnel-client');
      return (command.includes(python) && command.includes(' ' + bridge + ' ') && command.includes('--port '))
        || (command.startsWith(tunnel + ' ') && command.includes(' run ') && command.includes('--profile mac-local'));
    });
    const first = await this.#processTable();
    const candidates = [...first].filter(([pid, command]) => pid > 1 && matches(command));
    if (!candidates.length) return [];
    const second = await this.#processTable();
    const signalled = [];
    for (const [pid, command] of candidates) {
      if (second.get(pid) !== command) continue;
      try {
        await this.execute('/bin/kill', ['-TERM', `-${pid}`], { timeout: 5_000, maxBuffer: 64 * 1024 });
        signalled.push(pid);
      } catch { /* already gone, or not a group leader: nothing of ours to stop */ }
    }
    return signalled;
  }

  // One-time cleanup after the retired local runtime: its processes, its LaunchAgent and the copy
  // Web Pilot itself installed into its data folder. The user's own folders and the old tunnel key stay.
  // runtimeRoots are the runtime folders that earlier versions recorded in the settings.
  async retireLegacyRuntime({ dataDir, runtimeRoots = [] }) {
    if (!dataDir || !path.isAbsolute(dataDir)) throw new TypeError('retireLegacyRuntime requires an absolute dataDir');
    if (this.platform === 'win32') {
      if (!this.legacyWindows) throw new TypeError('retireLegacyRuntime on Windows requires legacyWindows');
      return retireLegacyWindowsRuntime({ dataDir, runtimeRoots, execute: this.execute, ...this.legacyWindows });
    }
    const installed = path.join(dataDir, 'runtime', LEGACY_RUNTIME_FOLDER);
    const roots = [...new Set([installed, ...runtimeRoots]
      .filter(root => typeof root === 'string' && path.isAbsolute(root)).map(root => path.resolve(root)))];
    const stopped = await this.stopLegacyProcesses(roots);
    try {
      await this.execute('/bin/launchctl', ['bootout', `gui/${this.uid}/${LEGACY_LAUNCH_AGENT}`], { timeout: 10_000, maxBuffer: 64 * 1024 });
    } catch { /* not loaded */ }
    await fs.rm(path.join(this.launchAgentDir, LEGACY_LAUNCH_AGENT + '.plist'), { force: true });
    for (const leftover of [installed, path.join(dataDir, 'runtime', 'mac-runtime.json'), path.join(dataDir, 'runtime', '.mac-runtime-staging')]) {
      await fs.rm(leftover, { recursive: true, force: true });
    }
    return { stopped, removed: installed };
  }

  // Prepares the services for this app run: source and start at login, selector and channel, the MCP itself and,
  // when a tunnel is configured, the tunnel. A computer without a tunnel is a normal first run, not an error.
  async activate(runtime, { chatgptChannel = runtime?.channel, retireLegacy = null } = {}) {
    if (!(runtime instanceof MacSelectedRuntime)) throw new TypeError('activate requires the runtime created by createRuntime');
    if (!CHATGPT_CHANNELS.includes(chatgptChannel)) throw new RuntimeError('CHATGPT_CHANNEL_INVALID', 'Неизвестный канал ChatGPT.');
    const app = this.appServerRuntime;
    const mac = this.platform === 'darwin';
    if (mac) {
      await this.ensureAppServerLaunchAgent();
      // The login item is switched off while the services are reconfigured, and back on whatever the outcome:
      // a failed start (no Codex yet, the tunnel is offline) must not cancel the start at the next login.
      await this.setLaunchAgentEnabled(this.appServerLabel, false);
    }
    let legacyRetired = false, combined;
    app.activationAttempted = true;
    try {
      if (retireLegacy) {
        // Cleanup must never keep the working backend from starting; it is simply tried again next time.
        try { await this.retireLegacyRuntime(retireLegacy); legacyRetired = true; } catch { /* retried on the next start */ }
      }

      const active = this.platform === 'win32' ? await app.control('status') : null;
      const reuse = active?.setup_complete === true && active.mcp?.ready === true && active.mcp?.owned === true
        && active.selector?.mode === 'app-server' && active.selector?.chatgpt_channel === chatgptChannel
        && active.selector?.mcp_url === active.mcp_url;
      if (!reuse) {
        await app.control('stop');
        await app.configureSelector();
        await app.configureChannel(chatgptChannel);
      }
      runtime.channel = chatgptChannel;

      const backend = await app.ensureMcpOnly();
      // The VPS forward follows the MCP port.
      const vps = await runtime.applyVps(backend.mcp_url);
      let status = backend;
      if (chatgptChannel === CHATGPT_CHANNEL_SECURE && backend.tunnel?.configured) {
        const stable = backend.tunnel?.running && backend.tunnel?.owned
          ? backend : await app.control('start', { tunnelOnly: true });
        if (!stable.tunnel?.ready || !stable.tunnel?.owned || !stable.tunnel?.configured) {
          throw new RuntimeError('RUNTIME_NOT_READY', 'Стабильный Secure MCP Tunnel ещё не готов.');
        }
        status = { ...backend, ...stable };
      }
      // tunnel-client was stopped above; in the VPS channel it stays stopped. An unready VPS
      // is reported in the status instead of blocking startup: the server may be offline.
      combined = runtime.combine(status, vps);
      // Windows: the Run entry only acts at sign-in, so it is written once the services have started and is
      // never switched off here; an earlier entry survives a failed start.
      if (this.platform === 'win32') await app.autostart(true);
    } finally {
      if (mac) await this.setLaunchAgentEnabled(this.appServerLabel, true);
    }
    app.activated = true;
    return { runtime, status: combined, legacyRetired };
  }
}
