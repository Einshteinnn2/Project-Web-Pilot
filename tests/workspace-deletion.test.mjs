import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import { WorkspaceSessions, WorkspaceError } from '../src/workspace-session.mjs';
import { WorkspaceDeletion } from '../src/workspace-deletion.mjs';
import { purgeProjectStateFiles } from '../src/project-state-cleanup.mjs';

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

test('two confirmed journals finish without orphan records when folders and hashed group are missing',async t=>{
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
  assert.deepEqual(errors,[]);
  assert.ok(!store.project(parent),'parent metadata was recovered without original/quarantine');
  assert.deepEqual(await fs.readdir(service.journalDir),[]);
  assert.equal(store.project(child,childSessionId),null);
  assert.equal(store.project(neighbour).workspace,neighbour);
  assert.equal(await fs.readFile(path.join(neighbour,'my-file.txt'),'utf8'),'keep until confirmed');
  assert.ok(store.file.startsWith(root+path.sep),'the test store must stay inside the temporary fixture');
  assert.deepEqual(await restarted.recover(),[],'second recovery is a no-op');
});

test('overlapping journals complete in either order with exact persisted cleanup and no duplicate writes',async t=>{
  for(const first of ['parent','child']){
    await t.test(first+' first',async sub=>{
      const {root,store,service,project}=await fixture(sub);
      const parent=await project('Parent'),neighbour=await project('Neighbour');
      const child=await boundChild(store,parent,'owned-t003');
      const parentId=store.project(parent).projectId,childId=store.project(child).projectId;
      const parentSessionId=store.project(parent).sessionId,childSessionId=store.project(child).sessionId;
      await store.setArchived(child,true);await store.setArchived(parent,true);
      const neighbourId=store.project(neighbour).projectId,neighbourSessionId=store.project(neighbour).sessionId;
      const deleted=[{workspace:parent,projectId:parentId,sessionIds:[parentSessionId]},
        {workspace:child,projectId:childId,sessionIds:[childSessionId]}];
      const settings={theme:'light',projectAutoPlan:Object.fromEntries([parent,child,neighbour].map(workspace=>[workspace,{enabled:true}])),
        parallelExecutionBook:{parent:{workspace:parent,projectId:parentId},child:{workspace:child,projectId:childId},
          neighbour:{workspace:neighbour,projectId:neighbourId,assignments:{active:{phase:'unknown'}}}},
        reviewCheckpoint:{entries:[...deleted.map(entry=>({key:JSON.stringify([entry.workspace,entry.sessionIds[0]])})),
          {key:JSON.stringify([neighbour,neighbourSessionId])}]},
        automationCheckpoint:{entries:[...deleted.map(entry=>({sessionId:entry.sessionIds[0]})),{sessionId:neighbourSessionId}]}};
      const dataDir=path.dirname(store.file);
      for(const name of ['settings.json','settings.json.v1-backup'])
        await fs.writeFile(path.join(dataDir,name),JSON.stringify(settings));
      for(const suffix of [1,2,3,4,5])await fs.writeFile(store.file+`.v${suffix}-backup`,JSON.stringify(store.snapshot()));
      await fs.writeFile(path.join(dataDir,'diagnostics.jsonl'),
        [parent,child,neighbour].map(workspace=>JSON.stringify({workspace})).join('\n')+'\n');
      await fs.mkdir(path.join(dataDir,'diagnostics'));
      for(const name of ['chromium-events.jsonl','chromium-events.jsonl.1'])
        await fs.writeFile(path.join(dataDir,'diagnostics',name),
          [...deleted.map(entry=>({sessionId:entry.sessionIds[0]})),{sessionId:neighbourSessionId}]
            .map(JSON.stringify).join('\n')+'\n');
      service.finish=async()=>{throw Error('after confirmed journal');};
      for(const workspace of first==='parent'?[parent,child]:[child,parent]){
        const preview=await service.preview(workspace);
        await assert.rejects(service.apply(preview.token,preview.name),/after confirmed journal/);
      }
      const files=await fs.readdir(service.journalDir);
      const jobs=await Promise.all(files.map(name=>fs.readFile(path.join(service.journalDir,name),'utf8').then(JSON.parse)));
      const parentJob=jobs.find(job=>job.workspace===parent),childJob=jobs.find(job=>job.workspace===child);
      assert.deepEqual(parentJob.related.map(item=>item.workspace),[child]);
      await fs.rm(child,{recursive:true});await fs.rmdir(path.dirname(child));await fs.rm(parent,{recursive:true});
      const restoredStore=new WorkspaceSessions(store.file);await restoredStore.load();
      const restarted=new WorkspaceDeletion({store:restoredStore,journalDir:service.journalDir});
      await restarted.finish(first==='parent'?parentJob:childJob);
      if(first==='child'){
        const afterChild=JSON.parse(await fs.readFile(path.join(dataDir,'settings.json'),'utf8'));
        assert.ok(afterChild.projectAutoPlan[parent],'child-first cleanup cannot remove parent with same projectId');
        assert.deepEqual(Object.keys(afterChild.parallelExecutionBook),['parent','neighbour']);
      }
      assert.deepEqual(await restarted.recover(),[],'remaining journal finishes after the first one');
      assert.deepEqual(await restarted.recover(),[],'recovery after both journals is idempotent');
      assert.deepEqual(await fs.readdir(service.journalDir),[]);
      assert.deepEqual(restoredStore.snapshot().projects.map(p=>p.workspace),[neighbour]);
      assert.equal(restoredStore.project(neighbour).sessionId,neighbourSessionId);
      for(const name of ['settings.json','settings.json.v1-backup']) {
        const data=JSON.parse(await fs.readFile(path.join(dataDir,name),'utf8'));
        assert.deepEqual(Object.keys(data.projectAutoPlan),[neighbour]);
        assert.deepEqual(Object.keys(data.parallelExecutionBook),['neighbour']);
        assert.deepEqual(data.reviewCheckpoint.entries,[{key:JSON.stringify([neighbour,neighbourSessionId])}]);
        assert.deepEqual(data.automationCheckpoint.entries,[{sessionId:neighbourSessionId}]);
      }
      for(const suffix of [1,2,3,4,5]){
        const data=JSON.parse(await fs.readFile(store.file+`.v${suffix}-backup`,'utf8'));
        assert.deepEqual(data.projects.map(p=>p.workspace),[neighbour]);
      }
      assert.deepEqual(JSON.parse((await fs.readFile(path.join(dataDir,'diagnostics.jsonl'),'utf8')).trim()),{workspace:neighbour});
      for(const name of ['chromium-events.jsonl','chromium-events.jsonl.1'])
        assert.deepEqual(JSON.parse((await fs.readFile(path.join(dataDir,'diagnostics',name),'utf8')).trim()),{sessionId:neighbourSessionId});
      const watched=[path.join(dataDir,'settings.json'),store.file+'.v1-backup',
        path.join(dataDir,'diagnostics.jsonl')];
      const stamps=await Promise.all(watched.map(file=>fs.stat(file).then(s=>s.mtimeNs??s.mtimeMs)));
      await restarted.recover();
      assert.deepEqual(await Promise.all(watched.map(file=>fs.stat(file).then(s=>s.mtimeNs??s.mtimeMs))),stamps,
        'no second write to unrelated settings or backup files');
      assert.equal(await fs.readFile(path.join(neighbour,'my-file.txt'),'utf8'),'keep until confirmed');
      assert.ok(store.file.startsWith(root+path.sep),'fixture never reads or writes real userData');
    });
  }
});

