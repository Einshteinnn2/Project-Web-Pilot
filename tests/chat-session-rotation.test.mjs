import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { advanceChatSessionTaskCounter, chatRotationDecision } from '../src/chat-session-rotation.mjs';
import { readChatSessionTaskProof } from '../src/auto-plan-state.mjs';
import { renderPlan } from '@webpilot/workflow-kit/lib/plan';

const hash = digit => digit.repeat(40);
const base = hash('a');
const prior = hash('b');
const task1 = hash('c');
const task2 = hash('d');
const task3 = hash('e');
const record = (sha, taskId, role = 'implementation', scopeId = 'scope') => ({ sha, taskId, role, scopeId });
const initialHistory = [record(prior, 'published', 'scope-plan')];
const proof = (options = {}) => ({
  confirmed:true,workspace:'/fixture',projectId:'project',sessionId:'chat-a',scopeId:'scope',
  experience:'chat',executionStrategy:'sequential',planRevision:1,baselineCommit:base,
  head:prior,done:[],history:initialHistory,...options,
});

test('T004 decision: quotas 1 and 4, terminal DONE, Work, parallel, Stop and unconfirmed states',()=>{
 const selected={experience:'chat',scopeId:'scope'};
 const plan={confirmed:true,scopeId:'scope',scopeStatus:'ACTIVE',planExecution:{execution_strategy:'sequential'},
   planView:{tasks:[{id:'T001',status:'done'},{id:'T002',status:'pending'}]}};
 const decide=(count,limit,options={})=>chatRotationDecision({selected,plan,count,limit,...options});
 assert.equal(decide(0,1).status,'continue');
 assert.equal(decide(1,1).status,'rotate');
 assert.equal(decide(3,4).status,'continue');
 assert.equal(decide(4,4).status,'rotate');
 assert.equal(decide(5,4).status,'rotate');
 assert.equal(decide(4,4,{blocked:true}).reason,'MANUAL_STOP');
 assert.equal(decide(4,4,{plan:{...plan,confirmed:false}}).reason,'PLAN_CHANGED_OR_TRANSACTION');
 assert.equal(decide(4,4,{plan:{...plan,planView:{tasks:[{id:'T001',status:'done'}]}}}).status,'complete');
 assert.equal(decide(4,4,{selected:{...selected,experience:'work'}}).status,'continue');
 assert.equal(decide(4,4,{plan:{...plan,planExecution:{execution_strategy:'parallel'}}}).status,'continue');
 assert.equal(decide(-1,4).reason,'ROTATION_PROOF_ERROR');
 assert.equal(decide(4,0).reason,'ROTATION_SETTING_INVALID');
});

test('a new Chat starts at zero even when the plan already has completed tasks', () => {
  const done = [{ id: 'T001', sha: task1 }, { id: 'DOCS', sha: task2 }];
  const first = advanceChatSessionTaskCounter(null,proof({head:task2,done,history:[...initialHistory,
    record(task1,'T001'),record(task2,'DOCS')]}));
  assert.equal(first.count,0);
  assert.deepEqual(first.cursor.baselineDone,done);
  assert.deepEqual(first.added,[]);
  const next = advanceChatSessionTaskCounter(first.cursor,proof({planRevision:2,head:task3,
    done:[...done,{id:'T002',sha:task3}],history:[...initialHistory,record(task1,'T001'),record(task2,'DOCS'),record(task3,'T002')]}));
  assert.equal(next.count,1);
  assert.deepEqual(next.added,[{id:'T002',sha:task3}]);
});

