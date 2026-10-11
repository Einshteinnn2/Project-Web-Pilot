import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoPlan, CONTINUE_TEXT, CONTINUE_MESSAGE_BYTES, continueMessage } from '../src/auto-plan.mjs';
import { readAutoPlanState } from '../src/auto-plan-state.mjs';
import { ChatGPTComposer } from '../src/chatgpt-composer.mjs';
import { PlanMonitor } from '../src/plan-monitor.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

function fixture({ busy = false, scopeId = 'scope', turnId = 'a1234' } = {}) {
  let selected = { workspace: '/project', projectId: 'project-id', sessionId: 'chat', scopeId, chatUrl: 'https://chatgpt.com/c/abcdefgh' };
  const plan = { confirmed: true, scopeId, scopeStatus: scopeId ? 'ACTIVE' : 'NONE', planRevision: 7,
    planView: { tasks: scopeId ? [{ id: 'T001', status: 'done' }, { id: 'T002', status: 'current' }, { id: 'DOCS', status: 'pending' }] : [] } };
  const timers = new Map(), sends = [], events = [], saved = [];
  let timerId = 0, sendResult = { state: 'sent' }, gate = null, inspectGate = null, available = true, reads = 0;
  const flow = new AutoPlan({ selected: () => selected, available: () => available,
    inspectPlan: async () => { reads++; if (inspectGate) await inspectGate(); return structuredClone(plan); },
    log: (event, fields) => events.push({ event, ...fields }),
    saveCheckpoint: async checkpoint => { saved.push(structuredClone(checkpoint)); },
    send: async (text, current, before) => {
      if (gate) await gate();
      if (!current() || !await before()) return { state: 'cancelled' };
      if (sendResult.state !== 'deferred') sends.push(text);
      return sendResult;
    },
    schedule: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, cancel: id => timers.delete(id) });
  const state = { url: selected.chatUrl, editorAvailable: true, writable: true, busy, assistantRevision: 0,
    manualStopRevision: 0, manualInputRevision: 0, manualSendRevision: 0, userMessageCount: 1, turnId, userTurnId: 'f1234', lastMessageRole: turnId ? 'assistant' : null, draftPresent: false };
  const observe = patch => { Object.assign(state, patch); flow.observe({ state: { ...state }, documentId: 'document-1111' }); };
  observe({});
  const drain = async () => {
    for (let i = 0; i < 4; i++) {
      await settle();
      for (const [id, value] of [...timers.entries()].filter(([, value]) => value.ms < 1000)) {
        timers.delete(id); value.fn();
      }
    }
    await settle();
  };
  const finish = async () => {
    observe({ busy: true }); await settle();
    observe({ busy: false, assistantRevision: ++state.assistantRevision, turnId: state.assistantRevision.toString(16), lastMessageRole: 'assistant' });
    await drain();
  };
  return { flow, plan, sends, saved, observe, drain, finish, timers, events, state, selected: () => selected, reads: () => reads,
    setResult: value => { sendResult = value; }, setGate: value => { gate = value; },
    setInspectGate: value => { inspectGate = value; },
    setAvailable: value => { available = value; flow.availabilityChanged(); },
    setSelection: value => { selected = { ...selected, ...value }; flow.selectionChanged(); },
    setScope: value => { selected = { ...selected, scopeId: value }; },
    changeSelection: () => { selected = { ...selected, sessionId: 'other', chatUrl: 'https://chatgpt.com/c/otherchat' }; flow.selectionChanged(); } };
}

