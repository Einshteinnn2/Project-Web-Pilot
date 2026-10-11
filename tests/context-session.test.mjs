import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ContextCache } from '../src/context-cache.mjs';
import { ContextSession, externalClientLine, packetMatchesProject, startupMessage, rotationRecoveryStatus } from '../src/context-session.mjs';
import * as contextSessionModule from '../src/context-session.mjs';
import { EXECUTOR_TOOL_RULES } from '../src/mac-runtime-switch.mjs';

const project={workspace:'/Projects/Мой проект',projectId:'id-1',name:'Мой проект',planRevision:7,scopeId:'scope-1',
  scopeStatus:'ACTIVE',deliveryStatus:'IN_PROGRESS',nextTaskId:'T001',nextTaskTitle:'Read',sessionId:'session-1', experience:'chat',
  chatUrl:'https://chatgpt.com/c/aaaaaaaa',attempt:null,receipt:null};
const facts={project_id:project.projectId,project_name:project.name,plan_revision:7,scope_id:'scope-1',
  execution_scope_status:'ACTIVE',delivery_status:'IN_PROGRESS',task_id:'T001',task_title:'Read'};
const now=2000000;

test('rotation recovery uses normal durable ContextSession phases and never replays an attempted Send',async()=>{
  const f=controllerFixture({chatUrl:null});
  const rotation={id:'rotation-'+'a'.repeat(64),sourceSessionId:'previous',scopeId:'scope-1',boundary:'b'.repeat(40)};
  f.saved.rotation=rotation;
  assert.deepEqual(rotationRecoveryStatus(f.saved,'selected'),{state:'waiting',retry:true});
  await f.controller.tick();
  assert.equal(f.sends(),1);
  await f.controller.tick();
  assert.equal(f.controller.state.phase,'delivered');
  assert.deepEqual(rotationRecoveryStatus(f.saved,'delivered'),{state:'delivered',retry:false});
  f.controller.attach(f.saved);
  await f.controller.tick();
  assert.equal(f.sends(),1,'restarting a previously sent Recovery cannot send it twice');
  const unknown={...f.saved,attempt:{...f.saved.attempt,state:'unknown'}};
  assert.deepEqual(rotationRecoveryStatus(unknown,'send-unknown'),{state:'blocked',retry:false});
  assert.deepEqual(rotationRecoveryStatus({...f.saved,manualStart:true},'manual-session'),{state:'blocked',retry:false});
  assert.equal(rotationRecoveryStatus({...f.saved,rotation:undefined},'delivered'),null);
});

test('explicit preparation retry retains drafts and cannot replay a sent or unknown request',async()=>{
  const f=controllerFixture();f.controller.state={phase:'error',error:{code:'CONTEXT_INPUTS_UNAVAILABLE'}};
  f.inspection.draftLength=20;
  assert.equal(await f.controller.resumePreparation(),true);assert.equal(f.sends(),0);assert.equal(f.controller.state.phase,'waiting-draft');
  for(const state of ['sending','unknown','sent','acknowledged']) {
    await f.store.updateSession(project.workspace,project.sessionId,{attempt:{state}});
    f.controller.state={phase:'error',error:{code:'CONTEXT_INPUTS_UNAVAILABLE'}};
    assert.equal(await f.controller.resumePreparation(),false);assert.equal(f.sends(),0);
  }
});
function packet(){
  const context='ПОЛНЫЙ КОНТЕКСТ\nОписание проекта\nПлан\n\nНезавершённые изменения\nКОНЕЦ';
  return {delivery_protocol:'inline-context-v1',ack_required:false,status:'ready',completeness:'COMPLETE',workspace:project.workspace,session_id:project.sessionId,plan_id:project.scopeId,
    parts:[{index:1,total:1,text:context,bytes:Buffer.byteLength(context),sha256:createHash('sha256').update(context).digest('hex')}],
    context,context_bytes:Buffer.byteLength(context),context_sha256:createHash('sha256').update(context).digest('hex'),
    generated_at_ms:now,signature:'signature',head:'head',facts:{...facts}};
}
function controllerFixture({ savedAttempt=null, chatUrl=project.chatUrl }={}){
  let saved={...structuredClone(project),chatUrl,attempt:savedAttempt};let sends=0,loads=0;
  let info={...project};let inspection={url:chatUrl??'https://chatgpt.com/',editorAvailable:true,writable:true,draftLength:0,busy:false,login:false,messageSeen:false};
  const stateLog=[];const boundLog=[];
  const store={selected:()=>structuredClone(saved),project:()=>structuredClone(saved),inspect:async()=>{
    const {sessionId,experience,chatUrl,attempt,receipt,...result}=info;return structuredClone(result);},
    updateSession:async(_w,_s,patch)=>{saved={...saved,...structuredClone(patch)};return structuredClone(saved);},
    bindChat:async(_w,_s,url)=>{saved.chatUrl=url;return structuredClone(saved);}};
  const runtime={ensure:async()=>({}),loadContext:async()=>{loads++;return packet();}};
  const composer={inspect:async options=>({...inspection,
    ...(options?.action==='select-experience'?{action: (inspection.experience??store.project().experience)===options.expectedExperience
      ?'experience-confirmed':'experience-selecting'}:{})}),contents:{getURL:()=>inspection.url},deliver:async options=>{
    assert.equal(saved.attempt.state,'prepared');assert.equal(options.attachments.map(p=>p.text).join('\n\n'),packet().context);
    assert.deepEqual(options.attachments.map(p=>p.name),packet().parts.map(p=>`context-testrequ-${String(p.index).padStart(2,'0')}-of-${p.total}.md`));assert.ok(!options.text.includes(packet().context));
    if(!options.canContinue())return {state:'cancelled'};
    await options.onBeforeFill?.();
    await options.onBeforeSend();if(!options.canContinue())return {state:'cancelled'};
    assert.equal(saved.attempt.state,'sending');sends++;inspection.messageSeen=true;
    inspection.url=project.chatUrl;return {state:'sent'};
  }};
  const controller=new ContextSession({store,runtime,composer,onChange:s=>stateLog.push(s),onChatBound:event=>boundLog.push(event),now:()=>now,uuid:()=> 'test-request'});
  controller.attach(saved);
  return {controller,store,runtime,composer,stateLog,boundLog,sends:()=>sends,loads:()=>loads,get saved(){return saved;},inspection,info};
}

