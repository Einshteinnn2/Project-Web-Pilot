import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { exists, sha256File } from './common.mjs';
import { ZipError, extractZip, fileReader, zipEntries, zipEntryData } from './zip-archive.mjs';

const execFile = promisify(execFileCallback);
// The pinned archive of the Windows package. Since 0.6.96 only its vendor folder is used:
// uv, tunnel-client, ripgrep and MinGit for the Codex App Server executor and for Workflow Kit.
export const WINDOWS_RUNTIME_ARCHIVE = 'Windows-Codex-Local-2026-10-22.zip';
export const WINDOWS_RUNTIME_SHA256 = '0721b2e1a717ecbead8771aee1aa251401e53d5ab59f890b226eb8ed0cad9bb9';
const WINDOWS_RUNTIME_FOLDER = 'Windows-Codex-Local';
// Vendor archive id -> the name under which control.py of the executor reads the executable from tools.json.
export const WINDOWS_VENDOR_TOOLS = Object.freeze({ uv: 'uv', 'tunnel-client': 'tunnel_client', ripgrep: 'rg', git: 'git' });

class WindowsRuntimeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function windowsCommandFailureText(error, fallback = 'Windows runtime command failed') {
  for (const value of [error?.stderr, error?.stdout, error?.message]) {
    const text = String(value ?? '').trim();
    if (text) return text.slice(-1500);
  }
  return fallback;
}

// Where the executor keeps what Project Web Pilot unpacks for it; control.py reads the same marker.
export function windowsExecutorPaths(stateDir, api = path) {
  const runtime = api.join(stateDir, 'runtime');
  return { runtime, tools: api.join(runtime, 'tools'), marker: api.join(runtime, 'tools.json'),
    staging: api.join(runtime, 'tools.staging'), venv: api.join(runtime, 'venv'),
    python: api.join(runtime, 'venv', 'Scripts', 'python.exe') };
}

// Workflow Kit on Windows uses the MinGit of the package, never a Git found on PATH.
export function windowsWorkflowEnvironment(toolsDir, tools, environment = {}, api = path) {
  const gitHome = api.join(api.resolve(toolsDir), 'git');
  const git = api.join(gitHome, 'cmd', 'git.exe');
  if (!tools || typeof tools.git !== 'string' || api.resolve(tools.git).toLowerCase() !== git.toLowerCase()) {
    throw new WindowsRuntimeError('WINDOWS_GIT_LAYOUT_INVALID', 'Комплект Git не соответствует установленным компонентам Windows. Повторите подготовку.');
  }
  const oldPath = Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  return { WORKFLOW_GIT_BIN: git, WORKFLOW_GIT_HOME: gitHome,
    Path: [api.join(gitHome, 'cmd'), api.join(gitHome, 'usr', 'bin'), oldPath].filter(Boolean).join(';') };
}

// Prepares what the executor cannot prepare itself on Windows, where there is no system Python:
// the four vendor tools from the pinned archive and the private Python environment that runs control.py.
export class WindowsExecutorBootstrap {
  constructor({ payloadFile, stateDir, execute = execFile, environment = process.env, platform = process.platform,
    expectedSha256 = WINDOWS_RUNTIME_SHA256, onState = null } = {}) {
    if (!payloadFile || !stateDir) throw new TypeError('WindowsExecutorBootstrap requires payloadFile and stateDir');
    this.payloadFile = payloadFile;
    this.platform = platform;
    this.environment = environment;
    this.execute = execute;
    this.expectedSha256 = expectedSha256;
    this.paths = windowsExecutorPaths(stateDir);
    this.onState = typeof onState === 'function' ? onState : null;
    this.pending = null;
    this.toolsPending = null;
    this.state = { phase: platform === 'win32' ? 'embedded' : 'unavailable', installed: false, toolsReady: false, error: null };
  }

  snapshot() { return { ...this.state }; }