test('toggle during busy sends nothing; ordinary idle replies send only exact Continue', async () => {
  const f = fixture({ busy: true, turnId: '' });
  await f.flow.start();
  assert.equal(f.reads(), 0, 'streaming progress does not read Git');
  assert.deepEqual(f.sends, []);
  await f.finish();
  assert.deepEqual(f.sends, [CONTINUE_TEXT]);
  await f.finish();
  assert.deepEqual(f.sends, ['Продолжай', 'Продолжай']);
});
test('existing idle replies with and without native IDs are suitable pauses', async () => {
  for (const turnId of ['a1234', '']) {
    const f = fixture({ turnId }); f.observe({ lastMessageRole: 'assistant' }); await f.flow.start();
    assert.deepEqual(f.sends, [CONTINUE_TEXT]);
    assert.deepEqual(f.flow.run.completedAtStart, ['T001']);
    f.observe({ busy: false }); await f.flow.planChanged(); await f.drain();
    assert.equal(f.sends.length, 1);
    await f.finish();
    assert.equal(f.sends.length, 2, 'a task can continue without a new DONE or commit');
    f.plan.planView.tasks.forEach(t => { t.status = 'done'; });
    await f.flow.planChanged(); await f.drain();
    assert.equal(f.flow.view().phase, 'complete');
    assert.equal(f.flow.view().enabled, false);
    assert.equal(f.sends.length, 2);
  }
});
test('T001 controller boundary: one ON on a recovered idle conversation sends once, old sent/unknown pauses remain guarded',async()=>{
 const f=fixture();
 await f.flow.start();
 assert.equal(f.sends.length,1,'previous main sent exactly once');
 const previous=f.flow.checkpointState();
  previous.entries.push({...previous.entries[0],turnId:'previous-uncertain',status:'sending'});
 f.flow.disable({manual:true});
 f.changeSelection();
 f.observe({url:f.selected().chatUrl,turnId:'recovery-idle',lastMessageRole:'assistant'});
 assert.equal(f.flow.view().enabled,false);
 f.flow.restore(false,previous);
 await f.flow.start(); // one explicit permission; no second OFF -> ON
 await f.drain();
 assert.equal(f.sends.length,2,'recovered main is immediately eligible at its already idle pause');
  assert.equal(f.flow.checkpointState().entries.length,3,'old sent and UNKNOWN plus recovered sent remain independent');
 await f.flow.planChanged();await f.drain();
 assert.equal(f.sends.length,2,'repeat plan/page events do not dispatch a duplicate');
 f.flow.dispose();f.flow.restore(true,f.flow.checkpointState());
 await f.flow.recover();assert.equal(f.sends.length,2,'restart does not repeat an acknowledged Send');
});
test('NONE becomes ACTIVE through PlanMonitor while an ordinary reply is busy', async () => {
  const f = fixture({ busy: true, scopeId: null, turnId: '' });
  const monitor = new PlanMonitor({
    selected: f.selected, retryDelays: [],
    inspect: async () => ({ ...structuredClone(f.plan), workspace: '/project', projectId: 'project-id', inspectedSessionId: 'chat' }),
    onChange: (info, meta) => { f.setScope(info.scopeId); if (meta.semanticChanged) void f.flow.planChanged(); },
  });
  await f.flow.start(); await monitor.tick(); await f.drain();
  assert.deepEqual(f.sends, []);
  f.plan.scopeId = 'scope'; f.plan.scopeStatus = 'ACTIVE'; f.plan.planRevision++;
  f.plan.planView.tasks = [{ id: 'T001', status: 'pending' }, { id: 'DOCS', status: 'pending' }];
  await monitor.tick(); await f.drain();
  assert.equal(f.reads(), 0);
  assert.deepEqual(f.sends, [], 'creating the plan never interrupts the current response');
  await f.finish();
  assert.deepEqual(f.sends, ['Продолжай']);
  f.plan.planView.tasks[0].status = 'done'; f.plan.planRevision++;
  await monitor.tick(); await f.finish();
  assert.deepEqual(f.sends, ['Продолжай', 'Продолжай']);
  monitor.close();
});
test('an enabled idle client wakes when its first plan appears', async () => {
  const f = fixture({ scopeId: null, turnId: '' }); f.observe({ lastMessageRole: 'assistant' }); await f.flow.start();
  assert.equal(f.flow.view().reason, 'PLAN_UNAVAILABLE');
  f.plan.scopeId = 'scope'; f.plan.scopeStatus = 'ACTIVE'; f.plan.planView.tasks = [{ id: 'T001', status: 'pending' }];
  f.setScope('scope'); await f.flow.planChanged(); await f.drain();
  assert.deepEqual(f.sends, ['Продолжай']);
});
test('completed, empty, inactive, unconfirmed, mismatched and OFF plans never send', async () => {
  for (const kind of ['done', 'empty', 'blocked', 'transaction', 'mismatch', 'off']) {
    const f = fixture();
    if (kind === 'done') f.plan.planView.tasks.forEach(t => { t.status = 'done'; });
    if (kind === 'empty') f.plan.planView.tasks = [];
    if (kind === 'blocked') f.plan.scopeStatus = 'BLOCKED';
    if (kind === 'transaction') f.plan.confirmed = false;
    if (kind === 'mismatch') f.plan.scopeId = 'another';
    if (kind !== 'off') await f.flow.start(); else await f.flow.planChanged();
    assert.deepEqual(f.sends, [], kind);
  }
});
test('unready pages wait and recover on their next relevant event', async () => {
  for (const kind of ['editor', 'writable', 'connection', 'url', 'availability']) {
    const f = fixture();
    if (kind === 'editor') f.observe({ editorAvailable: false });
    if (kind === 'writable') f.observe({ writable: false });
    if (kind === 'connection') f.observe({ connectionError: 'stream-interrupted' });
    if (kind === 'url') f.observe({ url: 'https://chatgpt.com/c/otherchat' });
    if (kind === 'availability') f.setAvailable(false);
    await f.flow.start();
    assert.deepEqual(f.sends, [], kind);
    f.observe({ editorAvailable: true, writable: true, connectionError: null, url: f.selected().chatUrl });
    f.setAvailable(true); await f.drain();
    assert.deepEqual(f.sends, ['Продолжай'], kind);
  }
});
test('a transaction or read error waits until a later plan event without a toggle', async () => {
  for (const kind of ['transaction', 'read-error']) {
    const f = fixture();
    if (kind === 'transaction') f.plan.confirmed = false;
    else f.setInspectGate(() => { throw Error('private-read-error'); });
    await f.flow.start();
    assert.deepEqual(f.sends, []);
    assert.equal(f.flow.view().enabled, true);
    f.plan.confirmed = true; f.setInspectGate(null);
    await f.flow.planChanged(); await f.drain();
    assert.deepEqual(f.sends, ['Продолжай']);
    assert.doesNotMatch(JSON.stringify(f.events), /private-read-error/);
  }
});
test('duplicate page and plan events serialize inspections and consume one pause', async () => {
  const f = fixture();
  let release, first = true, active = 0, max = 0;
  f.setInspectGate(async () => {
    active++; max = Math.max(max, active);
    if (first) { first = false; await new Promise(resolve => { release = resolve; }); }
    active--;
  });
  const start = f.flow.start(); await settle();
  f.observe({}); void f.flow.planChanged(); f.observe({}); void f.flow.recover();
  release(); await start; await f.drain();
  assert.equal(max, 1);
  assert.deepEqual(f.sends, ['Продолжай']);
});
test('page becomes busy during the plan read: do not send on stale idle', async () => {
  const f = fixture(); let first = true;
  f.setInspectGate(async () => { if (first) { first = false; f.observe({ busy: true }); } });
  await f.flow.start(); await f.drain();
  assert.deepEqual(f.sends, []);
  await f.finish(); assert.deepEqual(f.sends, ['Продолжай']);
});
test('simultaneous plan change and end of answer wait for settled idle and send once', async () => {
  const f = fixture({ busy: true }); await f.flow.start();
  f.observe({ busy: false, turnId: 'b1234', assistantRevision: 1 });
  f.plan.planRevision++; await f.flow.planChanged();
  assert.deepEqual(f.sends, [], 'settle timer gates all event sources');
  await f.drain(); assert.deepEqual(f.sends, ['Продолжай']);
});
test('disable, selection, completion and new busy during pre-Send cancel dispatch', async () => {
  for (const kind of ['off', 'selection', 'done', 'busy']) {
    const f = fixture();
    f.setGate(async () => {
      if (kind === 'off') f.flow.disable();
      if (kind === 'selection') f.changeSelection();
      if (kind === 'done') f.plan.planView.tasks.forEach(t => { t.status = 'done'; });
      if (kind === 'busy') f.observe({ busy: true });
    });
    await f.flow.start(); await f.drain();
    assert.deepEqual(f.sends, [], kind);
  }
});
test('draft waits without changing it; clearing the draft wakes the same pause', async () => {
  const f = fixture(); f.observe({ draftPresent: true }); await f.flow.start();
  assert.equal(f.flow.view().reason, 'DRAFT_PRESENT');
  assert.equal(f.state.draftPresent, true);
  assert.deepEqual(f.sends, []);
  f.observe({ draftPresent: false }); await f.drain();
  assert.deepEqual(f.sends, ['Продолжай']);
});
test('manual Send wins while continuation is being inspected and waits for a new reply', async () => {
  const f = fixture();
  f.setGate(async () => { f.observe({ manualSendRevision: 1, busy: true }); });
  await f.flow.start(); await f.drain();
  assert.deepEqual(f.sends, []);
  f.setGate(null); await f.finish();
  assert.deepEqual(f.sends, ['Продолжай']);
});
test('own composer insertion can change draft state while its guarded Send is in flight', async () => {
  const f = fixture();
  f.setGate(async () => { f.observe({ draftPresent: true }); });
  await f.flow.start();
  assert.deepEqual(f.sends, ['Продолжай']);
});
test('unknown Send never repeats the same pause on events, reload or toggle', async () => {
  const f = fixture(); f.setResult({ state: 'unknown' });
  await f.flow.start(); assert.equal(f.flow.view().reason, 'SEND_UNKNOWN');
  const checkpoint = f.flow.checkpoint;
  f.observe({}); await f.flow.planChanged(); await f.drain();
  f.flow.observe({ reset: true }); f.observe({}); await f.drain();
  f.flow.disable(); await f.flow.start();
  assert.deepEqual(f.sends, ['Продолжай']);
  assert.deepEqual(f.flow.checkpoint, checkpoint);
});
test('known deferred Send preserves the previous checkpoint and never claims delivery', async () => {
  const f = fixture(); f.setResult({ state: 'deferred', reason: 'DRAFT_PRESENT' });
  await f.flow.start();
  assert.deepEqual(f.sends, []);
  assert.equal(f.flow.checkpoint, null);
  assert.equal(f.flow.view().reason, 'DRAFT_PRESENT');
  assert.equal(f.flow.view().continuations, 0);
});
test('counter records confirmed automatic Continue and retains it across waits', async () => {
  const f = fixture(); await f.flow.start(); assert.equal(f.flow.view().continuations, 1);
  f.observe({ connectionError: 'stream-interrupted' }); await f.drain();
  assert.equal(f.flow.view().continuations, 1);
  f.observe({ connectionError: null }); await f.finish();
  assert.equal(f.flow.view().continuations, 2);
  f.setResult({ state: 'unknown' }); await f.finish();
  assert.equal(f.flow.view().continuations, 2);
  f.changeSelection(); await f.drain();
  assert.equal(f.flow.view().continuations, 0);
});
test('busy watchdog warns without stopping automation or reading Git', async () => {
  const f = fixture({ busy: true }); await f.flow.start();
  const first = f.flow.watchdog;
  f.observe({ visibility: 'hidden' }); await f.drain();
  assert.equal(f.flow.watchdog, first);
  f.observe({ assistantRevision: 2 }); await f.drain();
  assert.notEqual(f.flow.watchdog, first);
  const id = f.flow.watchdog, timeout = f.timers.get(id); f.timers.delete(id); timeout.fn();
  assert.equal(f.flow.view().warning, 'STALL_WARNING');
  assert.equal(f.flow.view().enabled, true);
  assert.equal(f.reads(), 0);
  assert.deepEqual(f.sends, []);
  f.observe({ assistantRevision: 3 }); await f.drain();
  assert.equal(f.flow.view().warning, null);
  await f.finish(); assert.deepEqual(f.sends, ['Продолжай']);
});
test('timers never poll an idle plan after a confirmed Send', async () => {
  const f = fixture(); await f.flow.start(); const reads = f.reads();
  for (const [id, value] of [...f.timers]) { f.timers.delete(id); value.fn(); }
  await settle();
  assert.equal(f.reads(), reads);
  assert.deepEqual(f.sends, ['Продолжай']);
});
test('persistent enabled choice resumes busy and consumed checkpoints without another Send', async () => {
  for (const kind of ['busy', 'draft', 'done', 'off', 'sent', 'sending']) {
    const f = fixture({ busy: kind === 'busy' });
    if (kind === 'draft') f.observe({ draftPresent: true });
    if (kind === 'done') f.plan.planView.tasks.forEach(t => { t.status = 'done'; });
    const checkpoint = ['sent', 'sending'].includes(kind) ? { key: JSON.stringify(['/project', 'chat', 'scope', f.selected().chatUrl]), turnId: 'a1234', status: kind } : null;
    f.flow.restore(kind !== 'off', checkpoint); await f.flow.recover(); await f.drain();
    assert.deepEqual(f.sends, [], kind);
    if (kind === 'busy') { await f.finish(); assert.deepEqual(f.sends, ['Продолжай']); }
    if (kind === 'sending') assert.equal(f.flow.view().reason, 'SEND_UNKNOWN');
  }
});
test('checkpoint is saved before Send and failed persistence never sends', async () => {
  const order = [], f = fixture();
  f.flow.saveCheckpoint = async checkpoint => { if (checkpoint.entries.length) order.push(checkpoint.entries.at(-1).status); };
  const send = f.flow.send; f.flow.send = async (...args) => { order.push('Send'); return send(...args); };
  await f.flow.start();
  assert.deepEqual(order, ['sending', 'Send', 'sent']);
  const failed = fixture(); failed.flow.saveCheckpoint = async () => { throw Error('private-disk-error'); };
  await failed.flow.start(); assert.deepEqual(failed.sends, []);
  assert.equal(failed.flow.view().reason, 'SEND_CHECKPOINT_ERROR');
  assert.equal(failed.flow.view().enabled, true);
  assert.doesNotMatch(JSON.stringify(failed.events), /private-disk-error/);
});
test('UI publication only wakes automation when availability changes', async () => {
  const f = fixture(); f.flow.onChange = () => f.flow.availabilityChanged();
  await f.flow.start(); const reads = f.reads();
  for (let i = 0; i < 10; i++) f.flow.availabilityChanged();
  await f.drain();
  assert.equal(f.reads(), reads);
  assert.deepEqual(f.sends, ['Продолжай']);
});

