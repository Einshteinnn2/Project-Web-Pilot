import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import { WorkspaceSessions } from '../src/workspace-session.mjs';
import { WorkspaceDeletion } from '../src/workspace-deletion.mjs';

async function boundChild(store,a,id) {
  const {createHash}=await import('node:crypto'),git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try{git(a,'rev-parse','HEAD');}catch{
    git(a,'init');git(a,'config','user.name','Fixture');git(a,'config','user.email','fixture@example.invalid');git(a,'add','.');git(a,'commit','-m','fixture');
  }
  const origin=store.project(a),worktree=path.join(path.dirname(a),'.web-pilot-worktrees',createHash('sha256').update(a).digest('hex').slice(0,16),id);
  await fs.mkdir(path.dirname(worktree),{recursive:true});git(a,'worktree','add','-b',id,worktree);
  const assignment={id,parent_root:a,worktree,base_commit:git(a,'rev-parse','HEAD'),parent_scope_id:'scope',parent_task_id:'T001',phase:'INTEGRATED',title:id};
  const admin=git(worktree,'rev-parse','--absolute-git-dir');
  await fs.mkdir(path.join(admin,'workflow-kit'),{recursive:true});await fs.mkdir(path.join(a,'.git/workflow-kit/assignments'),{recursive:true});
  await fs.writeFile(path.join(admin,'workflow-kit/assignment.json'),JSON.stringify(assignment));
  await fs.writeFile(path.join(a,'.git/workflow-kit/assignments',id+'.json'),JSON.stringify(assignment));
  await store.ensureExecutor(assignment,origin);
  return worktree;
}

test('legacy migration needs committed ownership, keeps foreign and missing parents as recovery records',async t=>{
  const {store,project}=await fixture(t),a=await project('A'),child=await boundChild(store,a,'legacy');
  const saved=store.data.projects.find(p=>p.workspace===child);
  delete saved.parentProjectId;for(const s of saved.sessions)delete s.parentProjectId;
  await store.save();const restart=new WorkspaceSessions(store.file);await restart.load();
  assert.equal(restart.project(child).parentProjectId,'A');
  assert.equal(restart.project(child).ownershipState,'confirmed');
  delete saved.parentProjectId;store.data.projects.find(p=>p.workspace===a).projectId='replacement';await store.save();
  const replaced=new WorkspaceSessions(store.file);await replaced.load();
  assert.equal(replaced.project(child).parentProjectId,undefined);assert.equal(replaced.project(child).ownershipState,'recovery');
  await assert.rejects(replaced.selectSession(child,replaced.project(child).sessionId),{code:'ASSIGNMENT_OWNER'});
  store.data.projects=store.data.projects.filter(p=>p.workspace!==a);await store.save();
  const missing=new WorkspaceSessions(store.file);await missing.load();
  assert.equal(missing.project(child).ownershipState,'recovery');assert.equal(missing.landing(),null);
});

test('multiple owned children are journaled, archived with parent visibility, and cleaned after restart',async t=>{
  const {store,service,project}=await fixture(t),a=await project('A'),b=await project('B');
  const one=await boundChild(store,a,'one'),two=await boundChild(store,a,'two');
  await store.selectSession(one,store.project(one).sessionId);await store.setArchived(a,true);
  assert.equal(store.selected(),null);assert.equal(store.landing().workspace,b);
  service.prepare=()=>store.saveExecutorTime(one,store.project(one).sessionId,{activeMs:10,waitingMs:5});
  service.cleanup=async()=>{throw Error('restart checkpoint');};
  const preview=await service.preview(a);await assert.rejects(service.apply(preview.token,preview.name),/restart checkpoint/);
  const restart=new WorkspaceDeletion({store,journalDir:service.journalDir});assert.deepEqual(await restart.recover(),[]);
  assert.equal(store.project(one),null);assert.equal(store.project(two),null);assert.ok(store.project(b));
  assert.deepEqual(await restart.recover(),[]);
});

test('a replaced child directory stops journal recovery before parent removal',async t=>{
  const {store,service,project}=await fixture(t),a=await project('A'),child=await boundChild(store,a,'replace');
  await store.setArchived(a,true);service.finish=async()=>{throw Error('interrupt');};
  const preview=await service.preview(a);await assert.rejects(service.apply(preview.token,preview.name),/interrupt/);
  await fs.rename(child,child+'-original');await fs.mkdir(child);await fs.writeFile(path.join(child,'foreign'),'keep');
  const restarted=new WorkspaceDeletion({store,journalDir:service.journalDir});
  assert.ok((await restarted.recover()).length);assert.equal(await fs.readFile(path.join(child,'foreign'),'utf8'),'keep');
  assert.ok(await fs.stat(a));
});

