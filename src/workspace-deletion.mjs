import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { readWorkspace, WorkspaceError, assignmentOwnership, ownedExecutor, workspaceGit } from './workspace-session.mjs';
import { diagnosticFiles, queueDiagnosticFile } from './common.mjs';
import { purgeProjectStateFiles } from './project-state-cleanup.mjs';

const fail = (code, message) => { throw new WorkspaceError(code, message); };
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const lstatOrNull = async file => { try { return await fs.lstat(file, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const same = (stat, expected) => stat?.isDirectory() && !stat.isSymbolicLink() && String(stat.dev) === expected.dev && String(stat.ino) === expected.ino;
const worktreeGroup = parent => path.join(path.dirname(parent), '.web-pilot-worktrees',
  createHash('sha256').update(parent).digest('hex').slice(0, 16));
const validIdentity = value => value && /^\d+$/.test(value.dev) && /^\d+$/.test(value.ino);
const validJournal = (job, name) => job && typeof job === 'object'
  && typeof job.id === 'string' && /^[0-9a-f-]{36}$/.test(job.id) && name === job.id + '.json'
  && typeof job.workspace === 'string' && path.isAbsolute(job.workspace)
  && path.normalize(job.workspace) === job.workspace
  && typeof job.projectId === 'string' && !!job.projectId
  && (job.parentWorkspace === undefined || typeof job.parentWorkspace === 'string' && path.isAbsolute(job.parentWorkspace)
      && typeof job.parentProjectId === 'string' && !!job.parentProjectId)
  && job.quarantine === path.join(path.dirname(job.workspace), '.web-pilot-delete-' + job.id)
  && ['confirmed', 'removing'].includes(job.stage)
  && typeof job.missing === 'boolean' && (job.missing ? job.identity === null : validIdentity(job.identity))
  && Array.isArray(job.sessionIds) && job.sessionIds.every(id => typeof id === 'string')
  && Array.isArray(job.related) && job.related.every(child =>
    child && typeof child.workspace === 'string' && path.isAbsolute(child.workspace)
    && path.normalize(child.workspace) === child.workspace
    && (child.projectId === undefined || typeof child.projectId === 'string' && !!child.projectId)
    && child.parentProjectId === job.projectId
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(child.id??'')
    && child.workspace === path.join(worktreeGroup(job.workspace),child.id)
    && (child.identity === undefined || validIdentity(child.identity))
    && Array.isArray(child.sessionIds) && child.sessionIds.every(id=>typeof id==='string'));

export class WorkspaceDeletion {
  constructor({ store, journalDir, protectedPaths = [], home = os.homedir(), prepare=async()=>{}, cleanup=async()=>{}, purgeState=purgeProjectStateFiles, git=workspaceGit }) {
    Object.assign(this, { store, journalDir, protectedPaths, home, prepare, cleanup, purgeState, git });
    this.tickets = new Map(); this.pending = new Set();
  }
  clear() { this.tickets.clear(); }
  isPending(workspace) { return this.pending.has(workspace); }
  record(workspace, projectId) {
    const project = this.store.snapshot().projects.find(p => p.workspace === workspace);
    if (!project?.archivedAt) fail('PROJECT_NOT_ARCHIVED', 'Удалить можно только проект из архива.');
    if (projectId && project.projectId !== projectId) fail('PROJECT_REPLACED', 'Запись проекта изменилась. Повторите проверку.');
    return project;
  }
  async guard(workspace) {
    if (!path.isAbsolute(workspace) || path.normalize(workspace) !== workspace || workspace === path.parse(workspace).root)
      fail('DELETE_PROTECTED', 'Эту папку нельзя удалить через Web Pilot.');
    const canonical = async value => fs.realpath(value).catch(() => path.resolve(value));
    const home = await canonical(this.home);
    if (within(home, workspace)) fail('DELETE_PROTECTED', 'Домашнюю папку нельзя удалить через Web Pilot.');
    for (const input of [this.journalDir, path.dirname(this.store.file), ...this.protectedPaths]) {
      const protectedPath = await canonical(input);
      if (within(protectedPath, workspace) || within(workspace, protectedPath)) fail('DELETE_PROTECTED', 'Папка используется приложением или локальными инструментами.');
    }
    for (const other of this.store.snapshot().projects) {
      if (other.workspace !== workspace && (within(other.workspace, workspace) || within(workspace, other.workspace)))
        fail('DELETE_NESTED_PROJECT', 'Вложенные проекты пересекаются с этой папкой. Сначала разберите их отдельно.');
    }
    const stat = await lstatOrNull(workspace);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(workspace) !== workspace))
      fail('DELETE_PATH_CHANGED', 'Путь больше не указывает на исходную папку проекта.');
    return stat;
  }
  async related(project) {
    const records=this.store.snapshot().projects.filter(p=>ownedExecutor(p,project));
    const assignments=path.join(project.workspace,'.git/workflow-kit/assignments');
    const candidates=new Map(records.map(p=>[p.workspace,{workspace:p.workspace,
      id:p.sessions.find(s=>s.assignmentId)?.assignmentId,projectId:p.projectId,
      parentProjectId:project.projectId,sessionIds:p.sessions.map(s=>s.sessionId)}]));
    for(const name of await fs.readdir(assignments).catch(e=>{if(e.code==='ENOENT'||e.code==='ENOTDIR')return [];throw e;})) {
      if(!/^[A-Za-z0-9_-]+\.json$/.test(name))continue;
      const a=JSON.parse(await fs.readFile(path.join(assignments,name),'utf8'));
      if(a.parent_root!==project.workspace)continue;
      if(!candidates.has(a.worktree)) {
        const saved=this.store.snapshot().projects.find(p=>p.workspace===a.worktree);
        if(saved&&saved.parentProjectId&& !ownedExecutor(saved,project))fail('DELETE_WORKTREE_CHANGED','Исполнитель принадлежит другой записи проекта.');
        candidates.set(a.worktree,{workspace:a.worktree,id:a.id,projectId:saved?.projectId,parentProjectId:project.projectId,
          legacyVerified:!!saved&&!saved.parentProjectId,sessionIds:saved?.sessions.map(s=>s.sessionId)??[]});
      }
    }
    const result=[];
    for(const item of candidates.values()) {
      const expected=path.join(worktreeGroup(project.workspace),item.id??'');
      if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(item.id??'')||item.workspace!==expected)
        fail('DELETE_WORKTREE_CHANGED','Путь исполнителя не подтверждён. Удаление остановлено.');
      const stat=await lstatOrNull(item.workspace);
      if(stat) {
        if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(item.workspace)!==item.workspace)
          fail('DELETE_WORKTREE_CHANGED','Путь исполнителя не подтверждён. Удаление остановлено.');
        const gitFile=await fs.readFile(path.join(item.workspace,'.git'),'utf8');
        const pointer=gitFile.trim().replace(/^gitdir: /,'');
        if(!gitFile.startsWith('gitdir: ')||!within(pointer,path.join(project.workspace,'.git/worktrees')))
          fail('DELETE_WORKTREE_CHANGED','Git исполнителя принадлежит другому проекту.');
        const binding=await assignmentOwnership(project,item.workspace,item.id,this.git);
        if(!binding)
          fail('DELETE_WORKTREE_CHANGED','Назначение исполнителя не соответствует удаляемому проекту.');
        const stdout=await this.git(item.workspace,['status','--porcelain']);
        if(stdout.trim()||binding.phase!=='INTEGRATED')fail('DELETE_WORKTREE_BUSY','У исполнителя осталась незавершённая работа. Сначала завершите её.');
        item.identity=identity(stat);
      } else {
        // A missing directory is not ownership proof. Check the durable parent
        // assignment and the original scope in Git before journaling it.
        const saved=this.store.snapshot().projects.find(p=>p.workspace===item.workspace);
        const sessions=saved?.sessions??[];
        const assigned=sessions.filter(s=>s.assignmentId);
        if(!saved||!ownedExecutor(saved,project)||!assigned.length
          ||assigned.some(s=>s.assignmentId!==item.id||s.parentWorkspace!==project.workspace
            ||s.parentProjectId!==project.projectId||!s.executionOriginSessionId
            ||!project.sessions.some(origin=>origin.sessionId===s.executionOriginSessionId)))
          fail('DELETE_WORKTREE_CHANGED','У отсутствующего исполнителя нет доказанной принадлежности.');
        let assignment;
        try {assignment=JSON.parse(await fs.readFile(path.join(assignments,item.id+'.json'),'utf8'));}
        catch {fail('DELETE_WORKTREE_CHANGED','Нет назначения удалённого исполнителя в Git родителя.');}
        if(assignment.id!==item.id||assignment.parent_root!==project.workspace||assignment.worktree!==item.workspace
          ||assignment.phase!=='INTEGRATED'||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(assignment.base_commit??'')
          ||assigned.some(s=>s.taskId!==assignment.parent_task_id||s.parentScopeId!==assignment.parent_scope_id))
          fail('DELETE_WORKTREE_CHANGED','Назначение отсутствующего исполнителя не подтверждено.');
        try {
          const source=await this.git(project.workspace,['show',assignment.base_commit+':.harness/plans/todo-plan.md']);
          const base=JSON.parse(source.match(/<!-- workflow-state:begin -->\s*```json\s*([\s\S]*?)```\s*<!-- workflow-state:end -->/)?.[1]??'');
          if(base.project_id!==project.projectId||base.scope_id!==assignment.parent_scope_id)throw Error('ownership');
        } catch {fail('DELETE_WORKTREE_CHANGED','Git не подтверждает исходный scope назначения.');}
        await this.verifyAbsent(item.workspace,null,project.workspace);
      }
      result.push(item);
    }
    return result;
  }
  async inspect(workspace) {
    const project = this.record(workspace);
    const stat = await this.guard(workspace);
    const related=await this.related(project),sessionIds=project.sessions.map(s=>s.sessionId);
    if (!stat) return { workspace, projectId: project.projectId, name: project.name, sessionCount: project.sessions.length, missing: true, bytes: 0, files: 0, fingerprint: 'missing', identity: null, related, sessionIds };
    const info = await readWorkspace(workspace);
    if (info.projectId !== project.projectId) fail('PROJECT_REPLACED', 'В этой папке теперь другой проект. Удаление остановлено.');
    const hash = createHash('sha256'); let bytes = 0, files = 0;
    const visit = async (file, relative) => {
      const item = await fs.lstat(file, { bigint: true });
      if (item.dev !== stat.dev) fail('DELETE_MOUNTED_FOLDER', 'Внутри проекта подключён другой диск. Сначала отключите его.');
      hash.update(JSON.stringify([relative, String(item.ino), String(item.mode), String(item.size), String(item.mtimeNs), String(item.ctimeNs)]));
      if (item.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name), path.join(relative, name));
      else { files++; bytes += Number(item.size); }
    };
    await visit(workspace, '');
    return { workspace, projectId: project.projectId, name: project.name, sessionCount: project.sessions.length, missing: false, bytes, files, fingerprint: hash.digest('hex'), identity: identity(stat), related, sessionIds };
  }
  async preview(workspace) {
    if (this.isPending(workspace)) fail('DELETE_PENDING', 'Завершите ранее подтверждённое удаление кнопкой «Повторить очистку».');
    const details = await this.inspect(workspace), token = randomUUID();
    this.clear(); this.tickets.set(token, details);
    const { fingerprint, identity: ignored, related: ignoredRelated, sessionIds: ignoredSessions, ...visible } = details;
    return { ...visible, token };
  }
  async apply(token, confirmation) {
    const expected = this.tickets.get(token);
    if (!expected) fail('DELETE_PREVIEW_EXPIRED', 'Откройте подтверждение удаления заново.');
    if (confirmation !== expected.name) fail('DELETE_CONFIRMATION', 'Введите точное имя проекта для подтверждения.');
    this.clear();
    const current = await this.inspect(expected.workspace);
    if (current.projectId !== expected.projectId || current.fingerprint !== expected.fingerprint || current.sessionCount !== expected.sessionCount || JSON.stringify(current.related)!==JSON.stringify(expected.related))
      fail('DELETE_PREVIEW_CHANGED', 'Проект изменился после проверки. Откройте подтверждение заново.');
    const id = randomUUID();
    const record=this.store.project(expected.workspace);
    const owner=record?.parentWorkspace?{parentWorkspace:record.parentWorkspace,parentProjectId:record.parentProjectId}:{};
    const job = { ...expected, ...owner, id, quarantine: path.join(path.dirname(expected.workspace), '.web-pilot-delete-' + id), stage: 'confirmed' };
    // A busy server or page has not admitted deletion. Do not leave an unusable confirmed journal.
    await this.prepare(job);
    await fs.mkdir(this.journalDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.jobFile(job), JSON.stringify(job), { mode: 0o600, flag: 'wx' });
    this.pending.add(job.workspace);
    await this.finish(job);
  }
  jobFile(job) { return path.join(this.journalDir, job.id + '.json'); }
  async saveJob(job) {
    const temporary = this.jobFile(job) + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(job), { mode: 0o600 }); await fs.rename(temporary, this.jobFile(job));
  }
  async purgeCopies(workspace, projectId) {
    // Every migration copy the store can create (v1–v5) may hold the project's URLs and attempts.
    for (const version of [1, 2, 3, 4, 5]) {
      const file = this.store.file + `.v${version}-backup`;
      if (!await lstatOrNull(file)) continue;
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Array.isArray(data.projects)) throw new Error('Не удалось очистить старую локальную копию списка проектов.');
      const before=data.projects.length,selected=data.selectedWorkspace;
      data.projects = data.projects.filter(p => p.workspace !== workspace
        || projectId && p.projectId!==projectId);
      if (data.selectedWorkspace === workspace && !data.projects.some(p=>p.workspace===workspace))
        data.selectedWorkspace = null;
      if(data.projects.length!==before||data.selectedWorkspace!==selected) {
        await fs.writeFile(file + '.tmp', JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); await fs.rename(file + '.tmp', file);
      }
    }
    const diagnostics=path.join(path.dirname(this.store.file),'diagnostics.jsonl');
    await queueDiagnosticFile(diagnostics,async()=>{
    for (const file of diagnosticFiles(diagnostics)) {
      if (!await lstatOrNull(file)) continue;
      const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
      const kept=lines.filter(line => {
        const row=JSON.parse(line);
        return row.workspace !== workspace || projectId && row.projectId && row.projectId!==projectId;
      });
      if(kept.length!==lines.length){
        await fs.writeFile(file + '.tmp', kept.length ? kept.join('\n') + '\n' : '', { mode: 0o600 }); await fs.rename(file + '.tmp', file);
      }
    }
    });
  }
  // ENOENT alone is ambiguous: the disk or mount point might have disappeared.
  // For an already removed worktree, its hashed group may be gone; its outer
  // .web-pilot-worktrees container must still be accessible on the original device.
  async verifyAbsent(workspace, expectedDev, parentWorkspace = null) {
    if (await lstatOrNull(workspace)) fail('DELETE_PATH_CHANGED', 'На месте удалённой папки появился другой каталог.');
    let anchor = path.dirname(workspace);
    const groupIsHashed=/^[a-f0-9]{16}$/.test(path.basename(anchor))
      && path.basename(path.dirname(anchor))==='.web-pilot-worktrees';
    if (groupIsHashed && (!parentWorkspace || anchor===worktreeGroup(parentWorkspace))
        && !await lstatOrNull(anchor)) anchor=path.dirname(anchor);
    const stat = await lstatOrNull(anchor);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()
        || await fs.realpath(anchor) !== anchor
        || expectedDev && String(stat.dev) !== expectedDev)
      fail('DELETE_SOURCE_UNAVAILABLE', 'Не удалось подтвердить доступность исходного тома и каталога. Очистка остановлена.');
    // An inaccessible but present mount/root is not proof that the child is gone.
    await fs.readdir(anchor);
    if (await lstatOrNull(workspace)) fail('DELETE_PATH_CHANGED', 'Исходный путь снова занят. Очистка остановлена.');
    return String(stat.dev);
  }
  async inspectOrphan({workspace,projectId}) {
    if(typeof workspace!=='string'||!path.isAbsolute(workspace)||path.normalize(workspace)!==workspace
      ||typeof projectId!=='string'||!projectId)fail('EXECUTOR_RECORD_CHANGED','Неверная запись исполнителя.');
    const saved=this.store.snapshot().projects,child=saved.find(p=>p.workspace===workspace);
    if(!child||child.projectId!==projectId)fail('EXECUTOR_RECORD_CHANGED','Исполнитель больше не соответствует выбранной записи.');
    const parentWorkspace=child.parentWorkspace,parentProjectId=child.parentProjectId;
    if(!parentWorkspace||!path.isAbsolute(parentWorkspace)
      ||path.normalize(parentWorkspace)!==parentWorkspace||!parentProjectId
      ||saved.some(p=>p.workspace===parentWorkspace)
      ||!child.sessions.length||!child.sessions.some(s=>s.assignmentId)
      ||child.sessions.some(s=>s.parentWorkspace!==parentWorkspace
        ||s.parentProjectId!==parentProjectId)
      ||child.sessions.filter(s=>s.assignmentId).some(s=>!s.executionOriginSessionId||!s.taskId||!s.parentScopeId
        ||!s.assignmentId.match(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/)
        ||workspace!==path.join(worktreeGroup(parentWorkspace),s.assignmentId)))
      fail('EXECUTOR_OWNER_UNCONFIRMED','Принадлежность исполнителя не подтверждена. Очистка запрещена.');
    const expected={workspace,projectId,parentWorkspace,parentProjectId,
      sessionIds:child.sessions.map(s=>s.sessionId)};
    await this.guard(parentWorkspace);
    await this.guard(workspace);
    if(this.isPending(workspace)||this.isPending(parentWorkspace))
      fail('DELETE_PENDING','Сначала завершите подтверждённое удаление родителя или исполнителя.');
    // A parent's related[] journal claims the child even if its own job does not.
    for(const name of await fs.readdir(this.journalDir).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
      if(!name.endsWith('.json'))continue;
      let job;
      try {job=JSON.parse(await fs.readFile(path.join(this.journalDir,name),'utf8'));}
      catch {fail('DELETE_PENDING','Журнал удаления не читается. Сначала восстановите его.');}
      if(!validJournal(job,name))fail('DELETE_PENDING','Есть неподтверждённый журнал удаления. Проверьте восстановление.');
      if(job.workspace===workspace||job.workspace===parentWorkspace
        ||job.related.some(item=>item.workspace===workspace))
        fail('DELETE_PENDING','Исполнитель указан в незавершённом журнале удаления.');
    }
    const volume=await this.verifyAbsent(parentWorkspace,null);
    await this.verifyAbsent(workspace,volume,parentWorkspace);
    return expected;
  }
  async clearOrphan(input,{checkBusy=async()=>{},cleanup=async()=>{},purgeState=this.purgeState}={}) {
    const expected=await this.inspectOrphan(input);
    await checkBusy(expected);
    // Recheck after potentially asynchronous command/activity checks and immediately
    // before removing any application-owned metadata; never remove a disk folder.
    const current=await this.inspectOrphan(input);
    if(JSON.stringify(current)!==JSON.stringify(expected))fail('EXECUTOR_RECORD_CHANGED','Запись исполнителя изменилась.');
    const identities=[{workspace:expected.workspace,projectId:expected.projectId,sessionIds:expected.sessionIds}];
    await cleanup({...expected,related:[]});
    await purgeState(path.dirname(this.store.file),identities);
    await this.purgeCopies(expected.workspace,expected.projectId);
    await this.store.removeTemporaries();
    const final=await this.inspectOrphan(input);
    if(JSON.stringify(final)!==JSON.stringify(expected))fail('EXECUTOR_RECORD_CHANGED','Условия очистки изменились.');
    await checkBusy(expected);
    await this.store.forgetOrphanExecutor(expected);
    return expected;
  }
  async finish(job) {
    const record = this.store.project(job.workspace);
    if (record && (!record.archivedAt || record.projectId !== job.projectId)) fail('DELETE_RECORD_CHANGED', 'Запись проекта изменилась. Автоматическая очистка остановлена.');
    if(record?.parentWorkspace&&job.parentWorkspace&&
        (job.parentWorkspace!==record.parentWorkspace||job.parentProjectId!==record.parentProjectId))
      fail('DELETE_RECORD_CHANGED','Родитель исполнителя изменился.');
    for(const child of job.related??[]) {
      const current=this.store.project(child.workspace);
      if(current&&(current.projectId!==child.projectId||current.parentWorkspace!==job.workspace
        ||current.parentProjectId&&current.parentProjectId!==job.projectId))
        fail('DELETE_RECORD_CHANGED','Запись исполнителя изменилась. Очистка остановлена.');
    }
    await this.prepare(job);
    await this.guard(job.workspace);
    let quarantined = await lstatOrNull(job.quarantine);
    if (quarantined && !same(quarantined, job.identity)) fail('DELETE_PATH_CHANGED', 'Папка удаления была заменена. Очистка остановлена.');
    const original = job.stage === 'confirmed' ? await lstatOrNull(job.workspace) : null;
    const metadataOnly = job.metadataOnly === true
      || job.stage === 'confirmed' && !quarantined && !original;
    if(job.metadataOnly && quarantined)fail('DELETE_PATH_CHANGED','В карантине появилась папка после подтверждённого отсутствия.');
    if (job.stage === 'confirmed' && job.missing && (original || quarantined))
      fail('DELETE_PATH_CHANGED', 'После подтверждения отсутствующей папки путь изменился.');
    if (metadataOnly) {
      await this.verifyAbsent(job.workspace, job.identity?.dev, job.parentWorkspace??record?.parentWorkspace);
      for (const item of job.related??[]) {
        const expected = path.join(worktreeGroup(job.workspace), item.id??'');
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(item.id??'') || item.workspace !== expected)
          fail('DELETE_WORKTREE_CHANGED', 'Путь исполнителя в журнале изменён.');
        await this.verifyAbsent(item.workspace, item.identity?.dev ?? job.identity?.dev, job.workspace);
      }
    } else if (!quarantined && job.stage === 'confirmed' && !job.missing) {
      if (!same(original, job.identity)) fail('DELETE_PATH_CHANGED', 'Исходная папка изменилась. Очистка остановлена.');
      const latest = await this.inspect(job.workspace);
      if (latest.fingerprint !== job.fingerprint) fail('DELETE_PREVIEW_CHANGED', 'Папка изменилась до удаления. Очистка остановлена.');
      await fs.rename(job.workspace, job.quarantine);
      quarantined = await lstatOrNull(job.quarantine);
      if (!same(quarantined, job.identity)) fail('DELETE_PATH_CHANGED', 'Папка изменилась во время удаления. Очистка остановлена.');
    }
    // After this durable stage, recovery only touches the renamed directory; a replacement at the old path is preserved.
    if(metadataOnly)job.metadataOnly = true;
    job.stage = 'removing'; await this.saveJob(job);
    if (quarantined) await fs.rm(job.quarantine, { recursive: true });
    for(const item of job.related??[]) {
      const expected=path.join(worktreeGroup(job.workspace),item.id??'');
      if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(item.id??'')||item.workspace!==expected)fail('DELETE_WORKTREE_CHANGED','Путь в журнале удаления не подтверждён.');
      const stat=await lstatOrNull(item.workspace);
      if(stat) {
        if(metadataOnly)fail('DELETE_WORKTREE_CHANGED','Папка исполнителя появилась после проверки. Очистка остановлена.');
        if(!item.identity||!same(stat,item.identity)||await fs.realpath(item.workspace)!==item.workspace)
          fail('DELETE_WORKTREE_CHANGED','Папка исполнителя была заменена. Очистка остановлена.');
        await fs.rm(item.workspace,{recursive:true});
      }
    }
    const group=worktreeGroup(job.workspace);
    if(!metadataOnly)await fs.rmdir(group).catch(e=>{if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(e.code))throw e;});
    else await this.verifyAbsent(job.workspace,job.identity?.dev,job.parentWorkspace??record?.parentWorkspace);
    const identities=[{workspace:job.workspace,projectId:job.projectId,sessionIds:job.sessionIds??[]},...(job.related??[])];
    await this.cleanup(job);
    await this.purgeState(path.dirname(this.store.file),identities);
    for(const item of identities)await this.purgeCopies(item.workspace,item.projectId);
    await this.store.removeTemporaries();
    await this.store.forgetDeletedProject(job.workspace, job.projectId, job.related);
    await fs.unlink(this.jobFile(job)); this.pending.delete(job.workspace);
  }
  async recover() {
    const errors = [];
    for (const name of await fs.readdir(this.journalDir).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      let job;
      try {
        job = JSON.parse(await fs.readFile(path.join(this.journalDir, name), 'utf8'));
        if (!validJournal(job,name)) throw new Error('Неверный журнал удаления.');
        this.pending.add(job.workspace); await this.finish(job);
      } catch (error) { errors.push({ workspace: job?.workspace, message: String(error.message), code: error.code ?? 'DELETE_RECOVERY_FAILED' }); }
    }
    return errors;
  }
}
