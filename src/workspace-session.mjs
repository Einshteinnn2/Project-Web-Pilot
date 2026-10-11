import { exists, diagnosticFiles } from './common.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateParallelSettings } from './parallel-settings.mjs';
import {plannedExecution} from './execution-projection.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const executeGit=promisify(execFile);
export const workspaceGit=async(workspace,args)=>(await executeGit('git',['--no-optional-locks','-C',workspace,...args],
  {encoding:'utf8',timeout:10000,maxBuffer:1024*1024,windowsHide:true})).stdout.trim();

// A path alone is not ownership: legacy records need the assignment's committed parent identity.
export const ownedExecutor = (child,parent) => !!parent && !!child.parentProjectId
  && child.parentProjectId===parent.projectId && child.parentWorkspace===parent.workspace;
export async function assignmentOwnership(parent,workspace,id,git=workspaceGit) {
  try {
    if(!parent||!path.isAbsolute(workspace)||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id))return null;
    const folder=await fs.lstat(workspace);
    if(!folder.isDirectory()||folder.isSymbolicLink()||await fs.realpath(workspace)!==workspace)return null;
    const main=await readWorkspace(parent.workspace);
    if(main.projectId!==parent.projectId)return null;
    const pointerText=await fs.readFile(path.join(workspace,'.git'),'utf8');
    if(!pointerText.startsWith('gitdir: '))return null;
    const pointer=path.resolve(workspace,pointerText.trim().slice(8));
    const admin=path.join(parent.workspace,'.git/worktrees');
    if(!pointer.startsWith(admin+path.sep)||await fs.realpath(pointer)!==pointer)return null;
    const record=JSON.parse(await fs.readFile(path.join(parent.workspace,'.git/workflow-kit/assignments',id+'.json'),'utf8'));
    const bound=JSON.parse(await fs.readFile(path.join(pointer,'workflow-kit/assignment.json'),'utf8'));
    const fields=['id','parent_root','parent_scope_id','parent_task_id','worktree','base_commit','branch'];
    if(fields.some(k=>record[k]!==bound[k])||record.id!==id||record.parent_root!==parent.workspace
      ||record.worktree!==workspace||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(record.base_commit??''))return null;
    const stdout=await git(parent.workspace,['show',record.base_commit+':.harness/plans/todo-plan.md']);
    const base=JSON.parse(stdout.match(/<!-- workflow-state:begin -->\s*```json\s*([\s\S]*?)```\s*<!-- workflow-state:end -->/)?.[1]??'');
    return base.project_id===parent.projectId&&base.scope_id===record.parent_scope_id?record:null;
  }catch{return null;}
}

export class WorkspaceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function activeSessionsNewestFirst(sessions) {
  return sessions.map((session, index) => ({ session, index }))
    .filter(({ session }) => !session.archivedAt)
    .sort((a, b) => b.session.createdAt - a.session.createdAt || b.index - a.index)
    .map(({ session }) => session);
}

export function normalizeChatUrl(input) {
  if (typeof input !== 'string') return null;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.port || url.username || url.password) return null;
    // Chat and Work conversations may have different prefixes; bind only an actual conversation ID.
    const match = url.pathname.match(/^\/(?:c|work\/c|work|g\/[a-zA-Z0-9_-]+\/c)\/([a-zA-Z0-9_-]{8,})\/?$/);
    return match ? url.origin + url.pathname.replace(/\/$/, '') : null;
  } catch { return null; }
}

export function conversationExperience(input) {
  const normalized = normalizeChatUrl(input);
  if (!normalized) return null;
  const pathname = new URL(normalized).pathname;
  // Legacy inference only: before schema v4, /c/<id> meant Chat because experience was not persisted.
  return pathname.startsWith('/work/') ? 'work' : 'chat';
}

export function conversationUrlCompatibleWithExperience(input, experience) {
  const normalized = normalizeChatUrl(input);
  if (!normalized || !['chat', 'work'].includes(experience)) return false;
  const pathname = new URL(normalized).pathname;
  if (experience === 'chat') return !pathname.startsWith('/work/');
  // Production ChatGPT Work enters through /work/, but created Work conversations currently use shared /c/<id>.
  return pathname.startsWith('/work/') || /^\/c\/[a-zA-Z0-9_-]{8,}$/.test(pathname);
}

function sessionExperience(value) {
  if (!['chat', 'work'].includes(value)) throw new WorkspaceError('SESSION_EXPERIENCE', 'Выберите Chat или Work.');
  return value;
}

