import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectAutoPlan } from '../src/project-auto-plan.mjs';

test('T006: durable handoff has no recipient while Recovery is pending and exactly one afterwards',()=>{
  const sessions=new Set(['old','new','manual']);
  const owner=()=> 'same-project';
  const owned=(_w,id)=>sessions.has(id);
  const auth=new ProjectAutoPlan({identity:owner,ownsSession:owned});
  auth.sync('/project','scope',{confirmed:true,planRevision:8,originSessionId:'old',executionStrategy:'sequential'});
  auth.set('/project','scope',true,'old');
  auth.saveCheckpoint('/project','scope','old',{autoPlanCheckpoint:{version:3,entries:[{status:'sent'}]}});
  auth.beginHandoff('/project','scope','old',{operationId:'rotation-123',kind:'rotation'});
  assert.equal(auth.enabled('/project','scope'),true,'global user permission stays ON');
  assert.equal(auth.state('/project').sessionId,null,'old loses recipient before target is allowed');
  auth.attachHandoff('/project','rotation-123','new');
  const reopened=new ProjectAutoPlan({saved:auth.snapshot(),identity:owner,ownsSession:owned});
  assert.equal(reopened.state('/project').handoff.targetSessionId,'new');
  assert.equal(reopened.state('/project').sessionId,null);
  assert.throws(()=>reopened.attachHandoff('/project','rotation-123','manual'),{code:'ROTATION_HANDOFF_CONFLICT'});
  reopened.finishHandoff('/project','rotation-123','new');
  assert.equal(reopened.handoffPending('/project'),true,'new recipient cannot send until authority is durable');
  reopened.releaseHandoff('/project','rotation-123','new');
  assert.equal(reopened.state('/project').sessionId,'new');
  assert.equal(reopened.state('/project').enabled,true);
  assert.equal(reopened.state('/project').handoff.status,'done');
  assert.equal(reopened.checkpoint('/project','scope','old').autoPlanCheckpoint.entries[0].status,'sent');
  assert.deepEqual(reopened.checkpoint('/project','scope','new'),{},'new Chat has no old Send ledger');
  reopened.beginHandoff('/project','scope','new',{operationId:'rotation-456'});
  reopened.attachHandoff('/project','rotation-456','manual');
  reopened.finishHandoff('/project','rotation-456','manual');
  reopened.releaseHandoff('/project','rotation-456','manual');
  assert.equal(reopened.state('/project').sessionId,'manual','the next quota can hand off again');
});

test('T006: a failed, unknown or cancelled handoff never transfers authority or alters DONE',()=>{
  const auth=new ProjectAutoPlan({identity:()=> 'project',ownsSession:(_w,id)=>['old','new'].includes(id)});
  auth.sync('/project','scope',{confirmed:true,planRevision:9,executionStrategy:'sequential'});
  auth.set('/project','scope',true,'old');
  auth.saveCheckpoint('/project','scope','old',{chatTaskCursor:{counted:[{id:'T001',sha:'a'.repeat(40)}]}});
  auth.beginHandoff('/project','scope','old',{operationId:'manual-one',kind:'manual'});
  auth.attachHandoff('/project','manual-one','new');
  assert.equal(auth.failHandoff('/project','manual-one','ROTATION_RECOVERY_FAILED'),true);
  assert.equal(auth.failHandoff('/project','manual-one','ROTATION_RECOVERY_FAILED'),false);
  assert.equal(auth.state('/project').sessionId,null);
  assert.throws(()=>auth.finishHandoff('/project','manual-one','new'),{code:'ROTATION_HANDOFF_CONFLICT'});
  const restarted=new ProjectAutoPlan({saved:auth.snapshot(),identity:()=> 'project',ownsSession:()=>true});
  assert.equal(restarted.state('/project').handoff.status,'failed');
  assert.equal(restarted.state('/project').handoff.error,'ROTATION_RECOVERY_FAILED');
  assert.equal(restarted.state('/project').sessionId,null);
  assert.equal(restarted.checkpoint('/project','scope','old').chatTaskCursor.counted.length,1);
  restarted.set('/project','scope',false,'old');
  assert.equal(restarted.enabled('/project','scope'),false);
  restarted.set('/project','scope',true,'new');
  assert.equal(restarted.state('/project').sessionId,'new','only a new explicit ON may recover');
  assert.equal(restarted.state('/project').handoff,null);
});