test('the first message contains the exact complete packet and asks for a short project reply without tools',()=>{
  const p=packet(), text=startupMessage(project,'unique-request',p);
  assert.ok(text.includes(JSON.stringify({recipient_session_id:project.sessionId})));
  assert.match(text,/получатель продолжения, не владелец плана/);
  assert.ok(!text.includes(p.context));
  assert.ok(text.includes('Читай каждое вложение отдельно одним вызовом'));
  assert.ok(text.includes('при признаках обрезки дочитай'));
  assert.ok(text.includes('выведи список /mnt/data и открой файл по фактическому имени'));
  assert.ok(text.includes('Не подтверждай восстановление, пока не прочитаны все части'));
  assert.ok(text.includes('Инструменты чтения вложений разрешены'));
  for(const item of ['"/Projects/Мой проект"','session-1','unique-request','коротко подтверди','опиши назначение проекта','не вызывай MCP проекта'])assert.ok(text.includes(item));
  for(const name of ['workflow_context_recover','workflow_context_ack','workflow_context_hook'])assert.ok(!text.includes(name));
  assert.equal(packetMatchesProject(p,project),true);
  assert.equal(packetMatchesProject({...p,session_id:'legacy-other',plan_id:'historical-plan'},project),true);
  assert.equal(packetMatchesProject(p,{...project,planRevision:8}),false);
  assert.ok(!text.includes('plan:prepare')); // Kit owns workflow rules.
  for (const rule of ['Не запускай codex exec', 'других модельных агентов', 'не делегируй им работу',
    'если пользователь прямо этого не попросил', 'локальный исполнитель MCP без модельных запросов разрешён'])
    assert.ok(text.includes(rule), rule);
  // 0.6.90: the model may look at the screen but must not drive the interface, also through shell commands.
  assert.ok(text.includes('Интерфейсом компьютера не управляй: не двигай мышь, не нажимай клавиши и не переключай окна — ни инструментами, ни командами (osascript, System Events, cliclick и подобными). Список окон и снимки экрана и окна (`computer_list_windows`, `computer_capture_screen`, `computer_capture_window`) разрешены. Живую проверку интерфейса выполняет пользователь.'));
});

test('every start names its parts with a short fragment of its own request id', () => {
  const { contextPartName } = contextSessionModule;
  const part = { index: 1, total: 5 };
  const first = contextPartName(part, 'wp-request-b8f5450a-cd1b-4c5f-9ea3-1a3004dca278');
  const second = contextPartName(part, 'wp-request-0c9e7d21-5a4b-4c3d-8e2f-6a7b8c9d0e1f');
  assert.equal(first, 'context-b8f5450a-01-of-5.md');
  assert.equal(second, 'context-0c9e7d21-01-of-5.md');
  assert.notEqual(first, second);
  assert.equal(contextPartName({ index: 12, total: 12 }, 'wp-request-b8f5450a-cd1b'), 'context-b8f5450a-12-of-12.md');
  assert.throws(() => contextPartName(part, ''), /request id/);
});

test('ordinary session contract defines one verified microtask per reply without an AutoPlan protocol', () => {
  const p = packet(), text = startupMessage(project, 'contract-request', p);
  assert.ok(!text.includes('Delivery-порядок'));
  assert.ok(!text.includes(p.context), 'recovery is delivered only in attachments');
  assert.doesNotMatch(text, /AutoPlan|автовыполнения|Готов продолжать\.|Нужен ваш ответ\.|План завершён\./);
  assert.equal(startupMessage({ ...project, autoPlanEnabled: true }, 'contract-request', p),
    startupMessage({ ...project, autoPlanEnabled: false }, 'contract-request', p));
});

test('attachment failure keeps its request and complete payload on explicit retry',async()=>{
  const f=controllerFixture({chatUrl:null}),deliver=f.composer.deliver;
  f.composer.deliver=async()=>{throw Object.assign(Error('pending upload'),{code:'ATTACHMENTS_PENDING'});};
  await f.controller.tick();assert.equal(f.controller.state.phase,'error');
  const saved=structuredClone(f.saved.attempt);assert.equal(saved.attachments.length,1);
  f.composer.deliver=deliver;await f.controller.retry();
  assert.equal(f.saved.attempt.requestId,saved.requestId);
  assert.deepEqual(f.saved.attempt.attachments,saved.attachments);
  assert.equal(f.loads(),1);assert.equal(f.sends(),1);
});

test('loads once, saves full message before send, and reopens the same chat without another recovery or send',async()=>{
  const f=controllerFixture({chatUrl:null});await f.controller.tick();assert.equal(f.sends(),1);assert.equal(f.loads(),1);
  assert.equal(f.saved.attempt.state,'sent');await f.controller.tick();assert.equal(f.controller.state.phase,'delivered');
  assert.equal(f.saved.chatUrl,project.chatUrl);assert.equal(f.controller.state.delivery.contextBytes,packet().context_bytes);
  assert.deepEqual(f.boundLog,[{workspace:project.workspace,sessionId:project.sessionId,chatUrl:project.chatUrl}], 'late bind emits one natural title-sync event');
  f.controller.attach(f.saved);await f.controller.tick();assert.equal(f.sends(),1);assert.equal(f.loads(),1);
  assert.equal(f.boundLog.length,1,'reopening an already bound chat does not emit another bind event');
});

