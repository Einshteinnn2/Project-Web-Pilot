import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectAutoPlan } from '../src/project-auto-plan.mjs';

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

test('T001 CURRENT race: recovered ON during an unconfirmed plan read strands the previous ACTIVE scope',()=>{
 // Reproduce the exact authorization calls made by pilot:auto-plan when a
 // transient read returns unconfirmed: sync(null) followed by set(null, ON).
 // This is a characterization, NOT a desired assertion. T003 must keep the
 // known unfinished scope and transfer the recipient to the recovered chat.
 const auth=new ProjectAutoPlan({identity:()=> 'project',ownsSession:()=>true});
 auth.set('/fixture','partial',true,'previous');
 auth.sync('/fixture','partial',{confirmed:true,planRevision:42,originSessionId:'previous'});
 auth.set('/fixture','partial',false,'previous');
 auth.saveCheckpoint('/fixture','partial','previous',{autoPlanCheckpoint:{version:3,entries:[{
   key:JSON.stringify(['/fixture','previous','partial','https://chatgpt.com/c/previous']),
   turnId:'already-sent',status:'sent'}]}});
 auth.sync('/fixture',null,{confirmed:false});
 auth.set('/fixture',null,true,'recovered');
 assert.deepEqual({scope:auth.state('/fixture').scopeId,awaiting:auth.state('/fixture').awaitingPlan,
   recipient:auth.state('/fixture').sessionId},
   {scope:'',awaiting:true,recipient:'recovered'},'T001 CURRENT: uncertain read turns recovered ON into pre-plan wait');
 auth.sync('/fixture','partial',{confirmed:true,planRevision:43,originSessionId:'previous'});
 assert.equal(auth.state('/fixture').scopeId,'',
   'T001 CURRENT: previousScopeId blocks rebinding to same partial plan; T003 must retain ACTIVE');
 assert.equal(auth.enabled('/fixture','partial'),false,'a recovered idle chat cannot send while stranded');
 assert.equal(auth.checkpoint('/fixture','partial','previous').autoPlanCheckpoint,undefined,
   'T001 CURRENT: changing scope loses the old scoped checkpoint lookup');
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