test('T006: old controller stays silent while new recovered Chat receives exactly one continuation',async t=>{
 const {configureProjectAutoPlan}=await import('../src/project-session-auto-plan.mjs');
 const auth=new ProjectAutoPlan({identity:()=> 'project',ownsSession:(_w,id)=>['old','new'].includes(id)});
 const workspace='/handoff-test';const scopeId='scope';
 const plan={workspace,projectId:'project',scopeId,scopeStatus:'ACTIVE',confirmed:true,planRevision:10,
   planExecution:{execution_strategy:'sequential'},planView:{tasks:[{id:'T001',status:'done'},{id:'T002',status:'pending'}]}};
 auth.sync(workspace,scopeId,{confirmed:true,planRevision:10,executionStrategy:'sequential'});
 auth.set(workspace,scopeId,true,'old');
 const records={},sends=[];
 for(const id of ['old','new']){
  const current={workspace,projectId:'project',sessionId:id,scopeId,experience:'chat',chatUrl:'https://chatgpt.com/c/'+id+'-12345678',planExecution:plan.planExecution};
  const record={identity:{workspace,sessionId:id},project:()=>current,ready:true,loading:false,cleanups:[],
    controller:{pending:false,state:{phase:id==='old'?'delivered':'selected'},projectChanged:()=>{}},
    composer:{inFlight:false,sendUserMessage:async({canContinue,onBeforeSend})=>{
      if(!canContinue()||!await onBeforeSend())return {state:'cancelled'};
      sends.push(id);return {state:'sent'};
    }}};
  records[id]=record;
  configureProjectAutoPlan(record,{authorization:auth,store:{inspect:async(_workspace,sessionId)=>({...plan,inspectedSessionId:sessionId})},
    inspectPlan:async()=>({...plan,inspectedSessionId:id}),onChange:()=>{}});
  t.after(()=>record.cleanups.forEach(cleanup=>cleanup()));
 }
 const observe=id=>records[id].primaryAutomation.observe({documentId:'page-'+id,state:{
   url:records[id].project().chatUrl,editorAvailable:true,writable:true,busy:false,draftPresent:false,
   lastMessageRole:'assistant',turnId:'turn-'+id,userTurnId:'user-'+id,manualStopRevision:0,
   manualInputRevision:0,manualSendRevision:0}});
 auth.beginHandoff(workspace,scopeId,'old',{operationId:'rotation-test'});
 auth.attachHandoff(workspace,'rotation-test','new');
 records.old.primaryAutomation.update();records.new.primaryAutomation.update();
 observe('old');observe('new');
 await new Promise(resolve=>setTimeout(resolve,50));
 assert.deepEqual(sends,[],'neither source nor target can send during pending Recovery');
 records.new.controller.state.phase='delivered';
 const page=records.new.primaryAutomation.flow.page;
 assert.equal((await import('../src/chat-session-rotation.mjs')).chatHandoffDecision({
   project:{...records.new.project(),attempt:{state:'sent'}},handoff:auth.state(workspace).handoff,
   phase:'delivered',page}).status,'ready');
 auth.finishHandoff(workspace,'rotation-test','new');
 auth.releaseHandoff(workspace,'rotation-test','new');
 records.old.primaryAutomation.update();records.new.primaryAutomation.update();
 await records.new.primaryAutomation.flow.planChanged();
 await new Promise(resolve=>setTimeout(resolve,50));
 assert.deepEqual(sends,['new']);
 await Promise.all([records.old.primaryAutomation.flow.planChanged(),records.new.primaryAutomation.flow.planChanged()]);
 assert.deepEqual(sends,['new'],'no duplicate from second PlanMonitor or old idle pause');
});

test('T006: manual new Chat revokes an already prepared old Composer before its Send click',async t=>{
 const {configureProjectAutoPlan}=await import('../src/project-session-auto-plan.mjs');
 const auth=new ProjectAutoPlan({identity:()=> 'project',ownsSession:()=>true});
 auth.sync('/fixture','scope',{confirmed:true,planRevision:3,executionStrategy:'sequential'});
 auth.set('/fixture','scope',true,'old');
 const project={workspace:'/fixture',projectId:'project',sessionId:'old',scopeId:'scope',experience:'chat',
   chatUrl:'https://chatgpt.com/c/old-session',planExecution:{execution_strategy:'sequential'}};
 const plan={...project,confirmed:true,scopeStatus:'ACTIVE',planRevision:3,
   planView:{tasks:[{id:'T001',status:'pending'}]}};
 let release,signal;const gate=new Promise(resolve=>{release=resolve;});
 const entered=new Promise(resolve=>{signal=resolve;});let sends=0;
 const record={identity:{workspace:'/fixture',sessionId:'old'},project:()=>project,ready:true,loading:false,cleanups:[],
   controller:{pending:false,state:{phase:'delivered'},projectChanged:()=>{}},
   composer:{inFlight:false,sendUserMessage:async({canContinue,onBeforeSend})=>{
     signal();await gate;
     if(canContinue()&&await onBeforeSend())sends++;
     return {state:sends?'sent':'cancelled'};
   }}};
 configureProjectAutoPlan(record,{authorization:auth,
   store:{inspect:async()=>({...plan,inspectedSessionId:'old'})},inspectPlan:async()=>structuredClone(plan),onChange:()=>{}});
 t.after(()=>{release();record.cleanups.forEach(fn=>fn());});
 record.primaryAutomation.observe({documentId:'doc',state:{url:project.chatUrl,editorAvailable:true,writable:true,
   busy:false,draftPresent:false,lastMessageRole:'assistant',turnId:'assistant',userTurnId:'user'}});
 await Promise.race([entered,new Promise((_,reject)=>setTimeout(()=>reject(Error('Composer not entered')),2000))]);
 auth.beginHandoff('/fixture','scope','old',{operationId:'manual-click',kind:'manual'});
 release();await record.primaryAutomation.flow.reconcile();
 assert.equal(sends,0,'authorization changes before click cannot leak Continue to old Chat');
 assert.equal(auth.state('/fixture').sessionId,null);
});