test('checkpoint reader distinguishes working task, prepared DONE and committed DONE', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-plan-proof-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init','-b','main']); git(['config','user.name','Fixture']); git(['config','user.email','fixture@example.invalid']);
  await fs.mkdir(path.join(root,'.harness/plans'),{ recursive: true }); await fs.mkdir(path.join(root,'scripts'));
  await fs.writeFile(path.join(root,'scripts/workflow.mjs'),'');
  const p = { schema_version: 1, project_id: 'fixture', project_name: 'Fixture', plan_revision: 1, scope_id: 'scope',
    execution_scope_status: 'ACTIVE', delivery_status: 'IN_PROGRESS',
    tasks: [{ id: 'DOCS', title: 'Docs', implementation_status: 'IN_PROGRESS', commit_status: 'PENDING', why: 'Keep context',
      acceptance_criteria: ['Docs match the result'], functional_paths: [], documentation_paths: ['docs/PRODUCT.md'], verification_ids: ['unit-all'] }] };
  const write = () => fs.writeFile(path.join(root,'.harness/plans/todo-plan.md'),
    '<!-- workflow-state:begin -->\n\x60\x60\x60json\n' + JSON.stringify(p) + '\n\x60\x60\x60\n<!-- workflow-state:end -->');
  await write(); git(['add','.']); git(['commit','-m','fixture']);
  const bundledGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
  const first = await readAutoPlanState({ workspace: root }, { ...process.env, PATH: '/unavailable', WORKFLOW_GIT_BIN: bundledGit });
  assert.equal(first.confirmed, true);
  // 0.6.96: the same plan check gives the next task for the continuation message.
  assert.deepEqual(first.nextTask, { id: 'DOCS', title: 'Docs', why: 'Keep context', acceptance: ['Docs match the result'],
    files: ['docs/PRODUCT.md'], checks: ['unit-all'] });
  p.plan_revision++; await write();
  assert.equal((await readAutoPlanState({ workspace: root })).confirmed, true, 'in-progress dirty plan may continue');
  p.tasks[0].implementation_status = 'DONE'; p.tasks[0].commit_status = 'DONE'; await write();
  const done = await readAutoPlanState({ workspace: root });
  assert.equal(done.confirmed, false, 'uncommitted DONE is not final');
  assert.equal(done.nextTask, null, 'a finished plan names no next task');
  git(['add','.']); git(['commit','-m','completed']);
  await fs.mkdir(path.join(root,'.git/workflow-kit'));
  await fs.writeFile(path.join(root,'.git/workflow-kit/transaction.json'),'{}');
  assert.equal((await readAutoPlanState({ workspace: root })).confirmed, false);
  await fs.unlink(path.join(root,'.git/workflow-kit/transaction.json'));
  assert.equal((await readAutoPlanState({ workspace: root })).confirmed, true);
  const previous=structuredClone(p.tasks);
  p.delivery_status='IN_PROGRESS';p.plan_revision++;
  p.tasks.push({...p.tasks[0],id:'T002',title:'Correction round',implementation_status:'TODO',commit_status:'PENDING'});
  await write();
  let round=await readAutoPlanState({workspace:root});
  assert.equal(round.nextTask.id,'T002');assert.equal(round.confirmed,true);
  assert.equal(round.deliveryStatus,'IN_PROGRESS');
  p.tasks.push({...p.tasks[1],id:'DOCS-2',title:'Release documents'},{...p.tasks[1],id:'T003',title:'New delivery'});
  p.tasks[1].implementation_status='DONE';p.tasks[1].commit_status='DONE';p.plan_revision++;
  await write();round=await readAutoPlanState({workspace:root});
  assert.equal(round.nextTask.id,'DOCS-2');assert.deepEqual(p.tasks.slice(0,previous.length),previous);
});
test('real Composer keeps the AutoPlan guard valid for its own insertion and inFlight', async () => {
  const f = fixture();
  const composer = new ChatGPTComposer({ getURL: () => f.selected().chatUrl }, { wait: async () => {} });
  f.flow.available = () => !composer.inFlight;
  let clicks = 0;
  composer.inspect = async ({ action = 'inspect' } = {}) => {
    const observation = { userMessageCount: 1, editorAvailable: true, writable: true, login: false,
      busy: false, sendEnabled: true, draftLength: f.state.draftPresent ? 1 : 0 };
    if (action === 'fill') { f.observe({ draftPresent: true }); return { ...observation, action: 'filled' }; }
    if (action === 'send') {
      clicks++; f.observe({ draftPresent: false, busy: true });
      return { ...observation, action: 'clicked' };
    }
    return observation;
  };
  f.flow.send = (text, canContinue, onBeforeSend) => composer.sendUserMessage({
    text, canContinue, onBeforeSend, waitForAcknowledgement: false });
  await f.flow.start(); await f.drain();
  assert.equal(clicks, 1);
  assert.equal(f.flow.view().continuations, 1);
  assert.equal(f.flow.checkpoint.status, 'sent');
});
test('a different idle turn arriving during inspection cannot reuse the previous pause', async () => {
  const f = fixture(); let first = true;
  f.setInspectGate(async () => { if (first) { first = false; f.observe({ turnId: 'b1234', assistantRevision: 1 }); } });
  await f.flow.start(); await f.drain();
  assert.deepEqual(f.sends, ['Продолжай']);
  assert.equal(f.flow.checkpoint.turnId, 'b1234');
});
test('toggle can be used at any time and does not reuse a consumed pause', async () => {
  const f = fixture({ busy: true }); await f.flow.start(); f.flow.disable();
  await f.finish(); assert.deepEqual(f.sends, []);
  await f.flow.start(); assert.deepEqual(f.sends, ['Продолжай']);
  f.flow.disable(); await f.flow.start(); assert.deepEqual(f.sends, ['Продолжай']);
  await f.finish(); assert.deepEqual(f.sends, ['Продолжай', 'Продолжай']);
});
test('new pause proceeds after an uncertain Send, while that earlier pause remains blocked', async () => {
  const f = fixture(); f.setResult({ state: 'unknown' }); await f.flow.start();
  f.setResult({ state: 'sent' }); await f.finish();
  assert.deepEqual(f.sends, ['Продолжай', 'Продолжай']);
  f.observe({ turnId: 'a1234' }); await f.drain();
  assert.equal(f.sends.length, 2, 'an older pause is still protected by its own checkpoint');
  assert.equal(f.flow.view().reason, 'SEND_UNKNOWN');
});
test('checkpoints survive switching conversations and revisiting an earlier pause', async () => {
  const f = fixture(); await f.flow.start(); const first = f.selected();
  f.changeSelection(); f.observe({ url: f.selected().chatUrl, turnId: 'b1234' }); await f.drain();
  assert.equal(f.sends.length, 2);
  f.setSelection(first); f.observe({ url: first.chatUrl, turnId: 'a1234' }); await f.drain();
  assert.equal(f.sends.length, 2);
  await f.finish(); assert.equal(f.sends.length, 3);
  f.observe({ turnId: 'a1234' }); await f.drain(); assert.equal(f.sends.length, 3);
  assert.equal(f.flow.checkpointState().entries.length, 3);
});
test('synthetic initial pause remains consumed across plan revisions and reconstruction', async () => {
  const f = fixture({ turnId: '' }); f.observe({ lastMessageRole: 'assistant' }); await f.flow.start(); const saved = f.flow.checkpointState();
  f.plan.planRevision++; await f.flow.planChanged(); await f.drain();
  assert.equal(f.sends.length, 1);
  f.flow.dispose(); f.flow.restore(true, saved); await f.flow.recover();
  assert.equal(f.sends.length, 1);
  assert.deepEqual(f.flow.checkpointState(), saved);
});
test('manual Send consumes a pause even when busy has not appeared and after reload', async () => {
  const f = fixture(); f.observe({ draftPresent: true }); await f.flow.start();
  f.observe({ draftPresent: false, manualSendRevision: 1, userTurnId: 'f5678',
    lastMessageRole: 'user', userMessageCount: 2 });
  await f.drain(); assert.deepEqual(f.sends, []);
  f.flow.observe({ reset: true });
  f.flow.observe({ documentId: 'document-2222', state: { ...f.state, manualSendRevision: 0, assistantRevision: 0 } });
  await f.flow.recover(); assert.deepEqual(f.sends, []);
  assert.equal(f.flow.view().reason, 'USER_MESSAGE_PENDING');
  f.flow.observe({ documentId: 'document-2222', state: { ...f.state, busy: false,
    turnId: 'b1234', lastMessageRole: 'assistant' } });
  await f.drain(); assert.deepEqual(f.sends, ['Продолжай']);
});
test('manual waiting does not mistake idle text progress for a new answer', async () => {
  const f = fixture(); f.observe({ draftPresent: true }); await f.flow.start();
  f.observe({ manualSendRevision: 1, draftPresent: false });
  await f.drain(); assert.deepEqual(f.sends, []);
  f.observe({ assistantRevision: 9 }); await f.drain();
  assert.deepEqual(f.sends, []);
  f.flow.observe({ reset: true }); f.observe({ assistantRevision: 0 }); await f.drain();
  assert.deepEqual(f.sends, []);
  f.observe({ turnId: 'b1234' }); await f.drain();
  assert.deepEqual(f.sends, ['Продолжай']);
});
test('manual input or a newly visible user turn cancels Send at the last guard', async () => {
  for (const kind of ['input', 'user-turn']) {
    const f = fixture();
    f.setGate(async () => {
      if (kind === 'input') f.observe({ manualInputRevision: 1, draftPresent: true });
      else f.observe({ userTurnId: 'f5678', lastMessageRole: 'user' });
    });
    await f.flow.start(); await f.drain();
    assert.deepEqual(f.sends, [], kind);
    assert.equal(f.flow.view().reason, kind === 'input' ? 'DRAFT_PRESENT' : 'USER_MESSAGE_PENDING');
  }
});
test('Stop at a new partial answer is an idle pause and mode stays enabled', async () => {
  const f = fixture({ busy: true }); await f.flow.start();
  f.observe({ turnId: 'b1234', manualStopRevision: 1, busy: false });
  await f.drain();
  assert.deepEqual(f.sends, ['Продолжай']);
  assert.equal(f.flow.view().enabled, true);
});
test('confirmed Send is retained when OFF happens just after dispatch', async () => {
  const f = fixture();
  f.flow.send = async (_text, current, before) => {
    assert.equal(current(), true); assert.equal(await before(), true);
    f.sends.push('Продолжай'); f.flow.disable();
    return { state: 'sent' };
  };
  await f.flow.start();
  assert.equal(f.flow.view().enabled, false);
  assert.equal(f.flow.checkpoint.status, 'sent');
  assert.equal(f.flow.view().continuations, 1);
  await f.flow.start(); assert.deepEqual(f.sends, ['Продолжай']);
});
test('failure to save a sent confirmation retains its fact and never repeats Send', async () => {
  const f = fixture();
  f.flow.saveCheckpoint = async snapshot => {
    if (snapshot.entries.at(-1)?.status === 'sent') throw Error('private-disk-error');
  };
  await f.flow.start();
  assert.equal(f.flow.view().continuations, 1);
  assert.equal(f.flow.checkpoint.status, 'sent');
  assert.equal(f.flow.view().reason, 'SEND_CHECKPOINT_ERROR');
  f.observe({}); await f.flow.planChanged(); await f.drain();
  assert.deepEqual(f.sends, ['Продолжай']);
});
test('checkpoint save failing before Composer permits a later event to retry the known unsent pause', async () => {
  const f = fixture(); let fail = true;
  f.flow.saveCheckpoint = async () => { if (fail) throw Error('disk temporarily unavailable'); };
  await f.flow.start(); assert.deepEqual(f.sends, []); assert.equal(f.flow.checkpoint, null);
  fail = false; await f.flow.planChanged();
  assert.deepEqual(f.sends, ['Продолжай']);
});
test('fresh Node processes retain ON/OFF, sent and sending checkpoints, including earlier pauses', () => {
  const owner = JSON.stringify(['/project', 'chat', 'scope', 'https://chatgpt.com/c/abcdefgh']);
  const moduleUrl = new URL('../src/auto-plan.mjs', import.meta.url).href;
  const program = [
    'import { AutoPlan } from ' + JSON.stringify(moduleUrl) + ';',
    'const input = JSON.parse(process.argv[1]);',
    'const selected = {workspace:"/project",sessionId:"chat",scopeId:"scope",chatUrl:"https://chatgpt.com/c/abcdefgh"};',
    'const sends=[];',
    'const flow=new AutoPlan({selected:()=>selected,inspectPlan:async()=>({confirmed:true,scopeId:"scope",scopeStatus:"ACTIVE",planRevision:10,planView:{tasks:[{id:"T001",status:"pending"}]}}),send:async text=>{sends.push(text);return {state:"sent"};}});',
    'flow.restore(input.enabled,input.checkpoint);',
    'flow.observe({documentId:"document-2222",state:{url:selected.chatUrl,editorAvailable:true,writable:true,busy:false,turnId:"a1234",userTurnId:"f1234",lastMessageRole:input.userPending?"user":"assistant"}});',
    'await flow.recover();',
    'console.log(JSON.stringify({enabled:flow.view().enabled,reason:flow.view().reason,sends}));',
    'flow.dispose();',
  ].join('\n');
  for (const kind of ['off', 'sent', 'sending', 'earlier', 'manual']) {
    const checkpoint = { version: 2, entries: [
      { key: owner, turnId: 'a1234', status: kind === 'sending' ? 'sending' : 'sent' },
      ...(kind === 'earlier' ? [{ key: owner, turnId: 'b1234', status: 'sent' }] : []),
    ] };
    const output = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program,
      JSON.stringify({ enabled: kind !== 'off', checkpoint: kind === 'manual' ? null : checkpoint, userPending: kind === 'manual' })], { encoding: 'utf8' }));
    assert.deepEqual(output.sends, [], kind);
    assert.equal(output.enabled, kind !== 'off');
    if (kind === 'sending') assert.equal(output.reason, 'SEND_UNKNOWN');
    if (kind === 'manual') assert.equal(output.reason, 'USER_MESSAGE_PENDING');
  }
});
test('failed rollback of a known unsent attempt recovers on the next event in the live client', async () => {
  const f = fixture(); let failRollback = true;
  f.setResult({ state: 'deferred', reason: 'DRAFT_PRESENT' });
  f.flow.saveCheckpoint = async snapshot => {
    if (snapshot === null && failRollback) throw Error('rollback persistence unavailable');
  };
  await f.flow.start(); assert.deepEqual(f.sends, []); assert.equal(f.flow.checkpoint, null);
  failRollback = false; f.setResult({ state: 'sent' }); await f.flow.planChanged();
  assert.deepEqual(f.sends, ['Продолжай']);
});

