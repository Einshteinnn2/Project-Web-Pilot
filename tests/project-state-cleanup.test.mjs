import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {belongsToProject,removeProjectSettings,purgeProjectStateFiles,queueProjectStatePurge} from '../src/project-state-cleanup.mjs';

test('project cleanup removes exact nested delivery owners, preserves neighbours and does not change input',()=>{
  const ids=[{workspace:'/projects/a',projectId:'id-a',sessionIds:['session-a']}];
  const deleted={key:JSON.stringify([JSON.stringify(['/projects/a','session-a','url']),'turn']),status:'sending'};
  const neighbour={key:JSON.stringify(['/projects/ab','other','url']),status:'sending'};
  const settings={theme:'dark',projectAutoPlan:{'/projects/a':{enabled:true},'/projects/ab':{enabled:true}},
    parallelExecutionBook:{a:{workspace:'/projects/a'},b:{workspace:'/projects/ab'}},
    reviewCheckpoint:{entries:[deleted,neighbour],cycles:[{key:JSON.stringify(['/projects/a','session-a'])}],reviewStops:[{key:JSON.stringify(['/projects/a','session-a'])}]},
    automationCheckpoint:{entries:[deleted,neighbour],cycles:[{sessionId:'session-a'}]}};
  const next=removeProjectSettings(settings,ids);
  assert.deepEqual(next.projectAutoPlan,{'/projects/ab':{enabled:true}});assert.deepEqual(next.parallelExecutionBook,{b:{workspace:'/projects/ab'}});
  assert.deepEqual(next.reviewCheckpoint.entries,[neighbour]);assert.deepEqual(next.reviewCheckpoint.cycles,[]);assert.deepEqual(next.reviewCheckpoint.reviewStops,[]);
  assert.deepEqual(next.automationCheckpoint.entries,[neighbour]);assert.deepEqual(next.automationCheckpoint.cycles,[]);
  assert.equal(next.theme,'dark');assert.equal(settings.reviewCheckpoint.entries.length,2);
  assert.equal(belongsToProject('/projects/a extra',ids),false);
});

test('a shared parent/worktree projectId and a replaced path do not transfer deletion ownership',()=>{
  const parent='/projects/parent',child='/projects/.web-pilot-worktrees/group/child',id='same-project-id';
  const samePathNew={workspace:child,projectId:'new-project-id',sessionId:'new-session'};
  const settings={projectAutoPlan:{[parent]:{projectId:id,enabled:true},
      [child]:{projectId:id,enabled:true},'/projects/other':{enabled:true}},
    parallelExecutionBook:{parent:{workspace:parent,projectId:id},
      child:{workspace:child,projectId:id},replacement:{workspace:child,projectId:'new-project-id'},
      other:{workspace:'/projects/other'}},
    reviewCheckpoint:{entries:[{key:JSON.stringify([child,'deleted-session'])},
      {key:JSON.stringify([parent,'parent-session'])},{workspace:child,projectId:'new-project-id',sessionId:'new-session'}]},
    automationCheckpoint:{entries:[{sessionId:'deleted-session'},{sessionId:'parent-session'},samePathNew]}};
  const next=removeProjectSettings(settings,[{workspace:child,projectId:id,sessionIds:['deleted-session']}]);
  assert.deepEqual(Object.keys(next.projectAutoPlan),[parent,'/projects/other']);
  assert.deepEqual(Object.keys(next.parallelExecutionBook),['parent','replacement','other']);
  assert.deepEqual(next.reviewCheckpoint.entries,[{key:JSON.stringify([parent,'parent-session'])},
    {workspace:child,projectId:'new-project-id',sessionId:'new-session'}]);
  assert.deepEqual(next.automationCheckpoint.entries,[{sessionId:'parent-session'},samePathNew]);
  assert.equal(belongsToProject(id,[{workspace:child,projectId:id,sessionIds:[]}]),false);
});

