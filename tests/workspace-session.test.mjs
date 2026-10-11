import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { WorkspaceSessions, readWorkspace, normalizeChatUrl, conversationExperience, conversationUrlCompatibleWithExperience, activeSessionsNewestFirst } from '../src/workspace-session.mjs';
import { sessionExecutionMessage } from '../src/context-session.mjs';

const directoryLink = (target, link) => fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');

test('assignment gets one inherited session without moving selection and persists its separate worktree',async t=>{
  const {project,store}=await fixture(t);
  store.getExecutionSettings=()=>({parallel_allowed:true,max_workers:2});
  const main=await store.select(await project('Main'),{experience:'work'}),worktree=await fs.realpath(await project('Assigned worktree'));
  const assignment={id:'worker-one',worktree,parent_root:main.workspace,parent_scope_id:'scope',parent_task_id:'T001',title:'Assigned task'};
  store.getExecutionSettings=()=>{throw Error('must inherit');};
  const first=await store.ensureExecutor(assignment,main),again=await store.ensureExecutor(assignment,main);
  assert.equal(first.sessionId,again.sessionId);assert.equal(store.selected().sessionId,main.sessionId);
  assert.equal(first.workspace,worktree);assert.equal(first.parentWorkspace,main.workspace);assert.equal(first.taskId,'T001');
  assert.equal(first.parentProjectId,main.projectId);
  assert.equal(first.experience,'work');assert.deepEqual(first.executionSnapshot,main.executionSnapshot);
  await store.saveExecutorAutomation(worktree,first.sessionId,{autoPlanCheckpoint:{version:3,entries:[]}});
  const restarted=new WorkspaceSessions(store.file);await restarted.load();
  assert.equal(restarted.project(worktree).assignmentId,assignment.id);
  assert.equal(restarted.project(worktree).parentProjectId,main.projectId);
  assert.equal(restarted.project(worktree).executionAutomation.autoPlanCheckpoint.version,3);
  await assert.rejects(store.ensureExecutor({...assignment,parent_task_id:'T002'},main),{code:'ASSIGNMENT_OWNER'});
});

test('characterization: five missing executor folders remain recovery records after their parent disappears',async t=>{
  const {root,project,store}=await fixture(t);
  const parent=await store.select(await project('PL_Мастерская_файлов','deleted-parent-id'));
  const group=path.join(path.dirname(parent.workspace),'.web-pilot-worktrees',createHash('sha256').update(parent.workspace).digest('hex').slice(0,16));
  const children=[];
  for(let i=0;i<5;i++) {
    const id='wp-lost-'+String(i+1).padStart(2,'0');
    const worktree=path.join(group,id);
    await fs.mkdir(path.join(worktree,'.harness/plans'),{recursive:true});
    await fs.mkdir(path.join(worktree,'scripts'),{recursive:true});
    await fs.copyFile(path.join(parent.workspace,'.harness/plans/todo-plan.md'),path.join(worktree,'.harness/plans/todo-plan.md'));
    await fs.writeFile(path.join(worktree,'scripts/workflow.mjs'),'// fixture');
    const assigned=await store.ensureExecutor({id,worktree,parent_root:parent.workspace,
      parent_scope_id:'fixture-scope',parent_task_id:'T001',title:'Изолированный исполнитель '+i},parent);
    const chatUrl='https://chatgpt.com/c/lost-worker-'+i+'-fixture';
    store.data.projects.find(p=>p.workspace===worktree).sessions.find(s=>s.sessionId===assigned.sessionId).chatUrl=chatUrl;
    await store.save();
    children.push({workspace:worktree,projectId:assigned.projectId,sessionId:assigned.sessionId,chatUrl});
  }
  const neighbour=await store.select(await project('Соседний','neighbour-id'));
  const neighbourBefore=store.project(neighbour.workspace);
  store.data.projects=store.data.projects.filter(p=>p.workspace!==parent.workspace);
  await store.save();
  await fs.rm(parent.workspace,{recursive:true});
  await fs.rm(group,{recursive:true});
  assert.equal(store.file.startsWith(root+path.sep),true,'never use real userData as the fixture store');

  const restarted=new WorkspaceSessions(store.file);
  await restarted.load();
  const records=restarted.snapshot().projects;
  assert.equal(records.length,6);
  assert.equal(records.some(p=>p.workspace===parent.workspace),false);
  assert.equal(restarted.selected().workspace,neighbour.workspace);
  assert.equal(restarted.landing().workspace,neighbour.workspace);
  assert.equal(restarted.project(neighbour.workspace).sessionId,neighbourBefore.sessionId);
  for(const expected of children) {
    const entry=records.find(p=>p.workspace===expected.workspace);
    assert.ok(entry,'all five original records survive load');
    assert.equal(entry.parentWorkspace,parent.workspace);
    assert.equal(entry.parentProjectId,parent.projectId);
    assert.equal(entry.ownershipState,'recovery');
    assert.equal(entry.sessions.length,1);
    assert.equal(entry.sessions[0].sessionId,expected.sessionId);
    assert.equal(entry.sessions[0].chatUrl,expected.chatUrl);
    await assert.rejects(fs.lstat(expected.workspace),{code:'ENOENT'});
    await assert.rejects(restarted.selectSession(expected.workspace,expected.sessionId),{code:'WORKFLOW_NOT_INSTALLED'});
  }
  const disk=JSON.parse(await fs.readFile(store.file,'utf8'));
  assert.equal(disk.projects.length,6);
  assert.equal(disk.projects.filter(p=>p.ownershipState==='recovery').length,5);

  // T004: load() must keep these records until explicit per-executor confirmation.
  // After confirming removal of the first child only:
  // assert.equal(restarted.project(children[0].workspace), null);
  // assert.equal(restarted.snapshot().projects.length, 5);
  // assert.ok(restarted.project(children[1].workspace));
  // assert.equal(restarted.project(neighbour.workspace).sessionId,neighbourBefore.sessionId);
});

test('forgetDeletedProject handles a child already removed by its own confirmed journal without touching siblings',async t=>{
  const {project,store}=await fixture(t);
  const origin=await store.select(await project('Parent','shared-id'));
  const child=await fs.realpath(await project('Child','shared-id'));
  const foreign=await store.select(await project('Neighbour','neighbour-id'));
  const assigned=await store.ensureExecutor({id:'assigned-child',worktree:child,parent_root:origin.workspace,
    parent_scope_id:'fixture-scope',parent_task_id:'T001',title:'Owned'},origin);
  const childRecord=store.snapshot().projects.find(p=>p.workspace===child);
  const related=[{workspace:child,projectId:childRecord.projectId,parentProjectId:origin.projectId,
    sessionIds:childRecord.sessions.map(s=>s.sessionId)}];
  await store.setArchived(origin.workspace,true);
  await store.setArchived(child,true);
  await store.forgetDeletedProject(child,assigned.projectId);
  await store.forgetDeletedProject(origin.workspace,origin.projectId,related);
  await store.forgetDeletedProject(origin.workspace,origin.projectId,related);
  assert.deepEqual(store.snapshot().projects.map(p=>p.workspace),[foreign.workspace]);
  assert.equal(store.project(foreign.workspace).sessionId,foreign.sessionId);
});