test('unknown send after restart remains idle without verification or automatic replay',async()=>{
  const f=controllerFixture();await f.controller.tick();
  const unknown={...f.saved.attempt,state:'unknown'};await f.store.updateSession('', '',{attempt:unknown});f.inspection.messageSeen=false;
  f.controller.attach(f.saved);await f.controller.tick();assert.equal(f.controller.state.phase,'send-unknown');
  await f.controller.retry();assert.equal(f.sends(),1);assert.equal(f.loads(),1);
  const inspect=f.composer.inspect;
  f.composer.inspect=async options=>{assert.equal(options.requestId,undefined);assert.equal(options.text,undefined);return inspect(options);};
  f.inspection.messageSeen=true;await f.controller.tick();assert.equal(f.controller.state.phase,'send-unknown');
  assert.equal(f.controller.state.messageSent,false);
});

test('legacy sessions stay bound and retry never sends another recovery',async()=>{
  const f=controllerFixture({savedAttempt:{requestId:'old',text:'old startup',state:'acknowledged',sendStartedAtMs:now-1000}});
  await f.controller.tick();assert.equal(f.controller.state.phase,'legacy-session');assert.equal(f.loads(),0);assert.equal(f.sends(),0);
  await f.controller.retry();await f.controller.tick();assert.equal(f.controller.state.phase,'legacy-session');assert.equal(f.sends(),0);
  assert.equal(f.saved.attempt.protocol,undefined);
});

test('drafts and generation delay packet preparation and do not overwrite user input',async()=>{
  for(const [patch,phase] of [[{draftLength:7,draftMatches:false},'waiting-draft'],[{busy:true},'waiting-generation']]){
    const f=controllerFixture();Object.assign(f.inspection,patch);await f.controller.tick();
    assert.equal(f.controller.state.phase,phase);assert.equal(f.sends(),0);assert.equal(f.loads(),0);
  }
});

test('incomplete or wrong-project packet and a changed plan fail before sending',async()=>{
  for(const mutate of [p=>p.workspace='/other',p=>p.completeness='PARTIAL',p=>p.facts.plan_revision=6]){
    const f=controllerFixture();f.runtime.loadContext=async()=>{const p=packet();mutate(p);return p;};await f.controller.tick();
    assert.equal(f.controller.state.phase,'error');assert.equal(f.sends(),0);assert.equal(f.saved.attempt,null);
  }
});

test('plan changes before insertion cannot insert an outdated packet',async()=>{
  const f=controllerFixture();const deliver=f.composer.deliver;
  f.composer.deliver=async options=>{f.info.planRevision=8;return deliver(options);};
  await f.controller.tick();assert.equal(f.controller.state.phase,'prepared-stale');assert.equal(f.sends(),0);
  assert.equal(f.saved.attempt.state,'prepared');assert.equal(f.saved.attempt.sendStartedAtMs,null);
});

test('switching workspace during context loading cancels before storing or sending',async()=>{
  const f=controllerFixture();let release;f.runtime.loadContext=()=>new Promise(r=>{release=r;});
  const running=f.controller.tick();await new Promise(r=>setImmediate(r));f.controller.cancel();release(packet());await running;
  assert.equal(f.sends(),0);assert.equal(f.saved.attempt,null);
});

test('a foreign chat opened before or during preparation is never used for Send',async()=>{
  const unbound=controllerFixture({chatUrl:null});unbound.inspection.url=project.chatUrl;
  await unbound.controller.tick();assert.equal(unbound.controller.state.phase,'chat-changed');assert.equal(unbound.loads(),0);
  const changed=controllerFixture({chatUrl:null});changed.runtime.loadContext=async()=>{changed.inspection.url=project.chatUrl;return packet();};
  await changed.controller.tick();assert.equal(changed.controller.state.phase,'chat-changed');assert.equal(changed.sends(),0);
});

test('changed plan after delivery cannot trigger another recovery through retry',async()=>{
  const f=controllerFixture();await f.controller.tick();f.info.planRevision=8;await f.controller.tick();
  assert.equal(f.controller.state.phase,'stale');assert.equal(f.sends(),1);
  f.runtime.loadContext=async()=>{const p=packet();p.facts.plan_revision=8;return p;};
  await f.controller.retry();await f.controller.tick();assert.equal(f.controller.state.phase,'stale');assert.equal(f.sends(),1);
});

test('retry during a background read cannot rearm a delivered session',async()=>{
  for (const cancelled of [false,true]) {
    const f=controllerFixture();await f.controller.tick();f.info.planRevision=8;
    const inspect=f.store.inspect;let release;
    f.store.inspect=()=>new Promise(resolve=>{release=()=>{f.store.inspect=inspect;resolve(inspect());};});
    const reading=f.controller.tick();await new Promise(resolve=>setImmediate(resolve));
    f.runtime.loadContext=async()=>{const p=packet();p.facts.plan_revision=8;return p;};
    await f.controller.retry();await f.controller.retry();
    if(cancelled)f.controller.cancel();
    release();await reading;
    for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
    await f.controller.tick();
    assert.equal(f.sends(),1);
    assert.equal(f.controller.state.phase,cancelled?'selected':'stale');
  }
});


test('Work session fails closed when ChatGPT is not in Work experience', async()=>{
  const f=controllerFixture({chatUrl:null});
  f.store.selected=()=>({...structuredClone(f.saved),experience:'work'});
  f.store.project=()=>({...structuredClone(f.saved),experience:'work'});
  f.inspection.url='https://chatgpt.com/';
  f.inspection.experience='chat';
  f.controller.attach({...f.saved,experience:'work'});
  await f.controller.tick();
  assert.equal(f.controller.state.phase,'waiting-composer');
  assert.equal(f.loads(),0); assert.equal(f.sends(),0);
});