test('durable cleanup includes settings migration copies, interrupted writes and diagnostic session IDs, preserving browser data',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'project-cleanup-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const ids=[{workspace:'/projects/a',projectId:'id-a',sessionIds:['session-a']}];
  const settings={projectAutoPlan:{'/projects/a':{enabled:true},'/b':{enabled:false}},parallelExecutionBook:{a:{workspace:'/projects/a'}},theme:'light'};
  for(const f of ['settings.json','settings.json.v1-backup','settings.json.tmp'])await fs.writeFile(path.join(dir,f),JSON.stringify(settings));
  await fs.mkdir(path.join(dir,'diagnostics'));await fs.mkdir(path.join(dir,'Partitions'));
  await fs.writeFile(path.join(dir,'Partitions','keep'),'/projects/a');
  await fs.writeFile(path.join(dir,'diagnostics','chromium-events.jsonl'),[{sessionId:'session-a'},{sessionId:'other'}].map(JSON.stringify).join('\n')+'\n');
  await purgeProjectStateFiles(dir,ids);await purgeProjectStateFiles(dir,ids);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'settings.json'))).projectAutoPlan['/projects/a'],undefined);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'settings.json.v1-backup'))).projectAutoPlan['/b'].enabled,false);
  await assert.rejects(fs.stat(path.join(dir,'settings.json.tmp')),{code:'ENOENT'});
  assert.equal((await fs.readFile(path.join(dir,'diagnostics','chromium-events.jsonl'),'utf8')).trim(),JSON.stringify({sessionId:'other'}));
  assert.equal(await fs.readFile(path.join(dir,'Partitions','keep'),'utf8'),'/projects/a');
});

test('startup drops orphan state and delivery keys but retains archived projects and UNKNOWN for existing identities',async()=>{
 const {pruneOrphanProjectSettings}=await import('../src/project-state-cleanup.mjs');
 const saved={projectAutoPlan:{'/gone':{enabled:true},'/kept':{enabled:true,projectId:'kept'}},parallelExecutionBook:{a:{workspace:'/gone'},b:{workspace:'/kept',projectId:'kept',assignments:{a:{phase:'unknown'}}}},
  reviewCheckpoint:{entries:[{key:JSON.stringify(['/gone','s'])},{key:JSON.stringify(['/kept','old'])},{key:JSON.stringify(['/kept','s'])}]}};
 const next=pruneOrphanProjectSettings(saved,[{workspace:'/kept',projectId:'kept',archivedAt:1,sessions:[{sessionId:'s'}]}]);
 assert.deepEqual(Object.keys(next.projectAutoPlan),['/kept']);assert.deepEqual(Object.keys(next.parallelExecutionBook),['b']);assert.equal(next.parallelExecutionBook.b.assignments.a.phase,'unknown');assert.equal(next.reviewCheckpoint.entries.length,1);
});

test('stale permission never removes a current project UNKNOWN execution ledger',async()=>{
 const {pruneOrphanProjectSettings}=await import('../src/project-state-cleanup.mjs');
 const saved={projectAutoPlan:{'/a':{projectId:'old'}},parallelExecutionBook:{live:{workspace:'/a',projectId:'new',assignments:{reserved:{phase:'unknown'}}}}};
 const result=pruneOrphanProjectSettings(saved,[{workspace:'/a',projectId:'new',sessions:[]}]);
 assert.deepEqual(result.projectAutoPlan,{});assert.equal(result.parallelExecutionBook.live.assignments.reserved.phase,'unknown');
});


test('purge waits for the active settings writer and preserves its neighbour update',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'queued-cleanup-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const file=path.join(dir,'settings.json'),temporary=file+'.tmp';
  await fs.writeFile(temporary,JSON.stringify({projectAutoPlan:{'/gone':{enabled:true},'/kept':{enabled:true}},theme:'new'}));
  const writer=gate.then(()=>fs.rename(temporary,file));
  const purge=queueProjectStatePurge(writer,dir,[{workspace:'/gone'}]);
  assert.equal((await fs.stat(temporary)).isFile(),true);
  release();await purge;
  const result=JSON.parse(await fs.readFile(file));
  assert.deepEqual(result.projectAutoPlan,{'/kept':{enabled:true}});assert.equal(result.theme,'new');
});

test('cleanup removes a diagnostic session across rotation and preserves concurrent neighbour writes',async t=>{
  const {DiagnosticJsonl}=await import('../src/chromium-diagnostics.mjs');
  const {appendDiagnostic,queueDiagnosticFile}=await import('../src/common.mjs');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'diagnostic-cleanup-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'diagnostics/chromium-events.jsonl');
  const log=new DiagnosticJsonl(file,{sessionId:'technical',owner:()=>({sessionId:'deleted-chat'})});await log.init();
  log.record('test','owned');await log.flush();
  await fs.writeFile(file+'.1',JSON.stringify({diagnosticSession:'technical',event:'old-navigation'})+'\n');
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const blocked=queueDiagnosticFile(file,()=>gate);
  const purge=purgeProjectStateFiles(dir,[{workspace:'/gone',sessionIds:['deleted-chat']}]);
  const append=appendDiagnostic(file,JSON.stringify({diagnosticSession:'neighbour',event:'keep'})+'\n');
  release();await Promise.all([blocked,purge,append]);
  assert.equal((await fs.readFile(file+'.1','utf8')).trim(),'');
  const lines=(await fs.readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines,[{diagnosticSession:'neighbour',event:'keep'}]);
});