  #publish(next) {
    if (Object.entries(next).every(([key, value]) => this.state[key] === value)) return;
    this.state = { ...this.state, ...next };
    try { this.onState?.(this.snapshot()); } catch { /* a view error must not stop the preparation */ }
  }

  #requireWindows() {
    if (this.platform !== 'win32') throw new WindowsRuntimeError('WINDOWS_ONLY', 'Компоненты Windows доступны только в Windows-сборке.');
  }

  // The recorded executables, or null when the tools are not unpacked from this very archive.
  async #tools() {
    let marker;
    try { marker = JSON.parse((await fs.readFile(this.paths.marker, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
    if (marker?.schema_version !== 1 || marker.archive_sha256 !== this.expectedSha256 || !marker.tools) return null;
    const tools = {};
    for (const key of Object.values(WINDOWS_VENDOR_TOOLS)) {
      const file = marker.tools[key];
      if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
      const relative = path.relative(this.paths.tools, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !await exists(file)) return null;
      tools[key] = file;
    }
    return tools;
  }

  async inspect() {
    if (this.platform !== 'win32') return this.snapshot();
    const tools = await this.#tools();
    const installed = !!tools && await exists(this.paths.python);
    // A running preparation owns the phase; inspection only reports what is already on disk.
    if (!this.pending && !this.toolsPending) this.#publish({ phase: installed ? 'installed' : this.state.phase === 'error' ? 'error' : 'embedded',
      toolsReady: !!tools, installed });
    return { ...this.snapshot(), toolsReady: !!tools, installed };
  }

  // The vendor tools alone: enough for Workflow Kit (Git), needs no internet.
  ensureTools() {
    if (this.toolsPending) return this.toolsPending;
    this.toolsPending = this.#ensureTools().finally(() => { this.toolsPending = null; });
    return this.toolsPending;
  }

  // The tools and the private Python of the executor. The first run downloads Python and needs internet.
  ensure() {
    if (this.pending) return this.pending;
    this.pending = this.#ensure().finally(() => { this.pending = null; });
    return this.pending;
  }

  async #ensureTools() {
    this.#requireWindows();
    let tools = await this.#tools();
    if (tools) { this.#publish({ toolsReady: true }); return tools; }
    this.#publish({ phase: 'verifying', installed: false, toolsReady: false, error: null });
    try {
      let actual;
      try { actual = await sha256File(this.payloadFile); }
      catch { throw new WindowsRuntimeError('WINDOWS_RUNTIME_PAYLOAD_MISSING', 'В Windows-поставке отсутствует архив локальных компонентов.'); }
      if (actual !== this.expectedSha256) {
        throw new WindowsRuntimeError('WINDOWS_RUNTIME_PAYLOAD_DAMAGED', 'SHA-256 архива локальных компонентов Windows не совпадает с закреплённым.');
      }
      this.#publish({ phase: 'extracting' });
      tools = await this.#extract();
    } catch (error) {
      const failure = error instanceof WindowsRuntimeError ? error
        : new WindowsRuntimeError(error instanceof ZipError ? 'WINDOWS_RUNTIME_ARCHIVE_INVALID' : 'WINDOWS_RUNTIME_SETUP_FAILED',
          windowsCommandFailureText(error, 'Не удалось распаковать компоненты Windows.'));
      this.#publish({ phase: 'error', error: failure.code });
      throw failure;
    }
    this.#publish({ phase: 'embedded', toolsReady: true });
    return tools;
  }

  async #extract() {
    const { staging, tools: target, marker } = this.paths;
    const invalid = message => new WindowsRuntimeError('WINDOWS_RUNTIME_ARCHIVE_INVALID', message);
    const recorded = {};
    await fs.rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const reader = await fileReader(this.payloadFile);
    try {
      const entries = new Map((await zipEntries(reader)).map(entry => [entry.name, entry]));
      const vendor = name => {
        const entry = entries.get(`${WINDOWS_RUNTIME_FOLDER}/vendor/${name}`);
        if (!entry || entry.directory) throw invalid(`В архиве компонентов Windows нет файла vendor/${name}.`);
        return entry;
      };
      let manifest;
      try { manifest = JSON.parse((await zipEntryData(reader, vendor('manifest.json'))).toString('utf8').replace(/^\uFEFF/, '')); }
      catch (error) { throw error instanceof WindowsRuntimeError ? error : invalid('Список компонентов Windows в архиве повреждён.'); }
      if (manifest?.schema_version !== 1 || !Array.isArray(manifest.tools)) throw invalid('Список компонентов Windows имеет неизвестный формат.');
      for (const [id, key] of Object.entries(WINDOWS_VENDOR_TOOLS)) {
        const found = manifest.tools.filter(tool => tool?.id === id);
        const tool = found[0];
        if (found.length !== 1 || typeof tool.file !== 'string' || !/^[A-Za-z0-9._-]+\.zip$/.test(tool.file)
            || typeof tool.sha256 !== 'string' || typeof tool.executable !== 'string') throw invalid(`Компонент ${id} описан в архиве неверно.`);
        const archive = await zipEntryData(reader, vendor(tool.file));
        if (createHash('sha256').update(archive).digest('hex') !== tool.sha256.toLowerCase()) throw invalid(`SHA-256 компонента ${id} не совпадает со списком архива.`);
        const files = await extractZip(archive, path.join(staging, id));
        if (!files.includes(tool.executable)) throw invalid(`В компоненте ${id} нет исполняемого файла ${tool.executable}.`);
        recorded[key] = path.join(target, id, ...tool.executable.split('/'));
      }
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally { await reader.close(); }
    // The marker goes first and comes back last: an interrupted swap is simply repeated.
    await fs.rm(marker, { force: true });
    await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await fs.rename(staging, target);
    await fs.writeFile(marker + '.tmp', JSON.stringify({ schema_version: 1, archive_sha256: this.expectedSha256, tools: recorded }, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(marker + '.tmp', marker);
    return recorded;
  }

  async #ensure() {
    const tools = await this.ensureTools();
    if (!await exists(this.paths.python)) {
      this.#publish({ phase: 'installing', installed: false, error: null });
      try {
        // The same command control.py setup uses; --clear replaces what an interrupted attempt left.
        await this.execute(tools.uv, ['venv', '--clear', '--managed-python', '--python', '3.13', '--no-config', this.paths.venv], {
          timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
          env: { ...this.environment, UV_PYTHON_INSTALL_DIR: path.join(this.paths.runtime, 'python'), UV_CACHE_DIR: path.join(this.paths.runtime, 'uv-cache') },
        });
      } catch (error) {
        this.#publish({ phase: 'error', error: 'WINDOWS_RUNTIME_SETUP_FAILED' });
        throw new WindowsRuntimeError('WINDOWS_RUNTIME_SETUP_FAILED', windowsCommandFailureText(error, 'Не удалось подготовить Python для локальных инструментов Windows.'));
      }
      if (!await exists(this.paths.python)) {
        this.#publish({ phase: 'error', error: 'WINDOWS_RUNTIME_SETUP_INCOMPLETE' });
        throw new WindowsRuntimeError('WINDOWS_RUNTIME_SETUP_INCOMPLETE', 'Подготовка Python для локальных инструментов Windows завершилась без обязательных файлов.');
      }
    }
    this.#publish({ phase: 'installed', installed: true, toolsReady: true, error: null });
    return this.snapshot();
  }

  async workflowEnvironment() {
    const tools = await this.#tools();
    if (!tools) throw new WindowsRuntimeError('WINDOWS_RUNTIME_NOT_INSTALLED', 'Сначала подготовьте локальные компоненты Windows.');
    const environment = windowsWorkflowEnvironment(this.paths.tools, tools, this.environment);
    if (!await exists(path.join(environment.WORKFLOW_GIT_HOME, 'usr', 'bin', 'sh.exe')))
      throw new WindowsRuntimeError('WINDOWS_GIT_INCOMPLETE', 'Комплект Git неполон. Распакуйте всю Windows-поставку и повторите подготовку.');
    let version;
    try { version = await this.execute(environment.WORKFLOW_GIT_BIN, ['--version'], { timeout: 10000, windowsHide: true }); }
    catch { throw new WindowsRuntimeError('WINDOWS_GIT_START_FAILED', 'Не удалось запустить комплектный Git. Проверьте разрешение Windows на запуск и повторите подготовку.'); }
    if (!/^git version \d+\./.test(version.stdout)) throw new WindowsRuntimeError('WINDOWS_GIT_START_FAILED', 'Комплектный Git не подтвердил готовность.');
    return environment;
  }
}

// One-time cleanup after the bridge that Web Pilot ran on Windows before 0.6.96: its services, its start at
// sign-in and the copy Web Pilot itself unpacked into its data folder. Folders the user chose for the bridge
// and its state with the old tunnel key stay; the executor reads that key once and never writes there.
export async function retireLegacyWindowsRuntime({ dataDir, runtimeRoots = [], legacyStateDir = null, controlFile,
  execute = execFile, environment = process.env, api = path } = {}) {
  if (!dataDir || !api.isAbsolute(dataDir)) throw new TypeError('retireLegacyWindowsRuntime requires an absolute dataDir');
  if (!controlFile) throw new TypeError('retireLegacyWindowsRuntime requires the lifecycle script of the old bridge');
  const installed = api.join(dataDir, 'runtime', WINDOWS_RUNTIME_FOLDER);
  const recorded = [];
  if (legacyStateDir) {
    for (const name of ['mcp.pid.json', 'tunnel.pid.json']) {
      try {
        const record = JSON.parse(await fs.readFile(api.join(legacyStateDir, name), 'utf8'));
        if (typeof record?.package_root === 'string') recorded.push(record.package_root);
      } catch { /* no record: nothing was started from an unknown folder */ }
    }
  }
  const roots = [...new Map([installed, ...runtimeRoots, ...recorded]
    .filter(root => typeof root === 'string' && api.isAbsolute(root))
    .map(root => [api.resolve(root).toLowerCase(), api.resolve(root)])).values()];
  const stopped = [];
  for (const root of roots) {
    const python = api.join(root, '.venv', 'Scripts', 'python.exe');
    // Windows keeps the executable of a running process on disk: without this Python nothing of the folder runs.
    if (!await exists(python)) continue;
    // The lifecycle script of the old bridge stops only the processes it recorded itself, checked by identity.
    await execute(python, ['-B', controlFile, 'stop'], { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true,
      env: { ...environment, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', WEB_PILOT_RUNTIME_ROOT: root } });
    stopped.push(root);
  }
  const systemRoot = Object.entries(environment).find(([key]) => key.toLowerCase() === 'systemroot')?.[1] || 'C:\\Windows';
  try {
    await execute(api.join(systemRoot, 'System32', 'reg.exe'),
      ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'ProjectWebPilotMCP', '/f'],
      { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true });
  } catch { /* reg.exe fails when the value is already absent */ }
  for (const leftover of [installed, api.join(dataDir, 'runtime', 'windows-runtime.json'), api.join(dataDir, 'runtime', '.windows-runtime-staging')]) {
    await fs.rm(leftover, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return { stopped, removed: installed };
}