test('hydrating an existing conversation never starts an empty-history Send', async () => {
  const f = fixture({ turnId: '' }); await f.flow.start(); await f.drain();
  assert.equal(f.sends.length, 0); assert.equal(f.flow.view().reason, 'HISTORY_NOT_READY');
  f.observe({ turnId: 'abc', lastMessageRole: 'assistant' }); await f.drain();
  assert.equal(f.sends.length, 1);
});

test('persisted cycles distinguish native-less replies with unchanged message counts', async () => {
  const f = fixture({ turnId: '' }); f.observe({ lastMessageRole: 'assistant', userTurnId: '' });
  await f.flow.start(); assert.equal(f.sends.length, 1);
  f.observe({ busy: true }); await f.drain();
  const busyCheckpoint = f.flow.checkpointState();
  f.flow.dispose(); f.flow.restore(true, busyCheckpoint); await f.flow.recover();
  f.observe({ busy: false, assistantRevision: 10 }); await f.drain();
  assert.equal(f.sends.length, 2, 'completion after restart uses the persisted pending cycle');
  const idleCheckpoint = f.flow.checkpointState();
  f.flow.dispose(); f.flow.restore(true, idleCheckpoint); await f.flow.recover();
  f.observe({ assistantRevision: 11 }); await f.drain();
  f.plan.planRevision++; await f.flow.planChanged();
  assert.equal(f.sends.length, 2, 'rerender, restart and plan revision do not create another pause');
  f.observe({ busy: true }); await f.drain();
  f.observe({ busy: false, assistantRevision: 12 }); await f.drain();
  assert.equal(f.sends.length, 3);
  f.plan.planView.tasks.forEach(t => t.status = 'done');
  f.observe({ busy: true }); await f.drain(); f.observe({ busy: false }); await f.drain();
  assert.equal(f.sends.length, 3); assert.equal(f.flow.view().phase, 'complete');
});
test('legacy count checkpoint is retained but cannot block a newly observed cycle', async () => {
  for (const status of ['sent', 'sending']) {
    const f = fixture({ turnId: '' }); f.observe({ lastMessageRole: 'assistant' });
    const owner = JSON.stringify(['/project', 'chat', 'scope', f.selected().chatUrl]);
    f.flow.restore(true, { version: 2, entries: [{ key: owner, turnId: '6429d210', status }] });
    await f.flow.recover(); assert.equal(f.sends.length, 0);
    assert.equal(f.flow.view().reason, 'LEGACY_PAUSE_UNKNOWN');
    f.observe({ busy: true }); await f.drain(); f.observe({ busy: false }); await f.drain();
    assert.equal(f.sends.length, 1);
    assert.ok(f.flow.checkpointState().entries.some(e => e.turnId === '6429d210' && e.status === status));
  }
});