test('unbound Work session accepts Work entrypoint before recovery', async()=>{
  const f=controllerFixture({chatUrl:null});
  f.store.selected=()=>({...structuredClone(f.saved),experience:'work'});
  f.store.project=()=>({...structuredClone(f.saved),experience:'work'});
  f.inspection.url='https://chatgpt.com/work/';
  f.composer.contents.getURL=()=>f.inspection.url;
  f.composer.deliver=async options=>{ assert.equal(options.canContinue(),true); return {state:'deferred',reason:'SEND_UNAVAILABLE'}; };
  f.controller.attach({...f.saved,experience:'work'});
  await f.controller.tick();
  assert.equal(f.loads(),1);
  assert.equal(f.controller.state.phase,'waiting-composer');
});


test('Work session keeps provenance when ChatGPT moves from /work/ to shared /c/<id>', async()=>{
  const f=controllerFixture({chatUrl:null});
  f.saved.experience='work';
  f.store.selected=()=>({...structuredClone(f.saved),experience:'work'});
  f.store.project=()=>({...structuredClone(f.saved),experience:'work'});
  f.inspection.url='https://chatgpt.com/work/';
  f.composer.contents.getURL=()=>f.inspection.url;
  f.composer.deliver=async options=>{
    assert.equal(options.canContinue(),true);
    await options.onBeforeFill?.();
    await options.onBeforeSend();
    f.inspection.url='https://chatgpt.com/c/work-real-session';
    f.inspection.messageSeen=true;
    assert.equal(options.canContinue(),true,'same Work send may transition to shared conversation URL');
    return {state:'sent'};
  };
  f.controller.attach({...f.saved,experience:'work'});
  await f.controller.tick();
  assert.equal(f.loads(),1); assert.equal(f.controller.state.phase,'waiting-chat');
  await f.controller.tick();
  assert.equal(f.controller.state.phase,'delivered');
  assert.equal(f.saved.experience,'work');
  assert.equal(f.saved.chatUrl,'https://chatgpt.com/c/work-real-session');
  f.controller.attach(f.saved);
  await f.controller.tick();
  assert.equal(f.controller.state.phase,'delivered','bound Work /c URL is authoritative by exact match');
  assert.equal(f.loads(),1,'reopen does not reload recovery');
});

test('unconfirmed native mode prevents packet preparation, then confirmed Chat sends once', async () => {
  const f=controllerFixture({chatUrl:null});
  f.inspection.experience='work';
  await f.controller.tick(); assert.equal(f.loads(),0); assert.equal(f.sends(),0);
  assert.equal(f.controller.state.phase,'waiting-composer');
  f.inspection.experience='chat';
  await f.controller.tick(); await f.controller.tick();
  assert.equal(f.sends(),1); assert.equal(f.controller.state.phase,'delivered');
});
test('pending WEB conversation after Send waits for its permanent URL for Chat and Work', async () => {
  for (const prefix of ['WEB:', 'local-chatgpt%3A']) for (const experience of ['chat','work']) {
    const f=controllerFixture({chatUrl:null}); f.saved.experience=experience;
    f.inspection.url=experience==='work'?'https://chatgpt.com/work/':'https://chatgpt.com/';
    let clicks=0;
    f.composer.deliver=async options=>{
      assert.equal(options.expectedExperience,experience);
      await options.onBeforeFill?.();
      await options.onBeforeSend(); clicks++;
      f.inspection.url='https://chatgpt.com/c/'+prefix+'12345678-1234-1234-1234-123456789abc';
      assert.equal(options.canContinue(),true);
      return {state:'unknown'};
    };
    await f.controller.tick();
    await f.controller.tick(); assert.equal(f.controller.state.phase,'send-unknown');
    assert.equal(f.saved.chatUrl,null);
    f.inspection.messageSeen=true;
    await f.controller.tick(); assert.equal(f.controller.state.phase,'send-unknown');
    assert.equal(f.controller.state.messageSent,false); assert.equal(f.saved.attempt.state,'unknown');
    assert.equal(f.saved.chatUrl,null);
    f.inspection.url='https://chatgpt.com/c/permanent-conversation';
    await f.controller.tick(); assert.equal(f.controller.state.phase,'send-unknown');
    assert.equal(f.saved.chatUrl,f.inspection.url); assert.equal(clicks,1);
    f.controller.attach(f.saved);await f.controller.tick();assert.equal(clicks,1);
  }
});
test('pending WEB conversation before any send never receives project context', async () => {
  const f=controllerFixture({chatUrl:null});
  f.inspection.url='https://chatgpt.com/c/WEB:12345678-1234-1234-1234-123456789abc';
  await f.controller.tick();
  assert.equal(f.controller.state.phase,'chat-changed');assert.equal(f.loads(),0);assert.equal(f.sends(),0);
});


test('prepared cache records timings and retry does not duplicate delivery',async()=>{
  const f=controllerFixture();
  const cache=new ContextCache({load:async()=>({...packet(),generated_at_ms:1}),inputKey:async()=> 'unchanged'});
  await cache.load(project.workspace);f.controller.contextCache=cache;
  await f.controller.tick();assert.equal(f.sends(),1);assert.equal(f.loads(),0);
  assert.equal(f.saved.attempt.packet.cacheHit,true);assert.equal(f.saved.attempt.packet.generatedAtMs,1);
  assert.ok(Number.isFinite(f.saved.attempt.packet.preparationMs));assert.ok(Number.isFinite(f.saved.attempt.packet.deliveryMs));
  await f.controller.retry();assert.equal(f.sends(),1);assert.equal(f.loads(),0);
});
test('source edit before insertion blocks send even when plan revision is unchanged',async()=>{
  const f=controllerFixture();let key='before';
  const cache=new ContextCache({load:async()=>packet(),inputKey:async()=>key});
  await cache.load(project.workspace);f.controller.contextCache=cache;
  const deliver=f.composer.deliver;f.composer.deliver=async options=>{key='after';return deliver(options);};
  await f.controller.tick();assert.equal(f.sends(),0);assert.equal(f.controller.state.phase,'prepared-stale');
  assert.equal(f.saved.attempt.state,'prepared');assert.equal(f.saved.attempt.sendStartedAtMs,null);
});