test('confirmed parent with missing child needs committed integrated ownership, not only database fields',async t=>{
  for(const scenario of ['valid','assignment-missing','not-integrated','wrong-owner','changed-path']){
    await t.test(scenario,async sub=>{
      const {store,service,project}=await fixture(sub),parent=await project('Parent');
      const child=await boundChild(store,parent,'wp-missing-proof');
      await fs.rm(child,{recursive:true});
      const saved=store.data.projects.find(p=>p.workspace===child);
      const assignmentFile=path.join(parent,'.git/workflow-kit/assignments/wp-missing-proof.json');
      if(scenario==='assignment-missing')await fs.rm(assignmentFile);
      if(scenario==='not-integrated'){
        const assignment=JSON.parse(await fs.readFile(assignmentFile,'utf8'));
        assignment.phase='IN_PROGRESS';await fs.writeFile(assignmentFile,JSON.stringify(assignment));
      }
      if(scenario==='wrong-owner')saved.parentProjectId='foreign-project-id';
      if(scenario==='changed-path')saved.sessions[0].assignmentId='foreign-worker';
      await store.setArchived(parent,true);
      if(scenario==='valid'){
        const preview=await service.preview(parent);
        assert.equal(preview.sessionCount,1);
        await service.apply(preview.token,preview.name);
        assert.equal(store.project(parent),null);
        assert.equal(store.project(child),null);
      }else{
        await assert.rejects(service.preview(parent),{code:'DELETE_WORKTREE_CHANGED'});
        assert.ok(store.project(child),'a non-proven child is never removed');
      }
    });
  }
});