test('execution settings are captured at creation, independent of edits, selection and restart', async t => {
  const { project, store } = await fixture(t);
  let settings = { parallel_allowed: true, max_workers: 3 };
  store.getExecutionSettings = () => settings;
  const first = await store.select(await project('Execution snapshots'), { experience: 'work' });
  settings.max_workers = 5;
  const second = await store.newSession(first.workspace, 'chat');
  assert.deepEqual(first.executionSnapshot, { parallel_allowed: true, max_workers: 3 });
  assert.deepEqual(second.executionSnapshot, { parallel_allowed: true, max_workers: 5 });
  settings = { parallel_allowed: false, max_workers: 1 };
  await store.selectSession(first.workspace, first.sessionId);
  assert.deepEqual(store.selected().executionSnapshot, first.executionSnapshot);
  first.executionSnapshot.max_workers = 99;
  assert.equal(store.selected().executionSnapshot.max_workers, 3, 'returned views cannot mutate storage');
  await assert.rejects(store.updateSession(first.workspace, first.sessionId, { executionSnapshot: settings }), /INVALID_SESSION_PATCH/);
  const restarted = new WorkspaceSessions(store.file, { getExecutionSettings: () => settings });
  await restarted.load();
  assert.equal(restarted.selected().experience, 'work');
  assert.equal(restarted.selected().executionSnapshot.max_workers, 3);
  assert.deepEqual((await restarted.newSession(first.workspace, 'work')).executionSnapshot, settings);
  restarted.getExecutionSettings = () => { throw new Error('Inherited snapshot must not read Settings'); };
  const inherited = { parallel_allowed: true, max_workers: 3 };
  assert.deepEqual((await restarted.newSession(first.workspace, 'chat', { executionSnapshot: inherited })).executionSnapshot, inherited);
});

test('new sessions preserve active plan parameters without creating or rewriting a plan', async t => {
  const { project, store } = await fixture(t);
  const folder = await fs.realpath(await project('Active policy'));
  const policy = { parallel_allowed: true, max_workers: 4, execution_strategy: 'parallel', execution_reason: 'Independent tasks' };
  await changeScopePlan(folder, policy);
  const file = path.join(folder, '.harness/plans/todo-plan.md'), before = await fs.readFile(file, 'utf8');
  store.getExecutionSettings = () => ({ parallel_allowed: false, max_workers: 1 });
  await store.select(folder);
  const fresh = await store.newSession(folder, 'work');
  assert.deepEqual(fresh.planExecution, policy);
  assert.deepEqual(fresh.executionSnapshot, { parallel_allowed: false, max_workers: 1 });
  assert.match(sessionExecutionMessage(fresh), /следующему новому плану/);
  assert.ok(sessionExecutionMessage(fresh).includes(JSON.stringify(policy)));
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal('planExecution' in JSON.parse(await fs.readFile(store.file, 'utf8')).projects[0], false, 'plan policy is a projection, not another plan');
  const restarted = new WorkspaceSessions(store.file); await restarted.load();
  assert.deepEqual((await restarted.select(folder)).planExecution, policy);
  await changeScopePlan(folder, { max_workers: 0 });
  await assert.rejects(readWorkspace(folder), { code: 'WORKFLOW_PLAN_INVALID' });
});

test('legacy sessions retain data and never acquire current execution settings', async t => {
  const { project, store } = await fixture(t);
  const first = await store.select(await project('Legacy snapshots'));
  await store.bindChat(first.workspace, first.sessionId, 'https://chatgpt.com/c/legacy-snapshot-chat');
  await store.renameSession(first.workspace, first.sessionId, 'Ручное имя');
  await store.recordAgentTime(first.workspace, first.sessionId, 1250);
  await store.updateSession(first.workspace, first.sessionId, { attempt: { state: 'sent', requestId: 'preserved' }, receipt: { preserved: true } });
  await store.newSession(first.workspace, 'work');
  await store.setSessionArchived(first.workspace, first.sessionId, true);
  const legacy = store.snapshot();
  for (const session of legacy.projects[0].sessions) delete session.executionSnapshot;
  const original = JSON.stringify(legacy); await fs.writeFile(store.file, original);
  const restarted = new WorkspaceSessions(store.file, { getExecutionSettings: () => ({ parallel_allowed: true, max_workers: 7 }) });
  await restarted.load();
  assert.deepEqual(restarted.snapshot(), legacy);
  assert.equal(await fs.readFile(store.file, 'utf8'), original, 'no unnecessary migration rewrites');
  assert.match(sessionExecutionMessage(restarted.selected()), /Legacy-сессия.*выключено/);
  assert.equal((await restarted.newSession(first.workspace, 'work')).executionSnapshot.max_workers, 7);
  const broken = restarted.snapshot(); broken.projects[0].sessions[0].executionSnapshot = { parallel_allowed: true, max_workers: 0 };
  const bad = JSON.stringify(broken); await fs.writeFile(store.file, bad);
  await assert.rejects(new WorkspaceSessions(store.file).load(), { code: 'SESSIONS_INVALID' });
  assert.equal(await fs.readFile(store.file, 'utf8'), bad, 'invalid input is not overwritten');
});

test('explicit background delivery updates only its own live saved session', async t => {
  const { project, store } = await fixture(t);
  const a=await store.select(await project('Background'));
  const b=await store.newSession(a.workspace,'chat');
  await assert.rejects(store.updateSession(a.workspace,a.sessionId,{attempt:{state:'sent'}}),{code:'SESSION_CHANGED'});
  await store.updateSession(a.workspace,a.sessionId,{attempt:{state:'sent'}},{background:true});
  const bound=await store.bindChat(a.workspace,a.sessionId,'https://chatgpt.com/c/background-worker',{background:true});
  assert.equal(bound.sessionId,a.sessionId);assert.equal(store.selected().sessionId,b.sessionId);
  assert.equal(store.selected().attempt,null);assert.equal(store.project(a.workspace,a.sessionId).attempt.state,'sent');
  assert.equal(store.project(a.workspace,'missing'),null);
  await store.setSessionArchived(a.workspace,a.sessionId,true);
  await assert.rejects(store.updateSession(a.workspace,a.sessionId,{attempt:null},{background:true}),{code:'SESSION_CHANGED'});
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-pilot-workspaces-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function project(name, id = randomUUID()) {
    const folder = path.join(root, name);
    await fs.mkdir(path.join(folder, '.harness/plans'), { recursive: true });
    await fs.mkdir(path.join(folder, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(folder, 'scripts/workflow.mjs'), '// fixture');
    const plan = { schema_version: 1, project_id: id, project_name: name, plan_revision: 7,
      scope_id: 'fixture-scope', execution_scope_status: 'ACTIVE', delivery_status: 'IN_PROGRESS',
      current_task_id: null, tasks: [{ id: 'T001', title: 'Задача', implementation_status: 'TODO', commit_status: 'PENDING' }] };
    await fs.writeFile(path.join(folder, '.harness/plans/todo-plan.md'),
      '<!-- workflow-state:begin -->\n```json\n' + JSON.stringify(plan) + '\n```\n<!-- workflow-state:end -->');
    return folder;
  }
  return { root, project, store: new WorkspaceSessions(path.join(root, 'app-data/sessions.json')) };
}



test('interrupted writes leave no copies: a failed save cleans up and load removes orphans', async t => {
  const { root, project, store } = await fixture(t);
  const folder = await project('Хранилище');
  const selected = (await store.select(folder)).workspace;
  const dir = path.dirname(store.file);
  const orphans = ['sessions.json.tmp-0a26bc01-4d21-4c3f-8d83-6becf46588c6', 'sessions.json.tmp-session-archive',
    'sessions.json.v2-backup.tmp', 'diagnostics.jsonl.tmp', 'diagnostics.jsonl.1.tmp-session-archive'];
  const foreign = ['other.json.tmp-1', 'sessions.json.v2-backup', 'diagnostics.jsonl', 'sessions.json.tmp-dir'];
  for (const name of orphans) await fs.writeFile(path.join(dir, name), '{"projects":[]}');
  for (const name of foreign.slice(0, 3)) await fs.writeFile(path.join(dir, name), 'keep');
  await fs.mkdir(path.join(dir, foreign[3]));
  const reloaded = new WorkspaceSessions(store.file);
  await reloaded.load();
  assert.equal(reloaded.selected().workspace, selected);
  const left = await fs.readdir(dir);
  for (const name of orphans) assert.ok(!left.includes(name), name);
  for (const name of foreign) assert.ok(left.includes(name), name);
  // A write that fails after the temporary file exists removes it.
  const failing = new WorkspaceSessions(store.file, { uuid: () => 'failing-write' });
  await failing.load();
  const original = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error('rename failed'), { code: 'EIO' }); };
  try { await assert.rejects(failing.save(), { code: 'EIO' }); } finally { fs.rename = original; }
  assert.ok(!(await fs.readdir(dir)).includes('sessions.json.tmp-failing-write'));
});

