import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SessionRuntimes,sessionStore,sessionRuntimeKey } from '../src/session-runtime.mjs';

function fixture(t) {
  let selected='a',connections=0,disconnections=0;
  const projects={a:{workspace:'/project',sessionId:'a',projectId:'p',chatUrl:'https://chatgpt.com/c/aaaaaaaa'},
    b:{workspace:'/project',sessionId:'b',projectId:'p',chatUrl:'https://chatgpt.com/c/bbbbbbbb'}};
  const store={project:(workspace,id)=>workspace==='/project'?projects[id??selected]:null,selected:()=>projects[selected],
    inspect:async()=>({projectId:'p'}),recordAgentTime:async()=>{},bindChat:async(w,id,url)=>{projects[id].chatUrl=url;return projects[id];},
    updateSession:async(w,id,patch)=>{Object.assign(projects[id],patch);return projects[id];}};
  const createView=()=>{
    const contents=new EventEmitter();contents.url='';contents.destroyed=false;contents.loads=[];
    contents.getURL=()=>contents.url;contents.isDestroyed=()=>contents.destroyed;contents.close=()=>{contents.destroyed=true;};
    contents.loadURL=async url=>{contents.loads.push(url);contents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false});contents.url=url;contents.emit('did-finish-load');};
    return {webContents:contents,setVisible(value){this.visible=value;}};
  };
  const manager=new SessionRuntimes({store,runtime:()=>({}),createView,ipc:{},
    createComposer:contents=>({contents,inFlight:false,inspect:async()=>({login:true})}),
    connectPageState:()=>{connections++;return()=>disconnections++;}});
  t.after(()=>manager.dispose());
  const host=()=>({children:new Set(),addChildView(view){this.children.add(view);},removeChildView(view){this.children.delete(view);}});
  return {manager,projects,store,host,select:id=>{selected=id;},counts:()=>({connections,disconnections})};
}

test('independent sessions keep pages, controllers and timers when switching or moving their presentation',async t=>{
  const f=fixture(t),a=f.manager.ensure(f.projects.a),b=f.manager.ensure(f.projects.b),host=f.host(),otherHost=f.host();
  assert.notEqual(a.view,b.view);assert.notEqual(a.controller,b.controller);assert.notEqual(a.composer,b.composer);
  assert.notEqual(a.pageState,b.pageState);assert.notEqual(a.recovery,b.recovery);assert.notEqual(a.timer,b.timer);
  assert.equal(f.manager.ensure(f.projects.a),a);assert.equal(f.counts().connections,2);
  await f.manager.navigate(a,f.projects.a.chatUrl);await f.manager.navigate(b,f.projects.b.chatUrl);
  a.controller.attach(f.projects.a);const generation=a.controller.generation;
  a.timer.observe(a.identity,true);const timer=a.timer.active;
  f.manager.show(a,host);f.select('b');f.manager.show(b,host);
  assert.equal(a.controller.current(generation),true,'background controller remains bound to its session');
  assert.equal(a.timer.active,timer);assert.equal(a.view.webContents.destroyed,false);
  assert.equal(a.view.webContents.getURL(),f.projects.a.chatUrl);assert.equal(a.view.webContents.loads.length,1);
  f.manager.show(a,otherHost);
  assert.equal(host.children.size,0);assert.equal(otherHost.children.has(a.view),true);
  assert.equal(a.controller.generation,generation);assert.equal(a.timer.active,timer);
  await f.manager.navigate(a,f.projects.a.chatUrl);
  assert.equal(a.view.webContents.loads.length,1,'showing an existing chat does not navigate or resend');
  f.manager.hide();assert.equal(a.view.webContents.destroyed,false);assert.equal(a.controller.current(generation),true);
});

test('explicit release refuses active work and cleans only that session',t=>{
  const f=fixture(t),a=f.manager.ensure(f.projects.a),b=f.manager.ensure(f.projects.b);
  a.composer.inFlight=true;assert.equal(f.manager.release(a),false);
  a.composer.inFlight=false;assert.equal(f.manager.release(a),true);
  assert.equal(a.view.webContents.destroyed,true);assert.equal(b.view.webContents.destroyed,false);
  assert.equal(a.pageState.listeners.size,0);assert.equal(a.view.webContents.listenerCount('did-finish-load'),0);
  assert.deepEqual(f.counts(),{connections:2,disconnections:1});
  assert.throws(()=>f.manager.show(a,f.host()),/RELEASED/);assert.equal(f.manager.release(a),false);
});

test('session-scoped store and operation keys preserve worktree/task address independently of selection',async t=>{
  const f=fixture(t),identity={workspace:'/project',sessionId:'a'},own=sessionStore(f.store,identity);
  f.select('b');await own.updateSession('/project','a',{attempt:{state:'sent'}});
  assert.equal(f.projects.a.attempt.state,'sent');assert.equal(f.projects.b.attempt,undefined);
  assert.equal(own.selected().sessionId,'a');assert.equal(own.project('/project').sessionId,'a');
  assert.throws(()=>own.updateSession('/project','b',{}),{code:'SESSION_CHANGED'});
  assert.throws(()=>own.project('/other'),{code:'SESSION_CHANGED'});
  assert.notEqual(sessionRuntimeKey({...identity,taskId:'T1'}),sessionRuntimeKey({...identity,taskId:'T2'}));
  assert.notEqual(sessionRuntimeKey(identity),sessionRuntimeKey({...identity,workspace:'/worktree'}));
});

test('late navigation completion cannot revive a released session',async t=>{
  const f=fixture(t),a=f.manager.ensure(f.projects.a);let finish;
  a.view.webContents.loadURL=()=>new Promise(resolve=>{finish=resolve;});
  const pending=f.manager.navigate(a,f.projects.a.chatUrl);f.manager.release(a,{force:true});finish();
  assert.equal(await pending,null);assert.equal(a.controller.active,null);assert.equal(a.view.webContents.destroyed,true);
});

test('rotated Chat uses a separate background Runtime and never changes the visible host',async t=>{
  const f=fixture(t);
  const original=f.manager.ensure(f.projects.a),host=f.host();f.manager.show(original,host);
  const target={...f.projects.b,experience:'chat',chatUrl:null,
    rotation:{id:'rotation-'+'a'.repeat(64),sourceSessionId:'a',scopeId:'scope',boundary:'c'.repeat(40),creationHead:'b'.repeat(40)}};
  f.projects.b=target;
  let readiness=0;
  const record=await f.manager.openRotationChat(target,{checkReady:async()=>{readiness++;return {ready:true};}});
  assert.equal(readiness,1);
  assert.notEqual(record,original);
  assert.equal(record.ready,true);
  assert.equal(record.controller.active?.sessionId,'b');
  assert.equal(record.view.webContents.getURL(),'https://chatgpt.com/');
  assert.equal(f.manager.visible,original);
  assert.equal(host.children.has(original.view),true);
  assert.equal(host.children.has(record.view),false);
  assert.equal(record.view.webContents.loads.length,1);
  await f.manager.openRotationChat(target,{checkReady:async()=>({ready:true})});
  assert.equal(record.view.webContents.loads.length,1,'a repeated recovery event does not reload the target');
  await assert.rejects(f.manager.openRotationChat({...target,experience:'work'}),{code:'ROTATION_TARGET_INVALID'});
});