test('cascade retries after settings purge interruption preserve unrelated data',async t=>{
  const {root,store,service,project}=await fixture(t),parent=await project('Parent'),neighbour=await project('Neighbour');
  const child=await boundChild(store,parent,'retry-child');
  await store.setArchived(parent,true);
  const settingsFile=path.join(root,'app/settings.json');
  await fs.writeFile(settingsFile,JSON.stringify({projectAutoPlan:{[parent]:{enabled:true},[child]:{enabled:true},[neighbour]:{enabled:true}}}));
  let interrupted=false;
  const recovering=new WorkspaceDeletion({store,journalDir:service.journalDir,
    purgeState:async (folder,identities)=>{
      await purgeProjectStateFiles(folder,identities);
      if(!interrupted){interrupted=true;throw Error('after settings cleanup');}
    }});
  const preview=await recovering.preview(parent);
  await assert.rejects(recovering.apply(preview.token,preview.name),/after settings cleanup/);
  assert.equal(recovering.isPending(parent),true);
  const restart=new WorkspaceDeletion({store,journalDir:service.journalDir});
  assert.deepEqual(await restart.recover(),[]);
  assert.deepEqual(await restart.recover(),[]);
  assert.equal(store.project(parent),null);assert.equal(store.project(child),null);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(settingsFile)).projectAutoPlan),[neighbour]);
  assert.equal(await fs.readFile(path.join(neighbour,'my-file.txt'),'utf8'),'keep until confirmed');
});

test('missing owned worktree with additional local chats keeps exact session IDs in cascade journal',async t=>{
  const {store,service,project}=await fixture(t);
  const parent=await project('Parent'),child=await boundChild(store,parent,'multi-chat-child');
  const extra=await store.newChat(child);
  const sessions=store.snapshot().projects.find(p=>p.workspace===child).sessions.map(s=>s.sessionId);
  assert.equal(sessions.length,2);
  assert.ok(sessions.includes(extra.sessionId));
  await fs.rm(child,{recursive:true});
  await store.setArchived(parent,true);
  service.finish=async()=>{throw Error('journal captured');};
  const preview=await service.preview(parent);
  await assert.rejects(service.apply(preview.token,preview.name),/journal captured/);
  const [name]=await fs.readdir(service.journalDir);
  const journal=JSON.parse(await fs.readFile(path.join(service.journalDir,name),'utf8'));
  assert.deepEqual(journal.related[0].sessionIds,sessions);
  const restarted=new WorkspaceDeletion({store,journalDir:service.journalDir});
  assert.deepEqual(await restarted.recover(),[]);
  assert.equal(store.project(child),null);assert.equal(store.project(parent),null);
});