test('readWorkspace exposes user plan lifecycle without using plan revision as UI state', async t => {
  const { project } = await fixture(t);
  const folder = await project('Plan view');
  const file = path.join(folder, '.harness/plans/todo-plan.md');
  const write = async plan => fs.writeFile(file, '<!-- workflow-state:begin -->\n```json\n' + JSON.stringify(plan) + '\n```\n<!-- workflow-state:end -->');
  await fs.mkdir(path.join(folder, 'docs/planning'), { recursive: true });
  await fs.writeFile(path.join(folder, 'docs/planning/plan-view.md'), '# Короткий заголовок этапа\n\nКонтракт.\n');
  const base = { schema_version: 1, project_id: randomUUID(), project_name: 'Plan view', plan_revision: 99,
    scope_id: 'scope-1', objective: 'Проверить отображение плана', execution_scope_status: 'ACTIVE', delivery_status: 'IN_PROGRESS', blocked_reason: null,
    context_pack: { documents: [{ path: 'docs/planning/plan-view.md', required: true }], include_last_completed_task: false, dependency_task_ids: [] },
    current_task_id: 'T002', tasks: [
      { id: 'T001', title: 'Готовая задача', implementation_status: 'DONE', commit_status: 'DONE' },
      { id: 'T002', title: 'Текущая задача', implementation_status: 'IN_PROGRESS', commit_status: 'PENDING' },
      { id: 'T003', title: 'Следующая задача', implementation_status: 'TODO', commit_status: 'PENDING' },
    ] };
  await write(base);
  let info = await readWorkspace(folder);
  assert.deepEqual(info.planView, { state: 'working', completed: 1, total: 3, blockedReason: null, tasks: [
    { id: 'T001', title: 'Готовая задача', status: 'done', executionLabel:'Последовательно' },
    { id: 'T002', title: 'Текущая задача', status: 'current', executionLabel:'Последовательно' },
    { id: 'T003', title: 'Следующая задача', status: 'pending', executionLabel:'Последовательно' },
  ] });
  assert.equal(info.planRevision, 99, 'revision remains available only for protocol matching');
  assert.equal(info.objective, 'Проверить отображение плана', 'scope objective remains available as fallback');
  assert.equal(info.scopeTitle, 'Короткий заголовок этапа', 'required planning H1 is the canonical session title source');

  await write({ ...base, current_task_id: null, delivery_status: 'READY_FOR_ACCEPTANCE',
    tasks: base.tasks.map(t => ({ ...t, implementation_status: 'DONE', commit_status: 'DONE' })) });
  info = await readWorkspace(folder);
  assert.equal(info.planView.state, 'awaiting-acceptance'); assert.equal(info.planView.completed, 3);

  await write({ ...base, execution_scope_status: 'BLOCKED', blocked_reason: 'Нужно решение пользователя', current_task_id: null });
  info = await readWorkspace(folder);
  assert.equal(info.planView.state, 'blocked'); assert.equal(info.planView.blockedReason, 'Нужно решение пользователя');

  await write({ ...base, scope_id: null, execution_scope_status: 'NONE', delivery_status: 'IN_PROGRESS', current_task_id: null, tasks: [], archived_scope_id: 'scope-1' });
  info = await readWorkspace(folder);
  assert.equal(info.planView.state, 'closed'); assert.equal(info.planView.total, 0);

  const { archived_scope_id, ...never } = { ...base, scope_id: null, execution_scope_status: 'NONE', delivery_status: 'IN_PROGRESS', current_task_id: null, tasks: [], archived_scope_id: 'scope-1' };
  await write(never);
  info = await readWorkspace(folder); assert.equal(info.planView.state, 'not-created');
});

test('canonical folder with spaces and Cyrillic survives restart with its conversation', async t => {
  const { root, project, store } = await fixture(t);
  const folder = await project('Мой проект');
  const link = path.join(root, 'ссылка'); await directoryLink(folder, link);
  const a = await store.select(link);
  assert.equal(a.workspace, await fs.realpath(folder));
  assert.equal(a.nextTaskId, 'T001', 'a new session projects the current checkout plan');
  const chat = 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await store.bindChat(a.workspace, a.sessionId, chat + '?utm_source=x#bottom');
  const next = new WorkspaceSessions(store.file); await next.load();
  const reopened = await next.select(folder);
  assert.equal(reopened.sessionId, a.sessionId);
  assert.equal(reopened.chatUrl, chat);
  if (process.platform !== 'win32') assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
});



test('old and new sessions keep their chats while projecting one current checkout plan', async t => {
  const { project, store } = await fixture(t);
  const first = await store.select(await project('Single current plan'));
  const firstUrl = 'https://chatgpt.com/c/aaaaaaaa-1111-2222-3333-eeeeeeeeeeee';
  await store.bindChat(first.workspace, first.sessionId, firstUrl);
  const second = await store.newSession(first.workspace, 'work');
  const secondUrl = 'https://chatgpt.com/c/bbbbbbbb-1111-2222-3333-eeeeeeeeeeee';
  await store.bindChat(first.workspace, second.sessionId, secondUrl);

  const a = await store.selectSession(first.workspace, first.sessionId);
  const b = await store.selectSession(first.workspace, second.sessionId);
  assert.equal(a.scopeId, 'fixture-scope'); assert.equal(b.scopeId, 'fixture-scope');
  assert.equal(a.planRevision, 7); assert.equal(b.planRevision, 7);
  assert.deepEqual(a.planView, b.planView);
  assert.equal(a.chatUrl, firstUrl); assert.equal(b.chatUrl, secondUrl);

  const third = await store.newSession(first.workspace, 'chat');
  assert.equal(third.scopeId, 'fixture-scope');
  assert.equal(third.nextTaskId, 'T001');
  assert.equal(third.chatUrl, null);
  assert.deepEqual(store.snapshot().projects[0].sessions.map(s => s.chatUrl), [firstUrl, secondUrl, null]);
});


