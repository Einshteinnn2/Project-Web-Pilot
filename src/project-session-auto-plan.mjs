import { AutoPlan } from './auto-plan.mjs';
import { AutomationSendState } from './automation-send-state.mjs';
import { PlanMonitor } from './plan-monitor.mjs';
import { chatRotationDecision } from './chat-session-rotation.mjs';

// The same controller runs for visible and hidden main chats. Its sender,
// watcher, checkpoint and current plan always address its own saved identity.
export function configureProjectAutoPlan(record,{store,authorization,inspectPlan,onChange,log=()=>{},
  inspectTaskProof=null,taskLimit=null,onRotationReady=null}) {
  if(record.primaryAutomation||!record.identity||record.identity.assignmentId)return record.primaryAutomation;
  let monitor,flow;
  const selected=()=>{
    const project=record.project();if(!project)return null;
    const info=monitor?.view(project),authority=authorization.state(project.workspace);
    // A different chat's stale monitor cannot supersede project-level scope.
    return {...project,...info,scopeId:authority?.scopeId??info?.scopeId??null};
  };
  const permitted=p=>{
    const state=authorization.state(p.workspace);
    if(!state?.enabled||(state.projectId&&state.projectId!==p.projectId)
      ||!authorization.enabled(p.workspace,p.scopeId))return false;
    // An ON armed before the first scope belongs to the project, not to the
    // chat which happened to be selected when ON was clicked. Every main chat
    // may show WAIT; none can Send until a confirmed plan binds its origin.
    return !authorization.handoffPending?.(p.workspace)
      &&(state.awaitingPlan===true || state.sessionId===p.sessionId);
  };
  const save=patch=>{const project=selected();authorization.saveCheckpoint(project.workspace,project.scopeId,project.sessionId,patch);};
  const automation=new AutomationSendState({save:checkpoint=>save({automationCheckpoint:checkpoint})});
  const complete=()=>{const project=selected();authorization.sync(project.workspace,project.scopeId,
    {complete:true,confirmed:true,planRevision:project.planRevision});};
  const checkRotation=typeof inspectTaskProof==='function'&&typeof taskLimit==='function'
    ? async(p,plan)=>{
      if(p.experience!=='chat'||plan.planExecution?.execution_strategy!=='sequential')return {status:'continue'};
      if(automation.blocked(p))return {status:'wait',reason:'MANUAL_STOP'};
      const proof=await inspectTaskProof(p);
      if(proof?.confirmed!==true || proof.scopeId!==plan.scopeId || proof.planRevision!==plan.planRevision
        || proof.projectId!==p.projectId || proof.sessionId!==p.sessionId)
        return {status:'wait',reason:'ROTATION_PROOF_ERROR'};
      const result=authorization.recordTaskProof(p.workspace,p.sessionId,proof);
      if(result?.recorded!==true)return {status:'wait',reason:'ROTATION_PROOF_ERROR'};
      const decision=chatRotationDecision({selected:p,plan,count:result.count,limit:taskLimit(),
        blocked:automation.blocked(p)});
      if(decision.status!=='rotate')return decision;
      const boundary=authorization.checkpoint(p.workspace,p.scopeId,p.sessionId).chatTaskCursor?.counted?.at(-1)?.sha;
      return {...decision,boundary,count:result.count};
    }:null;
  flow=new AutoPlan({selected,inspectPlan,log,onChange,onComplete:complete,
    checkRotation,onRotation:onRotationReady,
    available:()=>{const p=selected();return !!p&&!p.archivedAt&&!p.sessionArchivedAt&&!record.disposed&&record.ready&&!record.loading
      &&!record.composer.inFlight&&!record.controller.pending&&permitted(p)&&!!monitor?.view(record.project())&&!monitor.error
      &&p.planExecution?.execution_strategy!=='parallel'&&['delivered','stale','manual-session'].includes(record.controller.state.phase);},
    saveCheckpoint:checkpoint=>save({autoPlanCheckpoint:checkpoint}),
    send:(text,canContinue,onBeforeSend)=>{
      // A manual new Chat or automatic handoff may revoke the old recipient
      // between Composer insertion and click; recheck authority at both gates.
      const ready=()=>canContinue()&&permitted(selected());
      const before=async()=>ready()&&await onBeforeSend()&&ready();
      return automation.send({selected:selected(),page:flow.page,kind:'plan',ready,
        perform:()=>record.composer.sendUserMessage({text,canContinue:ready,onBeforeSend:before,
          waitForAcknowledgement:false,cleanupOnCancel:true})});
    }});
  let savedScope;
  const update=()=>{
    const p=selected();if(!p)return;
    const enabled=permitted(p);
    if(savedScope!==p.scopeId) {savedScope=p.scopeId;const saved=authorization.checkpoint(p.workspace,p.scopeId,p.sessionId);
      automation.restore(saved.automationCheckpoint);flow.restore(enabled,saved.autoPlanCheckpoint);}
    else if(enabled!==flow.enabled) {if(enabled)void flow.start();else if(flow.state.phase!=='complete')flow.disable();}
    flow.availabilityChanged();
  };
  let refreshing=null,again=false;
  const changed=()=>{
    update();if(refreshing){again=true;return;}
    refreshing=(async()=>{do {again=false;const p=selected();if(!p)continue;
      try {const checked=await inspectPlan(p);
        if(record.disposed||record.project()?.sessionId!==p.sessionId)continue;
        const trusted=checked.confirmed===true&&checked.workspace===p.workspace
          &&checked.projectId===p.projectId&&typeof checked.scopeId==='string'&&!!checked.scopeId
          &&Number.isSafeInteger(checked.planRevision);
        if(trusted)authorization.sync(p.workspace,checked.scopeId,{confirmed:true,planRevision:checked.planRevision,
          originSessionId:checked.planExecution?.execution_origin_session_id??null,
          executionStrategy:checked.planExecution?.execution_strategy??null});
        const done=checked.confirmed&&checked.planView?.tasks?.length>0&&checked.planView.tasks.every(t=>t.status==='done');
        if(trusted&&done&&authorization.state(p.workspace)?.scopeId===checked.scopeId
          &&authorization.state(p.workspace)?.planRevision===checked.planRevision){
          flow.complete();authorization.sync(p.workspace,checked.scopeId,{complete:true,confirmed:true,planRevision:checked.planRevision});
        }
        else void flow.planChanged();
      }catch{void flow.planChanged();}
    }while(again&&!record.disposed);})().finally(()=>{refreshing=null;});
  };
  monitor=new PlanMonitor({selected:record.project,inspect:(workspace,id)=>store.inspect(workspace,id),onChange:()=>{changed();onChange();},
    onInputsChanged:()=>record.controller.projectChanged(),onError:()=>{onChange();}});
  record.primaryAutomation={flow,automation,monitor,update,changed,observe:event=>{update();automation.observe(selected(),event);flow.observe(event);}};
  const p=selected(),saved=authorization.checkpoint(p.workspace,p.scopeId,p.sessionId);
  automation.restore(saved.automationCheckpoint);flow.restore(permitted(p),saved.autoPlanCheckpoint);
  monitor.observeSelection();
  record.cleanups.push(()=>{flow.dispose();monitor.close();});return record.primaryAutomation;
}