test('archive migration copy preserves a replacement identity at the old path',async t=>{
  const {store,service,project}=await fixture(t);
  const parent=await project('Parent'),neighbour=await project('Neighbour');
  const oldId=store.project(parent).projectId;
  await store.setArchived(parent,true);
  service.finish=async()=>{throw Error('journal captured');};
  const preview=await service.preview(parent);
  await assert.rejects(service.apply(preview.token,preview.name),/journal captured/);
  await fs.rm(parent,{recursive:true});
  const archive=store.snapshot();
  archive.projects.push({...structuredClone(archive.projects.find(p=>p.workspace===parent)),
    projectId:'replacement-identity',sessions:[{...archive.projects.find(p=>p.workspace===parent).sessions[0],
      sessionId:'replacement-session'}]});
  await fs.writeFile(store.file+'.v3-backup',JSON.stringify(archive));
  const restarted=new WorkspaceDeletion({store,journalDir:service.journalDir});
  assert.deepEqual(await restarted.recover(),[]);
  const kept=JSON.parse(await fs.readFile(store.file+'.v3-backup','utf8')).projects;
  assert.ok(kept.some(p=>p.workspace===parent&&p.projectId==='replacement-identity'));
  assert.ok(!kept.some(p=>p.workspace===parent&&p.projectId===oldId));
  assert.ok(kept.some(p=>p.workspace===neighbour));
});

async function interruptConfirmed(service,workspace) {
  service.finish=async()=>{throw Error('fixture interruption before filesystem mutation');};
  const preview=await service.preview(workspace);
  await assert.rejects(service.apply(preview.token,preview.name),/fixture interruption/);
  const [filename]=await fs.readdir(service.journalDir);
  return {filename,job:JSON.parse(await fs.readFile(path.join(service.journalDir,filename),'utf8'))};
}

test('confirmed with neither path present only clears local state, copies and journal; restart is idempotent',async t=>{
  const {root,store,service,project}=await fixture(t);
  const removed=await project('Removed'),neighbour=await project('Neighbour');
  await store.setArchived(removed,true);
  const diagnostic=path.join(root,'app/diagnostics.jsonl');
  await fs.writeFile(diagnostic,[removed,neighbour].map(workspace=>JSON.stringify({workspace})).join('\n')+'\n');
  await fs.writeFile(store.file+'.v2-backup',JSON.stringify(store.snapshot()));
  const {job}=await interruptConfirmed(service,removed);
  assert.equal(job.stage,'confirmed');
  await fs.rm(removed,{recursive:true});
  const marker=path.join(root,'outside.txt');
  await fs.writeFile(marker,'unchanged');
  const restarted=new WorkspaceDeletion({store,journalDir:service.journalDir});
  assert.deepEqual(await restarted.recover(),[]);
  assert.equal(store.project(removed),null);
  assert.deepEqual(await fs.readdir(service.journalDir),[]);
  assert.deepEqual(await restarted.recover(),[]);
  assert.equal(await fs.readFile(marker,'utf8'),'unchanged');
  assert.equal(await fs.readFile(path.join(neighbour,'my-file.txt'),'utf8'),'keep until confirmed');
  assert.deepEqual(JSON.parse(await fs.readFile(store.file+'.v2-backup','utf8')).projects.map(p=>p.workspace),[neighbour]);
  assert.deepEqual(JSON.parse((await fs.readFile(diagnostic,'utf8')).trim()),{workspace:neighbour});
});