test('Kit-proven T*, DOCS and delivery each count once; repeat monitors, OFF/ON and restart retain the ledger',()=>{
  let view=advanceChatSessionTaskCounter(null,proof());
  for (const [index,id,sha] of [[1,'T001',task1],[2,'DOCS',task2],[3,'T002',task3]]) {
    const revisions=index+1;
    const commits=[record(task1,'T001'),record(task2,'DOCS'),record(task3,'T002')].slice(0,index);
    view=advanceChatSessionTaskCounter(view.cursor,proof({planRevision:revisions,head:sha,
      done:commits.map(commit=>({id:commit.taskId,sha:commit.sha})),history:[...initialHistory,...commits]}));
    assert.equal(view.count,index);
    assert.equal(view.added.length,1);
    const restored=JSON.parse(JSON.stringify(view.cursor)); // persisted settings.json / restart
    const again=advanceChatSessionTaskCounter(restored,proof({planRevision:revisions,head:sha,
      done:commits.map(commit=>({id:commit.taskId,sha:commit.sha})),history:[...initialHistory,...commits]}));
    assert.equal(again.count,index);
    assert.deepEqual(again.added,[],'duplicate PlanMonitor/ON must not count again');
    view=again;
  }
  assert.equal(view.count,3);
});

test('unconfirmed/foreign/rewritten/stale evidence fails closed and leaves the saved cursor unchanged',()=>{
  const first=advanceChatSessionTaskCounter(null,proof());
  const old=JSON.stringify(first.cursor);
  const cases=[
    [proof({confirmed:false}), 'ROTATION_PROOF_UNAVAILABLE'],
    [proof({experience:'work'}), 'ROTATION_PROOF_UNAVAILABLE'],
    [proof({executionStrategy:'parallel'}), 'ROTATION_PROOF_UNAVAILABLE'],
    [proof({sessionId:'other-chat'}), 'ROTATION_CURSOR_OWNER_CHANGED'],
    [proof({scopeId:'other-scope'}), 'ROTATION_CURSOR_OWNER_CHANGED'],
    [proof({projectId:'replacement'}), 'ROTATION_CURSOR_OWNER_CHANGED'],
    [proof({planRevision:0}), 'ROTATION_PROOF_STALE'],
    [proof({head:task1,done:[{id:'T001',sha:task1}],history:[...initialHistory,record(task1,'wrong')]}), 'ROTATION_PROOF_AMBIGUOUS'],
    [proof({head:task1,done:[{id:'T001',sha:task1}],history:[...initialHistory,record(task1,'T001','implementation','other')]}), 'ROTATION_PROOF_AMBIGUOUS'],
    [proof({head:task1,done:[],history:[...initialHistory,record(task1,'T001')]}), 'ROTATION_PROOF_EXTERNAL'],
    [proof({head:task1,done:[],history:[...initialHistory,record(task1,'x','integration')]}), 'ROTATION_PROOF_EXTERNAL'],
  ];
  for (const [candidate,code] of cases) {
    assert.throws(()=>advanceChatSessionTaskCounter(first.cursor,candidate),{code});
    assert.equal(JSON.stringify(first.cursor),old,'failed observation must never mutate durable state');
  }
  const valid=advanceChatSessionTaskCounter(first.cursor,proof({head:task1,planRevision:3,
    done:[{id:'T001',sha:task1}],history:[...initialHistory,record(task1,'T001')]}));
  assert.equal(valid.count,1);
  assert.throws(()=>advanceChatSessionTaskCounter(valid.cursor,proof({planRevision:4,head:prior,
    done:[],history:initialHistory})),{code:'ROTATION_PROOF_REWRITTEN'});
  assert.throws(()=>advanceChatSessionTaskCounter(valid.cursor,proof({planRevision:4,head:task2,
    done:[{id:'T001',sha:task2}],history:[...initialHistory,record(task2,'T001')]})),
    {code:'ROTATION_PROOF_REWRITTEN'});
});

test('legitimate documentation metadata does not count or change recipient, but an external task does not slip through',()=>{
  const cursor=advanceChatSessionTaskCounter(null,proof()).cursor;
  const docs=advanceChatSessionTaskCounter(cursor,proof({head:task1,planRevision:2,history:[...initialHistory,
    record(task1,'docs-commit','documentation')]}));
  assert.equal(docs.count,0);
  assert.deepEqual(docs.added,[]);
  assert.throws(()=>advanceChatSessionTaskCounter(docs.cursor,proof({head:task2,planRevision:3,
    history:[...initialHistory,record(task1,'docs-commit','documentation'),record(task2,'unrelated','implementation','other')]})),
    {code:'ROTATION_PROOF_EXTERNAL'});
});