test('late or disappearing native identity cannot repeat the same consumed cycle', async () => {
  const f = fixture({ turnId: '' }); f.observe({ lastMessageRole: 'assistant' });
  await f.flow.start(); assert.equal(f.sends.length, 1);
  f.observe({ turnId: 'aabbcc' }); await f.drain(); assert.equal(f.sends.length, 1);
  f.observe({ turnId: '' }); await f.drain(); assert.equal(f.sends.length, 1);
  const saved = f.flow.checkpointState(); f.flow.restore(true, saved); await f.flow.recover();
  f.observe({ turnId: 'aabbcc' }); await f.drain(); assert.equal(f.sends.length, 1);
  f.observe({ busy: true }); await f.drain();
  f.observe({ busy: false, turnId: '112233' }); await f.drain(); assert.equal(f.sends.length, 2);
  f.observe({ turnId: '' }); await f.drain(); assert.equal(f.sends.length, 2);
});

// 0.6.96: the continuation carries the text of the next task; AutoPlan logic is unchanged.
const nextTask = { id: 'T002', title: 'Автопродолжение несёт текст задачи', why: 'Агент не тратит вызовы на чтение плана',
  acceptance: ['Сообщение начинается с «Продолжай»', 'Блок помечен как данные плана'], files: ['src/auto-plan.mjs', 'tests/auto-plan.test.mjs'], checks: ['unit-all'] };