test('Chat task cursor persists by scope and session without changing ON/OFF or recipient',()=>{
 const sessions=new Set(['chat-a','chat-b']);
 const auth=new ProjectAutoPlan({identity:()=> 'project',ownsSession:(_workspace,id)=>sessions.has(id)});
 auth.sync('/fixture','scope',{confirmed:true,planRevision:1,executionStrategy:'sequential',originSessionId:'chat-a'});
 auth.set('/fixture','scope',true,'chat-a');
 const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40);
 const baseline={confirmed:true,workspace:'/fixture',projectId:'project',sessionId:'chat-a',scopeId:'scope',
   experience:'chat',executionStrategy:'sequential',planRevision:1,baselineCommit:a,head:b,done:[],
   history:[{sha:b,scopeId:'scope',taskId:'publish',role:'scope-plan'}]};
 assert.deepEqual(auth.recordTaskProof('/fixture','chat-a',baseline),{recorded:true,count:0,added:[]});
 const done={...baseline,planRevision:2,head:c,done:[{id:'T001',sha:c}],history:[...baseline.history,
   {sha:c,scopeId:'scope',taskId:'T001',role:'implementation'}]};
 auth.set('/fixture','scope',false,'chat-a');
 assert.equal(auth.recordTaskProof('/fixture','chat-a',done).count,1,'OFF does not erase the cursor');
 auth.set('/fixture','scope',true,'chat-a');
 assert.equal(auth.recordTaskProof('/fixture','chat-a',done).count,1,'ON does not count twice');
 const restored=new ProjectAutoPlan({saved:auth.snapshot(),identity:()=> 'project',ownsSession:(_w,id)=>sessions.has(id)});
 assert.equal(restored.recordTaskProof('/fixture','chat-a',done).count,1,'restart retains task evidence');
 assert.equal(restored.state('/fixture').sessionId,'chat-a','recording is not an authorization transfer');
 assert.deepEqual(restored.checkpoint('/fixture','scope','chat-b'),{},'a different session has no inherited counter');
 const otherBaseline={...done,sessionId:'chat-b'};
 assert.equal(restored.recordTaskProof('/fixture','chat-b',otherBaseline).count,0,'new Chat snapshots existing DONE as baseline');
 assert.equal(restored.state('/fixture').sessionId,'chat-a','a manual select does not steal the recipient');
 const before=restored.snapshot();
 assert.deepEqual(restored.recordTaskProof('/fixture','chat-a',{...done,scopeId:'other'}),
   {recorded:false,reason:'ROTATION_SCOPE_OR_SESSION_CHANGED'});
 assert.deepEqual(restored.snapshot(),before,'wrong plan cannot mutate persisted ledgers');
 const foreign=new ProjectAutoPlan({saved:restored.snapshot(),identity:()=> 'replacement',ownsSession:()=>true});
 assert.equal(foreign.recordTaskProof('/fixture','chat-a',done).recorded,false,'replaced project cannot inherit evidence');
 restored.sync('/fixture','next-scope',{confirmed:true,planRevision:3,originSessionId:'chat-b',executionStrategy:'sequential'});
 assert.deepEqual(restored.checkpoint('/fixture','next-scope','chat-a'),{},'a new scope gets a new cursor');
});

test('project permission is OFF by default and never migrates legacy global ON',()=>{
 const a=new ProjectAutoPlan({saved:{autoPlanEnabled:true,autoPlanCheckpoint:{}}});
 assert.deepEqual(a.checkpoint('/unknown',undefined,'chat'),{});a.saveCheckpoint('/unknown',undefined,'chat',{});
 assert.equal(a.enabled('/a','one'),false);a.set('/a','one',true,'chat-a');
 assert.equal(a.enabled('/a','one'),true);assert.equal(a.enabled('/b','one'),false);
 a.set('/b','two',true,'chat-b');a.set('/a','one',false);
 assert.equal(a.enabled('/b','two'),true);
});
test('only confirmed completion disables that project; next scope and unknown plan are OFF',()=>{
 const a=new ProjectAutoPlan();a.set('/a','one',true,'chat');a.set('/b','two',true,'other');
 a.sync('/a','one',{complete:true,confirmed:false});assert.equal(a.enabled('/a','one'),true);
 a.sync('/a','one',{complete:true,confirmed:true});assert.equal(a.enabled('/a','one'),false);assert.equal(a.enabled('/b','two'),true);
 a.set('/a','one',true,'chat');a.sync('/a','next',{confirmed:true,planRevision:2});assert.equal(a.enabled('/a','next'),false);
 a.set('/a','next',true,'chat');a.sync('/a',null);assert.equal(a.enabled('/a','next'),true,'stale NONE cannot revoke an explicit ON');
});
test('restart preserves only the same unfinished scope and independent per-chat ledgers',()=>{
 const a=new ProjectAutoPlan();a.set('/a','one',true,'chat');
 a.saveCheckpoint('/a','one','chat',{autoPlanCheckpoint:{status:'sending'}});
 a.saveCheckpoint('/a','one','other',{autoPlanCheckpoint:{status:'sent'}});
 const b=new ProjectAutoPlan({saved:JSON.parse(JSON.stringify(a.snapshot()))});
 assert.equal(b.enabled('/a','one'),true);assert.equal(b.state('/a').sessionId,'chat');
 assert.equal(b.checkpoint('/a','one','chat').autoPlanCheckpoint.status,'sending');
 assert.equal(b.checkpoint('/a','one','other').autoPlanCheckpoint.status,'sent');
 assert.deepEqual(b.checkpoint('/b','one','chat'),{});
 b.sync('/a','next',{confirmed:true,planRevision:2});b.saveCheckpoint('/a','one','chat',{autoPlanCheckpoint:{status:'stale'}});
 assert.deepEqual(b.checkpoint('/a','next','chat'),{});
});