test('legacy session echo does not route a packet with matching current checkout facts', async()=>{
  const f=controllerFixture();f.runtime.loadContext=async()=>({...packet(),session_id:'other-session',plan_id:'historical-plan'});
  await f.controller.tick();assert.equal(f.sends(),1);assert.equal(f.saved.attempt.state,'sent');
  await f.controller.tick();assert.equal(f.controller.state.phase,'delivered');assert.equal(f.controller.state.error,null);
});

test('saved sent, legacy and unknown chats are observed without services or recovery warmup', async () => {
  const original = controllerFixture(); await original.controller.tick();
  for (const state of ['sent', 'unknown', 'legacy']) {
    const attempt = state === 'legacy' ? { requestId: 'old', text: 'old', state: 'acknowledged', sendStartedAtMs: now - 1000 }
      : { ...original.saved.attempt, state };
    const f = controllerFixture({ savedAttempt: attempt });
    let ensures = 0, warms = 0;
    f.runtime.ensure = async () => { ensures++; throw Error('MCP unavailable'); };
    f.controller.contextCache = { warm: async () => { warms++; throw Error('unexpected warm'); } };
    await f.controller.tick();
    assert.equal(f.controller.state.phase, state === 'sent' ? 'delivered' : state === 'unknown' ? 'send-unknown' : 'legacy-session');
    assert.equal(ensures, 0); assert.equal(warms, 0); assert.equal(f.loads(), 0); assert.equal(f.sends(), 0);
  }
});

test('readiness failure before preparation and changed readiness before insertion cannot authorize a packet', async () => {
  for (const changedBeforeInsertion of [false, true]) {
    const f = controllerFixture(); let ready = changedBeforeInsertion, builds = 0;
    const cache = new ContextCache({ inputKey: async () => { if (!ready) throw Error('hooks changed or transaction active'); return 'ready-key'; },
      load: async () => { builds++; return packet(); } });
    f.controller.contextCache = cache;
    if (changedBeforeInsertion) {
      const deliver = f.composer.deliver;
      f.composer.deliver = async options => { ready = false; return deliver(options); };
    }
    await f.controller.tick();
    assert.equal(f.sends(), 0); assert.equal(builds, changedBeforeInsertion ? 1 : 0);
    assert.equal(f.controller.state.phase, changedBeforeInsertion ? 'prepared-stale' : 'error');
  }
});

test('a prepared packet without a fingerprint is not authorized by its recent age', async () => {
  const f = controllerFixture(); await f.controller.tick();
  await f.store.updateSession('', '', { attempt: { ...f.saved.attempt, state: 'prepared', sendStartedAtMs: null } });
  f.controller.contextCache = new ContextCache({ inputKey: async () => 'current', load: async () => packet() });
  f.inspection.draftLength = 10; f.inspection.draftMatches = true; f.inspection.messageSeen = false;
  f.controller.attach(f.saved); await f.controller.tick();
  assert.equal(f.controller.state.phase, 'prepared-stale'); assert.equal(f.sends(), 1);
});

test('a readiness result for an earlier A generation cannot send after A-B-A', async () => {
  const f = controllerFixture(); let release;
  f.controller.contextCache = new ContextCache({ inputKey: () => new Promise(resolve => { release = resolve; }), load: async () => packet() });
  const running = f.controller.tick();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.controller.cancel(); f.controller.attach(f.saved);
  // Subsequent key reads complete normally; only the first readiness belongs to old A.
  f.controller.contextCache.inputKey = async () => 'ready'; release('ready'); await running;
  assert.equal(f.sends(), 0); assert.equal(f.saved.attempt, null);
});

test('a signal arriving during an active controller pass is rerun once without parallel inspection', async () => {
  const f = controllerFixture();
  await f.controller.tick();
  let release, calls = 0, active = 0, maxActive = 0;
  const originalInspect = f.store.inspect;
  f.store.inspect = async (...args) => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    if (calls === 1) await new Promise(resolve => { release = resolve; });
    active--;
    return originalInspect(...args);
  };
  const running = f.controller.tick();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.info.planRevision = 8;
  assert.equal(f.controller.signal(), true);
  assert.equal(f.controller.signal(), true);
  release();
  await running;
  for (let i = 0; i < 5 && calls < 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2, 'multiple signals collapse into one follow-up pass');
  assert.equal(maxActive, 1, 'controller inspection remains serialized');
  assert.equal(f.controller.state.phase, 'stale');
  assert.equal(f.sends(), 1, 'project change never resends recovery automatically');
});

test('project reads retry a bounded number of times and persistent failure becomes visible', async () => {
  const f = controllerFixture();
  let calls = 0;
  f.store.inspect = async () => { calls++; throw Error('transactional file unavailable'); };
  f.controller.readRetryDelays = [0, 0];
  f.controller.wait = async () => {};
  await f.controller.tick();
  assert.equal(calls, 3);
  assert.equal(f.controller.state.phase, 'error');
  assert.equal(f.controller.state.error.code, 'PROJECT_READ_FAILED');
  assert.match(f.controller.state.error.message, /transactional file unavailable/);
  assert.equal(f.sends(), 0);
});