test('confirmed metadata-only survives stage-save error and a restart after cleanup failure',async t=>{
  const {store,service,project}=await fixture(t);
  const removed=await project('A'),neighbour=await project('B');
  await store.setArchived(removed,true);
  const {filename}=await interruptConfirmed(service,removed);
  await fs.rm(removed,{recursive:true});
  const failing=new WorkspaceDeletion({store,journalDir:service.journalDir});
  failing.saveJob=async()=>{throw Error('stage write failure');};
  assert.deepEqual((await failing.recover()).map(e=>e.message),['stage write failure']);
  assert.equal(JSON.parse(await fs.readFile(path.join(service.journalDir,filename),'utf8')).stage,'confirmed');
  const checkpoint=new WorkspaceDeletion({store,journalDir:service.journalDir,cleanup:async()=>{throw Error('interrupted cleanup');}});
  assert.deepEqual((await checkpoint.recover()).map(e=>e.message),['interrupted cleanup']);
  const saved=JSON.parse(await fs.readFile(path.join(service.journalDir,filename),'utf8'));
  assert.equal(saved.stage,'removing');assert.equal(saved.metadataOnly,true);
  await fs.mkdir(removed);
  await fs.writeFile(path.join(removed,'foreign'),'keep');
  const retry=new WorkspaceDeletion({store,journalDir:service.journalDir});
  assert.deepEqual((await retry.recover()).map(e=>e.code),['DELETE_PATH_CHANGED']);
  assert.equal(await fs.readFile(path.join(removed,'foreign'),'utf8'),'keep');
  await fs.rm(removed,{recursive:true}); // fixture-only cleanup of the foreign replacement
  assert.deepEqual(await retry.recover(),[]);
  assert.deepEqual(await retry.recover(),[]);
  assert.equal(store.project(removed),null);assert.ok(store.project(neighbour));
});

test('confirmed missing worktree tolerates removed hashed group with verified outer container',async t=>{
  const {store,service,project}=await fixture(t);
  const parent=await project('Parent'),child=await boundChild(store,parent,'child-t002');
  await store.setArchived(child,true);
  const {job}=await interruptConfirmed(service,child);
  assert.ok(job.identity?.dev);
  const group=path.dirname(child),container=path.dirname(group);
  await fs.rm(child,{recursive:true});
  await fs.rmdir(group);
  assert.ok((await fs.stat(container)).isDirectory());
  const restarted=new WorkspaceDeletion({store,journalDir:service.journalDir});
  assert.deepEqual(await restarted.recover(),[]);
  assert.equal(store.project(child),null);
  assert.ok(store.project(parent));
  assert.ok((await fs.stat(container)).isDirectory(),'container is not removed by metadata-only recovery');
});

test('a removed worktree container is not proof of completed deletion',async t=>{
  const {store,service,project}=await fixture(t);
  const parent=await project('Parent'),child=await boundChild(store,parent,'child-t002-unavailable');
  await store.setArchived(child,true);
  const {filename}=await interruptConfirmed(service,child);
  await fs.rm(path.dirname(path.dirname(child)),{recursive:true});
  const restarted=new WorkspaceDeletion({store,journalDir:service.journalDir});
  assert.deepEqual((await restarted.recover()).map(e=>e.code),['DELETE_SOURCE_UNAVAILABLE']);
  assert.ok(store.project(child));
  assert.deepEqual(await fs.readdir(service.journalDir),[filename]);
  assert.ok(store.project(parent));
});

test('a missing=true confirmed journal rejects a newly appeared project directory',async t=>{
  const {store,service,project}=await fixture(t);
  const removed=await project('A');
  await store.setArchived(removed,true);
  await fs.rm(removed,{recursive:true});
  const {job}=await interruptConfirmed(service,removed);
  assert.equal(job.missing,true);
  await fs.mkdir(removed);
  await fs.writeFile(path.join(removed,'replacement.txt'),'new owner');
  const restarted=new WorkspaceDeletion({store,journalDir:service.journalDir});
  assert.deepEqual((await restarted.recover()).map(e=>e.code),['DELETE_PATH_CHANGED']);
  assert.equal(await fs.readFile(path.join(removed,'replacement.txt'),'utf8'),'new owner');
  assert.ok(store.project(removed));
});

