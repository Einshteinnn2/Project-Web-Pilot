import { PageStateSource } from './page-state.mjs';
import { ContextSession } from './context-session.mjs';
import { ChatGPTComposer } from './chatgpt-composer.mjs';
import { AgentTimer } from './agent-timer.mjs';
import { ConversationRecovery } from './conversation-recovery.mjs';
import { chatGPTEntrypoint } from './chatgpt-experience.mjs';

export const sessionRuntimeKey = project => project ? JSON.stringify([
  project.workspace, project.sessionId, project.assignmentId ?? null, project.taskId ?? null,
]) : 'entry';

// This facade addresses one saved session, never the current sidebar selection.
export function sessionStore(store, identity) {
  const owns = (workspace, sessionId = identity.sessionId) => {
    if(workspace!==identity.workspace || sessionId!==identity.sessionId)throw Object.assign(new Error('Чужая сессия.'),{code:'SESSION_CHANGED'});
  };
  return {
    selected:()=>store.project(identity.workspace,identity.sessionId),
    project:workspace=>{owns(workspace);return store.project(workspace,identity.sessionId);},
    inspect:(workspace,sessionId)=>{owns(workspace,sessionId);return store.inspect(workspace,sessionId);},
    bindChat:(workspace,sessionId,url,options)=>{owns(workspace,sessionId);return store.bindChat(workspace,sessionId,url,{...options,background:true});},
    updateSession:(workspace,sessionId,patch)=>{owns(workspace,sessionId);return store.updateSession(workspace,sessionId,patch,{background:true});},
  };
}