test('characterization: two confirmed journals stay pending after parent and executor folders disappear',async t=>{
  const {root,store,service,project}=await fixture(t);
  const parent=await project('Мастерская файлов параллельно'),neighbour=await project('Соседний');
  const child=await boundChild(store,parent,'wp-lost-child');
  const childSessionId=store.project(child).sessionId;
  await store.setArchived(parent,true);
  await store.setArchived(child,true);

  // Both real preview/apply calls persist a confirmed journal before the simulated interruption.
  service.finish=async()=>{throw Error('fixture: interruption before rename');};
  for(const workspace of [parent,child]) {
    const preview=await service.preview(workspace);
    await assert.rejects(service.apply(preview.token,preview.name),/fixture: interruption/);
  }
  const journalNames=(await fs.readdir(service.journalDir)).sort();
  assert.equal(journalNames.length,2);
  const journals=await Promise.all(journalNames.map(name=>fs.readFile(path.join(service.journalDir,name),'utf8').then(JSON.parse)));
  assert.deepEqual(new Set(journals.map(job=>job.workspace)),new Set([parent,child]));
  assert.ok(journals.every(job=>job.stage==='confirmed'&&!job.missing&&job.identity?.ino));
  assert.deepEqual(journals.find(job=>job.workspace===parent).related.map(item=>item.workspace),[child]);

  await fs.rm(child,{recursive:true});
  await fs.rmdir(path.dirname(child)); // The normal cleanup may remove this hashed group.
  await fs.rm(parent,{recursive:true});
  for(const job of journals) {
    await assert.rejects(fs.lstat(job.workspace),{code:'ENOENT'});
    await assert.rejects(fs.lstat(job.quarantine),{code:'ENOENT'});
  }
  const restarted=new WorkspaceDeletion({store,journalDir:service.journalDir});
  const errors=await restarted.recover();
  assert.equal(errors.length,2);
  assert.deepEqual(new Set(errors.map(e=>e.workspace)),new Set([parent,child]));
  assert.ok(errors.every(e=>e.code==='DELETE_PATH_CHANGED'));
  assert.equal(restarted.isPending(parent),true);
  assert.equal(restarted.isPending(child),true);
  assert.equal(store.project(parent).archivedAt!==null,true);
  assert.equal(store.project(child,childSessionId).sessionId,childSessionId);
  assert.equal((await fs.readdir(service.journalDir)).length,2);
  assert.equal(store.project(neighbour).workspace,neighbour);
  assert.equal(await fs.readFile(path.join(neighbour,'my-file.txt'),'utf8'),'keep until confirmed');
  assert.ok(store.file.startsWith(root+path.sep),'the test store must stay inside the temporary fixture');
  assert.deepEqual(await restarted.recover(),errors,'repeated recovery preserves the same pending journals');

  // T002/T003: replace current-error assertions with the successful post-fix contract:
  // assert.deepEqual(await restarted.recover(), []);
  // assert.equal(store.project(parent), null);
  // assert.equal(store.project(child), null);
  // assert.deepEqual(await fs.readdir(service.journalDir), []);
  // assert.deepEqual(await restarted.recover(), []);
  // assert.ok(store.project(neighbour));
});

test('characterization: confirmed journal refuses a new directory at the deleted project path',async t=>{
  const {root,store,service,project}=await fixture(t);
  const parent=await project('Удаляемый'),neighbour=await project('Соседний');
  await store.setArchived(parent,true);
  service.finish=async()=>{throw Error('fixture: interruption before rename');};
  const preview=await service.preview(parent);
  await assert.rejects(service.apply(preview.token,preview.name),/fixture: interruption/);
  const [name]=await fs.readdir(service.journalDir);
  const journal=JSON.parse(await fs.readFile(path.join(service.journalDir,name),'utf8'));
  assert.equal(journal.stage,'confirmed');
  const saved=path.join(root,'original-project');
  await fs.rename(parent,saved);
  await fs.mkdir(parent);
  await fs.writeFile(path.join(parent,'replacement.txt'),'new owner must survive');
  const restarted=new WorkspaceDeletion({store,journalDir:service.journalDir});
  assert.deepEqual((await restarted.recover()).map(e=>e.code),['DELETE_PATH_CHANGED']);
  assert.equal(await fs.readFile(path.join(parent,'replacement.txt'),'utf8'),'new owner must survive');
  assert.equal(await fs.readFile(path.join(saved,'my-file.txt'),'utf8'),'keep until confirmed');
  assert.equal(await fs.readFile(path.join(neighbour,'my-file.txt'),'utf8'),'keep until confirmed');
  assert.ok(store.project(parent).archivedAt);
  assert.deepEqual(await fs.readdir(service.journalDir),[name]);

  // T002 must keep refusing any replacement even after introducing missing-folder recovery.
});