test('missing mountpoint, inaccessible anchor and changed device refuse confirmed recovery',async t=>{
  for(const variant of ['absent-mountpoint','EACCES','EIO','different-device']) {
    await t.test(variant,async sub=>{
      const {root,store,service,project}=await fixture(sub);
      const removed=await project('volume/A');
      await store.setArchived(removed,true);
      const {filename}=await interruptConfirmed(service,removed);
      await fs.rm(removed,{recursive:true});
      if(variant==='absent-mountpoint')await fs.rmdir(path.dirname(removed));
      if(variant==='different-device') {
        const file=path.join(service.journalDir,filename),job=JSON.parse(await fs.readFile(file,'utf8'));
        job.identity.dev=String(BigInt(job.identity.dev)+1n);
        await fs.writeFile(file,JSON.stringify(job));
      }
      const restarted=new WorkspaceDeletion({store,journalDir:service.journalDir});
      if(variant==='EACCES'||variant==='EIO') {
        const original=fs.lstat;
        fs.lstat=async (file,...args)=>{if(file===path.dirname(removed))throw Object.assign(Error('inaccessible mount'),{code:variant});
          return original(file,...args);};
        try {assert.deepEqual((await restarted.recover()).map(e=>e.code),[variant]);}
        finally {fs.lstat=original;}
      } else assert.deepEqual((await restarted.recover()).map(e=>e.code),['DELETE_SOURCE_UNAVAILABLE']);
      assert.ok(store.project(removed));
      assert.deepEqual(await fs.readdir(service.journalDir),[filename]);
      assert.ok(store.file.startsWith(root+path.sep));
    });
  }
});