test('local project alias and explicit session titles persist without changing canonical workflow identity', async t => {
  const { project, store } = await fixture(t);
  const folder = await project('Canonical project');
  const first = await store.select(folder);
  assert.equal(await store.setProjectDisplayName(first.workspace, '  Мой   проект  '), true);
  assert.equal(await store.renameSession(first.workspace, first.sessionId, '  Ручное   имя  '), true);
  assert.equal(await store.setSessionTitle(first.workspace, first.sessionId, 'Заголовок страницы'), false,
    'page title cannot overwrite an explicit local title');
  await store.select(folder);
  let raw = store.snapshot().projects[0];
  assert.equal(raw.name, 'Canonical project');
  assert.equal(raw.displayName, 'Мой проект');
  assert.equal(raw.sessions[0].title, 'Ручное имя');
  assert.equal(raw.sessions[0].titleSource, 'manual');

  const restarted = new WorkspaceSessions(store.file); await restarted.load();
  raw = restarted.snapshot().projects[0];
  assert.equal(raw.name, 'Canonical project'); assert.equal(raw.displayName, 'Мой проект');
  assert.equal(raw.sessions[0].title, 'Ручное имя'); assert.equal(raw.sessions[0].titleSource, 'manual');
});

test('session titles remain chat metadata independent of the current project plan', async t => {
  const { project, store } = await fixture(t);
  const first = await store.select(await project('Chat titles'));
  assert.equal(await store.setSessionTitle(first.workspace, first.sessionId, 'Первый ChatGPT title'), true);
  const second = await store.newSession(first.workspace, 'chat');
  await store.renameSession(first.workspace, second.sessionId, 'Ручное имя второй сессии');

  const reopenedFirst = await store.selectSession(first.workspace, first.sessionId);
  assert.equal(reopenedFirst.title, 'Первый ChatGPT title');
  assert.equal(reopenedFirst.scopeId, 'fixture-scope');

  const reopenedSecond = await store.selectSession(first.workspace, second.sessionId);
  assert.equal(reopenedSecond.title, 'Ручное имя второй сессии');
  assert.equal(reopenedSecond.scopeId, 'fixture-scope');
  assert.deepEqual(reopenedSecond.planView, reopenedFirst.planView);
});

test('scope naming belongs to one session, while newly created sessions may inherit the active scope', async t => {
  const { project, store } = await fixture(t);
  const folder = await project('Scope titles');
  const first = await store.select(folder);
  const second = await store.newSession(first.workspace, 'chat');
  await store.selectSession(first.workspace, first.sessionId);
  const info = { scopeId: first.scopeId, objective: 'Синхронизация названий',
    nextTaskTitle: 'Добавить локальное автоимя', scopeStatus: 'ACTIVE' };
  assert.equal(await store.applyScopeTitle(first.workspace, first.sessionId, info), true);
  let session = store.snapshot().projects[0].sessions.find(item => item.sessionId === first.sessionId);
  assert.equal(session.title, 'Синхронизация названий');
  assert.equal(session.titleSource, 'scope');
  assert.equal(session.lastNamedScopeId, first.scopeId);
  assert.equal(await store.setSessionTitle(first.workspace, first.sessionId, 'Поздний заголовок страницы'), false);
  assert.equal(await store.applyScopeTitle(first.workspace, first.sessionId, { ...info, scopeTitle: 'Короткое имя planning' }), true,
    'same-scope legacy scope title migrates to the canonical planning heading');
  session = store.snapshot().projects[0].sessions.find(item => item.sessionId === first.sessionId);
  assert.equal(session.title, 'Короткое имя planning');
  assert.equal(await store.applyScopeTitle(first.workspace, first.sessionId, { ...info, scopeTitle: 'Короткое имя planning', nextTaskTitle: 'Другая задача' }), false,
    'plan revisions and task changes inside one scope do not rename a canonical session title');

  await store.selectSession(first.workspace, second.sessionId);
  assert.equal(await store.applyScopeTitle(first.workspace, second.sessionId, info), false,
    'switching to an existing chat never transfers the current scope title');
  session = store.snapshot().projects[0].sessions.find(item => item.sessionId === second.sessionId);
  assert.equal(session.title, '');
  assert.equal(session.lastNamedScopeId, null);

  const planFile = path.join(folder, '.harness/plans/todo-plan.md');
  const text = await fs.readFile(planFile, 'utf8');
  const block = text.match(/<!-- workflow-state:begin -->\s*```json\s*([\s\S]*?)```\s*<!-- workflow-state:end -->/);
  const plan = JSON.parse(block[1]); plan.objective = info.objective;
  await fs.writeFile(planFile, '<!-- workflow-state:begin -->\n```json\n' + JSON.stringify(plan) + '\n```\n<!-- workflow-state:end -->');
  const third = await store.newSession(first.workspace, 'chat');
  assert.equal(third.title, 'Синхронизация названий');
  assert.equal(third.titleSource, 'scope');
  assert.equal(third.lastNamedScopeId, first.scopeId);
  assert.equal(await store.renameSession(first.workspace, third.sessionId, 'Моё название'), true);
  assert.equal(await store.setSessionTitle(first.workspace, third.sessionId, 'Поздний заголовок страницы'), false);
  session = store.snapshot().projects[0].sessions.find(item => item.sessionId === third.sessionId);
  assert.equal(session.title, 'Моё название');
  assert.equal(session.titleSource, 'manual');
});

test('session titles use one concise Unicode and UTF-8 safe limit', async t => {
  const { project, store } = await fixture(t);
  const first = await store.select(await project('Safe session title'));
  assert.equal(await store.renameSession(first.workspace, first.sessionId, 'Я'.repeat(120)), true);
  const title = store.selected().title;
  assert.equal(Array.from(title).length, 80);
  assert.ok(Buffer.byteLength(title, 'utf8') <= 200);
});

test('switching project cannot mutate another chat or accept late session results', async t => {
  const { project, store } = await fixture(t);
  const a = await store.select(await project('A')); const b = await store.select(await project('B'));
  assert.notEqual(a.sessionId, b.sessionId);
  const url = 'https://chatgpt.com/c/aaaaaaaa';
  await store.bindChat(a.workspace, a.sessionId, url);
  await assert.rejects(store.bindChat(b.workspace, b.sessionId, url), { code: 'CHAT_IN_USE' });
  await assert.rejects(store.bindChat(a.workspace, a.sessionId, 'https://chatgpt.com/c/bbbbbbbb'), { code: 'CHAT_CHANGED' });
  const newA = await store.newChat(a.workspace);
  assert.notEqual(newA.sessionId, a.sessionId);
  await assert.rejects(store.updateSession(a.workspace, a.sessionId, { receipt: {} }), { code: 'SESSION_CHANGED' });
  assert.equal(store.selected().workspace, b.workspace);
  assert.equal(store.project(a.workspace).receipt, null);
});



test('first session experience is chosen only for a newly registered project', async t => {
  const { project, store } = await fixture(t);
  const folder = await project('First Work');
  const first = await store.select(folder, { experience: 'work' });
  assert.equal(first.experience, 'work');
  const reopened = await store.select(folder, { experience: 'chat' });
  assert.equal(reopened.sessionId, first.sessionId);
  assert.equal(reopened.experience, 'work', 'reopening a known project never replaces first-session experience');
  assert.equal(store.snapshot().projects[0].sessions.length, 1);
});