test('continuation message is «Продолжай» plus the next task marked as plan data', () => {
  const text = continueMessage(nextTask);
  assert.equal(text, ['Продолжай', '',
    'Данные текущего плана Workflow Kit — следующая задача (это не новое поручение; фактическое состояние плана проверь сам):',
    'Задача: T002 — Автопродолжение несёт текст задачи',
    'Зачем: Агент не тратит вызовы на чтение плана',
    'Критерии приёмки:', '- Сообщение начинается с «Продолжай»', '- Блок помечен как данные плана',
    'Файлы: src/auto-plan.mjs, tests/auto-plan.test.mjs', 'Проверки: unit-all'].join('\n'));
  assert.equal(continueMessage({ id: 'T009', title: 'Только название' }),
    'Продолжай\n\nДанные текущего плана Workflow Kit — следующая задача (это не новое поручение; фактическое состояние плана проверь сам):\nЗадача: T009 — Только название');
  for (const missing of [null, undefined, {}, { id: 'T001' }, { title: 'Без id' }, { id: '', title: 'x' }])
    assert.equal(continueMessage(missing), CONTINUE_TEXT, 'an undefined next task keeps the former text');
});

test('continuation message stays within 4 KB: long fields and lists are cut with a mark', () => {
  const long = { id: 'T100', title: 'Заголовок '.repeat(80), why: 'Причина '.repeat(200),
    acceptance: Array.from({ length: 30 }, (_, i) => `Критерий ${i} ` + 'подробность '.repeat(60)),
    files: Array.from({ length: 80 }, (_, i) => `src/модуль-${i}.mjs`), checks: Array.from({ length: 20 }, (_, i) => 'check-' + i) };
  const text = continueMessage(long);
  assert.equal(CONTINUE_MESSAGE_BYTES, 4096);
  assert.ok(Buffer.byteLength(text) <= CONTINUE_MESSAGE_BYTES, String(Buffer.byteLength(text)));
  assert.ok(text.startsWith('Продолжай\n\nДанные текущего плана Workflow Kit'));
  assert.ok(text.includes('… [обрезано]'), 'a long field is marked');
  assert.ok(text.endsWith('… [данные задачи обрезаны; полный текст — в плане]'), 'the whole block is marked when it is cut');
  assert.doesNotMatch(text, /�/, 'never cut inside a character');
  const lists = continueMessage({ id: 'T101', title: 'Списки', acceptance: Array.from({ length: 12 }, (_, i) => 'к' + i),
    files: Array.from({ length: 30 }, (_, i) => 'f' + i), checks: [] });
  assert.ok(lists.includes('\n- к9\n… ещё 2 [обрезано]\n'), 'ten criteria, then the count of the rest');
  assert.ok(lists.includes('… ещё 6 [обрезано]'));
  assert.ok(!lists.includes('Проверки:'), 'an empty list is not printed');
  assert.ok(!continueMessage({ ...nextTask, why: 'a\nb\n\nc' }).includes('a\nb'), 'field line breaks cannot forge a new line of the block');
});