test('invalid journal, protected root, active or UNKNOWN executor do not clear metadata',async t=>{
  for(const variant of ['journal','protected','active','unknown']) {
    await t.test(variant,async sub=>{
      const {store,service,project}=await fixture(sub),removed=await project('A');
      await store.setArchived(removed,true);
      const {filename}=await interruptConfirmed(service,removed);
      await fs.rm(removed,{recursive:true});
      if(variant==='journal') {
        const file=path.join(service.journalDir,filename),job=JSON.parse(await fs.readFile(file,'utf8'));
        job.identity.ino='invalid';
        await fs.writeFile(file,JSON.stringify(job));
      }
      const options={store,journalDir:service.journalDir};
      if(variant==='protected')options.protectedPaths=[removed];
      if(variant==='active'||variant==='unknown')options.prepare=async()=>{throw new WorkspaceError('DELETE_PROJECT_BUSY',variant+' executor');};
      const restarted=new WorkspaceDeletion(options);
      assert.deepEqual((await restarted.recover()).map(e=>e.code),[
        variant==='journal'?'DELETE_RECOVERY_FAILED':variant==='protected'?'DELETE_PROTECTED':'DELETE_PROJECT_BUSY']);
      assert.ok(store.project(removed));assert.deepEqual(await fs.readdir(service.journalDir),[filename]);
    });
  }
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

test('confirmed orphan removal only clears its exact local record, backup, settings and diagnostics',async t=>{
  const {root,store,service,project}=await fixture(t);
  const parent=await project('Missing parent'),neighbour=await project('Neighbour');
  const child=await boundChild(store,parent,'orphan-safe');
  const view=store.project(child),parentId=store.project(parent).projectId;
  const identity={workspace:child,projectId:view.projectId};
  const keep=store.project(neighbour).sessionId;
  const dataDir=path.dirname(store.file);
  const state=store.snapshot();
  await fs.writeFile(store.file+'.v2-backup',JSON.stringify(state));
  const settings={projectAutoPlan:{[child]:{enabled:true},[neighbour]:{enabled:true}},
    reviewCheckpoint:{entries:[{sessionId:view.sessionId},{sessionId:keep}]},
    automationCheckpoint:{entries:[{sessionId:view.sessionId},{sessionId:keep}]}};
  await fs.writeFile(path.join(dataDir,'settings.json'),JSON.stringify(settings));
  await fs.mkdir(path.join(dataDir,'diagnostics'));
  await fs.writeFile(path.join(dataDir,'diagnostics','chromium-events.jsonl'),
    [{sessionId:view.sessionId},{sessionId:keep}].map(JSON.stringify).join('\n')+'\n');
  await fs.writeFile(path.join(dataDir,'diagnostics.jsonl'),
    [child,neighbour].map(workspace=>JSON.stringify({workspace})).join('\n')+'\n');
  store.data.projects=store.data.projects.filter(p=>p.workspace!==parent);
  await store.save();
  await fs.rm(child,{recursive:true});await fs.rmdir(path.dirname(child));await fs.rm(parent,{recursive:true});
  const restartedStore=new WorkspaceSessions(store.file);await restartedStore.load();
  assert.equal(restartedStore.project(child).ownershipState,'recovery');
  const restarted=new WorkspaceDeletion({store:restartedStore,journalDir:service.journalDir});
  assert.deepEqual((await restarted.inspectOrphan(identity)).sessionIds,[view.sessionId]);
  let checks=0;
  await restarted.clearOrphan(identity,{checkBusy:async()=>{checks++;}});
  assert.ok(checks>=2,'busy status is checked again before committing');
  assert.equal(restartedStore.project(child),null);
  assert.ok(restartedStore.project(neighbour));assert.equal(restartedStore.project(neighbour).sessionId,keep);
  assert.equal(restartedStore.project(parent),null);
  assert.deepEqual(JSON.parse(await fs.readFile(store.file+'.v2-backup','utf8')).projects.map(p=>p.workspace),[neighbour,parent]);
  const cleaned=JSON.parse(await fs.readFile(path.join(dataDir,'settings.json')));
  assert.deepEqual(Object.keys(cleaned.projectAutoPlan),[neighbour]);
  assert.deepEqual(cleaned.reviewCheckpoint.entries,[{sessionId:keep}]);
  assert.deepEqual(cleaned.automationCheckpoint.entries,[{sessionId:keep}]);
  assert.deepEqual(JSON.parse((await fs.readFile(path.join(dataDir,'diagnostics','chromium-events.jsonl'),'utf8')).trim()),{sessionId:keep});
  assert.deepEqual(JSON.parse((await fs.readFile(path.join(dataDir,'diagnostics.jsonl'),'utf8')).trim()),{workspace:neighbour});
  await assert.rejects(restarted.clearOrphan(identity),{code:'EXECUTOR_RECORD_CHANGED'});
  assert.equal(await fs.readFile(path.join(neighbour,'my-file.txt'),'utf8'),'keep until confirmed');
  assert.ok(store.file.startsWith(root+path.sep));
  assert.equal(parentId,'Missing parent');
});

test('orphan removal refuses parent/child folders, swapped IDs, pending related journals and busy commands',async t=>{
  for(const scenario of ['child-present','parent-present','wrong-id','parent-record','related-journal','own-journal','busy','missing-container','no-ownership']){
    await t.test(scenario,async sub=>{
      const {store,service,project}=await fixture(sub);
      const parent=await project('Parent'),child=await boundChild(store,parent,'orphan-check');
      const view=store.project(child),identity={workspace:child,projectId:view.projectId};
      const parentId=store.project(parent).projectId;
      const interrupted=new WorkspaceDeletion({store,journalDir:service.journalDir});
      if(scenario==='related-journal'||scenario==='own-journal'){
        await store.setArchived(parent,true);await store.setArchived(child,true);
        interrupted.finish=async()=>{throw Error('interrupted');};
        const target=scenario==='related-journal'?parent:child;
        const preview=await interrupted.preview(target);
        await assert.rejects(interrupted.apply(preview.token,preview.name),/interrupted/);
      }
      if(scenario!=='parent-record')store.data.projects=store.data.projects.filter(p=>p.workspace!==parent);
      if(scenario==='no-ownership')store.data.projects.find(p=>p.workspace===child).parentProjectId='not-the-parent';
      await store.save();
      if(scenario!=='child-present')await fs.rm(child,{recursive:true});
      if(scenario==='missing-container'&&scenario!=='child-present')await fs.rm(path.dirname(path.dirname(child)),{recursive:true});
      if(!['parent-present','parent-record'].includes(scenario))await fs.rm(parent,{recursive:true});
      const restarted=new WorkspaceDeletion({store,journalDir:service.journalDir});
      const busy=async()=>{throw new WorkspaceError('DELETE_PROJECT_BUSY','UNKNOWN command');};
      const error={
        'child-present':'DELETE_PATH_CHANGED','parent-present':'DELETE_PATH_CHANGED','wrong-id':'EXECUTOR_RECORD_CHANGED',
        'parent-record':'EXECUTOR_OWNER_UNCONFIRMED','related-journal':'DELETE_PENDING','own-journal':'DELETE_PENDING',
        busy:'DELETE_PROJECT_BUSY','missing-container':'DELETE_SOURCE_UNAVAILABLE','no-ownership':'EXECUTOR_OWNER_UNCONFIRMED'
      }[scenario];
      await assert.rejects(restarted.clearOrphan(scenario==='wrong-id'?{...identity,projectId:'foreign'}:identity,
        scenario==='busy'?{checkBusy:busy}:{}),{code:error});
      assert.ok(store.project(child),'refusal must preserve the original local chat');
      assert.equal(store.project(child).sessionId,view.sessionId);
      if(scenario==='child-present')assert.ok(await fs.stat(child));
      if(scenario==='parent-present')assert.ok(await fs.stat(parent));
      if(scenario==='related-journal'||scenario==='own-journal')assert.equal((await fs.readdir(service.journalDir)).length,1);
      assert.ok(parentId);
    });
  }
});

test('orphan removal revalidates changed directories and identity after asynchronous busy check',async t=>{
  const {store,service,project}=await fixture(t);
  const parent=await project('Parent'),child=await boundChild(store,parent,'orphan-race');
  const identity={workspace:child,projectId:store.project(child).projectId};
  store.data.projects=store.data.projects.filter(p=>p.workspace!==parent);
  await store.save();await fs.rm(child,{recursive:true});await fs.rm(parent,{recursive:true});
  const restarted=new WorkspaceDeletion({store,journalDir:service.journalDir});
  await assert.rejects(restarted.clearOrphan(identity,{checkBusy:async()=>{await fs.mkdir(child);}}),
    {code:'DELETE_PATH_CHANGED'});
  assert.ok(store.project(child));await fs.rm(child,{recursive:true});
  await assert.rejects(restarted.clearOrphan(identity,{checkBusy:async()=>{
    store.data.projects.find(p=>p.workspace===child).projectId='replacement';
    await store.save();
  }}),{code:'EXECUTOR_RECORD_CHANGED'});
  assert.ok(store.project(child));
});

test('inaccessible recovery anchor refuses manual orphan cleanup without changing local records',async t=>{
  const {store,service,project}=await fixture(t);
  const parent=await project('Parent'),child=await boundChild(store,parent,'orphan-unavailable');
  const identity={workspace:child,projectId:store.project(child).projectId};
  store.data.projects=store.data.projects.filter(p=>p.workspace!==parent);await store.save();
  await fs.rm(child,{recursive:true});await fs.rm(parent,{recursive:true});
  const unavailable=path.dirname(parent),original=fs.lstat;
  fs.lstat=async(file,...args)=>file===unavailable
    ?Promise.reject(Object.assign(new Error('disk unavailable'),{code:'EIO'})):original(file,...args);
  try{
    const restarted=new WorkspaceDeletion({store,journalDir:service.journalDir});
    await assert.rejects(restarted.clearOrphan(identity),{code:'EIO'});
  }finally{fs.lstat=original;}
  assert.ok(store.project(child));
});
