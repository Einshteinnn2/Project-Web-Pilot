import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { settingsPanelView } from '../src/ui/settings-panel.mjs';
import { DEFAULT_PARALLEL_SETTINGS, validateParallelSettings } from '../src/parallel-settings.mjs';
import { startupMessage } from '../src/context-session.mjs';

test('execution settings reject malformed limits and return an independent snapshot', () => {
  assert.deepEqual(validateParallelSettings(), { parallel_allowed:false, max_workers:2 });
  const settings = { parallel_allowed:true, max_workers:3 };
  const snapshot = validateParallelSettings(settings);
  settings.max_workers = 8; assert.equal(snapshot.max_workers,3);
  for (const max_workers of [0,-1,1.5,Infinity,NaN,'2',Number.MAX_SAFE_INTEGER+1])
    assert.throws(()=>validateParallelSettings({parallel_allowed:true,max_workers}),{code:'PARALLEL_SETTINGS_INVALID'});
  for (const value of [null,[],true,{}, {parallel_allowed:'true',max_workers:2}, {...DEFAULT_PARALLEL_SETTINGS,autoPlan:true}])
    assert.throws(()=>validateParallelSettings(value),{code:'PARALLEL_SETTINGS_INVALID'});
  assert.deepEqual(validateParallelSettings({parallel_allowed:true,max_workers:1}),{parallel_allowed:true,max_workers:1});
});

test('real settings controls hide the limit when OFF, save valid values and explain invalid input', async t => {
  const dom = new JSDOM(await fs.readFile(new URL('../src/ui/index.html',import.meta.url),'utf8'));
  const before = globalThis.document; globalThis.document = dom.window.document;
  t.after(()=>{globalThis.document=before;dom.window.close();});
  const $ = id=>dom.window.document.getElementById(id), calls=[];
  const view = settingsPanelView((...args)=>calls.push(args));
  const state={platform:'linux',projects:[],settings:{workspace:null},archives:[],hideToolCalls:true,theme:'light'};
  view.render(state,false);
  assert.equal($('parallel-allowed').checked,false);
  assert.equal($('parallel-options').hidden,true);
  assert.equal($('parallel-max-workers').value,'2');
  assert.match($('parallel-settings-help').textContent,/только к новым сессиям/);
  $('parallel-allowed').click();
  assert.deepEqual(calls.pop(),['setParallelExecution',{parallel_allowed:true,max_workers:2}]);
  const on={...state,parallelExecution:{parallel_allowed:true,max_workers:2}};
  view.render(on,false);
  assert.equal($('parallel-options').hidden,false);
  for(const value of ['0','-1','2.5','','9007199254740992']) {
    $('parallel-max-workers').value=value;
    $('parallel-max-workers').dispatchEvent(new dom.window.Event('change'));
    assert.equal(calls.length,0);
    assert.equal($('parallel-settings-error').hidden,false);
    assert.equal($('parallel-max-workers').getAttribute('aria-invalid'),'true');
  }
  $('parallel-max-workers').value='4';
  $('parallel-max-workers').dispatchEvent(new dom.window.Event('change'));
  assert.deepEqual(calls.pop(),['setParallelExecution',{parallel_allowed:true,max_workers:4}]);
  assert.equal($('parallel-settings-error').hidden,true);
  view.render({...on,parallelExecution:{parallel_allowed:true,max_workers:4}},true);
  assert.equal($('parallel-allowed').disabled,true);
  assert.equal($('parallel-max-workers').disabled,true);
  view.render({...on,parallelExecution:{parallel_allowed:true,max_workers:4}},false);
  $('parallel-allowed').click();
  assert.deepEqual(calls.pop(),['setParallelExecution',{parallel_allowed:false,max_workers:4}]);
});

test('recovery settings expose exact executor action, keep cloud-chat warning and respect pending state',async t=>{
  const dom=new JSDOM(await fs.readFile(new URL('../src/ui/index.html',import.meta.url),'utf8'));
  const previous=globalThis.document;globalThis.document=dom.window.document;
  t.after(()=>{globalThis.document=previous;dom.window.close();});
  const calls=[],view=settingsPanelView((...args)=>calls.push(args));
  const $=id=>dom.window.document.getElementById(id);
  const record={workspace:'/tmp/.web-pilot-worktrees/group/worker-one',projectId:'exact-id',
    name:'Исполнитель один',message:'Связь с родителем не подтверждена. Облачные чаты ChatGPT сохраняются.'};
  const base={projects:[],settings:{workspace:null},executorRecovery:[record],platform:'linux',theme:'light',hideToolCalls:false};
  view.render(base,false);
  assert.equal($('executor-recovery').hidden,false);
  assert.match($('executor-recovery').textContent,/Восстановление исполнителей/);
  assert.match($('executor-recovery').textContent,/Облачные чаты ChatGPT сохраняются/);
  const button=$('executor-recovery-items').querySelector('button');
  assert.equal(button.textContent,'Убрать запись');
  button.click();
  assert.deepEqual(calls,[['clearOrphanExecutor',{workspace:record.workspace,projectId:record.projectId}]]);
  view.render(base,true);
  assert.equal($('executor-recovery-items').querySelector('button').disabled,true);
  view.render({...base,executorRecovery:[]},false);
  assert.equal($('executor-recovery').hidden,true);
  assert.equal($('executor-recovery-items').children.length,0);
});

test('startup recovery metadata uses the session snapshot and never AutoPlan or current Settings', () => {
  const project={name:'Fixture',workspace:'/fixture',sessionId:'fixture-session',scopeStatus:'NONE',
    executionSnapshot:{parallel_allowed:true,max_workers:3}};
  const packet={parts:[{text:'Unchanged Kit recovery'}]};
  const text=startupMessage(project,'request',packet);
  assert.ok(text.includes(JSON.stringify(project.executionSnapshot)));
  assert.match(text,/при планировании оцени зависимости/);
  assert.doesNotMatch(text,/AutoPlan/);
  assert.equal(startupMessage({...project,autoPlanEnabled:true,parallelExecution:{parallel_allowed:false,max_workers:1}},'request',packet),text);
  assert.deepEqual(packet,{parts:[{text:'Unchanged Kit recovery'}]},'shared recovery is not rewritten for a session');
  for(const scopeStatus of ['ACTIVE','BLOCKED']) {
    const active=startupMessage({...project,scopeStatus,planExecution:{parallel_allowed:true,max_workers:2,execution_strategy:'parallel',execution_reason:'Independent'}},'request',packet);
    assert.match(active,/не создавай второй план/);
    assert.match(active,/"max_workers":2/);
    assert.match(active,/"max_workers":3/);
  }
  const legacy=startupMessage({...project,executionSnapshot:undefined},'request',packet);
  assert.match(legacy,/Legacy-сессия.*выключено/);
});