test('session experience persists, migrates from v3, and rejects cross-experience URLs', async t => {
  const { project, store } = await fixture(t);
  const chat = await store.select(await project('Experiences'));
  assert.equal(chat.experience, 'chat');
  await store.bindChat(chat.workspace, chat.sessionId, 'https://chatgpt.com/c/chat-session');
  const work = await store.newSession(chat.workspace, 'work');
  assert.equal(work.experience, 'work');
  await store.bindChat(chat.workspace, work.sessionId, 'https://chatgpt.com/c/work-session');
  assert.equal(store.selected().experience, 'work');
  assert.equal(store.selected().chatUrl, 'https://chatgpt.com/c/work-session');
  await assert.rejects(store.newSession(chat.workspace, 'astra'), { code: 'SESSION_EXPERIENCE' });
  const saved = store.snapshot();
  assert.deepEqual(saved.projects[0].sessions.map(session => session.experience), ['chat', 'work']);
  const restarted = new WorkspaceSessions(store.file); await restarted.load();
  assert.equal(restarted.project(chat.workspace).experience, 'work');
  assert.equal(restarted.project(chat.workspace).chatUrl, 'https://chatgpt.com/c/work-session');

  const chatOnly = await store.select(await project('Chat only'));
  await assert.rejects(store.bindChat(chatOnly.workspace, chatOnly.sessionId, 'https://chatgpt.com/work/not-chat'), { code: 'CHAT_EXPERIENCE_MISMATCH' });

  const v3 = structuredClone(saved); v3.schemaVersion = 3;
  v3.projects[0].sessions[1].chatUrl = 'https://chatgpt.com/work/legacy-work';
  for (const session of v3.projects[0].sessions) delete session.experience;
  const original = JSON.stringify(v3); await fs.writeFile(store.file, original);
  const migrated = new WorkspaceSessions(store.file); await migrated.load();
  assert.equal(migrated.snapshot().schemaVersion, 6);
  assert.deepEqual(migrated.snapshot().projects[0].sessions.map(session => session.experience), ['chat', 'work']);
  assert.equal(await fs.readFile(store.file + '.v3-backup', 'utf8'), original);
  assert.equal(conversationExperience('https://chatgpt.com/c/aaaaaaaa'), 'chat');
  assert.equal(conversationExperience('https://chatgpt.com/work/aaaaaaaa'), 'work');
  assert.equal(conversationExperience('https://chatgpt.com/'), null);
  assert.equal(conversationUrlCompatibleWithExperience('https://chatgpt.com/c/aaaaaaaa', 'work'), true);
  assert.equal(conversationUrlCompatibleWithExperience('https://chatgpt.com/work/aaaaaaaa', 'chat'), false);
});



test('session archive switches selection, blocks the last active session, restores, and persists', async t => {
  let clock = 1000;
  const { project, root } = await fixture(t);
  const store = new WorkspaceSessions(path.join(root, 'app-data/archive-sessions.json'), { now: () => ++clock });
  const first = await store.select(await project('Session archive'));
  const second = await store.newSession(first.workspace, 'chat');
  const third = await store.newSession(first.workspace, 'work');
  await store.selectSession(first.workspace, first.sessionId);
  await store.setSessionArchived(first.workspace, first.sessionId, true);
  assert.equal(store.selected().sessionId, third.sessionId, 'most recently opened remaining session becomes selected');
  let raw = store.snapshot().projects[0];
  assert.ok(raw.sessions.find(session => session.sessionId === first.sessionId).archivedAt);
  await assert.rejects(store.selectSession(first.workspace, first.sessionId), { code: 'SESSION_ARCHIVED' });
  await store.setSessionArchived(first.workspace, first.sessionId, false);
  assert.equal(raw.sessions?.find?.(session => session.sessionId === first.sessionId)?.experience ?? 'chat', 'chat');
  await store.selectSession(first.workspace, first.sessionId);
  await store.setSessionArchived(first.workspace, second.sessionId, true);
  await store.setSessionArchived(first.workspace, third.sessionId, true);
  await assert.rejects(store.setSessionArchived(first.workspace, first.sessionId, true), { code: 'SESSION_LAST_ACTIVE' });
  const restarted = new WorkspaceSessions(store.file); await restarted.load();
  assert.equal(restarted.snapshot().schemaVersion, 6);
  assert.equal(restarted.snapshot().projects[0].sessions.filter(session => session.archivedAt === null).length, 1);
});

test('forget archived session removes local references but keeps project folder and active sessions', async t => {
  const { root, project, store } = await fixture(t);
  const first = await store.select(await project('Forget session'));
  const second = await store.newSession(first.workspace, 'work');
  await store.bindChat(first.workspace, second.sessionId, 'https://chatgpt.com/c/work-session-delete');
  await store.setSessionArchived(first.workspace, second.sessionId, true);
  const backup = store.snapshot(); backup.schemaVersion = 4;
  for (const item of backup.projects.flatMap(project => project.sessions)) delete item.archivedAt;
  await fs.writeFile(store.file + '.v4-backup', JSON.stringify(backup));
  await fs.writeFile(path.join(path.dirname(store.file), 'diagnostics.jsonl'), [
    JSON.stringify({ workspace: first.workspace, sessionId: second.sessionId, phase: 'test' }),
    JSON.stringify({ workspace: first.workspace, sessionId: first.sessionId, phase: 'keep' }),
  ].join('\n') + '\n');
  await store.forgetArchivedSessions([{ workspace: first.workspace, projectId: first.projectId, sessionId: second.sessionId }]);
  assert.equal(store.snapshot().projects[0].sessions.length, 1);
  assert.equal(store.snapshot().projects[0].sessions[0].sessionId, first.sessionId);
  assert.ok((await fs.stat(first.workspace)).isDirectory());
  const backupAfter = JSON.parse(await fs.readFile(store.file + '.v4-backup', 'utf8'));
  assert.equal(backupAfter.projects[0].sessions.some(session => session.sessionId === second.sessionId), false);
  const diagnostics = await fs.readFile(path.join(path.dirname(store.file), 'diagnostics.jsonl'), 'utf8');
  assert.equal(diagnostics.includes(second.sessionId), false); assert.equal(diagnostics.includes(first.sessionId), true);
});

test('a replacement project is rejected and the original binding is preserved', async t => {
  const { project, store } = await fixture(t);
  const folder = await project('Original'); const a = await store.select(folder);
  await project('Original', randomUUID());
  await assert.rejects(store.select(folder), { code: 'PROJECT_REPLACED' });
  assert.equal(store.project(a.workspace).projectId, a.projectId);
});

test('invalid/missing workspace and malformed storage fail without overwriting data', async t => {
  const { root, store } = await fixture(t);
  await assert.rejects(readWorkspace('relative'), { code: 'WORKSPACE_REQUIRED' });
  await assert.rejects(readWorkspace(root), { code: 'WORKFLOW_NOT_INSTALLED' });
  await fs.mkdir(path.dirname(store.file), { recursive: true });
  await fs.writeFile(store.file, 'broken original');
  await assert.rejects(store.load(), { code: 'SESSIONS_INVALID' });
  assert.equal(await fs.readFile(store.file, 'utf8'), 'broken original');
});

test('only actual HTTPS ChatGPT conversation URLs can be saved', () => {
  for (const url of ['http://chatgpt.com/c/aaaaaaaa', 'https://chatgpt.com.evil.test/c/aaaaaaaa',
    'file:///tmp/chat', 'https://evil@chatgpt.com/c/aaaaaaaa', 'https://chatgpt.com/',
    'https://chatgpt.com/auth/login', 'https://chatgpt.com:444/c/aaaaaaaa']) assert.equal(normalizeChatUrl(url), null);
  assert.equal(normalizeChatUrl('https://chatgpt.com/work/aaaaaaaa'), 'https://chatgpt.com/work/aaaaaaaa');
});