test('two main chats continue independently while hidden; completion and OFF affect only their project',async t=>{
 const {configureProjectAutoPlan}=await import('../src/project-session-auto-plan.mjs');
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'project-auto-flows-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const auth=new ProjectAutoPlan(),projects=new Map(),plans=new Map(),records=[],sends=[];
 const settle=()=>new Promise(resolve=>setTimeout(resolve,30));
 for(const name of ['a','b']) {
  const workspace=path.join(root,name);await fs.mkdir(workspace);
  const project={workspace,projectId:name,sessionId:name,chatUrl:'https://chatgpt.com/c/'+name,scopeId:'scope-'+name};
  projects.set(workspace,project);plans.set(workspace,{...project,inspectedSessionId:name,scopeStatus:'ACTIVE',confirmed:true,planRevision:1,
    planView:{tasks:[{id:'T001',status:'pending'}]}});
  const record={identity:{workspace,sessionId:name},project:()=>project,ready:true,loading:false,cleanups:[],
    controller:{pending:false,state:{phase:'delivered'},projectChanged:()=>{}},composer:{inFlight:false,sendUserMessage:async({canContinue,onBeforeSend})=>{
      if(!canContinue()||!await onBeforeSend())return {state:'cancelled'};sends.push(name);return {state:'sent'};}}};
  auth.set(workspace,project.scopeId,true,name);
  configureProjectAutoPlan(record,{store:{inspect:async w=>structuredClone(plans.get(w))},authorization:auth,
    inspectPlan:async p=>structuredClone(plans.get(p.workspace)),onChange:()=>{}});records.push(record);
  t.after(()=>record.cleanups.forEach(fn=>fn()));
 }
 await settle();
 for(const record of records)record.primaryAutomation.observe({documentId:'doc',state:{url:record.project().chatUrl,busy:false,
   editorAvailable:true,writable:true,lastMessageRole:'assistant',turnId:'first',userTurnId:'user',draftPresent:false}});
 await settle();await Promise.all(records.map(r=>r.primaryAutomation.flow.reconcile()));
 assert.deepEqual(sends.sort(),['a','b']);
 const first=records[0],second=records[1];plans.get(first.project().workspace).planView.tasks[0].status='done';
 first.primaryAutomation.changed();await settle();
 assert.equal(auth.enabled(first.project().workspace,first.project().scopeId),false);
 assert.equal(auth.enabled(second.project().workspace,second.project().scopeId),true);
 auth.set(second.project().workspace,second.project().scopeId,false);second.primaryAutomation.update();
 second.primaryAutomation.observe({documentId:'doc',state:{url:second.project().chatUrl,busy:false,editorAvailable:true,writable:true,lastMessageRole:'assistant',turnId:'next'}});
 await settle();assert.equal(sends.length,2);
});

test('explicit ON before a plan survives restart and binds once to the first scope',()=>{
 const a=new ProjectAutoPlan();assert.equal(a.enabled('/a',null),false);
 a.set('/a',null,true,'main');a.sync('/a',null);
 assert.equal(a.enabled('/a',null),true);assert.equal(a.enabled('/b',null),false);
 const b=new ProjectAutoPlan({saved:JSON.parse(JSON.stringify(a.snapshot()))});
 assert.equal(b.enabled('/a',null),true);b.sync('/a','first',{confirmed:true,planRevision:1});
 assert.equal(b.enabled('/a','first'),true);assert.equal(b.state('/a').sessionId,'main');
 b.sync('/a','first',{complete:true,confirmed:true});assert.equal(b.enabled('/a','first'),false);
 b.sync('/a','second',{confirmed:true,planRevision:2});assert.equal(b.enabled('/a','second'),false);
});

// Characterization before rotation: creating/selecting a second Chat does not
// change the permission recipient. Today an explicit OFF -> ON is necessary to
// move authority; T006 will add the guarded new-Chat+Recovery path without
// giving ordinary selection the same capability.
test('rotation baseline: new Chat alone does not transfer recipient; explicit ON does, without losing the old ledger',()=>{
 const sessions=new Set(['chat-old']);
 const identity=()=> 'same-project';
 const ownsSession=(_workspace,id)=>sessions.has(id);
 const auth=new ProjectAutoPlan({identity,ownsSession});
 auth.set('/fixture',null,true,'chat-old');
 auth.sync('/fixture','scope',{confirmed:true,planRevision:1,originSessionId:'chat-old',executionStrategy:'sequential'});
 assert.equal(auth.enabled('/fixture','scope'),true,'pre-plan ON attaches to the published plan');
 assert.equal(auth.state('/fixture').sessionId,'chat-old');
 auth.saveCheckpoint('/fixture','scope','chat-old',{autoPlanCheckpoint:{entries:[{status:'sent',turnId:'a'}]}});

 sessions.add('chat-new'); // WorkspaceSessions.newSession does not call ProjectAutoPlan.set.
 auth.sync('/fixture','scope',{confirmed:true,planRevision:2,originSessionId:'chat-old'});
 assert.equal(auth.state('/fixture').sessionId,'chat-old','a new/selected Chat does not steal the current recipient');
 assert.deepEqual(auth.checkpoint('/fixture','scope','chat-new'),{},'new chat starts with a fresh ledger');

 auth.set('/fixture','scope',false,'chat-old');
 assert.equal(auth.state('/fixture').offReason,'manual');
 auth.set('/fixture','scope',true,'chat-new');
 assert.equal(auth.state('/fixture').sessionId,'chat-new');
 assert.equal(auth.state('/fixture').offReason,null);
 const resumed=new ProjectAutoPlan({saved:auth.snapshot(),identity,ownsSession});
 assert.equal(resumed.enabled('/fixture','scope'),true);
 assert.equal(resumed.state('/fixture').sessionId,'chat-new');
 assert.deepEqual(resumed.checkpoint('/fixture','scope','chat-new'),{});
 assert.equal(resumed.checkpoint('/fixture','scope','chat-old').autoPlanCheckpoint.entries[0].status,'sent');
});