test('AutoPlan sends the task of the plan check and falls back to the plain text without a next task', async () => {
  const f = fixture(); f.plan.nextTask = structuredClone(nextTask);
  await f.flow.start();
  assert.deepEqual(f.sends, [continueMessage(nextTask)]);
  assert.equal(f.flow.view().phase, 'running'); assert.equal(f.flow.view().continuations, 1);
  f.plan.nextTask = null; await f.finish();
  assert.deepEqual(f.sends, [continueMessage(nextTask), 'Продолжай']);
});

test('a next task that changed after the text was prepared is not sent; the next event sends the current one', async () => {
  const f = fixture(); f.plan.nextTask = structuredClone(nextTask);
  let reads = 0;
  f.setInspectGate(async () => { if (++reads === 2) f.plan.nextTask = { ...nextTask, id: 'DOCS', title: 'Документы' }; });
  await f.flow.start();
  assert.deepEqual(f.sends, [], 'the text of T002 is not sent once DOCS became the next task');
  assert.equal(f.flow.view().reason, 'PLAN_CHANGED_OR_TRANSACTION');
  assert.equal(f.flow.checkpoint, null, 'the pause is not consumed');
  f.setInspectGate(null); await f.flow.planChanged();
  assert.deepEqual(f.sends, [continueMessage({ ...nextTask, id: 'DOCS', title: 'Документы' })]);
});