test('new chats retain all previous sessions and their independent context after restart', async t => {
  const { project, store } = await fixture(t);
  const first = await store.select(await project('История'));
  await store.bindChat(first.workspace, first.sessionId, 'https://chatgpt.com/c/first-chat');
  await store.setSessionTitle(first.workspace, first.sessionId, 'Первый разговор');
  await store.updateSession(first.workspace, first.sessionId, { attempt: { state: 'sent', requestId: 'request-1' } });
  const second = await store.newChat(first.workspace);
  await store.bindChat(first.workspace, second.sessionId, 'https://chatgpt.com/c/second-chat');
  await store.updateSession(first.workspace, second.sessionId, { attempt: { state: 'unknown', requestId: 'request-2' } });
  assert.equal(store.snapshot().projects[0].sessions.length, 2);
  await store.selectSession(first.workspace, first.sessionId);
  assert.equal(store.selected().title, 'Первый разговор');
  assert.equal(store.selected().attempt.requestId, 'request-1');
  await store.setExpanded(first.workspace, false);
  const restored = new WorkspaceSessions(store.file); await restored.load();
  assert.equal(restored.selected().sessionId, first.sessionId);
  assert.equal(restored.snapshot().projects[0].expanded, false);
  await restored.selectSession(first.workspace, second.sessionId);
  assert.equal(restored.selected().attempt.state, 'unknown');
  assert.equal(restored.selected().chatUrl, 'https://chatgpt.com/c/second-chat');
});

test('legacy storage migrates intact with an exclusive backup and is not migrated twice', async t => {
  const { project, store } = await fixture(t);
  const original = await store.select(await project('Прежний проект'));
  const legacy = { schemaVersion: 1, selectedWorkspace: original.workspace, projects: [{ ...original,
    chatUrl: 'https://chatgpt.com/c/legacy-chat', attempt: { state: 'sent', text: 'Точный старый текст', requestId: 'legacy-request' },
    receipt: { old: true } }] };
  const text = JSON.stringify(legacy);
  await fs.writeFile(store.file, text);
  const restored = new WorkspaceSessions(store.file); await restored.load();
  assert.equal(restored.snapshot().schemaVersion, 6);
  assert.equal(restored.snapshot().projects[0].sessions.length, 1);
  assert.equal(restored.selected().attempt.text, 'Точный старый текст');
  assert.equal(restored.selected().chatUrl, legacy.projects[0].chatUrl);
  assert.deepEqual(restored.selected().receipt, { old: true });
  assert.equal(await fs.readFile(store.file + '.v1-backup', 'utf8'), text);
  await restored.newChat(original.workspace); await restored.load();
  assert.equal(restored.snapshot().projects[0].sessions.length, 2);
  assert.equal(await fs.readFile(store.file + '.v1-backup', 'utf8'), text);
});

test('session selection and binding reject cross-project or duplicate conversations', async t => {
  const { project, store } = await fixture(t);
  const a = await store.select(await project('A'));
  const b = await store.select(await project('B'));
  await assert.rejects(store.selectSession(a.workspace, b.sessionId), { code: 'SESSION_NOT_FOUND' });
  assert.equal(store.selected().workspace, b.workspace);
  await store.bindChat(a.workspace, a.sessionId, 'https://chatgpt.com/c/one-chat');
  const next = await store.newChat(a.workspace);
  await assert.rejects(store.bindChat(a.workspace, next.sessionId, 'https://chatgpt.com/c/one-chat'), { code: 'CHAT_IN_USE' });
  await assert.rejects(store.setSessionTitle(a.workspace, a.sessionId, 'Late title'), { code: 'SESSION_CHANGED' });
});

test('corrupt histories and invalid selection preserve the original data', async t => {
  const { project, store } = await fixture(t);
  await store.select(await project('A'));
  for (const mutate of [d => d.projects[0].sessions.push({ ...d.projects[0].sessions[0] }),
    d => d.projects[0].selectedSessionId = 'missing', d => d.projects[0].sessions[0].chatUrl = 'https://evil.test/c/anything']) {
    const data = store.snapshot(); mutate(data); const text = JSON.stringify(data);
    await fs.writeFile(store.file, text);
    await assert.rejects(new WorkspaceSessions(store.file).load(), { code: 'SESSIONS_INVALID' });
    assert.equal(await fs.readFile(store.file, 'utf8'), text);
  }
});

test('landing returns to another active project after the selected one is archived or deleted', async t => {
  const { project, store } = await fixture(t);
  const first = await store.select(await project('Первый'));
  const second = await store.select(await project('Второй'));
  assert.equal(store.landing().workspace, second.workspace);
  await store.setArchived(second.workspace, true);
  assert.equal(store.selected(), null);
  assert.equal(store.landing().workspace, first.workspace);
  await store.forgetArchivedMany([{ workspace: second.workspace, projectId: second.projectId }]);
  assert.equal(store.landing().workspace, first.workspace);
  await store.setArchived(first.workspace, true);
  assert.equal(store.landing(), null);
});

test('archive and restore preserve every session, selection and project files', async t => {
  const { project, store } = await fixture(t); const a = await store.select(await project('Архив'));
  await store.bindChat(a.workspace, a.sessionId, 'https://chatgpt.com/c/archive-chat');
  await store.updateSession(a.workspace, a.sessionId, { attempt: { state: 'sent', requestId: 'kept-request' } });
  await store.newChat(a.workspace); await store.selectSession(a.workspace, a.sessionId);
  const before = store.snapshot().projects[0], plan = await fs.readFile(path.join(a.workspace, '.harness/plans/todo-plan.md'));
  await store.setArchived(a.workspace, true); assert.equal(store.selected(), null);
  await assert.rejects(store.select(a.workspace), { code: 'PROJECT_ARCHIVED' });
  await assert.rejects(store.newChat(a.workspace), { code: 'PROJECT_ARCHIVED' });
  await assert.rejects(store.updateSession(a.workspace, a.sessionId, { receipt: {} }), { code: 'PROJECT_ARCHIVED' });
  const restored = new WorkspaceSessions(store.file); await restored.load(); assert.ok(restored.project(a.workspace).archivedAt);
  await restored.setArchived(a.workspace, false);
  assert.deepEqual(restored.snapshot().projects[0], before);
  assert.deepEqual(await fs.readFile(path.join(a.workspace, '.harness/plans/todo-plan.md')), plan);
  const selected = await restored.select(a.workspace); assert.equal(selected.sessionId, a.sessionId); assert.equal(selected.attempt.requestId, 'kept-request');
});
test('version two history migrates with an exact backup and starts active', async t => {
  const { project, store } = await fixture(t); await store.select(await project('Version 2')); await store.newChat(store.selected().workspace);
  const old = store.snapshot(); old.schemaVersion = 2; delete old.projects[0].archivedAt;
  const original = JSON.stringify(old); await fs.writeFile(store.file, original);
  const next = new WorkspaceSessions(store.file); await next.load();
  assert.equal(next.snapshot().schemaVersion, 6); assert.equal(next.selected().archivedAt, null);
  assert.deepEqual(next.snapshot().projects[0].sessions, old.projects[0].sessions.map(session => ({ ...session, experience: conversationExperience(session.chatUrl) ?? 'chat', archivedAt: null })));
  assert.equal(await fs.readFile(store.file + '.v2-backup', 'utf8'), original);
});
test('archive save failure preserves current state and queued edits do not lose other projects', async t => {
  const { project, store } = await fixture(t); const a = await store.select(await project('A')); const b = await store.select(await project('B'));
  const diskBefore = await fs.readFile(store.file), before = store.snapshot(), save = store.save;
  store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(store.setArchived(a.workspace, true), /disk full/);
  assert.deepEqual(store.snapshot(), before); assert.deepEqual(await fs.readFile(store.file), diskBefore);
  store.save = save;
  await Promise.all([store.setArchived(a.workspace, true), store.setSessionTitle(b.workspace, b.sessionId, 'Preserved title')]);
  assert.ok(store.project(a.workspace).archivedAt); assert.equal(store.project(b.workspace).title, 'Preserved title');
  assert.equal(store.selected().workspace, b.workspace);
});
test('forgetting requires an archived matching identity and removes all local sessions only', async t => {
  const { project, store } = await fixture(t); const a = await store.select(await project('Forget'));
  await store.newChat(a.workspace);
  await assert.rejects(store.forgetArchived(a.workspace, a.projectId), { code: 'PROJECT_NOT_ARCHIVED' });
  await store.setArchived(a.workspace, true);
  await assert.rejects(store.forgetArchived(a.workspace, 'wrong-id'), { code: 'PROJECT_REPLACED' });
  await store.forgetArchived(a.workspace, a.projectId);
  assert.equal(store.project(a.workspace), null); assert.equal(store.snapshot().projects.length, 0);
  assert.ok((await fs.stat(a.workspace)).isDirectory(), 'Metadata operation never deletes files');
});