test.todo('rotation: manually created new Chat under ON becomes the sole recipient after confirmed Recovery without toggling');
test.todo('rotation: OFF keeps manual Chat creation inert and plain selection never steals permission');
test.todo('rotation: background project creates its replacement Chat without changing the visible project');

test('OFF cancels pre-plan authorization and a read failure cannot carry old scope ON',()=>{
 const a=new ProjectAutoPlan();a.set('/a',null,true,'main');a.set('/a',null,false,'main');
 a.sync('/a','first',{confirmed:true,planRevision:1});assert.equal(a.enabled('/a','first'),false);
 a.set('/a','first',true,'main');a.sync('/a',null);
 assert.equal(a.enabled('/a','first'),true,'a stale null does not revoke ON');assert.equal(a.enabled('/a',null),false);
});

test('a new project identity at the same path and scope cannot inherit ON or checkpoints',()=>{
 let id='old';const sessions=new Set(['old-chat']);
 const a=new ProjectAutoPlan({identity:()=>id,ownsSession:(_w,s)=>sessions.has(s)});
 a.set('/a','scope',true,'old-chat');a.saveCheckpoint('/a','scope','old-chat',{autoPlanCheckpoint:{status:'sending'}});
 const saved=a.snapshot();assert.equal(saved['/a'].projectId,'old');
 id='new';sessions.clear();sessions.add('new-chat');
 const b=new ProjectAutoPlan({saved,identity:()=>id,ownsSession:(_w,s)=>sessions.has(s)});
 assert.equal(b.enabled('/a','scope'),false);assert.deepEqual(b.checkpoint('/a','scope','new-chat'),{});
 b.sync('/a','scope',{confirmed:true});assert.equal(b.state('/a').projectId,'new');assert.equal(b.enabled('/a','scope'),false);
 b.set('/a','scope',true,'new-chat');b.saveCheckpoint('/a','scope','old-chat',{autoPlanCheckpoint:{status:'sent'}});
 assert.equal(b.state('/a').sessions['old-chat'],undefined);
 assert.equal(new ProjectAutoPlan({saved:b.snapshot(),identity:()=>id,ownsSession:(_w,s)=>sessions.has(s)}).enabled('/a','scope'),true);
});
test('legacy permission migrates only with its original registered chat',()=>{
 const saved={'/a':{scopeId:'scope',enabled:true,sessionId:'old',sessions:{}}};
 const a=new ProjectAutoPlan({saved,identity:()=> 'new',ownsSession:()=>false});assert.equal(a.enabled('/a','scope'),false);
 const b=new ProjectAutoPlan({saved,identity:()=> 'same',ownsSession:()=>true});assert.equal(b.enabled('/a','scope'),true);assert.equal(b.state('/a').projectId,'same');
});

test('A01-A05: awaitingPlan survives stale NONE, read errors and restart; only confirmed higher revision binds once to published origin',()=>{
 const sessions=new Set(['a','b']);const identity=()=> 'project';const ownsSession=(_w,id)=>sessions.has(id);
 const a=new ProjectAutoPlan({identity,ownsSession});
 a.set('/main',null,true,'a');
 for(const scope of [null,'draft'])a.sync('/main',scope,{confirmed:false,planRevision:1,originSessionId:'b'});
 assert.equal(a.enabled('/main',null),true);
 const b=new ProjectAutoPlan({saved:a.snapshot(),identity,ownsSession});
 b.sync('/main',null);b.sync('/main','draft',{confirmed:false,planRevision:2});
 assert.equal(b.state('/main').awaitingPlan,true);
 b.sync('/main','published',{confirmed:true,planRevision:3,originSessionId:'b'});
 assert.equal(b.enabled('/main','published'),true);assert.equal(b.state('/main').sessionId,'b');
 b.sync('/main','draft',{confirmed:true,planRevision:2,originSessionId:'a'});
 b.sync('/main',null);b.sync('/main','published',{confirmed:false,planRevision:4});
 assert.equal(b.state('/main').scopeId,'published');assert.equal(b.state('/main').sessionId,'b');
 assert.equal(b.enabled('/main','published'),true);
 b.sync('/main','published',{confirmed:true,planRevision:5,complete:true});
 assert.equal(b.state('/main').offReason,'complete');assert.equal(b.finalizationAllowed('/main','published'),true);
 b.sync('/main','next',{confirmed:true,planRevision:6,originSessionId:'a'});
 assert.equal(b.enabled('/main','next'),false);assert.equal(b.state('/main').offReason,null);
 b.sync('/main','published',{confirmed:true,planRevision:5});assert.equal(b.state('/main').scopeId,'next');
});

