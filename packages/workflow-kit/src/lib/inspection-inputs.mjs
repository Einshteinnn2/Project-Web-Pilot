import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { VERSION, MANIFEST, CONFIG, PLAN, hash, check, safePath, readJSON } from './common.mjs';
import { git, gitPath } from './git.mjs';
import { listPlans } from './session-plans.mjs';
import { hooksDirectory, kitRoot } from './installation-files.mjs';
import { gitExecutable } from './platform.mjs';
import { planningPaths, projectFactPaths } from './project-facts.mjs';

const missing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';
function fileState(file) {
  try {
    const link = fs.lstatSync(file);
    const stat = link.isSymbolicLink() ? fs.statSync(file) : link;
    check(stat.isFile(), 'INSPECTION_INPUT', 'Ожидается обычный файл: ' + file);
    check(stat.size <= 16 * 1024 * 1024, 'INSPECTION_INPUT', 'Слишком большой вход проверки: ' + file);
    return [fs.realpathSync(file), link.mode & 0o777, stat.mode & 0o777, hash(fs.readFileSync(file))];
  } catch (error) { if (missing(error)) return null; throw error; }
}
function treeFiles(root, relative, files) {
  const directory = path.join(root, relative);
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (missing(error)) return; throw error; }
  for (const entry of entries) {
    check(!entry.isSymbolicLink(), 'INSPECTION_INPUT', 'Символическая ссылка во входах проверки: ' + entry.name);
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) treeFiles(root, name, files);
    else files.add(path.join(root, name));
    check(files.size <= 10000, 'INSPECTION_INPUT', 'Слишком много входов проверки.');
  }
}