test('forgetting several archived projects is atomic and leaves folders untouched', async t => {
  const { project, store } = await fixture(t);
  const a = await store.select(await project('Forget A'));
  const b = await store.select(await project('Forget B'));
  const c = await store.select(await project('Keep active'));
  await store.setArchived(a.workspace, true); await store.setArchived(b.workspace, true);
  const before = store.snapshot();
  await assert.rejects(store.forgetArchivedMany([
    { workspace: a.workspace, projectId: a.projectId },
    { workspace: c.workspace, projectId: c.projectId },
  ]), { code: 'PROJECT_NOT_ARCHIVED' });
  assert.deepEqual(store.snapshot(), before, 'failed batch is atomic');
  assert.equal(await store.forgetArchivedMany([
    { workspace: a.workspace, projectId: a.projectId },
    { workspace: b.workspace, projectId: b.projectId },
  ]), 2);
  assert.equal(store.project(a.workspace), null); assert.equal(store.project(b.workspace), null); assert.ok(store.project(c.workspace));
  assert.ok((await fs.stat(a.workspace)).isDirectory()); assert.ok((await fs.stat(b.workspace)).isDirectory());
});

test('retired token estimates are removed on load without changing sessions or archive state', async t => {
  const { store, project } = await fixture(t);
  const folder = await fs.realpath(await project('Counter removal'));
  await store.load();
  await store.select(folder);
  const first = store.selected();
  await store.bindChat(folder, first.sessionId, 'https://chatgpt.com/c/removed-counter-chat');
  await store.newSession(folder, 'work');
  const second = store.selected();
  await store.bindChat(folder, second.sessionId, 'https://chatgpt.com/c/removed-counter-work');
  await store.setSessionArchived(folder, first.sessionId, true);
  const expected = store.snapshot();
  const old = structuredClone(expected);
  for (const session of old.projects[0].sessions) {
    session.tokenEstimate = { obsolete: true, total: 4052533, messages: { unused: { tokens: 4052533 } } };
  }
  await fs.writeFile(store.file, JSON.stringify(old));
  const reopened = new WorkspaceSessions(store.file);
  await reopened.load();
  assert.deepEqual(reopened.snapshot(), expected);
  assert.deepEqual(JSON.parse(await fs.readFile(store.file, 'utf8')), expected);
  reopened.save = () => { throw new Error('Already clean storage must not be rewritten'); };
  await reopened.load();
  assert.deepEqual(reopened.snapshot(), expected);
});

async function changeScopePlan(folder, patch) {
  const file = path.join(folder, '.harness/plans/todo-plan.md');
  const text = await fs.readFile(file, 'utf8');
  const plan = JSON.parse(text.match(/```json\s*([\s\S]*?)```/)[1]);
  Object.assign(plan, patch);
  plan.plan_revision++;
  await fs.writeFile(file, '<!-- workflow-state:begin -->\n```json\n' + JSON.stringify(plan) + '\n```\n<!-- workflow-state:end -->');
}

test('project selection chooses newest created active session without reordering stored history or reload selection', async t => {
  const { store, project } = await fixture(t);
  let time = 100;
  store.now = () => time;
  const input = await project('Recent sessions');
  const first = await store.select(input);
  const folder = first.workspace;
  const firstUrl = 'https://chatgpt.com/c/aaaaaaaa-1111-2222-3333-eeeeeeeeeeee';
  await store.bindChat(folder, first.sessionId, firstUrl);
  time = 200;
  const second = await store.newSession(folder, 'work');
  const third = await store.newSession(folder, 'chat');
  const order = () => activeSessionsNewestFirst(store.snapshot().projects.find(p => p.workspace === folder).sessions).map(s => s.sessionId);
  assert.deepEqual(order(), [third.sessionId, second.sessionId, first.sessionId], 'equal creation times use reverse insertion order');
  time = 500;
  await store.selectSession(folder, first.sessionId);
  assert.deepEqual(order(), [third.sessionId, second.sessionId, first.sessionId], 'opening old history does not promote it');
  assert.equal((await store.select(folder)).sessionId, first.sessionId, 'service reload preserves selection');
  const newest = await store.select(folder, { latest: true });
  assert.equal(newest.sessionId, third.sessionId);
  assert.equal(store.project(folder).expanded, true);
  assert.deepEqual(store.snapshot().projects.find(p => p.workspace === folder).sessions.map(s => s.sessionId), [first.sessionId, second.sessionId, third.sessionId], 'projection does not mutate storage order');
  await store.setSessionArchived(folder, third.sessionId, true);
  assert.equal((await store.select(folder, { latest: true })).sessionId, second.sessionId, 'archive is excluded');
  await store.selectSession(folder, first.sessionId);
  const restarted = new WorkspaceSessions(store.file);
  await restarted.load();
  assert.equal((await restarted.select(folder)).sessionId, first.sessionId, 'restart preserves explicitly chosen old conversation');
  assert.equal(restarted.selected().chatUrl, firstUrl);
  assert.equal((await restarted.select(folder, { latest: true })).sessionId, second.sessionId);
  assert.deepEqual(activeSessionsNewestFirst([]), []);
});