const directoryLink = (target, link) => fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'web-pilot-delete-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkspaceSessions(path.join(root, 'app/workspaces.json'));
  const service = new WorkspaceDeletion({ store, journalDir: path.join(root, 'app/deletions') });
  const project = async name => {
    const folder = path.join(root, name);
    await fs.mkdir(path.join(folder, '.harness/plans'), { recursive: true }); await fs.mkdir(path.join(folder, 'scripts'));
    const plan = { schema_version: 1, project_id: name, project_name: name, plan_revision: 1, scope_id:'scope', tasks: [] };
    await fs.writeFile(path.join(folder, '.harness/plans/todo-plan.md'), '<!-- workflow-state:begin -->\n```json\n' + JSON.stringify(plan) + '\n```\n<!-- workflow-state:end -->');
    await fs.writeFile(path.join(folder, 'scripts/workflow.mjs'), ''); await fs.writeFile(path.join(folder, 'my-file.txt'), 'keep until confirmed');
    await store.select(folder); return folder;
  };
  return { root, store, service, project };
}

test('confirmed archive deletion removes files, all local sessions and backup references, preserving outside symlink targets', async t => {
  const { root, store, service, project } = await fixture(t); const a = await project('Удаляемый'), b = await project('Соседний');
  await store.newChat(a); await store.bindChat(a, store.project(a).sessionId, 'https://chatgpt.com/c/keep-cloud-chat');
  await directoryLink(b, path.join(a, 'outside-link'));
  for (const version of [1, 2, 3, 4, 5]) await fs.writeFile(store.file + `.v${version}-backup`, JSON.stringify(store.snapshot()));
  await fs.writeFile(path.join(root, 'app/diagnostics.jsonl'), [a, b].map(workspace => JSON.stringify({ workspace })).join('\n') + '\n');
  await store.setArchived(a, true); const p = await service.preview(a);
  assert.equal(p.sessionCount, 2); assert.ok(p.bytes > 0); assert.equal(await fs.readFile(path.join(a, 'my-file.txt'), 'utf8'), 'keep until confirmed');
  await assert.rejects(service.apply(p.token, 'wrong'), { code: 'DELETE_CONFIRMATION' });
  await service.apply(p.token, 'Удаляемый');
  await assert.rejects(fs.stat(a), { code: 'ENOENT' }); assert.ok(await fs.stat(b)); assert.equal(store.project(a), null);
  assert.equal(store.selected().workspace, b); assert.equal((await fs.readdir(service.journalDir)).length, 0);
  for (const version of [1, 2, 3, 4, 5]) {
    const copy = JSON.parse(await fs.readFile(store.file + `.v${version}-backup`));
    assert.deepEqual(copy.projects.map(item => item.workspace), [b], `v${version} copy keeps only the neighbour`);
  }
  assert.deepEqual(JSON.parse((await fs.readFile(path.join(root, 'app/diagnostics.jsonl'), 'utf8')).trim()), { workspace: b });
});

test('project deletion removes orphan temporary copies of the store that still hold the project', async t => {
  const { root, store, service, project } = await fixture(t); const a = await project('Удаляемый'), b = await project('Соседний');
  const orphans = [store.file + '.tmp-0a26bc01-4d21-4c3f-8d83-6becf46588c6', store.file + '.v3-backup.tmp', path.join(root, 'app/diagnostics.jsonl.tmp-session-archive')];
  for (const file of orphans) await fs.writeFile(file, JSON.stringify(store.snapshot()));
  const foreign = path.join(root, 'app/notes.tmp-keep');
  await fs.writeFile(foreign, 'not ours');
  await store.setArchived(a, true); const p = await service.preview(a);
  await service.apply(p.token, 'Удаляемый');
  for (const file of orphans) await assert.rejects(fs.stat(file), { code: 'ENOENT' }, file);
  assert.equal(await fs.readFile(foreign, 'utf8'), 'not ours');
  assert.equal(store.selected().workspace, b);
});