// Shared by the trusted worker and full inspection. No project code is imported.
// Hash contents, including missing-file sentinels; timestamps are never a validity proof.
export function inspectionInputs(workspace, platform = process.platform) {
  const root = fs.realpathSync(workspace);
  const locations = git(root, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--shared-index-path']).stdout.trim().split('\n');
  const [gitDir, commonDir, sharedIndex] = locations;
  const index = gitPath(root, 'index');
  const status = git(root, ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']).stdout;
  const refs = git(root, ['for-each-ref', '--format=%(refname):%(objectname)']).stdout;
  const staged = git(root, ['ls-files', '--stage', '-z']).stdout;
  const config = git(root, ['config', '--null', '--show-origin', '--list']).stdout;
  const headResult = git(root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  const relative = new Set([PLAN, CONFIG, MANIFEST, '.codex/hooks.json', '.harness/plans/todo-plan.template.md',
    'scripts/workflow', 'scripts/workflow.cmd', 'scripts/workflow.mjs',
    'README.md', 'AGENTS.md', 'AGENTS.override.md', 'docs/architecture/OVERVIEW.md', '.harness/runtime/plan-review/state.json', ...planningPaths(root), ...projectFactPaths(root)]);
  const workflow = readJSON(path.join(root, CONFIG));
  if (workflow.documentation?.index) relative.add(workflow.documentation.index);
  for (const { file, plan } of listPlans(root)) {
    relative.add(file);
    for (const doc of plan.context_pack.documents) if ((doc.revision ?? 'WORKTREE') === 'WORKTREE') relative.add(doc.path);
    for (const task of plan.tasks) {
      for (const name of [...task.functional_paths, ...task.documentation_paths]) relative.add(name);
      for (const doc of task.context_pack?.documents ?? []) if ((doc.revision ?? 'WORKTREE') === 'WORKTREE') relative.add(doc.path);
    }
  }
  if (fs.existsSync(path.join(root, MANIFEST))) {
    for (const file of readJSON(path.join(root, MANIFEST)).required_documents ?? []) relative.add(file);
    for (const entry of readJSON(path.join(root, MANIFEST)).files) {
      if (entry.kind !== 'git-hook') relative.add(entry.path);
    }
  }
  // Foreign work appears only by name/status in recovery. Its contents are not
  // an input: do not reject an unrelated submodule, symlink or large untracked file.
  for (const name of [...relative]) {
    safePath(root, name);
    for (let directory = path.dirname(name); ; directory = path.dirname(directory)) {
      relative.add(path.join(directory, '.gitignore'));
      relative.add(path.join(directory, '.gitattributes'));
      if (directory === '.') break;
    }
  }
  const files = new Set([...relative].map(name => path.join(root, name)));
  const externalConfig = git(root, ['config', '--null', '--path', '--get-regexp', '^core\\.(attributesfile|excludesfile)$'], { allowFailure: true });
  const external = Object.fromEntries(externalConfig.stdout.split('\0').filter(Boolean).map(record => {
    const split = record.indexOf('\n'); return [record.slice(0, split).toLowerCase(), record.slice(split + 1)];
  }));
  const globalGit = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'git');
  files.add(external['core.attributesfile'] ? path.resolve(root, external['core.attributesfile']) : path.join(globalGit, 'attributes'));
  files.add(external['core.excludesfile'] ? path.resolve(root, external['core.excludesfile']) : path.join(globalGit, 'ignore'));
  treeFiles(root, '.harness/kit', files);
  // Include the trusted version used by this process, even during a source upgrade.
  treeFiles(kitRoot, '', files);
  const hookFolder = hooksDirectory(root).folder;
  for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push']) files.add(path.join(hookFolder, name));
  files.add(index);
  if (sharedIndex) files.add(path.resolve(root, sharedIndex));
  for (const name of ['HEAD', 'config.worktree', 'workflow-kit/transaction.json', 'workflow-kit/last-verification.json',
    'workflow-kit/installation.json', 'workflow-kit/recovery.json', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) files.add(path.join(gitDir, name));
  for (const name of ['config', 'shallow', 'info/grafts', 'info/attributes', 'info/exclude', 'objects/info/alternates']) files.add(path.join(commonDir, name));
  for (const name of ['rebase-merge', 'rebase-apply']) {
    check(!fs.existsSync(path.join(gitDir, name)), 'GIT_OPERATION_ACTIVE', 'Завершите текущую Git-операцию.');
  }
  files.add(path.join(root, '.harness/runtime/worktrees', hash(index).slice(0, 20), 'hook-acknowledgements.json'));
  const states = [...files].sort().map(file => [file, fileState(file)]);
  const transaction = Boolean(states.find(([file]) => file === path.join(gitDir, 'workflow-kit/transaction.json'))?.[1]);
  // Windows changes node.exe ctime during execution, even if its bytes are unchanged.
  // Hash the executable content instead of trusting mutable timestamps.
  // Stream in bounded chunks to avoid loading the entire runtime binary into memory.
  const executableHash = name => {
    const digest = createHash('sha256');
    const fd = fs.openSync(name, 'r');
    try {
      const chunk = Buffer.allocUnsafe(256 * 1024);
      let count;
      while ((count = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
        digest.update(chunk.subarray(0, count));
      }
    } finally { fs.closeSync(fd); }
    return digest.digest('hex');
  };
  const executableState = name => {
    try {
      const stat = fs.statSync(name, { bigint: true });
      const windowsNode = platform === 'win32' && path.basename(name).toLowerCase() === 'node.exe';
      const metadata = ['dev', 'ino', 'mode', 'size', 'mtimeNs', ...(windowsNode ? [] : ['ctimeNs'])]
        .map(key => String(stat[key]));
      return [name, fs.realpathSync(name), ...metadata, ...(windowsNode ? [executableHash(name)] : [])];
    } catch (error) { if (missing(error)) return [name, null]; throw error; }
  };
  const executables = [process.execPath, path.join(root, '.harness/runtime/node'), path.join(root, '.harness/runtime/node.exe'),
    path.join(root, '.harness/runtime/git/cmd/git.exe')];
  const gitBinary = gitExecutable(root);
  if (path.isAbsolute(gitBinary)) executables.push(gitBinary);
  const runtime = [...new Set(executables)].map(executableState);
  return { key: hash(JSON.stringify({ version: 1, kit: VERSION, root, gitDir, commonDir,
    head: headResult.status === 0 ? headResult.stdout.trim() : null, status, refs, staged, config, states, runtime })), transaction };
}