test('generation change cancels a delayed project-read recovery without publishing the old error', async () => {
  const f = controllerFixture();
  let releaseWait, calls = 0;
  f.store.inspect = async () => { calls++; throw Error('old generation read'); };
  f.controller.readRetryDelays = [1];
  f.controller.wait = () => new Promise(resolve => { releaseWait = resolve; });
  const running = f.controller.tick();
  while (!releaseWait) await new Promise(resolve => setImmediate(resolve));
  f.controller.cancel();
  f.controller.attach(f.saved);
  releaseWait();
  await running;
  assert.equal(calls, 1);
  assert.equal(f.controller.state.phase, 'selected');
  assert.equal(f.controller.state.error, null);
});
test('manual recovery Send binds only its own observed marker, including optimistic URL and restart', async () => {
  for (const optimistic of [false, true]) {
    const f = controllerFixture({ chatUrl: null });
    f.composer.deliver = async () => ({ state: 'deferred', reason: 'DRAFT_CHANGED' });
    await f.controller.tick();
    assert.equal(f.saved.attempt.state, 'prepared');
    assert.equal(f.saved.attempt.sendStartedAtMs, null);
    f.inspection.url = optimistic ? 'https://chatgpt.com/c/local-chatgpt%3A12345678-1234-1234-1234-123456789abc' : project.chatUrl;
    f.inspection.messageSeen = true;
    await f.controller.tick();
    assert.equal(f.saved.attempt.state, 'sent');
    if (optimistic) {
      assert.equal(f.saved.chatUrl, null);
      assert.equal(f.controller.state.phase, 'waiting-chat');
      f.inspection.url = project.chatUrl;
      await f.controller.tick();
    }
    assert.equal(f.saved.chatUrl, project.chatUrl);
    assert.equal(f.controller.state.phase, 'delivered');
    const restored = controllerFixture({ savedAttempt: f.saved.attempt, chatUrl: f.saved.chatUrl });
    restored.inspection.messageSeen = true;
    await restored.controller.tick();
    assert.equal(restored.loads(), 0); assert.equal(restored.sends(), 0);
    assert.equal(restored.controller.state.phase, 'delivered');
  }
});

test('an unregistered attempt cannot bind a foreign conversation without its user marker', async () => {
  const f = controllerFixture({ chatUrl: null });
  f.composer.deliver = async () => ({ state: 'deferred', reason: 'DRAFT_CHANGED' });
  await f.controller.tick();
  f.inspection.url = project.chatUrl; f.inspection.messageSeen = false;
  f.inspection.userMessageCount = 8;
  await f.controller.tick();
  assert.equal(f.saved.chatUrl, null);
  assert.equal(f.saved.attempt.state, 'prepared');
  assert.equal(f.controller.state.phase, 'chat-changed');
});

test('ordinary manually started conversation remains view-only after retry', async () => {
  const f = controllerFixture();
  await f.store.updateSession('', '', { manualStart: true });
  await f.controller.tick();
  assert.equal(f.controller.state.phase, 'manual-session');
  assert.equal(f.controller.state.messageSent, false);
  assert.equal(f.loads(), 0); assert.equal(f.sends(), 0);
  await f.controller.retry();
  await f.controller.tick();
  assert.equal(f.saved.manualStart, true);
  assert.equal(f.sends(), 0); assert.equal(f.controller.state.phase, 'manual-session');
});

// 0.6.96: the context goes as text in the start message on every platform; MCP carries tools only.
const mcpStarted = (state, extra = {}) => ({ protocol: 'inline-context-v1', requestId: 'mcp-request', text: 'start mcp-request', state,
  createdAtMs: now - 10, sendStartedAtMs: state === 'sent' ? now - 8 : null, ...(state === 'sent' ? { sentAtMs: now - 5 } : {}),
  packet: { workspace: project.workspace, contextMode: 'mcp' }, ...extra });

test('executor tool rules join the session rules of the start message; without them the text is the former one', () => {
  const p = packet(), plain = startupMessage(project, 'rules-request', p), text = startupMessage(project, 'rules-request', p, EXECUTOR_TOOL_RULES);
  assert.equal(EXECUTOR_TOOL_RULES.length, 3);
  for (const item of ['rg в exec_command', 'apply_patch и не перечитывай их после успешного патча',
    'OpenAI заблокировал вызов инструмента до выполнения', 'повтори тот же вызов один раз без изменений',
    'не уводи в фон через & или nohup', 'опрашивай эту сессию через write_stdin', 'не запускай команду повторно'])
    assert.ok(text.includes(item), item);
  assert.equal(text.replace(EXECUTOR_TOOL_RULES.join('\n') + '\n', ''), plain, 'only the executor rule lines are added');
  assert.ok(text.indexOf(EXECUTOR_TOOL_RULES[1]) < text.indexOf('Вложения содержат'), 'rules precede attachment instructions');
  assert.ok(!text.includes(p.context), 'packet is carried by separate files');
  for (const name of ['workflow_context_recover', 'part=1', 'ключом after']) assert.ok(!text.includes(name), name);
  assert.equal(contextSessionModule.mcpStartMessage, undefined, 'the short MCP start message is gone');
});

test('a new session sends one start message with the full packet and the rules of the runtime', async () => {
  const f = controllerFixture({ chatUrl: null }); const texts = [];
  f.runtime.startupRules = EXECUTOR_TOOL_RULES;
  const deliver = f.composer.deliver;
  f.composer.deliver = async options => { texts.push(options.text); return deliver(options); };
  await f.controller.tick();
  assert.equal(f.loads(), 1); assert.equal(f.sends(), 1);
  assert.deepEqual(texts, [startupMessage(project, 'wp-request-test-request', packet(), EXECUTOR_TOOL_RULES)]);
  assert.equal(f.saved.attempt.packet.contextMode, undefined);
  assert.equal(f.saved.attempt.packet.facts.plan_revision, 7);
  assert.equal(f.controller.state.phase, 'waiting-chat');
  assert.equal('contextMode' in f.controller.state, false, 'there is one delivery mode');
  await f.controller.tick();
  assert.equal(f.saved.chatUrl, project.chatUrl); assert.equal(f.controller.state.phase, 'delivered');
});