test('v5 migration backs up evidence and never guesses when several chats received the same scope', async t => {
  const { project, store } = await fixture(t);
  const first = await store.select(await project('Evidence'));
  const second = await store.newSession(first.workspace, 'work');
  const third = await store.newSession(first.workspace, 'chat');
  const old = store.snapshot(); old.schemaVersion = 5;
  for (const session of old.projects[0].sessions) {
    delete session.planId; delete session.originSessionId; delete session.legacyPlanId; delete session.planBinding;
    session.attempt = { state: 'sent', packet: { facts: { project_id: first.projectId, scope_id: session.sessionId === first.sessionId ? 'unique' : 'ambiguous' } } };
  }
  const text = JSON.stringify(old); await fs.writeFile(store.file, text);
  const migrated = new WorkspaceSessions(store.file); await migrated.load();
  assert.equal(await fs.readFile(store.file + '.v5-backup', 'utf8'), text);
  const sessions = migrated.snapshot().projects[0].sessions;
  assert.equal(sessions[0].legacyPlanId, 'unique'); assert.equal(sessions[0].planId, null);
  assert.equal(sessions[1].legacyPlanId, null); assert.equal(sessions[2].legacyPlanId, null);
  assert.equal(sessions[1].planBinding, 'unresolved');
  assert.deepEqual(sessions.map(s => [s.sessionId,s.experience,s.chatUrl,s.title,s.archivedAt]), old.projects[0].sessions.map(s => [s.sessionId,s.experience,s.chatUrl,s.title,s.archivedAt]));
  assert.equal('planView' in JSON.parse(await fs.readFile(store.file,'utf8')).projects[0],false);
});

test('legacy plan metadata remains readable but cannot select the runtime plan', async t => {
  const { project, store } = await fixture(t);
  const selected = await store.select(await project('Legacy metadata'));
  const saved = store.snapshot();
  const session = saved.projects[0].sessions[0];
  session.planId = 'historical-plan';
  session.originSessionId = 'historical-origin';
  session.legacyPlanId = 'historical-plan';
  session.planBinding = 'bound';
  await fs.writeFile(store.file, JSON.stringify(saved, null, 2) + '\n');

  const restarted = new WorkspaceSessions(store.file); await restarted.load();
  const raw = restarted.snapshot().projects[0].sessions[0];
  assert.equal(raw.legacyPlanId, 'historical-plan');
  assert.equal(raw.planId, 'historical-plan');
  const projected = await restarted.selectSession(selected.workspace, selected.sessionId);
  assert.equal(projected.planId, 'fixture-scope');
  assert.equal(projected.originSessionId, null);
  assert.equal(projected.scopeId, 'fixture-scope');
});

test('slow projections do not hold mutations; A-B-A selects and persists only the newest generation', async t => {
  const { project, store } = await fixture(t);
  const first = await store.select(await project('A')), second = await store.select(await project('B'));
  const a = first.workspace, b = second.workspace;
  const read = store.inspect, requests = [];
  store.inspect = (workspace, sessionId) => new Promise(resolve => requests.push({ workspace, sessionId, resolve }));
  const a1 = store.selectSession(a, first.sessionId), b1 = store.selectSession(b, second.sessionId), a2 = store.selectSession(a, first.sessionId);
  await store.setProjectDisplayName(b, 'B переименован'); // Must finish while all three reads are still pending.
  assert.equal(requests.length, 3);
  const resolve = async (i, revision) => requests[i].resolve({ ...await read(requests[i].workspace, requests[i].sessionId), planRevision: revision });
  await resolve(2, 102); await a2;
  await resolve(1, 101); assert.equal(await b1, null);
  await resolve(0, 100); assert.equal(await a1, null);
  assert.equal(store.selected().workspace, a); assert.equal(store.selected().planRevision, 102);
  assert.equal(store.selected().sessionId, first.sessionId);
  const disk = new WorkspaceSessions(store.file); await disk.load();
  assert.equal(disk.selected().workspace, a); assert.equal(disk.selected().planRevision, 102);
  assert.equal(disk.project(b).displayName, 'B переименован');
});

test('selection cancelled during an atomic save restores the previous disk snapshot', async t => {
  const { project, store } = await fixture(t);
  const a = await project('A'), b = await project('B');
  const first = await store.select(a), second = await store.select(b);
  let current = true, renamed;
  const afterRename = new Promise(resolve => { renamed = resolve; });
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const save = store.save.bind(store);
  store.save = async (...args) => { const result = await save(...args); if (args.length === 2) { renamed(); await hold; } return result; };
  const selecting = store.selectSession(a, first.sessionId, { isCurrent: () => current });
  await afterRename; current = false; release();
  assert.equal(await selecting, null);
  const disk = new WorkspaceSessions(store.file); await disk.load();
  assert.equal(store.selected().sessionId, second.sessionId); assert.equal(disk.selected().sessionId, second.sessionId);
});

test('agent time accumulates per session, survives restart and rejects malformed values', async t => {
  const { store, project } = await fixture(t);
  const folder = await fs.realpath(await project('Agent time'));
  await store.load();
  await store.select(folder);
  const first = store.selected().sessionId;
  assert.equal(await store.recordAgentTime(folder, first, 65400.4), true);
  await store.newSession(folder, 'chat');
  const second = store.selected().sessionId;
  assert.equal(await store.recordAgentTime(folder, first, 1000), true, 'a request finishing after a switch still belongs to its own session');
  assert.equal(await store.recordAgentTime(folder, 'missing-session', 1000), false);
  await assert.rejects(store.recordAgentTime(folder, first, -1), RangeError);
  await assert.rejects(store.recordAgentTime(folder, first, Number.NaN), RangeError);
  const sessions = () => store.snapshot().projects[0].sessions;
  assert.deepEqual(sessions().find(s => s.sessionId === first).agentTime, { totalMs: 66400, lastMs: 1000 });
  assert.equal(sessions().find(s => s.sessionId === second).agentTime, undefined);
  assert.equal(store.selected().sessionId, second, 'recording never changes the selection');
  const reopened = new WorkspaceSessions(store.file); await reopened.load();
  assert.deepEqual(reopened.snapshot().projects[0].sessions.find(s => s.sessionId === first).agentTime, { totalMs: 66400, lastMs: 1000 });
  for (const agentTime of [{ totalMs: 5, lastMs: 6 }, { totalMs: -1, lastMs: 0 }, { totalMs: 1.5, lastMs: 0 }, [], 'x']) {
    const broken = store.snapshot(); broken.projects[0].sessions[0].agentTime = agentTime;
    await fs.writeFile(store.file, JSON.stringify(broken));
    await assert.rejects(new WorkspaceSessions(store.file).load(), { code: 'SESSIONS_INVALID' });
  }
});
test('manual conversation binding persists independently of context delivery', async t => {
  const { store, project } = await fixture(t);
  const folder = await fs.realpath(await project('Manual chat')); await store.select(folder);
  const id = store.selected().sessionId;
  await store.bindChat(folder, id, 'https://chatgpt.com/c/manual-one', { manual: true });
  const reopened = new WorkspaceSessions(store.file); await reopened.load();
  assert.equal(reopened.selected().manualStart, true);
  assert.equal(reopened.selected().attempt, null);
  assert.equal(reopened.selected().chatUrl, 'https://chatgpt.com/c/manual-one');
  await assert.rejects(store.bindChat(folder, id, 'https://chatgpt.com/c/foreign-other', { manual: true }), { code: 'CHAT_CHANGED' });
});

test('a mutation that changes nothing does not rewrite the store', async t => {
  const { project, store } = await fixture(t);
  await store.select(await project('Без лишней записи'));
  let saves = 0; const save = store.save.bind(store);
  store.save = (...args) => { saves++; return save(...args); };
  assert.equal(await store.mutate(() => 'same'), 'same');
  assert.equal(saves, 0, 'unchanged data is not written');
  await store.mutate(data => { data.projects[0].displayName = 'Новое имя'; });
  assert.equal(saves, 1);
});