export async function readWorkspace(input, sessionId = null) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    throw new WorkspaceError('WORKSPACE_REQUIRED', 'Выберите папку проекта.');
  }
  let workspace;
  let text;
  try {
    workspace = await fs.realpath(input);
    text = await fs.readFile(path.join(workspace, '.harness/plans/todo-plan.md'), 'utf8');
    await fs.access(path.join(workspace, 'scripts/workflow.mjs'));
  } catch {
    throw new WorkspaceError('WORKFLOW_NOT_INSTALLED', 'В этой папке нет Workflow Kit. Выберите подготовленный проект.');
  }
  const block = text.match(/<!-- workflow-state:begin -->\s*```json\s*([\s\S]*?)```\s*<!-- workflow-state:end -->/);
  let plan;
  try { plan = JSON.parse(block?.[1] ?? ''); } catch {
    throw new WorkspaceError('WORKFLOW_PLAN_INVALID', 'Не удалось прочитать план выбранного проекта.');
  }
  if (plan.schema_version !== 1 || typeof plan.project_id !== 'string' || !plan.project_id
      || typeof plan.project_name !== 'string' || !Number.isSafeInteger(plan.plan_revision)
      || !Array.isArray(plan.tasks)) {
    throw new WorkspaceError('WORKFLOW_PLAN_INVALID', 'План проекта имеет неподдерживаемый формат.');
  }
  const scopeTitle = await readScopeTitle(workspace, plan);
  const view = projectPlan(plan, scopeTitle);
  return { workspace, ...view, inspectedSessionId: sessionId, planId: plan.scope_id,
    watchInputs: [...new Set([...(plan.context_pack?.documents ?? []),
      ...plan.tasks.flatMap(task => task.context_pack?.documents ?? [])]
      .map(document => document?.path).filter(file => typeof file === 'string'
        && /^docs\//.test(file) && !file.split(/[\\/]/).includes('..')))],
    originSessionId: null, preparedPlans: [], unassignedPlans: [] };
}

async function readScopeTitle(workspace, plan) {
  const documents = Array.isArray(plan.context_pack?.documents) ? plan.context_pack.documents : [];
  const candidates = documents.filter(document => document?.required === true && typeof document.path === 'string'
      && /^docs\/(?:planning|modules)\/[A-Za-z0-9._/-]+\.md$/i.test(document.path))
    .sort((a, b) => Number(!a.path.startsWith('docs/planning/')) - Number(!b.path.startsWith('docs/planning/')));
  for (const document of candidates) {
    const file = path.resolve(workspace, document.path);
    if (!file.startsWith(workspace + path.sep)) continue;
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    const heading = text.match(/^#\s+(.+?)\s*$/m)?.[1];
    if (heading) return sessionName(heading, { empty: 'У scope нет названия для сессии.' });
  }
  return '';
}

function projectPlan(plan, scopeTitle = '') {
  let planExecution = null;
  if (['parallel_allowed', 'max_workers', 'execution_strategy', 'execution_reason'].some(key => Object.hasOwn(plan, key))) {
    try {
      planExecution = { ...validateParallelSettings({ parallel_allowed: plan.parallel_allowed, max_workers: plan.max_workers }),
        execution_strategy: plan.execution_strategy, execution_reason: plan.execution_reason,
        ...(plan.execution_origin_session_id!==undefined?{execution_origin_session_id:plan.execution_origin_session_id}:{}) };
      if (!['sequential', 'parallel'].includes(planExecution.execution_strategy)
          || typeof planExecution.execution_reason !== 'string' || !planExecution.execution_reason.trim()
          || planExecution.execution_strategy === 'parallel' && (!planExecution.parallel_allowed || planExecution.max_workers < 2)) throw new Error('Invalid policy');
    } catch { throw new WorkspaceError('WORKFLOW_PLAN_INVALID', 'Некорректные параметры выполнения текущего плана.'); }
  }
  const tasks = plan.tasks.map(task => {
    if (!task || typeof task.id !== 'string' || !task.id || typeof task.title !== 'string' || !task.title
        || !['TODO', 'IN_PROGRESS', 'DONE'].includes(task.implementation_status)
        || !['PENDING', 'DONE'].includes(task.commit_status)) {
      throw new WorkspaceError('WORKFLOW_PLAN_INVALID', 'План проекта содержит некорректную микрозадачу.');
    }
    return { id: task.id, title: task.title, executionLabel:plannedExecution(task,plan.execution_strategy),
      status: task.commit_status === 'DONE' ? 'done' : task.implementation_status === 'IN_PROGRESS' ? 'current' : 'pending' };
  });
  const current = plan.tasks.find(t => t.id === plan.current_task_id)
    ?? plan.tasks.find(t => t.commit_status !== 'DONE');
  const completed = tasks.filter(task => task.status === 'done').length;
  const planState = plan.execution_scope_status === 'BLOCKED' ? 'blocked'
    : plan.execution_scope_status === 'ACTIVE' && plan.delivery_status === 'READY_FOR_ACCEPTANCE' && completed === tasks.length && tasks.length > 0 ? 'awaiting-acceptance'
      : plan.execution_scope_status === 'ACTIVE' ? 'working'
        : typeof plan.archived_scope_id === 'string' && plan.archived_scope_id ? 'closed' : 'not-created';
  return { projectId: plan.project_id, name: plan.project_name,
    planRevision: plan.plan_revision, scopeId: plan.scope_id, scopeTitle, objective: typeof plan.objective === 'string' ? plan.objective : '',
    scopeStatus: plan.execution_scope_status, deliveryStatus: plan.delivery_status, planExecution,
    archivedScopeId: typeof plan.archived_scope_id === 'string' ? plan.archived_scope_id : null,
    nextTaskId: current?.id ?? null, nextTaskTitle: current?.title ?? null,
    planView: { state: planState, completed, total: tasks.length, tasks,
      blockedReason: planState === 'blocked' && typeof plan.blocked_reason === 'string' ? plan.blocked_reason : null } };
}

const copy = value => structuredClone(value);
const persistent = data => JSON.parse(JSON.stringify(data, (key, value) => ['planView', 'preparedPlans', 'unassignedPlans', 'scopeTitle', 'watchInputs', 'planExecution'].includes(key) ? undefined : value));
const invalid = () => new WorkspaceError('SESSIONS_INVALID', 'Формат сохранённых проектов не поддерживается. Исходный файл сохранён.');
const sessionFields = ['planId', 'originSessionId', 'legacyPlanId', 'lastNamedScopeId', 'sessionId', 'experience', 'chatUrl', 'manualStart', 'attempt', 'receipt', 'title', 'titleSource', 'createdAt', 'lastOpenedAt', 'archivedAt', 'executionSnapshot'];
const explicitTitleSources = new Set(['manual', 'scope']);

function localName(value, { empty = 'Нужно непустое название.', code = 'TITLE_INVALID' } = {}) {
  if (typeof value !== 'string') throw new WorkspaceError(code, empty);
  const name = value.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!name) throw new WorkspaceError(code, empty);
  return name;
}

const SESSION_TITLE_MAX_CHARS = 80;
const SESSION_TITLE_MAX_BYTES = 200;
function sessionName(value, { empty = 'Нужно непустое название.', code = 'TITLE_INVALID' } = {}) {
  if (typeof value !== 'string') throw new WorkspaceError(code, empty);
  const normalized = value.replace(/\s+/g, ' ').trim();
  const result = []; let bytes = 0;
  for (const character of normalized) {
    const size = Buffer.byteLength(character, 'utf8');
    if (result.length >= SESSION_TITLE_MAX_CHARS || bytes + size > SESSION_TITLE_MAX_BYTES) break;
    result.push(character); bytes += size;
  }
  const name = result.join('').trim().replace(/[\s—–-]+$/u, '').trim();
  if (!name) throw new WorkspaceError(code, empty);
  return name;
}

function scopeSessionTitle(scopeTitle, objective) {
  const preferred = typeof scopeTitle === 'string' && scopeTitle.trim() ? scopeTitle : objective;
  return sessionName(preferred, { empty: 'У scope нет названия для сессии.' });
}

const validDuration = value => Number.isSafeInteger(value) && value >= 0;
const validAgentTime = value => typeof value === 'object' && !Array.isArray(value)
  && validDuration(value.totalMs) && validDuration(value.lastMs) && value.lastMs <= value.totalMs;

function validate(data) {
  if (data?.schemaVersion !== 6 || !Array.isArray(data.projects)) throw invalid();
  const urls = [], ids = [], workspaces = [];
  for (const p of data.projects) {
    if (!p || typeof p.workspace !== 'string' || !path.isAbsolute(p.workspace)
        || typeof p.projectId !== 'string' || !p.projectId || typeof p.name !== 'string'
        || (p.displayName !== undefined && p.displayName !== null && (typeof p.displayName !== 'string' || !p.displayName.trim()))
        || (p.lastNamedScopeId !== undefined && p.lastNamedScopeId !== null && (typeof p.lastNamedScopeId !== 'string' || !p.lastNamedScopeId))
        || !Array.isArray(p.sessions) || !p.sessions.length || typeof p.expanded !== 'boolean'
        || (p.archivedAt !== null && (!Number.isFinite(p.archivedAt) || p.archivedAt <= 0))
        || !p.sessions.some(s => s?.sessionId === p.selectedSessionId && s.archivedAt === null)
        || !p.sessions.some(s => s?.archivedAt === null)) throw invalid();
    if (p.scopeTransition !== undefined && p.scopeTransition !== null) {
      const transition = p.scopeTransition;
      if (typeof transition.scopeId !== 'string' || !transition.scopeId
          || !['watching', 'choice', 'opened'].includes(transition.state)
          || (transition.state === 'opened' ? typeof transition.sessionId !== 'string' || !transition.sessionId : transition.sessionId !== null))
        throw invalid();
    }
    workspaces.push(p.workspace);
    for (const s of p.sessions) {
      if (!s || typeof s.sessionId !== 'string' || !s.sessionId || typeof s.title !== 'string'
          || (s.titleSource !== undefined && s.titleSource !== null && !['page', 'manual', 'scope'].includes(s.titleSource))
          || !['chat', 'work'].includes(s.experience)
          || !Number.isFinite(s.createdAt) || !Number.isFinite(s.lastOpenedAt)
          || (s.archivedAt !== null && (!Number.isFinite(s.archivedAt) || s.archivedAt <= 0))
          || (s.chatUrl !== null && (!normalizeChatUrl(s.chatUrl) || normalizeChatUrl(s.chatUrl) !== s.chatUrl
            || !conversationUrlCompatibleWithExperience(s.chatUrl, s.experience)))) throw invalid();
      if (s.manualStart !== undefined && typeof s.manualStart !== 'boolean') throw invalid();
      if(s.assignmentId!==undefined) {
        if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(s.assignmentId)||typeof s.taskId!=='string'
          ||typeof s.parentScopeId!=='string'||typeof s.parentWorkspace!=='string'||!path.isAbsolute(s.parentWorkspace)
          ||typeof s.executionOriginSessionId!=='string'||p.parentWorkspace!==s.parentWorkspace
          ||(s.parentProjectId!==undefined&&(typeof s.parentProjectId!=='string'||s.parentProjectId!==p.parentProjectId)))throw invalid();
      }
      // Additive v6 field: missing means a legacy session, never today's Settings.
      if (s.executionSnapshot !== undefined) {
        try { validateParallelSettings(s.executionSnapshot); } catch { throw invalid(); }
      }
      if (s.agentTime !== undefined && s.agentTime !== null && !validAgentTime(s.agentTime)) throw invalid();
      if(s.executionTime!==undefined&&(!validDuration(s.executionTime?.activeMs)||!validDuration(s.executionTime?.waitingMs)))throw invalid();
      for (const key of ['planId','originSessionId','legacyPlanId','lastNamedScopeId']) {
        if (s[key] !== undefined && s[key] !== null && (typeof s[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(s[key]))) throw invalid();
      }
      ids.push(s.sessionId);
      if (s.chatUrl) urls.push(s.chatUrl);
    }
  }
  for (const values of [urls, ids, workspaces]) if (new Set(values).size !== values.length) throw invalid();
  return data;
}

function migrate(data) {
  if (data?.schemaVersion === 1 && Array.isArray(data.projects)) {
    data = { schemaVersion: 2, selectedWorkspace: data.selectedWorkspace, projects: data.projects.map(p => {
      if (!p || typeof p.sessionId !== 'string') throw invalid();
      const info = { ...p };
      for (const key of sessionFields) delete info[key];
      const time = p.attempt?.createdAtMs ?? p.lastOpenedAt ?? Date.now();
      return { ...info, expanded: false, selectedSessionId: p.sessionId,
        sessions: [{ sessionId: p.sessionId, chatUrl: p.chatUrl, attempt: p.attempt ?? null,
          receipt: p.receipt ?? null, title: p.title ?? '', createdAt: time, lastOpenedAt: p.lastOpenedAt ?? time }] };
    }) };
  }
  if (data?.schemaVersion === 2 && Array.isArray(data.projects)) {
    data = { ...data, schemaVersion: 3, projects: data.projects.map(p => ({ ...p, archivedAt: null })) };
  }
  if (data?.schemaVersion === 3 && Array.isArray(data.projects)) {
    data = { ...data, schemaVersion: 4, projects: data.projects.map(p => ({ ...p,
      sessions: p.sessions.map(session => ({ ...session, experience: conversationExperience(session.chatUrl) ?? 'chat' })) })) };
  }
  if (data?.schemaVersion === 4 && Array.isArray(data.projects)) data = { ...data, schemaVersion: 5, projects: data.projects.map(p => ({ ...p,
    sessions: p.sessions.map(session => ({ ...session, archivedAt: null })) })) };
  if (data?.schemaVersion !== 5 || !Array.isArray(data.projects)) throw invalid();
  return { ...data, schemaVersion: 6, projects: data.projects.map(project => {
    const candidates = new Map();
    for (const session of project.sessions) {
      const facts = session.attempt?.packet?.facts;
      if (['sent','acknowledged'].includes(session.attempt?.state) && facts?.project_id === project.projectId
          && typeof facts.scope_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(facts.scope_id)) {
        const list = candidates.get(facts.scope_id) ?? []; list.push(session.sessionId); candidates.set(facts.scope_id, list);
      }
    }
    const sessions = project.sessions.map(session => {
      const scopeId = session.attempt?.packet?.facts?.scope_id;
      const legacyPlanId = candidates.get(scopeId)?.length === 1 ? scopeId : null;
      return { ...session, planId: null, originSessionId: null, legacyPlanId,
        planBinding: legacyPlanId ? 'evidence' : scopeId ? 'unresolved' : 'none', lastNamedScopeId: null };
    });
    const { planView, preparedPlans, unassignedPlans, scopeTransition, ...info } = project;
    return { ...info, sessions };
  }) };

}

// Interrupted atomic writes leave whole copies of the store beside it, with project records in them.
// Only the store's own temporary names are touched: workspaces.json.tmp-*, .vN-backup.tmp and
// diagnostics.jsonl(.1).tmp*. Callers run this when none of their own writes is in flight.
export async function removeStoreTemporaries(storeFile) {
  const folder = path.dirname(storeFile), base = path.basename(storeFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const own = new RegExp(`^(?:${base}(?:\\.v[1-5]-backup)?|diagnostics\\.jsonl(?:\\.1)?)\\.tmp(?:-.+)?$`);
  let entries;
  try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !own.test(entry.name)) continue;
    await fs.rm(path.join(folder, entry.name), { force: true });
    removed++;
  }
  return removed;
}

async function writeJsonAtomic(file, data) {
  const temporary = file + '.tmp-session-archive';
  await fs.writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function purgeSessionCopies(storeFile, workspace, sessionId) {
  for (const version of [1, 2, 3, 4, 5]) {
    const file = storeFile + `.v${version}-backup`;
    if (!await exists(file, { strict: true })) continue;
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(data.projects)) throw new WorkspaceError('SESSION_LOCAL_CLEANUP', 'Не удалось очистить старую локальную копию сессий.');
    let projectRemoved = false;
    data.projects = data.projects.filter(project => {
      if (project.workspace !== workspace) return true;
      if (Array.isArray(project.sessions)) {
        project.sessions = project.sessions.filter(session => session.sessionId !== sessionId);
        if (project.selectedSessionId === sessionId) project.selectedSessionId = project.sessions[0]?.sessionId ?? null;
        if (!project.sessions.length) { projectRemoved = true; return false; }
        return true;
      }
      if (project.sessionId === sessionId) { projectRemoved = true; return false; }
      return true;
    });
    if (projectRemoved && data.selectedWorkspace === workspace && !data.projects.some(project => project.workspace === workspace)) data.selectedWorkspace = null;
    await writeJsonAtomic(file, data);
  }
  for (const diagnostics of diagnosticFiles(path.join(path.dirname(storeFile), 'diagnostics.jsonl'))) {
    if (!await exists(diagnostics, { strict: true })) continue;
    const lines = (await fs.readFile(diagnostics, 'utf8')).split('\n').filter(Boolean).filter(line => {
      const entry = JSON.parse(line);
      return !(entry.workspace === workspace && entry.sessionId === sessionId);
    });
    const temporary = diagnostics + '.tmp-session-archive';
    await fs.writeFile(temporary, lines.length ? lines.join('\n') + '\n' : '', { mode: 0o600 });
    await fs.rename(temporary, diagnostics);
  }
}

function currentView(project, sessionId = project?.selectedSessionId) {
  if (!project) return null;
  const { sessions, archivedAt: projectArchivedAt, ...info } = project;
  const session = sessions.find(s => s.sessionId === sessionId);
  if (!session) return null;
  return copy({ ...info, ...session, projectLastNamedScopeId: info.lastNamedScopeId ?? null,
    planId: info.scopeId ?? null, originSessionId: null,
    archivedAt: projectArchivedAt, sessionArchivedAt: session.archivedAt });
}

export class WorkspaceSessions {
  constructor(file, { inspect = readWorkspace, uuid = randomUUID, now = Date.now, planService = null,
    getExecutionSettings = () => validateParallelSettings(), git=workspaceGit } = {}) {
    Object.assign(this, { file, uuid, now, planService, getExecutionSettings, git });
    this.inspect = (workspace, sessionId = this.project(workspace)?.sessionId) => inspect(workspace, sessionId);
    this.saveTail = Promise.resolve();
    this.mutationTail = Promise.resolve();
    this.selectionGeneration = 0;
    this.data = { schemaVersion: 6, selectedWorkspace: null, projects: [] };
  }

  async load() {
    // One app instance owns the store, and nothing is written before load: leftovers are orphans.
    // Best effort here: a file locked by another program must not stop the app; deletion retries strictly.
    await removeStoreTemporaries(this.file).catch(() => 0);
    let text;
    try { text = await fs.readFile(this.file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return this.snapshot();
      throw error;
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw invalid(); }
    const legacy = [1, 2, 3, 4, 5].includes(parsed.schemaVersion);
    const data = validate(legacy ? migrate(parsed) : parsed);
    if (legacy) {
      try { await fs.writeFile(this.file + `.v${parsed.schemaVersion}-backup`, text, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    // Retire the optional estimate without keeping hashes/counts in normal session state.
    let removedEstimate = false;
    for (const project of data.projects) {
      for (const session of project.sessions) {
        if (Object.hasOwn(session, 'tokenEstimate')) {
          delete session.tokenEstimate;
          removedEstimate = true;
        }
      }
    }
    this.data = data;
    let ownershipChanged=false;
    for(const child of data.projects.filter(p=>p.parentWorkspace)) {
      const parent=data.projects.find(p=>p.workspace===child.parentWorkspace&&!p.parentWorkspace);
      let confirmed=ownedExecutor(child,parent);
      if(parent&&!child.parentProjectId) {
        const proofs=await Promise.all(child.sessions.map(s=>assignmentOwnership(parent,child.workspace,s.assignmentId,this.git)));
        confirmed=proofs.length>0&&proofs.every((proof,i)=>proof&&proof.parent_scope_id===child.sessions[i].parentScopeId
          &&proof.parent_task_id===child.sessions[i].taskId&&parent.sessions.some(s=>s.sessionId===child.sessions[i].executionOriginSessionId));
        if(confirmed){child.parentProjectId=parent.projectId;for(const s of child.sessions)s.parentProjectId=parent.projectId;ownershipChanged=true;}
      }
      const state=confirmed?'confirmed':'recovery';
      if(child.ownershipState!==state){child.ownershipState=state;ownershipChanged=true;}
    }
    if (!data.projects.some(p => p.workspace === data.selectedWorkspace && p.archivedAt === null
      &&(!p.parentWorkspace||data.projects.some(parent=>ownedExecutor(p,parent)&&!parent.archivedAt)))) this.data.selectedWorkspace = null;
    if (legacy || removedEstimate || ownershipChanged) await this.save();
    return this.snapshot();
  }

  snapshot() { return persistent(this.data); }
  selected() { return this.project(this.data.selectedWorkspace); }
  // Archiving or deleting the selected project clears the selection; the UI then returns
  // to another active project. Only an empty active list means first run.
  landing() { return this.selected() ?? currentView(this.data.projects.find(p => p.archivedAt === null&&!p.parentWorkspace)); }
  project(workspace, sessionId) { return currentView(this.data.projects.find(p => p.workspace === workspace), sessionId); }

  assertParent(project,data=this.data,allowArchived=false) {
    if(project?.parentWorkspace&&!data.projects.some(p=>ownedExecutor(project,p)&&(allowArchived||!p.archivedAt)))
      throw new WorkspaceError('ASSIGNMENT_OWNER','Родитель исполнителя отсутствует или находится в архиве. Файлы и чат сохранены.');
  }

  activeRecord(workspace, sessionId, data = this.data, { background = false } = {}) {
    const project = data.projects.find(p => p.workspace === workspace);
    // Flush an existing owned executor before deletion; this never permits selecting an archived parent.
    this.assertParent(project,data,background);
    if (project?.archivedAt) throw new WorkspaceError('PROJECT_ARCHIVED', 'Сначала верните проект из архива.');
    const session = project?.sessions.find(s => s.sessionId === sessionId);
    if (!session || session.archivedAt || !background && project.selectedSessionId !== sessionId) {
      throw new WorkspaceError('SESSION_CHANGED', 'Проект или сессия уже изменились.');
    }
    return { project, session };
  }

  save(data = this.data, isCurrent = () => true) {
    const transient = new Set(['planView', 'preparedPlans', 'unassignedPlans', 'scopeTitle', 'planExecution']);
    const text = JSON.stringify(data, (key, value) => transient.has(key) ? undefined : value, 2) + '\n';
    const operation = this.saveTail.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + '.tmp-' + this.uuid();
      let renamed = false;
      try {
        await fs.writeFile(temporary, text, { mode: 0o600 });
        if (!isCurrent()) return false;
        await fs.rename(temporary, this.file);
        renamed = true;
        return true;
      } finally {
        if (!renamed) await fs.rm(temporary, { force: true }).catch(() => {});
      }
    });
    this.saveTail = operation;
    return operation;
  }

  // In the mutation queue after pending saves, so no own temporary file is in flight.
  removeTemporaries() {
    const operation = this.mutationTail.catch(() => {}).then(async () => {
      await this.saveTail.catch(() => {});
      return removeStoreTemporaries(this.file);
    });
    this.mutationTail = operation;
    return operation;
  }

  createSession(experience = 'chat', executionSnapshot = this.getExecutionSettings()) {
    experience = sessionExperience(experience);
    executionSnapshot = validateParallelSettings(executionSnapshot);
    return { sessionId: 'web-pilot-' + this.uuid(), planId: null, originSessionId: null, legacyPlanId: null, planBinding: 'none', lastNamedScopeId: null, experience, chatUrl: null, title: '', titleSource: null,
      executionSnapshot, createdAt: this.now(), lastOpenedAt: this.now(), archivedAt: null, attempt: null, receipt: null };
  }

  mutate(change, isCurrent = () => true) {
    const operation = this.mutationTail.catch(() => {}).then(async () => {
      if (!isCurrent()) return null;
      const draft = copy(this.data);
      const result = await change(draft);
      if (!isCurrent()) return null;
      // Many publishes re-apply the same title or projection: an unchanged store is not rewritten.
      if (JSON.stringify(draft) === JSON.stringify(this.data)) return result;
      if (!await this.save(draft, isCurrent)) return null;
      // Selection can change during the atomic rename. Restore the previous snapshot
      // within the same mutation queue before another writer is allowed to proceed.
      if (!isCurrent()) { await this.save(this.data); return null; }
      this.data = draft;
      return result;
    });
    this.mutationTail = operation;
    return operation;
  }

  select(input, { experience = 'chat', latest = false, isCurrent = () => true } = {}) {
    return this.mutate(async data => {
      const info = await this.inspect(input);
      let project = data.projects.find(p => p.workspace === info.workspace);
      this.assertParent(project,data);
      if (project?.archivedAt) throw new WorkspaceError('PROJECT_ARCHIVED', 'Сначала верните проект из архива в настройках.');
      if (project && project.projectId !== info.projectId) throw new WorkspaceError('PROJECT_REPLACED', 'В этой папке теперь другой проект. Сохранённые чаты оставлены без изменений.');
      if (!project) {
        const session = this.createSession(experience);
        project = { ...info, selectedSessionId: session.sessionId, sessions: [session], expanded: false, archivedAt: null };
        data.projects.unshift(project);
      } else Object.assign(project, info);
      if (latest) {
        project.selectedSessionId = activeSessionsNewestFirst(project.sessions)[0].sessionId;
        project.expanded = true;
      }
      const selected = project.sessions.find(s => s.sessionId === project.selectedSessionId);
      const owned = await this.inspect(project.workspace, selected.sessionId);
      Object.assign(project, owned);
      selected.lastOpenedAt = this.now();
      data.selectedWorkspace = project.workspace;
      return currentView(project);
    }, isCurrent);
  }

  async selectSession(input, sessionId, { isCurrent = () => true, expand = true } = {}) {
    const generation = ++this.selectionGeneration;
    const current = () => generation === this.selectionGeneration && isCurrent();
    const info = await this.inspect(input, sessionId);
    return this.mutate(data => {
      const project = data.projects.find(p => p.workspace === info.workspace);
      this.assertParent(project,data);
      if (!project || !project.sessions.some(s => s.sessionId === sessionId)) throw new WorkspaceError('SESSION_NOT_FOUND', 'Эта сессия не принадлежит выбранному проекту.');
      if (project.sessions.find(s => s.sessionId === sessionId)?.archivedAt) throw new WorkspaceError('SESSION_ARCHIVED', 'Сначала верните сессию из архива.');
      if (project.archivedAt) throw new WorkspaceError('PROJECT_ARCHIVED', 'Сначала верните проект из архива.');
      if (project.projectId !== info.projectId) throw new WorkspaceError('PROJECT_REPLACED', 'В этой папке теперь другой проект. Сохранённые чаты оставлены без изменений.');
      Object.assign(project, info, { selectedSessionId: sessionId, expanded: expand || project.expanded });
      Object.assign(project.sessions.find(s => s.sessionId === sessionId), { lastOpenedAt: this.now() });
      data.selectedWorkspace = project.workspace;
      return currentView(project);
    }, current);
  }

  bindChat(workspace, sessionId, input, { manual = false, background = false } = {}) {
    return this.mutate(data => {
      const url = normalizeChatUrl(input);
      if (!url) throw new WorkspaceError('CHAT_URL_INVALID', 'Откройте конкретный чат ChatGPT.');
      const { session } = this.activeRecord(workspace, sessionId, data, { background });
      if (!conversationUrlCompatibleWithExperience(url, session.experience)) {
        throw new WorkspaceError('CHAT_EXPERIENCE_MISMATCH', session.experience === 'work'
          ? 'Эта сессия создана как Work. Откройте разговор, созданный из Work.' : 'Эта сессия создана как Chat. Откройте обычный Chat.');
      }
      if (session.chatUrl && session.chatUrl !== url) throw new WorkspaceError('CHAT_CHANGED', 'Открыт другой чат. Выберите его в дереве или вернитесь к сессии проекта.');
      if (data.projects.some(p => p.sessions.some(s => s.sessionId !== sessionId && s.chatUrl === url))) throw new WorkspaceError('CHAT_IN_USE', 'Этот чат уже связан с другой сессией.');
      session.chatUrl = url;
      if (manual && !['sent', 'acknowledged'].includes(session.attempt?.state)) session.manualStart = true;
      return currentView(data.projects.find(p => p.workspace === workspace), sessionId);
    });
  }

  newSession(workspace, experience, { executionSnapshot } = {}) {
    return this.mutate(async data => {
      experience = sessionExperience(experience);
      const project = data.projects.find(p => p.workspace === workspace);
      if (!project) throw new WorkspaceError('WORKSPACE_REQUIRED', 'Сначала выберите проект.');
      if (project.archivedAt) throw new WorkspaceError('PROJECT_ARCHIVED', 'Сначала верните проект из архива.');
      // An explicitly inherited snapshot never consults the current Settings.
      const session = this.createSession(experience, executionSnapshot);
      project.sessions.push(session); project.selectedSessionId = session.sessionId; project.expanded = true;
      const info = await this.inspect(workspace, session.sessionId);
      Object.assign(project, info);
      if (['ACTIVE', 'BLOCKED'].includes(info.scopeStatus) && typeof info.scopeId === 'string' && info.scopeId
          && typeof info.objective === 'string' && info.objective.trim()) {
        session.lastNamedScopeId = info.scopeId;
        session.title = scopeSessionTitle(info.scopeTitle, info.objective);
        session.titleSource = 'scope';
        project.lastNamedScopeId = info.scopeId;
      }
      return currentView(project);
    });
  }

  newChat(workspace) { return this.newSession(workspace, 'chat'); }

  ensureExecutor(assignment,origin) {
    return this.mutate(async data=>{
      if(typeof assignment.worktree!=='string'||!path.isAbsolute(assignment.worktree))
        throw new WorkspaceError('ASSIGNMENT_OWNER','Неверная папка назначения.');
      const workspace=await fs.realpath(assignment.worktree);
      const parent=data.projects.find(p=>p.workspace===origin.workspace&&!p.parentWorkspace);
      if(!parent||parent.projectId!==origin.projectId||parent.archivedAt||!parent.sessions.some(s=>s.sessionId===origin.sessionId&&!s.archivedAt))
        throw new WorkspaceError('ASSIGNMENT_OWNER','Родитель назначения изменился.');
      if(workspace===assignment.parent_root||assignment.parent_root!==origin.workspace)
        throw new WorkspaceError('ASSIGNMENT_OWNER','Неверная папка назначения.');
      let project=data.projects.find(p=>p.workspace===workspace);
      const existing=project?.sessions.find(s=>s.assignmentId===assignment.id);
      if(existing) {
        if(!ownedExecutor(project,parent)||existing.parentProjectId!==parent.projectId||existing.taskId!==assignment.parent_task_id||existing.parentScopeId!==assignment.parent_scope_id
          ||existing.executionOriginSessionId!==origin.sessionId||existing.archivedAt||project.archivedAt)
          throw new WorkspaceError('ASSIGNMENT_OWNER','Сохранённая сессия не соответствует назначению.');
        return currentView(project,existing.sessionId);
      }
      if(project)throw new WorkspaceError('ASSIGNMENT_OWNER','Worktree уже подключён без этого назначения.');
      const info=await this.inspect(workspace),session=this.createSession(origin.experience,origin.executionSnapshot);
      Object.assign(session,{assignmentId:assignment.id,taskId:assignment.parent_task_id,parentWorkspace:origin.workspace,parentProjectId:parent.projectId,
        parentScopeId:assignment.parent_scope_id,executionOriginSessionId:origin.sessionId,
        title:sessionName(assignment.parent_task_id+' — '+assignment.title),titleSource:'manual'});
      project={...info,parentWorkspace:origin.workspace,parentProjectId:parent.projectId,ownershipState:'confirmed',parentScopeId:assignment.parent_scope_id,
        selectedSessionId:session.sessionId,sessions:[session],expanded:false,archivedAt:null};
      data.projects.push(project);return currentView(project);
    });
  }

  saveExecutorAutomation(workspace,sessionId,patch) {
    return this.mutate(data=>{
      const {session}=this.activeRecord(workspace,sessionId,data,{background:true});
      if(!session.assignmentId||Object.keys(patch).some(k=>!['autoPlanCheckpoint','automationCheckpoint'].includes(k)))
        throw new WorkspaceError('ASSIGNMENT_OWNER','Нет такого исполнителя.');
      session.executionAutomation={...session.executionAutomation,...copy(patch)};
    });
  }

  saveExecutorTime(workspace,sessionId,time) {
    return this.mutate(data=>{
      const {session}=this.activeRecord(workspace,sessionId,data,{background:true});
      if(!session.assignmentId||!validDuration(time?.activeMs)||!validDuration(time?.waitingMs))
        throw new WorkspaceError('INVALID_EXECUTOR_TIME','Неверное время исполнителя.');
      session.executionTime={activeMs:time.activeMs,waitingMs:time.waitingMs};
    });
  }

  setExpanded(workspace, expanded) {
    return this.mutate(data => {
      const project = data.projects.find(p => p.workspace === workspace);
      if (!project || typeof expanded !== 'boolean') throw new WorkspaceError('WORKSPACE_REQUIRED', 'Выберите проект из списка.');
      project.expanded = expanded;
    });
  }

  setProjectDisplayName(workspace, value) {
    return this.mutate(data => {
      const project = data.projects.find(p => p.workspace === workspace);
      if (!project) throw new WorkspaceError('WORKSPACE_REQUIRED', 'Выберите проект из списка.');
      if (project.archivedAt) throw new WorkspaceError('PROJECT_ARCHIVED', 'Сначала верните проект из архива.');
      const displayName = localName(value, { code: 'PROJECT_NAME_INVALID', empty: 'Введите название проекта.' });
      if (project.displayName === displayName) return false;
      project.displayName = displayName; return true;
    });
  }

  renameSession(workspace, sessionId, value) {
    return this.mutate(data => {
      const project = data.projects.find(p => p.workspace === workspace);
      if (!project) throw new WorkspaceError('WORKSPACE_REQUIRED', 'Выберите проект из списка.');
      if (project.archivedAt) throw new WorkspaceError('PROJECT_ARCHIVED', 'Сначала верните проект из архива.');
      const session = project.sessions.find(item => item.sessionId === sessionId);
      if (!session) throw new WorkspaceError('SESSION_NOT_FOUND', 'Сессия не найдена.');
      if (session.archivedAt) throw new WorkspaceError('SESSION_ARCHIVED', 'Сначала верните сессию из архива.');
      const title = sessionName(value, { empty: 'Введите название сессии.' });
      if (session.title === title && session.titleSource === 'manual') return false;
      session.title = title; session.titleSource = 'manual'; return true;
    });
  }

  setSessionTitle(workspace, sessionId, value) {
    return this.mutate(data => {
      const { session } = this.activeRecord(workspace, sessionId, data);
      if (typeof value !== 'string') throw new WorkspaceError('TITLE_INVALID', 'Неверное название сессии.');
      const title = sessionName(value, { empty: 'Неверное название сессии.' });
      if (!title || explicitTitleSources.has(session.titleSource)) return false;
      if (session.title === title && session.titleSource === 'page') return false;
      session.title = title; session.titleSource = 'page'; return true;
    });
  }

  applyScopeTitle(workspace, sessionId, { scopeId, scopeTitle, objective, scopeStatus } = {}) {
    return this.mutate(data => {
      const { project, session } = this.activeRecord(workspace, sessionId, data);
      if (!['ACTIVE', 'BLOCKED'].includes(scopeStatus) || typeof scopeId !== 'string' || !scopeId) return false;
      const desired = scopeSessionTitle(scopeTitle, objective);
      if (session.lastNamedScopeId === scopeId) {
        if (session.titleSource === 'scope' && session.title !== desired) { session.title = desired; return true; }
        return false;
      }
      if (project.lastNamedScopeId === scopeId) return false;
      project.lastNamedScopeId = scopeId;
      session.lastNamedScopeId = scopeId;
      if (session.titleSource === 'manual') return true;
      session.title = desired;
      session.titleSource = 'scope';
      return true;
    });
  }

  // Adds one finished agent request to its session, even if another session is selected by now.
  async recordAgentTime(workspace, sessionId, durationMs) {
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new RangeError('INVALID_AGENT_TIME');
    const lastMs = Math.round(durationMs);
    return this.mutate(data => {
      const session = data.projects.find(p => p.workspace === workspace)?.sessions.find(s => s.sessionId === sessionId);
      if (!session) return false;
      const totalMs = (session.agentTime?.totalMs ?? 0) + lastMs;
      if (!Number.isSafeInteger(totalMs)) throw new RangeError('INVALID_AGENT_TIME');
      session.agentTime = { totalMs, lastMs };
      return true;
    });
  }

  updateSession(workspace, sessionId, patch, { background = false } = {}) {
    return this.mutate(data => {
      const { project, session } = this.activeRecord(workspace, sessionId, data, { background });
      if (Object.keys(patch).some(k => !['attempt', 'receipt', 'manualStart','conversationRecovery'].includes(k))) throw new Error('INVALID_SESSION_PATCH');
      if(patch.conversationRecovery!==undefined) {
        const c=patch.conversationRecovery;
        if(!c||typeof c.key!=='string'||typeof c.used!=='boolean'||[c.cooldownUntil,c.stoppedAt].some(n=>n!==null&&(!Number.isFinite(n)||n<0)))throw new Error('INVALID_SESSION_PATCH');
      }
      if (patch.manualStart !== undefined && typeof patch.manualStart !== 'boolean') throw new Error('INVALID_SESSION_PATCH');
      Object.assign(session, copy(patch)); return currentView(project, sessionId);
    });
  }

  setSessionArchived(workspace, sessionId, archived) {
    return this.mutate(data => {
      if (typeof archived !== 'boolean') throw new WorkspaceError('SESSION_ARCHIVE', 'Неверное состояние архива сессии.');
      const project = data.projects.find(p => p.workspace === workspace);
      if (!project) throw new WorkspaceError('WORKSPACE_REQUIRED', 'Выберите проект из списка.');
      if (project.archivedAt) throw new WorkspaceError('PROJECT_ARCHIVED', 'Сначала верните проект из архива.');
      const session = project.sessions.find(item => item.sessionId === sessionId);
      if (!session) throw new WorkspaceError('SESSION_NOT_FOUND', 'Сессия не найдена.');
      if (archived) {
        if (session.archivedAt) return currentView(project);
        const active = project.sessions.filter(item => item.archivedAt === null);
        if (active.length <= 1) throw new WorkspaceError('SESSION_LAST_ACTIVE', 'Нельзя архивировать единственную активную сессию проекта.');
        session.archivedAt = this.now();
        if (project.selectedSessionId === sessionId) {
          const fallback = active.filter(item => item.sessionId !== sessionId)
            .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || b.createdAt - a.createdAt)[0];
          project.selectedSessionId = fallback.sessionId;
          fallback.lastOpenedAt = this.now();
        }
      } else session.archivedAt = null;
      return currentView(project);
    });
  }

  forgetArchivedSessions(items) {
    return this.mutate(async data => {
      if (!Array.isArray(items) || !items.length) throw new WorkspaceError('SESSION_ARCHIVE', 'Выберите сессии из архива.');
      const seen = new Set();
      const records = items.map(item => {
        const key = `${item?.workspace ?? ''}\n${item?.sessionId ?? ''}`;
        if (!item || typeof item.workspace !== 'string' || typeof item.projectId !== 'string' || typeof item.sessionId !== 'string' || seen.has(key))
          throw new WorkspaceError('SESSION_ARCHIVE', 'Выберите корректные сессии из архива.');
        seen.add(key);
        const project = data.projects.find(project => project.workspace === item.workspace);
        if (!project || project.projectId !== item.projectId) throw new WorkspaceError('PROJECT_REPLACED', 'Запись проекта изменилась. Повторите выбор.');
        const session = project.sessions.find(session => session.sessionId === item.sessionId);
        if (!session?.archivedAt) throw new WorkspaceError('SESSION_NOT_ARCHIVED', 'Удалить локально можно только сессию из архива.');
        return { project, session };
      });
      for (const { project, session } of records) await purgeSessionCopies(this.file, project.workspace, session.sessionId);
      await this.saveTail.catch(() => {});
      await removeStoreTemporaries(this.file);
      for (const { project, session } of records) project.sessions = project.sessions.filter(item => item.sessionId !== session.sessionId);
      return records.length;
    });
  }

  setArchived(workspace, archived) {
    return this.mutate(data => {
      const project = data.projects.find(p => p.workspace === workspace);
      if (!project || typeof archived !== 'boolean') throw new WorkspaceError('WORKSPACE_REQUIRED', 'Выберите проект из списка.');
      project.archivedAt = archived ? (project.archivedAt ?? this.now()) : null;
      if (archived && (data.selectedWorkspace === workspace||data.projects.some(p=>p.workspace===data.selectedWorkspace&&ownedExecutor(p,project)))) data.selectedWorkspace = null;
      return currentView(project);
    });
  }

  forgetDeletedProject(workspace, projectId, related = []) {
    return this.mutate(data=>{
      const project=data.projects.find(p=>p.workspace===workspace);
      if(project&&(!project.archivedAt||project.projectId!==projectId))throw new WorkspaceError('DELETE_RECORD_CHANGED','Запись удаляемого проекта изменилась.');
      const removed=new Set(data.projects.filter(p=>p.workspace===workspace||related.some(r=>r.workspace===p.workspace
        &&r.projectId===p.projectId&&r.parentProjectId===projectId&&(ownedExecutor(p,{workspace,projectId})
          ||r.legacyVerified&&!p.parentProjectId&&p.parentWorkspace===workspace))).map(p=>p.workspace));
      data.projects=data.projects.filter(p=>!removed.has(p.workspace));
      if(removed.has(data.selectedWorkspace))data.selectedWorkspace=null;
      return true;
    });
  }

  forgetOrphanExecutor({workspace,projectId,parentWorkspace,parentProjectId,sessionIds}) {
    return this.mutate(data=>{
      const project=data.projects.find(p=>p.workspace===workspace);
      if(!project)throw new WorkspaceError('EXECUTOR_RECORD_CHANGED','Запись исполнителя уже отсутствует. Обновите Настройки.');
      if(project.projectId!==projectId||project.parentWorkspace!==parentWorkspace
        ||project.parentProjectId!==parentProjectId||!parentProjectId
        ||data.projects.some(p=>p.workspace===parentWorkspace)
        ||JSON.stringify(project.sessions.map(s=>s.sessionId))!==JSON.stringify(sessionIds))
        throw new WorkspaceError('EXECUTOR_RECORD_CHANGED','Запись исполнителя или его родитель изменились.');
      data.projects=data.projects.filter(p=>p!==project);
      if(data.selectedWorkspace===workspace)data.selectedWorkspace=null;
      return true;
    });
  }

  forgetArchived(workspace, projectId) {
    return this.forgetArchivedMany([{ workspace, projectId }]).then(count => count > 0);
  }

  forgetArchivedMany(items) {
    return this.mutate(data => {
      if (!Array.isArray(items) || !items.length) throw new WorkspaceError('WORKSPACE_REQUIRED', 'Выберите проект из архива.');
      const seen = new Set();
      const projects = items.map(item => {
        if (!item || typeof item.workspace !== 'string' || typeof item.projectId !== 'string' || seen.has(item.workspace))
          throw new WorkspaceError('WORKSPACE_REQUIRED', 'Выберите корректные проекты из архива.');
        seen.add(item.workspace);
        const project = data.projects.find(p => p.workspace === item.workspace);
        if (!project || project.projectId !== item.projectId) throw new WorkspaceError('PROJECT_REPLACED', 'Запись проекта изменилась. Повторите проверку.');
        if (!project.archivedAt) throw new WorkspaceError('PROJECT_NOT_ARCHIVED', 'Убрать из списка можно только проект из архива.');
        return project;
      });
      const remove = new Set(projects.map(project => project.workspace));
      data.projects = data.projects.filter(project => !remove.has(project.workspace));
      if (remove.has(data.selectedWorkspace)) data.selectedWorkspace = null;
      return projects.length;
    });
  }
}