test('A03/A06: only the user records manual OFF; stale reads and other projects/Review are independent',()=>{
 const a=new ProjectAutoPlan();a.set('/one',null,true,'chat-a');a.set('/two','other',true,'chat-c');
 a.sync('/one',null);a.sync('/one','pending',{confirmed:false,planRevision:1});
 assert.equal(a.state('/one').offReason,null);assert.equal(a.enabled('/one',null),true);
 a.sync('/one','one',{confirmed:true,planRevision:2,originSessionId:'chat-b'});
 a.sync('/one','one',{confirmed:true,planRevision:2});
 assert.equal(a.state('/one').offReason,null);assert.equal(a.enabled('/two','other'),true);
 a.set('/one','one',false,'chat-a');
 assert.equal(a.state('/one').offReason,'manual');assert.equal(a.enabled('/two','other'),true);
 a.sync('/one','one',{confirmed:true,planRevision:3,complete:true});
 assert.equal(a.state('/one').offReason,'manual','programmatic completion does not overwrite user OFF');
});

test('A04/A05: a new archived-plan epoch may restart revision numbers without resurrecting its previous scope',()=>{
 const auth=new ProjectAutoPlan();auth.set('/a','old',true,'main');
 auth.sync('/a','old',{confirmed:true,planRevision:500,complete:true});
 auth.set('/a',null,true,'main');
 auth.sync('/a','old',{confirmed:true,planRevision:500});
 assert.equal(auth.state('/a').awaitingPlan,true,'the archived scope cannot consume the new wait');
 auth.sync('/a','fresh',{confirmed:true,planRevision:1,originSessionId:'main'});
 assert.equal(auth.enabled('/a','fresh'),true);
 const restored=new ProjectAutoPlan({saved:auth.snapshot()});
 restored.sync('/a','old',{confirmed:true,planRevision:500});
 assert.equal(restored.state('/a').scopeId,'fresh');
});

test('T001 boundary: one pre-plan ON binds to the published origin despite stale NONE and another project',()=>{
 const sessions=new Set(['preplan','published']);
 const identities=new Map([['/fixture','project-a'],['/neighbor','project-b']]);
 const auth=new ProjectAutoPlan({identity:workspace=>identities.get(workspace),ownsSession:(_workspace,id)=>sessions.has(id)});
 auth.set('/fixture',null,true,'preplan');
 auth.set('/neighbor','neighbor-scope',true,'preplan');
 auth.sync('/fixture',null,{confirmed:false});
 auth.sync('/fixture','unpublished',{confirmed:false,planRevision:10,originSessionId:'published'});
 assert.equal(auth.state('/fixture').awaitingPlan,true);
 const afterRestart=new ProjectAutoPlan({saved:auth.snapshot(),identity:workspace=>identities.get(workspace),
   ownsSession:(_workspace,id)=>sessions.has(id)});
 afterRestart.sync('/fixture','published-scope',{confirmed:true,planRevision:11,originSessionId:'published'});
 assert.equal(afterRestart.state('/fixture').sessionId,'published');
 assert.equal(afterRestart.enabled('/fixture','published-scope'),true);
 afterRestart.sync('/fixture',null,{confirmed:false});
 assert.equal(afterRestart.enabled('/fixture','published-scope'),true);
 assert.equal(afterRestart.enabled('/neighbor','neighbor-scope'),true);
 // This authorization-unit path already works. The existing Electron smoke
 // needed a *second* ON after publication: T002 must repair that wiring.
});

test('T001 boundary: OFF and recovered-session ON transfer one project permission but not its ledgers',()=>{
 const auth=new ProjectAutoPlan({identity:()=> 'same-project',ownsSession:(_w,id)=>['previous','recovered'].includes(id)});
 auth.set('/fixture','scope',true,'previous');
 const sent={version:3,entries:[{key:JSON.stringify(['/fixture','previous','scope','https://chatgpt.com/c/previous']),
   turnId:'previous-answer',status:'sent',generation:1}],cycles:[]};
 auth.saveCheckpoint('/fixture','scope','previous',{autoPlanCheckpoint:sent,
   automationCheckpoint:{version:2,entries:[{status:'sending'}]}});
 auth.set('/fixture','scope',false,'previous');
 assert.equal(auth.state('/fixture').offReason,'manual');
 auth.set('/fixture','scope',true,'recovered');
 assert.equal(auth.state('/fixture').sessionId,'recovered');
 assert.equal(auth.enabled('/fixture','scope'),true);
 assert.deepEqual(auth.checkpoint('/fixture','scope','recovered'),{});
 assert.deepEqual(auth.checkpoint('/fixture','scope','previous').autoPlanCheckpoint,sent);
 const restarted=new ProjectAutoPlan({saved:auth.snapshot(),identity:()=> 'same-project',ownsSession:()=>true});
 assert.equal(restarted.state('/fixture').sessionId,'recovered');
 assert.deepEqual(restarted.checkpoint('/fixture','scope','previous').autoPlanCheckpoint,sent);
 // T003 must prove the click also wakes the new live runtime via sidebar IPC.
});