test('a chat started through MCP stays bound without another recovery after retry', async () => {
  const f = controllerFixture({ savedAttempt: mcpStarted('sent') });
  f.runtime.setActiveWorkspace = async () => { throw new Error('the client no longer records the active project'); };
  await f.controller.tick();
  assert.equal(f.controller.state.phase, 'legacy-session');
  assert.equal(f.controller.state.messageSent, true);
  assert.equal(f.controller.state.delivery, null);
  f.info.planRevision = 8; await f.controller.tick(); // a changed plan sends nothing either
  assert.equal(f.controller.state.phase, 'legacy-session');
  f.controller.attach(f.saved); await f.controller.tick();
  assert.equal(f.controller.state.phase, 'legacy-session');
  assert.equal(f.loads(), 0); assert.equal(f.sends(), 0); assert.equal(f.saved.chatUrl, project.chatUrl);
  f.info.planRevision = 7;
  await f.controller.retry();
  assert.equal(f.loads(), 0); assert.equal(f.sends(), 0, 'retry only observes the old conversation');
  assert.equal(f.controller.state.phase,'legacy-session');
});

test('a chat started through MCP whose address is not saved yet is bound when the address appears', async () => {
  const f = controllerFixture({ chatUrl: null, savedAttempt: mcpStarted('sent') });
  await f.controller.tick();
  assert.equal(f.controller.state.phase, 'waiting-chat');
  f.inspection.url = project.chatUrl;
  await f.controller.tick();
  assert.equal(f.saved.chatUrl, project.chatUrl); assert.equal(f.boundLog.length, 1);
  assert.equal(f.controller.state.phase, 'legacy-session');
  assert.equal(f.loads(), 0); assert.equal(f.sends(), 0);
});

test('a prepared short MCP start message is never sent: the full packet replaces it, a draft pauses it', async () => {
  const f = controllerFixture({ savedAttempt: mcpStarted('prepared') });
  await f.controller.tick();
  assert.equal(f.loads(), 1); assert.equal(f.sends(), 1, 'the full packet is sent instead');
  assert.notEqual(f.saved.attempt.requestId, 'mcp-request');
  assert.equal(f.controller.state.phase, 'waiting-chat');
  const drafted = controllerFixture({ savedAttempt: mcpStarted('prepared') });
  Object.assign(drafted.inspection, { draftLength: 17, draftMatches: true });
  drafted.composer.hasFilled = () => true;
  await drafted.controller.tick();
  assert.equal(drafted.controller.state.phase, 'prepared-stale');
  assert.equal(drafted.loads(), 0); assert.equal(drafted.sends(), 0);
});

test('fresh creation resets the draft before mode selection and never resets later user input', async () => {
  const f = controllerFixture({ chatUrl: null });
  f.inspection.draftLength = 30; f.inspection.draftMatches = false;
  let clears = 0, modePasses = 0;
  f.composer.clearNewSessionDraft = async ({ canContinue }) => {
    assert.equal(canContinue(), true); clears++; f.inspection.draftLength = 0;
    return { action: 'draft-cleared' };
  };
  const inspect = f.composer.inspect;
  f.composer.inspect = async options => {
    if (options?.action === 'select-experience' && modePasses++ === 0) {
      assert.equal(f.inspection.draftLength, 0);
      f.inspection.draftLength = 50; // Switching surface restored its other draft.
      return { ...f.inspection, action: 'experience-selecting' };
    }
    return inspect(options);
  };
  f.controller.attach(f.saved, { freshDraft: true });
  await f.controller.tick(); assert.equal(f.sends(), 0);
  await f.controller.tick(); assert.equal(f.sends(), 1); assert.equal(clears, 2);
  await f.controller.tick();
  f.inspection.draftLength = 20; f.controller.attach(f.saved); await f.controller.tick();
  assert.equal(f.inspection.draftLength, 20); assert.equal(clears, 2);
});

test('ordinary reopen of an unsent session never authorizes draft clearing', async () => {
  const f = controllerFixture({ chatUrl: null });
  f.inspection.draftLength = 10;
  f.composer.clearNewSessionDraft = () => { throw Error('Unexpected clearing'); };
  await f.controller.tick();
  assert.equal(f.controller.state.phase, 'waiting-draft'); assert.equal(f.loads(), 0);
});

test('cancellation during fresh draft reset never prepares or sends a context', async () => {
  const f = controllerFixture({ chatUrl: null }); let finish;
  f.composer.clearNewSessionDraft = () => new Promise(r => { finish = r; });
  f.controller.attach(f.saved, { freshDraft: true });
  const running = f.controller.tick(); await new Promise(setImmediate);
  f.controller.cancel(); finish({ action: 'draft-cleared' }); await running;
  assert.equal(f.sends(), 0); assert.equal(f.loads(), 0);
});

test('changes after insertion do not run a second readiness check before Send', async () => {
  const f=controllerFixture(); const deliver=f.composer.deliver;
  f.composer.deliver=options=>deliver({...options,onBeforeFill:async()=>{
    await options.onBeforeFill();
    f.info.planRevision=8;
    f.controller.packetIsCurrent=async()=>{throw Error('no revalidation after fill');};
    Object.assign(f.inspection,{draftLength:100,draftMatches:false});
  }});
  await f.controller.tick();
  assert.equal(f.sends(),1); assert.equal(f.saved.attempt.state,'sent');
});

test('already inserted attempt with edited draft continues without preparation or revalidation', async () => {
  const f=controllerFixture();
  f.composer.deliver=async options=>{
    await options.onBeforeFill();
    return {state:'deferred',reason:'SEND_UNAVAILABLE'};
  };
  await f.controller.tick();
  f.composer.hasFilled=id=>id===f.saved.attempt.requestId;
  f.inspection.draftLength=99; f.inspection.draftMatches=false;
  f.controller.packetIsCurrent=async()=>{throw Error('filled attempt must not be revalidated');};
  let delivered=0;
  f.composer.deliver=async options=>{await options.onBeforeSend(); delivered++;return {state:'sent'};};
  await f.controller.tick();
  assert.equal(delivered,1);assert.equal(f.loads(),1);assert.equal(f.saved.attempt.state,'sent');
});