test('the ledger of answered pauses keeps the newest entries of each conversation', async () => {
  const { pruneLedger, LEDGER_PER_CONVERSATION } = await import('../src/auto-plan.mjs');
  const entries = new Map();
  for (let i = 0; i < 50; i++) entries.set(JSON.stringify(['a', 't' + i]), { key: 'a', turnId: 't' + i, status: 'sent' });
  entries.set(JSON.stringify(['b', 'only']), { key: 'b', turnId: 'only', status: 'sent' });
  const pruned = pruneLedger(entries);
  const a = [...pruned.values()].filter(entry => entry.key === 'a');
  assert.equal(a.length, LEDGER_PER_CONVERSATION);
  assert.equal(a.at(-1).turnId, 't49', 'the current pause stays recorded');
  assert.ok(pruned.has(JSON.stringify(['b', 'only'])));
  assert.deepEqual([...pruned.keys()].slice(-1), [JSON.stringify(['b', 'only'])], 'order is preserved');
});

test('A03/A06: executor-style and Review disables are programmatic, not MANUAL_OFF',async()=>{
 const f=fixture({busy:true});await f.flow.start();
 f.flow.disable();assert.equal(f.flow.view().reason,'AUTHORIZATION_OFF');
 await f.flow.start();f.flow.disable({manual:true});assert.equal(f.flow.view().reason,'MANUAL_OFF');
 const {ReviewContinuation}=await import('../src/review-continuation.mjs');
 const selected={workspace:'/review',sessionId:'chat',chatUrl:'https://chatgpt.com/c/chat'};
 const client={workspace:'/review',state:{enabled:true,stage:'PREPARED',run_id:'run',recipient_session_id:'chat',generation:1},refresh(){}};
 const review=new ReviewContinuation({selected:()=>selected,client,available:()=>false,saveCheckpoint:async()=>{}});
 review.update();await settle();
 client.state={...client.state,enabled:false,generation:2};review.update();
 assert.equal(review.flow.view().reason,'AUTHORIZATION_OFF');
 assert.equal(f.sends.length,0);
});