test('T003: ON during an unconfirmed plan read retains ACTIVE identity and checkpoint on recovered main',()=>{
 // The same unconfirmed IPC path previously replaced a confirmed ACTIVE
 // scope with awaitingPlan and then could not rebind previousScopeId.
 const auth=new ProjectAutoPlan({identity:()=> 'project',ownsSession:()=>true});
 auth.set('/fixture','partial',true,'previous');
 auth.sync('/fixture','partial',{confirmed:true,planRevision:42,originSessionId:'previous'});
 auth.set('/fixture','partial',false,'previous');
 auth.saveCheckpoint('/fixture','partial','previous',{autoPlanCheckpoint:{version:3,entries:[{
   key:JSON.stringify(['/fixture','previous','partial','https://chatgpt.com/c/previous']),
   turnId:'already-sent',status:'sent'}]}});
 auth.sync('/fixture',null,{confirmed:false});
 auth.setWhileUnconfirmed('/fixture',true,'recovered');
 assert.deepEqual({scope:auth.state('/fixture').scopeId,awaiting:auth.state('/fixture').awaitingPlan,
   recipient:auth.state('/fixture').sessionId},
   {scope:'partial',awaiting:undefined,recipient:'recovered'},'unconfirmed read retains last trusted ACTIVE scope');
 auth.sync('/fixture','partial',{confirmed:true,planRevision:43,originSessionId:'previous'});
 assert.equal(auth.state('/fixture').scopeId,'partial');
 assert.equal(auth.state('/fixture').sessionId,'recovered','stale origin may not reassign an existing scope');
 assert.equal(auth.enabled('/fixture','partial'),true);
 assert.equal(auth.checkpoint('/fixture','partial','previous').autoPlanCheckpoint.entries[0].status,'sent');
 auth.setWhileUnconfirmed('/fixture',false,'recovered');
 assert.equal(auth.state('/fixture').offReason,'manual');
 assert.equal(auth.enabled('/fixture','partial'),false);
 auth.setWhileUnconfirmed('/fixture',true,'recovered');
 assert.equal(auth.state('/fixture').sessionId,'recovered');
 assert.equal(auth.checkpoint('/fixture','partial','previous').autoPlanCheckpoint.entries.length,1);
 const restarted=new ProjectAutoPlan({saved:auth.snapshot(),identity:()=> 'project',ownsSession:()=>true});
 assert.equal(restarted.enabled('/fixture','partial'),true);
 assert.equal(restarted.state('/fixture').sessionId,'recovered');
});

test('T003: incomplete reads cannot resurrect completed scope or import another project permission',()=>{
 let projectId='one';
 const auth=new ProjectAutoPlan({identity:()=>projectId,ownsSession:()=>true});
 auth.set('/fixture','done',true,'old');
 auth.sync('/fixture','done',{confirmed:true,planRevision:44,complete:true});
 auth.setWhileUnconfirmed('/fixture',true,'recovered');
 assert.equal(auth.state('/fixture').scopeId,'');
 assert.equal(auth.state('/fixture').awaitingPlan,true);
 auth.sync('/fixture','done',{confirmed:true,planRevision:44});
 assert.equal(auth.state('/fixture').scopeId,'','the previous confirmed completed scope is not rearmed');
 projectId='two';
 const restored=new ProjectAutoPlan({saved:auth.snapshot(),identity:()=>projectId,ownsSession:()=>false});
 assert.equal(restored.enabled('/fixture',null),false);
 assert.deepEqual(restored.checkpoint('/fixture','done','old'),{});
});

test('T003: unconfirmed parallel ON cannot transfer the published main origin',()=>{
 const auth=new ProjectAutoPlan({identity:()=> 'project',ownsSession:()=>true});
 auth.sync('/fixture','parallel-scope',{confirmed:true,planRevision:17,originSessionId:'main',executionStrategy:'parallel'});
 auth.set('/fixture','parallel-scope',true,'main');
 auth.set('/fixture','parallel-scope',false,'main');
 const restored=new ProjectAutoPlan({saved:auth.snapshot(),identity:()=> 'project',ownsSession:()=>true});
 assert.equal(restored.state('/fixture').executionStrategy,'parallel');
 restored.setWhileUnconfirmed('/fixture',true,'new-chat');
 assert.equal(restored.state('/fixture').sessionId,'main');
 assert.equal(restored.enabled('/fixture','parallel-scope'),true);
 restored.sync('/fixture',null,{confirmed:false});
 assert.equal(restored.state('/fixture').sessionId,'main');
});

test('T003: trustworthy NONE after an archived scope can arm a fresh first plan',()=>{
 const auth=new ProjectAutoPlan();
 auth.set('/fixture','old-scope',true,'main');
 auth.sync('/fixture','old-scope',{confirmed:true,planRevision:100,executionStrategy:'sequential'});
 auth.set('/fixture','old-scope',false,'main');
 // A separately verified NONE calls set(null) at IPC, not the unconfirmed path.
 auth.set('/fixture',null,true,'new-chat');
 assert.equal(auth.state('/fixture').awaitingPlan,true);
 auth.sync('/fixture','new-scope',{confirmed:true,planRevision:1,originSessionId:'new-chat',executionStrategy:'sequential'});
 assert.equal(auth.enabled('/fixture','new-scope'),true);
 assert.equal(auth.state('/fixture').sessionId,'new-chat');
 auth.sync('/fixture','old-scope',{confirmed:true,planRevision:100});
 assert.equal(auth.state('/fixture').scopeId,'new-scope');
});
test('T004: repeated recovered ON is idempotent, and a foreign project at the same path starts OFF',()=>{
 const identity={value:'project-one'};
 const auth=new ProjectAutoPlan({identity:()=>identity.value,ownsSession:()=>true});
 auth.set('/fixture','partial',true,'old');
 auth.sync('/fixture','partial',{confirmed:true,planRevision:7,originSessionId:'old',executionStrategy:'sequential'});
 auth.saveCheckpoint('/fixture','partial','old',{autoPlanCheckpoint:{entries:[{status:'sending'}]}});
 auth.set('/fixture','partial',false,'old');
 auth.setWhileUnconfirmed('/fixture',true,'recovered');
 auth.setWhileUnconfirmed('/fixture',true,'recovered');
 auth.sync('/fixture',null,{confirmed:false});
 auth.sync('/fixture','partial',{confirmed:true,planRevision:8,originSessionId:'old'});
 assert.equal(auth.state('/fixture').sessionId,'recovered');
 assert.equal(auth.enabled('/fixture','partial'),true);
 assert.equal(auth.checkpoint('/fixture','partial','old').autoPlanCheckpoint.entries[0].status,'sending');
 assert.deepEqual(auth.checkpoint('/fixture','partial','recovered'),{});
 const copy=structuredClone(auth.snapshot());
 identity.value='different-project';
 const foreign=new ProjectAutoPlan({saved:copy,identity:()=>identity.value,ownsSession:()=>true});
 assert.equal(foreign.enabled('/fixture','partial'),false);
 assert.notEqual(foreign.state('/fixture')?.sessionId,'recovered');
});