test('reader uses actual Workflow Kit Git commit refs, not a staged DONE or a similar-looking commit',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'chat-rotation-git-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  git('init','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
  await fs.mkdir(path.join(root,'.harness/plans'),{recursive:true});
  await fs.mkdir(path.join(root,'scripts'),{recursive:true});
  await fs.mkdir(path.join(root,'docs/planning'),{recursive:true});
  await fs.mkdir(path.join(root,'docs/architecture'),{recursive:true});
  await fs.writeFile(path.join(root,'scripts/workflow.mjs'),'// fixture\n');
  await fs.writeFile(path.join(root,'docs/planning/spec.md'),'# Fixture\n');
  await fs.writeFile(path.join(root,'docs/architecture/OVERVIEW.md'),'# Overview\n');
  git('add','.');git('commit','-m','base');const baselineCommit=git('rev-parse','HEAD');
  const scope='fixture-rotation';
  const makeTask=(id,title)=>({id,title,why:title,dependencies:[],functional_paths:[],
    documentation_paths:['docs/planning/spec.md'],verification_ids:[],verification_kind:'code',
    acceptance_criteria:['Verified'],expected_commit_message:'docs: fixture',implementation_status:'TODO',parallel_safe:false,
    commit_status:'PENDING',commit_ref:{scope_id:scope,task_id:id,role:'implementation'}});
  const p={schema_version:1,plan_revision:1,project_id:'fixture',project_name:'Fixture',scope_id:scope,
    execution_scope_status:'ACTIVE',delivery_status:'IN_PROGRESS',objective:'Rotation fixture',
    acceptance_criteria:['Accept'],baseline_commit:baselineCommit,current_task_id:null,blocked_reason:null,user_decisions:[],
    approved_scope:{functional_paths:[],documentation_paths:['docs/planning/spec.md']},
    context_pack:{documents:[{path:'docs/architecture/OVERVIEW.md',required:true,revision:'WORKTREE'}],
      include_last_completed_task:false,dependency_task_ids:[]},
    parallel_allowed:false,max_workers:1,execution_strategy:'sequential',execution_reason:'Test sequential proof',
    tasks:[makeTask('T001','First task'),makeTask('DOCS','Docs task'),makeTask('T002','Delivery-like task')]};
  const write=()=>fs.writeFile(path.join(root,'.harness/plans/todo-plan.md'),renderPlan(p));
  await write();git('add','.');git('commit','-m',`published\n\nWorkflow-Scope: ${scope}\nWorkflow-Task: scope-create\nWorkflow-Role: scope-plan`);
  const selected={workspace:root,sessionId:'chat-1',experience:'chat'};
  const baseline=await readChatSessionTaskProof(selected);
  assert.equal(baseline.confirmed,true);
  assert.equal(baseline.done.length,0);
  assert.equal(advanceChatSessionTaskCounter(null,baseline).count,0);
  p.tasks[0].implementation_status='IN_PROGRESS';p.current_task_id='T001';p.plan_revision++;
  await write();
  assert.equal((await readChatSessionTaskProof(selected)).confirmed,true,'task:start does not count as DONE');
  p.tasks[0].implementation_status='DONE';p.tasks[0].commit_status='DONE';p.current_task_id=null;p.plan_revision++;
  await write();
  await assert.rejects(readChatSessionTaskProof(selected),{code:'PLAN_COMMIT_MISMATCH'},
    'an uncommitted DONE in a partially active plan must fail closed');
  git('add','.');git('commit','-m',`First task\n\nWorkflow-Scope: ${scope}\nWorkflow-Task: T001\nWorkflow-Role: implementation\nWorkflow-Iteration: 1\nWorkflow-Transaction: fixture-t1`);
  const verified=await readChatSessionTaskProof(selected);
  assert.equal(verified.confirmed,true);
  assert.deepEqual(verified.done,[{id:'T001',sha:git('rev-parse','HEAD')}]);
  const after=advanceChatSessionTaskCounter(advanceChatSessionTaskCounter(null,baseline).cursor,verified);
  assert.equal(after.count,1);
});