// Owns pages and their work. A host only presents a page; hiding it does not stop it.
export class SessionRuntimes {
  constructor({store,runtime,contextCache,createView,connectPageState,ipc,onChange=()=>{},onPage=()=>{},
    decorate=()=>()=>{},onError=()=>{},onChatBound=()=>{},createComposer=(contents,options)=>new ChatGPTComposer(contents,options)}) {
    Object.assign(this,{store,runtime,contextCache,createView,connectPageState,ipc,onChange,onPage,decorate,onError,onChatBound,createComposer});
    this.records=new Map();this.visible=null;this.host=null;
  }
  ensure(project=null) {
    const key=sessionRuntimeKey(project), existing=this.records.get(key);
    if(existing)return existing;
    const identity=project?Object.freeze({workspace:project.workspace,sessionId:project.sessionId,
      assignmentId:project.assignmentId??null,taskId:project.taskId??null}):null;
    const record={key,identity,view:this.createView(),pageState:new PageStateSource(),loading:false,ready:false,
      epoch:0,readinessEpoch:0,disposed:false,manualDocumentOwner:null,lastStopObservation:null,error:null,cleanups:[]};
    this.records.set(key,record);
    const contents=record.view.webContents;
    record.project=()=>identity?this.store.project(identity.workspace,identity.sessionId):null;
    const scopedStore=identity?sessionStore(this.store,identity):this.store;
    record.composer=this.createComposer(contents,{pageState:record.pageState});
    record.controller=new ContextSession({store:scopedStore,runtime:this.runtime(),contextCache:this.contextCache,
      composer:record.composer,onChange:()=>this.onChange(record),onChatBound:()=>this.onChatBound(record)});
    record.controller.onIdle=()=>this.onChange(record);
    record.timer=new AgentTimer({onFinish:(target,durationMs)=>{
      void this.store.recordAgentTime(target.workspace,target.sessionId,durationMs).then(()=>this.onChange(record),error=>this.onError(record,error));
    }});
    record.recovery=new ConversationRecovery({selected:record.project,
      checkpoint:project?.conversationRecovery,
      save:checkpoint=>identity?this.store.updateSession(identity.workspace,identity.sessionId,{conversationRecovery:checkpoint},{background:true}):Promise.resolve(),
      available:()=>!record.disposed&&!record.loading&&record.ready&&!record.composer.inFlight,
      inspect:()=>record.composer.inspect(),
      reopen:async(project,current)=>{
        if(!current())return false;
        await this.navigate(record,project.chatUrl,{reload:true});
        if(!record.pageState.current)await record.pageState.waitForChange(record.pageState.version,{timeoutMs:5000,canContinue:current});
        return current()&&record.pageState.current?.state.url===project.chatUrl&&!record.pageState.current.state.connectionError;
      },onChange:()=>this.onChange(record)});
    const on=(event,handler)=>{contents.on(event,handler);record.cleanups.push(()=>contents.removeListener(event,handler));};
    record.cleanups.push(record.pageState.subscribe(event=>{
      if(record.disposed)return;
      if(event.reset){record.manualDocumentOwner=null;record.lastStopObservation=null;record.timer.finish();}
      else {
        const project=record.project(), documentId=event.documentId??record.pageState.current?.documentId;
        const revision=event.state.manualStopRevision??0;
        if(revision>(record.lastStopObservation?.documentId===documentId?record.lastStopObservation.revision:0))record.recovery.manualStop(event.state);
        record.lastStopObservation={documentId,revision};
        if(project&&!project.archivedAt&&!project.sessionArchivedAt)record.timer.observe(record.identity,event.state.busy);
        if(record.ready&&!record.loading)record.recovery.observe(event.state);
      }
      this.onPage(record,event);
      if(!event.reset&&record.ready&&!record.loading)this.tick(record);
    }));
    record.cleanups.push(this.connectPageState(contents,this.ipc,record.pageState,{onFailure:code=>{
      record.controller.cancel();record.error={code,message:'Наблюдатель ChatGPT недоступен. Повторите открытие страницы.'};
      this.onError(record,Object.assign(new Error(record.error.message),{code}));
    }}));
    on('did-start-navigation',(event,_url,inPlace,mainFrame)=>{
      if((event.isMainFrame??mainFrame)&&!(event.isSameDocument??inPlace)){record.loading=true;record.controller.cancel();}
    });
    on('did-finish-load',()=>{record.loading=false;this.tick(record);this.onChange(record);});
    on('did-navigate-in-page',()=>{this.tick(record);this.onChange(record);});
    on('render-process-gone',()=>{
      record.loading=false;record.ready=false;record.epoch++;record.controller.cancel();
      this.onError(record,Object.assign(new Error('Страница ChatGPT закрылась. Повторите открытие страницы.'),{code:'RENDER_PROCESS_GONE'}));
    });
    const cleanup=this.decorate(record);if(typeof cleanup==='function')record.cleanups.push(cleanup);
    return record;
  }
  tick(record,{freshDraft=false}={}) {
    const project=record.project();
    if(record.disposed||!record.ready||record.loading||!project||project.archivedAt||project.sessionArchivedAt)return;
    record.controller.runtime=this.runtime();
    if(!record.controller.active) {
      record.controller.attach(project,{freshDraft:freshDraft||record.freshDraft===true});
      record.freshDraft=false;
    }
    void record.controller.tick();
  }
  show(record,host) {
    if(record.disposed||this.records.get(record.key)!==record)throw new Error('SESSION_RUNTIME_RELEASED');
    if(this.visible===record&&this.host===host)return;
    this.hide();this.visible=record;this.host=host;
    if(host)host.addChildView(record.view);
    record.view.setVisible?.(true);
  }
  hide() {
    if(this.visible){this.visible.view.setVisible?.(false);this.host?.removeChildView(this.visible.view);}
    this.visible=null;this.host=null;
  }
  async navigate(record,url,{reload=false,freshDraft=false}={}) {
    if(record.disposed)throw new Error('SESSION_RUNTIME_RELEASED');
    const contents=record.view.webContents;
    if(!reload&&contents.getURL()===url){this.tick(record,{freshDraft});return record;}
    const epoch=++record.epoch;record.loading=true;record.error=null;record.freshDraft=freshDraft;record.controller.cancel();
    try {
      await contents.loadURL(url);
      if(record.disposed||epoch!==record.epoch)return null;
      record.loading=false;this.tick(record,{freshDraft});return record;
    }catch(error){if(!record.disposed&&epoch===record.epoch){record.loading=false;this.onError(record,error);}throw error;}
  }
  // A new main Chat can start in the background without changing the host's
  // selected project. The existing ContextSession owns preparation and Send;
  // on restart an attempted/UNKNOWN request is observed, never sent again.
  async openRotationChat(project,{checkReady=async()=>({ready:true})}={}) {
    if(project?.experience!=='chat'||!project.rotation?.id||project.archivedAt||project.sessionArchivedAt)
      throw Object.assign(new Error('Новая Chat-сессия ротации недоступна.'),{code:'ROTATION_TARGET_INVALID'});
    const record=this.ensure(project);
    if(record.disposed)throw Object.assign(new Error('Runtime сессии закрыт.'),{code:'ROTATION_TARGET_INVALID'});
    const status=await checkReady(project.workspace);
    if(!status?.ready)throw Object.assign(new Error('Нельзя подготовить проект для Recovery.'),{code:'ROTATION_TARGET_NOT_READY'});
    if(record.disposed)throw Object.assign(new Error('Runtime сессии закрыт.'),{code:'ROTATION_TARGET_INVALID'});
    record.ready=true;
    const target=project.chatUrl??chatGPTEntrypoint('chat');
    if(record.view.webContents.getURL()!==target)
      await this.navigate(record,target,{freshDraft:!project.chatUrl&&!project.attempt});
    else this.tick(record,{freshDraft:!project.chatUrl&&!project.attempt});
    return record;
  }
  release(record,{force=false}={}) {
    if(!record||record.disposed)return false;
    if(!force&&(record.pageState.current?.state.busy||record.controller.pending||record.composer.inFlight))return false;
    if(this.visible===record)this.hide();
    record.disposed=true;record.epoch++;record.controller.cancel();record.recovery.reset();record.timer.finish();
    for(const cleanup of record.cleanups.splice(0).reverse())cleanup();
    if(!record.view.webContents.isDestroyed())record.view.webContents.close({waitForBeforeUnload:false});
    this.records.delete(record.key);return true;
  }
  dispose() {for(const record of [...this.records.values()])this.release(record,{force:true});}
}