test('A01/A02/A04/A06: two main monitors in one project send only from plan origin despite stale/error, then OFF',async t=>{
 const {configureProjectAutoPlan}=await import('../src/project-session-auto-plan.mjs');
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'two-main-autoplan-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const records=[],sends=[];let failA=false,staleA=false,review=false;
 const state={workspace:root,projectId:'project',scopeId:null,scopeStatus:'NONE',confirmed:false,planRevision:0,
   planView:{tasks:[]}};
 const auth=new ProjectAutoPlan({identity:()=> 'project',ownsSession:(_w,id)=>['a','b'].includes(id),
   onChange:()=>records.forEach(r=>r.primaryAutomation?.update())});
 auth.set(root,null,true,'a');
 for(const id of ['a','b']){
  const project={workspace:root,projectId:'project',sessionId:id,experience:id==='a'?'chat':'work',
    chatUrl:'https://chatgpt.com/c/'+id};
  const record={identity:{workspace:root,sessionId:id},project:()=>project,ready:true,loading:false,cleanups:[],
    controller:{pending:false,state:{phase:'delivered'},projectChanged:()=>{}},
    composer:{inFlight:false,sendUserMessage:async({canContinue,onBeforeSend})=>{
      if(!canContinue()||!await onBeforeSend())return {state:'cancelled'};
      sends.push(id);return {state:'sent'};
    }}};
  records.push(record);
  configureProjectAutoPlan(record,{authorization:auth,store:{inspect:async(_workspace,sessionId)=>{
    if(failA&&sessionId==='a')throw Error('PLAN_READ_FAILED');
    return {...structuredClone(staleA&&sessionId==='a'?{
      ...state,scopeId:null,confirmed:false,scopeStatus:'NONE',planRevision:0,planView:{tasks:[]}}:state),inspectedSessionId:sessionId};
  }},inspectPlan:async()=>{
    if(failA&&id==='a')throw Error('PLAN_READ_FAILED');
    return {...structuredClone(state),confirmed:state.confirmed&&!review};
  },onChange:()=>{}});
  t.after(()=>record.cleanups.forEach(fn=>fn()));
 }
 const settle=()=>new Promise(resolve=>setTimeout(resolve,90));
 await settle();assert.equal(auth.enabled(root,null),true);
 assert.equal(records[0].primaryAutomation.flow.enabled,true,'old main reflects project WAIT');
 assert.equal(records[1].primaryAutomation.flow.enabled,true,'new main reflects the same WAIT, without new ON');
 assert.deepEqual(sends,[]);
 // The non-origin chat reports stale NONE while the published plan names b.
 Object.assign(state,{scopeId:'first',scopeStatus:'ACTIVE',confirmed:true,planRevision:3,
  planExecution:{execution_strategy:'sequential',execution_origin_session_id:'b'},
  planView:{tasks:[{id:'T001',status:'pending'}]}});
 review=true; // Review can project a plan before it is safe to publish/execute.
 staleA=true;await records[0].primaryAutomation.monitor.tick();
 await records[1].primaryAutomation.monitor.tick();await settle();
 assert.equal(auth.enabled(root,null),true,'Review cannot consume the pre-plan ON');
 assert.equal(auth.state(root).awaitingPlan,true);
 assert.deepEqual(sends,[],'Review blocks both Chat and Work');
 review=false;
 records[1].primaryAutomation.changed();await settle();
 assert.equal(auth.enabled(root,'first'),true);assert.equal(auth.state(root).sessionId,'b');
 for(const record of records)record.primaryAutomation.observe({documentId:'doc',state:{
  url:record.project().chatUrl,busy:false,lastMessageRole:'assistant',turnId:'before',userTurnId:'user',
  editorAvailable:true,writable:true,draftPresent:false}});
 await settle();await Promise.all(records.map(r=>r.primaryAutomation.flow.reconcile()));
 assert.deepEqual(sends,['b']);
 assert.equal(records[0].primaryAutomation.flow.enabled,false,'non-origin main loses execution permission after binding');
 assert.equal(records[1].primaryAutomation.flow.enabled,true,'published origin is automatically armed');
 failA=true;staleA=false;await records[0].primaryAutomation.monitor.tick();await settle();
 assert.equal(auth.enabled(root,'first'),true);assert.equal(auth.state(root).offReason,null);
 assert.deepEqual(sends,['b']);
 // Review never changes project permission and cannot initiate another Send.
 review=true;await records[1].primaryAutomation.changed();await settle();
 assert.equal(auth.enabled(root,'first'),true);
 auth.set(root,'first',false,'b');records[1].primaryAutomation.update();
 assert.equal(auth.state(root).offReason,'manual');assert.equal(records[1].primaryAutomation.flow.enabled,false);
 assert.deepEqual(sends,['b']);
});