test('active, protected, nested, replaced and symlink roots cannot be deleted', async t => {
  const { root, store, service, project } = await fixture(t); const a = await project('A');
  await assert.rejects(service.preview(a), { code: 'PROJECT_NOT_ARCHIVED' }); await store.setArchived(a, true);
  service.protectedPaths = [path.join(a, 'scripts')]; await assert.rejects(service.preview(a), { code: 'DELETE_PROTECTED' }); service.protectedPaths = [];
  const b = await project('B'); const item = store.data.projects.find(p => p.workspace === b); item.workspace = path.join(a, 'nested');
  await assert.rejects(service.preview(a), { code: 'DELETE_NESTED_PROJECT' }); item.workspace = b;
  const planFile = path.join(a, '.harness/plans/todo-plan.md'); const plan = await fs.readFile(planFile, 'utf8');
  await fs.writeFile(planFile, plan.replace('"project_id":"A"', '"project_id":"replacement"'));
  await assert.rejects(service.preview(a), { code: 'PROJECT_REPLACED' }); await fs.writeFile(planFile, plan);
  await fs.rename(a, path.join(root, 'original')); await directoryLink(b, a);
  await assert.rejects(service.preview(a), { code: 'DELETE_PATH_CHANGED' }); assert.ok(await fs.stat(b));
});

test('cancelled and stale confirmations cannot delete changed files or a replacement folder', async t => {
  const { root, store, service, project } = await fixture(t); const a = await project('A'); await store.setArchived(a, true);
  let p = await service.preview(a); service.clear(); await assert.rejects(service.apply(p.token, p.name), { code: 'DELETE_PREVIEW_EXPIRED' });
  p = await service.preview(a); await fs.writeFile(path.join(a, 'new.txt'), 'new work');
  await assert.rejects(service.apply(p.token, p.name), { code: 'DELETE_PREVIEW_CHANGED' });
  p = await service.preview(a); await fs.rename(a, path.join(root, 'saved-original')); await fs.mkdir(a);
  await assert.rejects(service.apply(p.token, p.name)); assert.ok(await fs.stat(a)); assert.ok(await fs.stat(path.join(root, 'saved-original')));
});

test('interrupted local metadata cleanup resumes without deleting a replacement at the old path', async t => {
  const { store, service, project } = await fixture(t); const a = await project('A'); await store.setArchived(a, true);
  const original = store.forgetDeletedProject.bind(store); store.forgetDeletedProject = async () => { throw new Error('disk failure'); };
  const p = await service.preview(a); await assert.rejects(service.apply(p.token, p.name), /disk failure/);
  assert.equal(service.isPending(a), true); await assert.rejects(fs.stat(a), { code: 'ENOENT' }); assert.ok(store.project(a).archivedAt);
  await fs.mkdir(a); await fs.writeFile(path.join(a, 'replacement.txt'), 'preserve'); store.forgetDeletedProject = original;
  const restarted = new WorkspaceDeletion({ store, journalDir: service.journalDir }); assert.deepEqual(await restarted.recover(), []);
  assert.equal(store.project(a), null); assert.equal(await fs.readFile(path.join(a, 'replacement.txt'), 'utf8'), 'preserve');
});

test('an already missing archived folder requires explicit confirmation to clear local history', async t => {
  const { store, service, project } = await fixture(t); const a = await project('A'); await store.setArchived(a, true); await fs.rm(a, { recursive: true });
  const p = await service.preview(a); assert.equal(p.missing, true); assert.ok(store.project(a));
  await service.apply(p.token, p.name); assert.equal(store.project(a), null);
});

test('recovery completes a confirmed rename interrupted before recording removal stage', async t => {
  const { store, service, project } = await fixture(t); const a = await project('A'); await store.setArchived(a, true);
  service.saveJob = async () => { throw new Error('interrupted'); };
  const p = await service.preview(a); await assert.rejects(service.apply(p.token, p.name), /interrupted/);
  const journal = JSON.parse(await fs.readFile(path.join(service.journalDir, (await fs.readdir(service.journalDir))[0])));
  assert.equal(journal.stage, 'confirmed'); assert.ok(await fs.stat(journal.quarantine));
  const restarted = new WorkspaceDeletion({ store, journalDir: service.journalDir }); assert.deepEqual(await restarted.recover(), []);
  await assert.rejects(fs.stat(journal.quarantine), { code: 'ENOENT' }); assert.equal(store.project(a), null);
});