test('dispatched recovery binds and reopens an attachment-only chat without looking for packet text', async () => {
  const f=controllerFixture({chatUrl:null});
  await f.controller.tick();
  f.inspection.messageSeen=false;f.inspection.userMessageCount=0;
  const inspect=f.composer.inspect;
  f.composer.inspect=async options=>{
    assert.equal(options.requestId,undefined);assert.equal(options.text,undefined);
    return inspect(options);
  };
  await f.controller.tick();
  assert.equal(f.saved.chatUrl,project.chatUrl);assert.equal(f.controller.state.phase,'delivered');
  f.controller.attach(f.saved);await f.controller.tick();
  assert.equal(f.sends(),1);assert.equal(f.loads(),1);assert.equal(f.controller.state.phase,'delivered');
});

const settleEvents = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

test('warm completion continues a waiting controller without another page signal and does not warm on every tick', async () => {
  const f = controllerFixture(); let release, warms = 0;
  f.inspection.busy = true;
  f.controller.contextCache = { warm: () => { warms++; return new Promise(resolve => { release = resolve; }); },
    load: async () => packet(), isCurrent: async () => true };
  await f.controller.tick(); await settleEvents();
  assert.equal(warms, 1);
  await f.controller.tick(); await f.controller.tick(); assert.equal(warms, 1);
  release({ ok: true }); await settleEvents();
  assert.equal(f.controller.state.phase, 'waiting-generation'); assert.equal(warms, 1);
  f.controller.projectChanged(); await settleEvents(); assert.equal(warms, 2);
  f.inspection.busy = false;
  release({ ok: true }); await settleEvents();
  assert.equal(f.sends(), 1); assert.equal(warms, 2);
});

test('warm failure is visible and bounded; explicit retry restarts it, cancellation ignores completion', async () => {
  const f = controllerFixture(); let warms = 0, release;
  f.inspection.busy = true;
  f.controller.contextCache = { warm: async () => { warms++; return { ok: false, error: Object.assign(Error('unavailable'), { code: 'INPUT_FAILED' }) }; } };
  await f.controller.tick(); await settleEvents();
  assert.equal(f.controller.state.phase, 'error'); assert.equal(f.controller.state.error.code, 'INPUT_FAILED');
  await settleEvents(); assert.equal(warms, 1);
  f.controller.contextCache.warm = () => { warms++; return new Promise(resolve => { release = resolve; }); };
  await f.controller.retry(); await settleEvents(); assert.equal(warms, 2);
  f.controller.cancel(); release({ ok: false, error: Error('old error') }); await settleEvents();
  assert.equal(f.controller.state.phase, 'selected'); assert.equal(f.sends(), 0);
});

test('known input change marks delivered recovery stale without another Send or warm', async () => {
  const f = controllerFixture(); await f.controller.tick(); await f.controller.tick();
  let fingerprints = 0;
  f.controller.contextCache = { isCurrent: async () => { fingerprints++; return false; }, warm: () => assert.fail('delivered chat must not warm') };
  f.controller.projectChanged(); await settleEvents();
  assert.equal(f.controller.state.phase, 'stale'); assert.equal(f.sends(), 1); assert.equal(fingerprints, 1);
  await f.controller.tick(); assert.equal(f.controller.state.phase, 'stale'); assert.equal(fingerprints, 1);
});

test('the line for an external client names the folder, AGENTS.md and the recovery file and carries no secrets', () => {
  const line = externalClientLine({ name: 'Мой проект', workspace: '/Projects/Мой "проект"' }, 'darwin');
  assert.equal(line, [
    'Проект «Мой проект». Папка проекта (точная абсолютная папка, JSON-строка): "/Projects/Мой \\"проект\\"".',
    'Работай в этой папке. Сначала прочитай в ней AGENTS.md.',
    'Затем получи контекст проекта: выполни в папке проекта команду ./scripts/workflow recover --format text > .harness/runtime/recovery.txt и прочитай файл .harness/runtime/recovery.txt целиком, по частям, если он не помещается в один ответ инструмента.',
    'После этого коротко подтверди, что контекст получен, и в одном-двух предложениях опиши назначение проекта и текущее состояние плана.',
  ].join('\n'));
  const windows = externalClientLine({ name: 'Demo', workspace: 'C:\\Projects\\Demo' }, 'win32');
  assert.ok(windows.includes('"C:\\\\Projects\\\\Demo"'), 'the folder is a JSON string');
  assert.ok(windows.includes('scripts\\workflow.cmd recover --format text > .harness\\runtime\\recovery.txt'));
  assert.ok(windows.includes('прочитай файл .harness\\runtime\\recovery.txt целиком'));
  for (const text of [line, windows]) {
    assert.doesNotMatch(text, /https?:\/\/|tunnel_|sk-|mcp|session|wp-request/i, 'no connector address, key or session data');
    assert.ok(Buffer.byteLength(text) < 1200);
  }
});

test('assigned initial recovery waits while project AutoPlan is OFF and resumes without a new attempt',async()=>{
  const f=controllerFixture({chatUrl:null});let allowed=false;
  await f.store.updateSession(project.workspace,project.sessionId,{assignmentId:'assigned',taskId:'T001',parentWorkspace:'/main',parentScopeId:'scope'});
  f.controller.canSendContext=()=>allowed;
  await f.controller.tick();assert.equal(f.sends(),0);assert.equal(f.loads(),0);assert.equal(f.saved.attempt,null);
  allowed=true;await f.controller.tick();assert.equal(f.sends(),1);assert.equal(f.saved.attempt.state,'sent');
  allowed=false;await f.controller.tick();assert.equal(f.sends(),1,'OFF cannot replay an already delivered recovery');
});
