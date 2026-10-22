import { sha256File } from '../src/common.mjs';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { BUNDLED_NODE_VERSION } from '../src/platform.mjs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { WINDOWS_RUNTIME_ARCHIVE, WINDOWS_RUNTIME_SHA256 } from '../src/windows-runtime.mjs';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NODE_VERSION = BUNDLED_NODE_VERSION;
export const NODE_ARCHIVE = `node-v${NODE_VERSION}-win-x64.zip`;
export const NODE_SHA256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541';
export const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}`;
export const NODE_FOLDER = `node-v${NODE_VERSION}-win-x64`;

// The pinned archive of Windows components (uv, tunnel-client, ripgrep, MinGit) is published with every GitHub Release next to the packages.
export const WINDOWS_RUNTIME_URL = `https://github.com/Einshteinnn2/Project-Web-Pilot/releases/download/v0.6.116/${WINDOWS_RUNTIME_ARCHIVE}`;

export function windowsRuntimeSourceCandidates(root = ROOT, environment = process.env) {
  return [...new Set([
    environment.WEB_PILOT_WINDOWS_RUNTIME_ARCHIVE,
    path.join(root, 'windows-app', 'resources', 'windows-payload', WINDOWS_RUNTIME_ARCHIVE),
  ].filter(Boolean))];
}

export function windowsToolchainPaths(root = ROOT) {
  const cacheDir = path.join(root, '.harness', 'runtime', 'windows-payload');
  const extractDir = path.join(root, '.harness', 'runtime', 'windows-node');
  return {
    cacheDir,
    archive: path.join(cacheDir, NODE_ARCHIVE),
    extractDir,
    nodeFolder: path.join(extractDir, NODE_FOLDER),
    nodeExe: path.join(extractDir, NODE_FOLDER, 'node.exe'),
    marker: path.join(extractDir, '.web-pilot-node.json'),
  };
}

// Order: verified build cache, a local copy named by the environment or the Windows build folder, then the release asset.
// Whatever the source, the archive is used only when its SHA-256 equals the pinned one.
export async function ensureWindowsRuntimePayload(root, cacheDir, { environment = process.env, fetchArchive = download,
  expectedSha256 = WINDOWS_RUNTIME_SHA256 } = {}) {
  const destination = path.join(cacheDir, WINDOWS_RUNTIME_ARCHIVE);
  let digest = null;
  try { digest = await sha256File(destination); } catch {}
  if (digest === expectedSha256) return { file: destination, sha256: digest, reused: true, downloaded: false };
  await fs.rm(destination, { force: true });
  for (const source of windowsRuntimeSourceCandidates(root, environment)) {
    try {
      if (await sha256File(source) !== expectedSha256) continue;
      await fs.copyFile(source, destination);
      if (await sha256File(destination) === expectedSha256) return { file: destination, sha256: expectedSha256, reused: false, downloaded: false };
    } catch {}
  }
  const manual = `Put ${WINDOWS_RUNTIME_ARCHIVE} at ${destination} or set WEB_PILOT_WINDOWS_RUNTIME_ARCHIVE.`;
  try { await fetchArchive(WINDOWS_RUNTIME_URL, destination); }
  catch (error) {
    await fs.rm(destination, { force: true });
    throw new Error(`The pinned archive of Windows components is missing and its download failed (${error.message}). ${manual}`);
  }
  let downloaded = null;
  try { downloaded = await sha256File(destination); } catch {}
  if (downloaded !== expectedSha256) {
    await fs.rm(destination, { force: true });
    throw new Error(`Downloaded archive of Windows components has SHA-256 ${downloaded ?? 'missing'}, expected ${expectedSha256}. ${manual}`);
  }
  return { file: destination, sha256: expectedSha256, reused: false, downloaded: true };
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Node download failed: HTTP ${response.status}`);
  const temporary = destination + '.download';
  await fs.rm(temporary, { force: true });
  const file = fsSync.createWriteStream(temporary, { mode: 0o600 });
  await new Promise(async (resolve, reject) => {
    file.on('error', reject); file.on('finish', resolve);
    try {
      for await (const chunk of response.body) if (!file.write(chunk)) await new Promise(r => file.once('drain', r));
      file.end();
    } catch (error) { file.destroy(error); }
  });
  await fs.rename(temporary, destination);
}

export function extractionCommand(platform, archive, destination) {
  if (platform === 'darwin') return { executable: '/usr/bin/ditto', args: ['-x', '-k', archive, destination], env: {} };
  if (platform === 'win32') return {
    executable: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      'Expand-Archive -LiteralPath $env:WEB_PILOT_NODE_ARCHIVE -DestinationPath $env:WEB_PILOT_NODE_DESTINATION -Force'],
    env: { WEB_PILOT_NODE_ARCHIVE: archive, WEB_PILOT_NODE_DESTINATION: destination },
  };
  return { executable: 'unzip', args: ['-q', archive, '-d', destination], env: {} };
}

export async function prepareWindowsToolchain({ root = ROOT, platform = process.platform, fetchArchive = download, run = execute } = {}) {
  const p = windowsToolchainPaths(root);
  await fs.mkdir(p.cacheDir, { recursive: true });
  const runtime = await ensureWindowsRuntimePayload(root, p.cacheDir, { fetchArchive });
  let digest = null;
  try { digest = await sha256File(p.archive); } catch {}
  if (digest !== NODE_SHA256) {
    await fs.rm(p.archive, { force: true });
    const packagedNode = path.join(root, 'windows-app', 'resources', 'windows-payload', NODE_ARCHIVE);
    try {
      if (await sha256File(packagedNode) === NODE_SHA256) await fs.copyFile(packagedNode, p.archive);
    } catch {}
    try { digest = await sha256File(p.archive); } catch { digest = null; }
    if (digest !== NODE_SHA256) {
      await fetchArchive(NODE_URL, p.archive);
      digest = await sha256File(p.archive);
    }
  }
  if (digest !== NODE_SHA256) throw new Error(`Node payload SHA-256 mismatch: ${digest ?? 'missing'}`);
  let marker = null;
  try { marker = JSON.parse(await fs.readFile(p.marker, 'utf8')); } catch {}
  if (marker?.sha256 !== NODE_SHA256 || !fsSync.existsSync(p.nodeExe)) {
    await fs.rm(p.extractDir, { recursive: true, force: true });
    await fs.mkdir(p.extractDir, { recursive: true });
    const command = extractionCommand(platform, p.archive, p.extractDir);
    await run(command.executable, command.args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...command.env }, windowsHide: true });
    if (!fsSync.existsSync(p.nodeExe)) throw new Error(`Portable Node extraction incomplete: ${p.nodeExe}`);
    await fs.writeFile(p.marker, JSON.stringify({ schemaVersion: 1, version: NODE_VERSION, sha256: NODE_SHA256 }, null, 2) + '\n');
  }
  return { ...p, sha256: NODE_SHA256, version: NODE_VERSION, runtimeArchive: runtime.file, runtimeSha256: runtime.sha256 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareWindowsToolchain().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