test('project deletion clears settings and executor metadata; cleanup failure remains recoverable',async t=>{
  const {root,store,service,project}=await fixture(t),a=await project('A'),b=await project('B');
  const sessionId=store.project(a).sessionId,settings=path.join(root,'app/settings.json');
  await fs.writeFile(settings,JSON.stringify({projectAutoPlan:{[a]:{enabled:true},[b]:{enabled:true}},parallelExecutionBook:{old:{workspace:a}},reviewCheckpoint:{cycles:[{key:JSON.stringify([a,sessionId])}]}}));
  await store.setArchived(a,true);let calls=0;
  service.cleanup=async()=>{if(!calls++)throw Error('settings disk failure');};
  const p=await service.preview(a);await assert.rejects(service.apply(p.token,p.name),/settings disk failure/);
  assert.equal(service.isPending(a),true);assert.ok(store.project(a));
  const restarted=new WorkspaceDeletion({store,journalDir:service.journalDir});assert.deepEqual(await restarted.recover(),[]);
  const data=JSON.parse(await fs.readFile(settings));assert.equal(data.projectAutoPlan[a],undefined);assert.equal(data.projectAutoPlan[b].enabled,true);
  assert.deepEqual(data.parallelExecutionBook,{});assert.deepEqual(data.reviewCheckpoint.cycles,[]);assert.equal(store.project(a),null);
});

test('deletion removes only verified worktrees and all child sessions',async t=>{
  const {root,store,service,project}=await fixture(t),a=await project('A');
  const {createHash}=await import('node:crypto');
  const id='wp-child',child=path.join(root,'.web-pilot-worktrees',createHash('sha256').update(a).digest('hex').slice(0,16),id);
  const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(a,'init');git(a,'config','user.name','Fixture');git(a,'config','user.email','fixture@example.invalid');git(a,'add','.');git(a,'commit','-m','fixture');
  const base=git(a,'rev-parse','HEAD');await fs.mkdir(path.dirname(child),{recursive:true});git(a,'worktree','add','-b','child',child);
  const gitDir=git(child,'rev-parse','--absolute-git-dir'),binding={id,parent_root:a,worktree:child,base_commit:base,parent_scope_id:'scope',parent_task_id:'T001',phase:'INTEGRATED'};
  await fs.mkdir(path.join(gitDir,'workflow-kit'),{recursive:true});
  await fs.mkdir(path.join(a,'.git/workflow-kit/assignments'),{recursive:true});
  await fs.writeFile(path.join(child,'.git'),'gitdir: '+gitDir+'\n');
  await fs.writeFile(path.join(gitDir,'workflow-kit/assignment.json'),JSON.stringify(binding));
  await fs.writeFile(path.join(a,'.git/workflow-kit/assignments',id+'.json'),JSON.stringify(binding));
  const data=store.data.projects[0];store.data.projects.push({...structuredClone(data),workspace:child,parentWorkspace:a,parentProjectId:data.projectId,projectId:'child',sessions:[{...data.sessions[0],sessionId:'worker',assignmentId:id}]});await store.save();
  await fs.writeFile(path.join(child,'unfinished.txt'),'work');
  await store.setArchived(a,true);await assert.rejects(service.preview(a),{code:'DELETE_WORKTREE_BUSY'});
  await fs.rm(path.join(child,'unfinished.txt'));
  await store.setArchived(a,true);const p=await service.preview(a);await service.apply(p.token,p.name);
  await assert.rejects(fs.stat(child),{code:'ENOENT'});await assert.rejects(fs.stat(path.dirname(child)),{code:'ENOENT'});assert.equal(store.project(child),null);assert.equal(store.project(a),null);
});


test('a traversal assignment cannot authorize removal outside its worktree group',async t=>{
  const {root,store,service,project}=await fixture(t),a=await project('A');
  const victim=path.join(root,'keep');await fs.mkdir(victim);await fs.writeFile(path.join(victim,'keep'),'safe');
  const assignments=path.join(a,'.git/workflow-kit/assignments');await fs.mkdir(assignments,{recursive:true});
  await fs.writeFile(path.join(assignments,'invalid.json'),JSON.stringify({id:'../keep',parent_root:a,worktree:victim}));
  await store.setArchived(a,true);await assert.rejects(service.preview(a),{code:'DELETE_WORKTREE_CHANGED'});
  assert.equal(await fs.readFile(path.join(victim,'keep'),'utf8'),'safe');assert.ok(await fs.stat(a));
});
