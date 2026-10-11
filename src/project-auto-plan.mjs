// Authorization belongs to a project and its current scope. Session ledgers
// survive OFF/restart, but never grant permission to another project or plan.
import { advanceChatSessionTaskCounter } from './chat-session-rotation.mjs';

export class ProjectAutoPlan {
  constructor({saved={},onChange=()=>{},identity=null,ownsSession=()=>true}={}) {
    this.book={};this.handoffGuards=new Set();this.onChange=onChange;this.identity=identity;this.ownsSession=ownsSession;
    for(const [workspace,value] of Object.entries(saved??{}))if(workspace.startsWith('/')||/^[A-Za-z]:[\\/]/.test(workspace)) {
      if(value&&typeof value.scopeId==='string'&&value.sessions&&typeof value.sessions==='object'&&!Array.isArray(value.sessions))
        this.book[workspace]={projectId:value.projectId??null,scopeId:value.scopeId,enabled:value.enabled===true,sessionId:typeof value.sessionId==='string'?value.sessionId:null,sessions:structuredClone(value.sessions),awaitingPlan:value.scopeId===''&&value.awaitingPlan===true,offReason:value.offReason??null,
          planRevision:Number.isSafeInteger(value.planRevision)?value.planRevision:null,
          previousScopeId:typeof value.previousScopeId==='string'?value.previousScopeId:null,
          handoff:value.handoff&&typeof value.handoff==='object'&&!Array.isArray(value.handoff)
            &&['waiting','done','failed'].includes(value.handoff.status)
            &&typeof value.handoff.scopeId==='string'&&typeof value.handoff.sourceSessionId==='string'
            &&typeof value.handoff.operationId==='string'?structuredClone(value.handoff):null,
          executionStrategy:['parallel','sequential'].includes(value.executionStrategy)?value.executionStrategy:null};
    }
  }
  state(workspace){
    const state=this.book[workspace];if(!state||!this.identity)return state;
    const id=this.identity(workspace);if(!id)return undefined;
    if(!state.projectId) {
      // Pre-identity permissions migrate only with the same registered chat.
      if(!state.sessionId||!this.ownsSession(workspace,state.sessionId))return undefined;
      state.projectId=id;
    }
    return state.projectId===id?state:undefined;
  }
  enabled(workspace,scopeId){const state=this.state(workspace);return !!state&&state.scopeId===(scopeId??'')&&state.enabled===true&&(!!scopeId||state.awaitingPlan===true);}
  handoffPending(workspace){return this.handoffGuards.has(workspace);}
  finalizationAllowed(workspace,scopeId){const state=this.state(workspace);return !!state&&state.scopeId===scopeId&&(state.enabled||state.offReason==='complete');}
  sync(workspace,scopeId,{complete=false,confirmed=false,planRevision=null,originSessionId=null,executionStrategy=null}={}) {
    if(!workspace||(this.identity&&!this.identity(workspace)))return false;
    const old=this.state(workspace);
    // NONE, a failed read, or an unconfirmed/stale projection cannot revoke an
    // explicit choice or bind it to the wrong scope. Only verified plan facts advance it.
    if(!scopeId||!confirmed)return this.enabled(workspace,scopeId);
    const revision=Number.isSafeInteger(planRevision)?planRevision:null;
    if(old?.scopeId!==scopeId&&old?.previousScopeId===scopeId)return this.enabled(workspace,scopeId);
    // After archive Kit may start a fresh revision sequence. A user-armed
    // awaitingPlan is a new epoch; only a confirmed current scope may bind it.
    if(!old?.awaitingPlan&&revision!==null&&old?.planRevision!==null&&old?.planRevision!==undefined
      &&(revision<old.planRevision||(revision===old.planRevision&&old.scopeId!==scopeId)))
      return this.enabled(workspace,scopeId);
    if(old?.scopeId!==scopeId){
      this.handoffGuards.delete(workspace);
      const inherited=old?.awaitingPlan===true&&old.enabled===true;
      // The published Kit origin takes priority over the pre-plan button
      // session. A missing (legacy) origin retains its former fallback; an
      // explicit but unregistered origin must not silently grant that chat.
      const recipient=originSessionId!==null?(this.ownsSession(workspace,originSessionId)?originSessionId:null):old?.sessionId??null;
      this.book[workspace]={projectId:this.identity?.(workspace)??null,scopeId,enabled:inherited,
        sessionId:inherited?recipient:null,offReason:null,planRevision:revision,
        previousScopeId:(old?.scopeId||old?.previousScopeId)??null,
        handoff:null,
        executionStrategy:['parallel','sequential'].includes(executionStrategy)?executionStrategy:null,
        sessions:Object.fromEntries(Object.entries(old?.sessions??{})
          .filter(([,entry])=>entry.automationCheckpoint).map(([id,entry])=>[id,{automationCheckpoint:entry.automationCheckpoint}]))};
      this.onChange(workspace);
    }
    const state=this.state(workspace);
    if(!state.executionStrategy&&['parallel','sequential'].includes(executionStrategy)){
      state.executionStrategy=executionStrategy;this.onChange(workspace);
    }
    if(revision!==null&&(state.planRevision===null||revision>state.planRevision)){
      state.planRevision=revision;this.onChange(workspace);
    }
    if(complete&&confirmed&&state.enabled){state.enabled=false;state.offReason='complete';this.onChange(workspace);}
    return this.enabled(workspace,scopeId);
  }
  set(workspace,scopeId,choice,sessionId=null){
    if(!workspace||(this.identity&&!this.identity(workspace)))return false;
    if(!scopeId){this.handoffGuards.delete(workspace);const old=this.state(workspace);this.book[workspace]={projectId:this.identity?.(workspace)??null,scopeId:'',enabled:choice===true,awaitingPlan:choice===true,offReason:choice?null:'manual',sessionId,sessions:old?.sessions??{},planRevision:old?.planRevision??null,
      previousScopeId:(old?.scopeId||old?.previousScopeId)??null};this.onChange(workspace);return choice===true;}
    // An explicit user toggle follows a separately verified plan read by the IPC.
    this.sync(workspace,scopeId,{confirmed:true});const state=this.state(workspace);
    const reason=choice?null:'manual';
    if(state.enabled!==(choice===true)||state.offReason!==reason||(choice&&sessionId&&state.sessionId!==sessionId)||state.handoff){state.enabled=choice===true;state.offReason=reason;if(choice&&sessionId)state.sessionId=sessionId;state.handoff=null;this.handoffGuards.delete(workspace);this.onChange(workspace);}return state.enabled;
  }
  // A transient read error, Review transaction or stale NONE is not evidence
  // that a previously confirmed unfinished scope has disappeared. Explicit
  // ON/OFF can still transfer its recipient, without replacing its ledger or
  // turning a completed scope into an executable one.
  setWhileUnconfirmed(workspace,choice,sessionId=null){
    const previous=this.state(workspace);
    const scope=previous?.scopeId && previous.offReason!=='complete' ? previous.scopeId : null;
    return this.set(workspace,scope,choice,previous?.executionStrategy==='parallel'?null:sessionId);
  }
  checkpoint(workspace,scopeId,sessionId){return this.state(workspace)&&this.state(workspace).scopeId===scopeId?this.state(workspace).sessions[sessionId]??{}:{};}
  saveCheckpoint(workspace,scopeId,sessionId,patch) {
    if(!this.state(workspace)||this.state(workspace).scopeId!==scopeId||!this.ownsSession(workspace,sessionId))return;
    this.state(workspace).sessions[sessionId]={...this.checkpoint(workspace,scopeId,sessionId),...patch};return this.onChange(workspace);
  }
  beginHandoff(workspace,scopeId,sourceSessionId,{operationId,kind='rotation'}={}) {
    const state=this.state(workspace);
    if(state?.handoff?.status==='done')state.handoff=null;
    if(!state?.enabled||state.scopeId!==scopeId||state.executionStrategy==='parallel'
      ||state.sessionId!==sourceSessionId||!this.ownsSession(workspace,sourceSessionId)
      ||typeof operationId!=='string'||!operationId||!['rotation','manual'].includes(kind))
      throw Object.assign(new Error('Право продолжения больше не принадлежит исходному Chat.'),{code:'ROTATION_AUTHORITY_CHANGED'});
    if(state.handoff){
      if(state.handoff.operationId!==operationId||state.handoff.status!=='waiting')
        throw Object.assign(new Error('Передача AutoPlan уже началась или заблокирована.'),{code:'ROTATION_HANDOFF_CONFLICT'});
      return state.handoff;
    }
    state.handoff={scopeId,sourceSessionId,targetSessionId:null,operationId,kind,status:'waiting'};
    state.sessionId=null;this.onChange(workspace);
    return structuredClone(state.handoff);
  }
  attachHandoff(workspace,operationId,targetSessionId){
    const state=this.state(workspace),handoff=state?.handoff;
    if(!state?.enabled||handoff?.operationId!==operationId||handoff.status!=='waiting'
      ||!this.ownsSession(workspace,targetSessionId)
      ||handoff.targetSessionId&&handoff.targetSessionId!==targetSessionId)
      throw Object.assign(new Error('Целевая Chat-сессия не принадлежит передаче.'),{code:'ROTATION_HANDOFF_CONFLICT'});
    if(handoff.targetSessionId===targetSessionId)return structuredClone(handoff);
    handoff.targetSessionId=targetSessionId;this.onChange(workspace);return structuredClone(handoff);
  }
  finishHandoff(workspace,operationId,targetSessionId){
    const state=this.state(workspace),handoff=state?.handoff;
    if(!state?.enabled||handoff?.operationId!==operationId||handoff.status!=='waiting'
      ||handoff.targetSessionId!==targetSessionId||!this.ownsSession(workspace,targetSessionId))
      throw Object.assign(new Error('Передача AutoPlan больше не действительна.'),{code:'ROTATION_HANDOFF_CONFLICT'});
    // The in-memory recipient is still NOT allowed to Send until settings.json
    // has durably recorded the transfer. A restart reads the saved state.
    this.handoffGuards.add(workspace);
    state.sessionId=targetSessionId;handoff.status='done';this.onChange(workspace);
  }
  releaseHandoff(workspace,operationId,targetSessionId){
    const h=this.state(workspace)?.handoff;
    if(h?.operationId!==operationId||h.status!=='done'||h.targetSessionId!==targetSessionId)
      throw Object.assign(new Error('Передача права продолжения изменилась.'),{code:'ROTATION_HANDOFF_CONFLICT'});
    this.handoffGuards.delete(workspace);
  }
  failHandoff(workspace,operationId,code='ROTATION_HANDOFF_FAILED'){
    const state=this.state(workspace),handoff=state?.handoff;
    if(!handoff||handoff.operationId!==operationId
      ||handoff.status!=='waiting'&&!(handoff.status==='done'&&this.handoffPending(workspace)))return false;
    this.handoffGuards.delete(workspace);
    handoff.status='failed';handoff.error=typeof code==='string'&&/^ROTATION_[A-Z_]+$/.test(code)?code:'ROTATION_HANDOFF_FAILED';
    state.sessionId=null;this.onChange(workspace);return true;
  }
  // Read-only with respect to permission: counting never toggles AutoPlan or
  // transfers its recipient. The caller must persist settings before relying
  // on this cursor to initiate a later session transition.
  recordTaskProof(workspace,sessionId,proof) {
    const state=this.state(workspace);
    if(!state||state.scopeId!==proof?.scopeId||state.projectId!==proof?.projectId
      ||state.executionStrategy==='parallel'||!this.ownsSession(workspace,sessionId)
      ||proof?.workspace!==workspace||proof?.sessionId!==sessionId)
      return { recorded:false, reason:'ROTATION_SCOPE_OR_SESSION_CHANGED' };
    const previous=this.checkpoint(workspace,state.scopeId,sessionId).chatTaskCursor??null;
    const result=advanceChatSessionTaskCounter(previous,proof);
    if(JSON.stringify(previous)!==JSON.stringify(result.cursor))
      this.saveCheckpoint(workspace,state.scopeId,sessionId,{chatTaskCursor:result.cursor});
    return { recorded:true,count:result.count,added:result.added };
  }
  snapshot(){return structuredClone(this.book);}
}
