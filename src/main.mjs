import { ProjectAutoPlan } from './project-auto-plan.mjs';
import { configureProjectAutoPlan } from './project-session-auto-plan.mjs';
import { AutoPlan } from './auto-plan.mjs';
import { PlanReviewClient } from './plan-review.mjs';
import { ReviewContinuation } from './review-continuation.mjs';
import { AutomationSendState } from './automation-send-state.mjs';
import { readAutoPlanState, reviewBlocksExecution } from './auto-plan-state.mjs';
import { connectPageState } from './page-state-bridge.mjs';
import { PlanMonitor } from './plan-monitor.mjs';
import { chatGPTTitleScript } from './chatgpt-title.mjs';
import { toolFilterScript } from './chatgpt-tool-filter.mjs';
import { app, BaseWindow, BrowserWindow, WebContentsView, Menu, session, ipcMain, dialog, nativeTheme, clipboard, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WorkspaceSessions, normalizeChatUrl, activeSessionsNewestFirst } from './workspace-session.mjs';
import { DEFAULT_PARALLEL_SETTINGS, validateParallelSettings } from './parallel-settings.mjs';
import { installChatGPTAutoScroll } from './chatgpt-auto-scroll.mjs';
import { ChatColors, normalizeChatColors, validateColorChange, DEFAULT_COLORS } from './chatgpt-colors.mjs';
import { ChatColorsWindow } from './chat-colors-window.mjs';
import { ContextCache } from './context-cache.mjs';
import { readinessContextKey } from './context-inputs.mjs';
const contextCache = new ContextCache({ load: workspace => runtime.loadContext(workspace),
  inputKey: workspace => readinessContextKey(workspaceSetup, workspace), onChange: () => publish() });
import { SessionPlans } from './session-plans.mjs';
import { externalClientLine } from './context-session.mjs';
import { SessionRuntimes } from './session-runtime.mjs';
import { sessionRuntimeKey } from './session-runtime.mjs';
import { ParallelExecution } from './parallel-execution.mjs';
import { ParallelKit } from './parallel-kit.mjs';
import {readCommandActivity,acknowledgeUnknownCommand} from './command-activity.mjs';
import { ProjectInputWatch, ChildCommandWatches } from './project-input-watch.mjs';
import { configureExecutor,executorPageState } from './executor-session.mjs';
import { projectExecutors } from './execution-projection.mjs';
import { chatGPTEntrypoint, CHATGPT_SIGNIN_ENTRYPOINT } from './chatgpt-experience.mjs';
import { WorkspaceDeletion } from './workspace-deletion.mjs';
import { removeProjectSettings, pruneOrphanProjectSettings, belongsToProject, queueProjectStatePurge } from './project-state-cleanup.mjs';
import { appendDiagnostic } from './common.mjs';
import { WorkspaceSetup } from './workspace-setup.mjs';
import { ProjectDoctor } from './project-doctor.mjs';
import { ChromiumDiagnostics, safeUrl } from './chromium-diagnostics.mjs';
import { openStartupPage } from './browser-startup.mjs';
import { BUNDLED_NODE_VERSION, defaultRuntimeFolder, legacyWindowsStateFolder, bundledMacNode, nodeExecutableCandidates } from './platform.mjs';
import { WindowsExecutorBootstrap, WINDOWS_RUNTIME_ARCHIVE } from './windows-runtime.mjs';
import { CodexAppServerRuntime, MacRuntimeSwitcher, runtimeLabel, CHATGPT_CHANNEL_SECURE, CHATGPT_CHANNELS } from './mac-runtime-switch.mjs';
import { VpsTunnel, WindowsVpsTunnel } from './vps-tunnel.mjs';
import { TunnelClipboard } from './tunnel-clipboard.mjs';
import { StartupReadiness, inspectMacGit, installMacGit, offerMacInstallation } from './startup-readiness.mjs';
import { startupPlatformOptions, startupSupported } from './startup-platform.mjs';

const eventBaseline = !app.isPackaged && process.argv.includes('--event-runtime-baseline');
const eventRuntimeChecker = !app.isPackaged && process.argv.includes('--event-runtime-checker');
const smoke = !app.isPackaged && (process.argv.includes('--smoke') || eventBaseline);
const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const sidebarUrl = pathToFileURL(path.join(sourceDir, 'ui/index.html')).href;
const archiveUrl = pathToFileURL(path.join(sourceDir, 'ui/archive.html')).href;
app.setName('Project Web Pilot');
app.setPath('userData', smoke ? fs.mkdtempSync(path.join(os.tmpdir(), 'web-pilot-electron-smoke-'))
  : path.join(app.getPath('appData'), 'Project Web Pilot'));
const dataDir = app.getPath('userData');
const settingsFile = path.join(dataDir, 'settings.json');
const chromiumDiagnosticsFile = path.join(dataDir, 'diagnostics', 'chromium-events.jsonl');
let parallelExecution = { ...DEFAULT_PARALLEL_SETTINGS };
let parallelExecutionBook = {};
const store = new WorkspaceSessions(path.join(dataDir, 'workspaces.json'), { getExecutionSettings: () => parallelExecution });
const planMonitor = new PlanMonitor({ selected: () => store.selected(),
  inspect: (workspace, sessionId) => store.inspect(workspace, sessionId), onChange: (_info, change) => {
    publish();
    if (change?.semanticChanged || change?.recovered) void autoPlan.planChanged().catch(report);
    if (change?.semanticChanged && !pageLoading && !setupState && !settingsState) void controller?.tick();
  }, onInputsChanged: () => {
    planReview.refresh();
    if (!pageLoading && !setupState && !settingsState) controller?.projectChanged();
  }, onError: () => publish() });
const partition = smoke ? 'web-pilot-smoke' : 'persist:chatgpt';
// State of the Codex App Server executor, the local MCP backend of both systems.
const runtimeFolder = defaultRuntimeFolder(os.homedir(), process.platform);
// What the runtime before the executor left behind (macOS before 0.6.91, Windows before 0.6.96) is removed once;
// until then the folders that earlier versions recorded in the settings are remembered.
const legacyRetiredSetting = process.platform === 'win32' ? 'legacyWindowsRuntimeRetired' : 'legacyMacRuntimeRetired';
let legacyRuntimeRetired = false, legacyRuntimeRoots = [];
let chatgptChannel = CHATGPT_CHANNEL_SECURE;
let appServerRuntime = null, runtimeSwitcher = null, runtimeActivation = null, vpsTunnel = null;
let shellTheme = 'light';
let hideToolCalls = true;
const projectAutoPlan=new ProjectAutoPlan({identity:workspace=>store.snapshot().projects.find(p=>p.workspace===workspace)?.projectId,
  ownsSession:(workspace,id)=>store.snapshot().projects.some(p=>p.workspace===workspace&&p.sessions.some(s=>s.sessionId===id)),onChange:workspace=>{
  for(const record of liveSessions.records.values()) {
    const project=record.project();
    if((project?.parentWorkspace??project?.workspace)!==workspace)continue;
    record.primaryAutomation?.update();
    if(record.executor){record.executor.setEnabled(projectAutoPlan.enabled(workspace,project.parentScopeId));record.controller.signal();}
  }
  void saveSettings().catch(report);void execution.signal(workspace);publish();
}});
let reviewCheckpoint = null, automationCheckpoint = null;
let chatColors = normalizeChatColors();
let chatColorStyles, colorEditor;
let settingsSaveTail = Promise.resolve();
const SIDEBAR_MIN_WIDTH = 312;
const BROWSER_MIN_WIDTH = 600;
let sidebarWidth = SIDEBAR_MIN_WIDTH;
let projectsParent = null;
let window, browser, sidebar, archiveWindow, runtime, controller, fixture, chromiumDiagnostics, windowsBootstrap;
let eventRuntimeCheckerTimer = null, lastEventRuntimeCheckerMismatch = '';
let sidebarReady = false, lastSidebarStateSignature = null;
let navigationId = 0;
const runtimeMetrics = {
  executeJavaScript: 0, ipcSnapshots: 0, workerNodeStarts: 0,
  reset() { this.executeJavaScript = 0; this.ipcSnapshots = 0; this.workerNodeStarts = 0; },
  snapshot() { return { executeJavaScript: this.executeJavaScript, ipcSnapshots: this.ipcSnapshots, workerNodeStarts: this.workerNodeStarts }; },
};
const actionContext = new AsyncLocalStorage();
let pageLoading = false;
let startupClipboard = null;
let startupFlow = null, startupActive = false;
let startupError = null;
let storageError = false;
let lastDiagnostic = '';
let actionTail = Promise.resolve();
const titleSyncSuccess = new Map();
const titleSyncPending = new Map();
const windowsPortableNode = process.platform === 'win32'
  ? (app.isPackaged
      ? path.join(process.resourcesPath, 'windows-node', `node-v${BUNDLED_NODE_VERSION}-win-x64`, 'node.exe')
      : path.join(sourceDir, `../.harness/runtime/windows-node/node-v${BUNDLED_NODE_VERSION}-win-x64/node.exe`))
  : null;
const workspaceSetup = new WorkspaceSetup({
  resourceDir: app.isPackaged ? path.join(process.resourcesPath, 'resources') : path.join(sourceDir, '../resources'),
  nodeCandidates: windowsPortableNode
    ? [windowsPortableNode, ...nodeExecutableCandidates({ platform: 'win32', environment: process.env, electron: true })]
    : process.platform === 'darwin'
      ? [bundledMacNode(app.isPackaged ? process.resourcesPath : path.join(sourceDir, '../.harness/runtime')), ...nodeExecutableCandidates()]
      : undefined,
  // Workflow Kit needs only the Git of the package: the tools are unpacked without starting any service.
  prepareEnvironment: process.platform === 'win32' && !smoke ? async () => {
    await windowsBootstrap.ensureTools();
    return windowsBootstrap.workflowEnvironment();
  } : undefined,
  onWorkerStart: () => { if (eventBaseline) runtimeMetrics.workerNodeStarts++; },
});
const sessionPlans = new SessionPlans({ setup: workspaceSetup,
  onWorkerStart: () => { if (eventBaseline) runtimeMetrics.workerNodeStarts++; } });
store.planService = sessionPlans;
// Agent time: wall clock while ChatGPT shows its Stop control; each finished request is added to its own session.
let agentTimer, pageState, conversationRecovery;
function observeManualConversation(state, record = liveSessions.visible) {
  const selected = record?.project(), documentId = record?.pageState.current?.documentId;
  if (!selected || selected.chatUrl || !documentId) return false;
  if (!record.manualDocumentOwner && /^https:\/\/chatgpt\.com\/(?:work\/?)?$/.test(state.url) && state.userMessageCount === 0) {
    record.manualDocumentOwner = { documentId, workspace: selected.workspace, sessionId: selected.sessionId, generation: record.epoch, binding: false };
  }
  const owner = record.manualDocumentOwner;
  if (!owner || owner.documentId !== documentId || owner.workspace !== selected.workspace
      || owner.sessionId !== selected.sessionId || owner.generation !== record.epoch || !state.manualSendRevision) return false;
  const ownRecovery = selected.attempt?.state === 'sent' || selected.attempt?.sendStartedAtMs;
  if (ownRecovery) return false;
  const url = normalizeChatUrl(state.url);
  record.controller.cancel();
  if (!url || owner.binding) return true;
  owner.binding = true;
  void store.bindChat(owner.workspace, owner.sessionId, url, { manual: true, background: true }).then(() => {
    if (record.manualDocumentOwner !== owner || record.disposed || record.epoch !== owner.generation) return;
    liveSessions.tick(record); publish();
    if(record===liveSessions.visible)void syncSelectedSessionTitle({ force: true, reason: 'manual-chat-bound' });
  }, error => { if (record.manualDocumentOwner === owner) { owner.binding = false; sessionRuntimeError(record,error); } });
  return true;
}
const automationSend = new AutomationSendState({save:async checkpoint=>{
  automationCheckpoint=checkpoint;await saveSettings({automationCheckpoint});
}});
function sendAutomation(text,canContinue,onBeforeSend,flow) {
  const sender=liveSessions.visible?.primaryAutomation?.automation??automationSend;
  return sender.send({selected:flow.selected(),page:flow.page,ready:canContinue,kind:flow===autoPlan?'plan':'review',
    perform:()=>controller.composer.sendUserMessage({text,canContinue,onBeforeSend,waitForAcknowledgement:false,cleanupOnCancel:true})});
}
const emptyAutoPlan=new AutoPlan({selected:()=>null,inspectPlan:async()=>({}),send:async()=>({})});
const autoPlan=new Proxy({}, {
  get:(_target,key)=>{const flow=liveSessions.visible?.primaryAutomation?.flow??emptyAutoPlan,value=flow[key];return typeof value==='function'?value.bind(flow):value;},
  set:(_target,key,value)=>{(liveSessions.visible?.primaryAutomation?.flow??emptyAutoPlan)[key]=value;return true;}
});
function configurePrimary(record) {
  return configureProjectAutoPlan(record,{store,authorization:projectAutoPlan,
    inspectPlan:selected=>readAutoPlanState(selected,workspaceSetup.environment),onChange:()=>publish(),
    log:(event,fields)=>record.diagnostics?.log.record('auto-plan',event,fields)});
}
const planReview = new PlanReviewClient({selected:()=>store.selected(),onChange:()=>publish()});
const reviewContinuation=new ReviewContinuation({selected:()=>store.selected(),client:planReview,
  send:sendAutomation,onChange:()=>publish(),
  available:()=>!!controller && !controller.composer.inFlight && !pageLoading && !setupState && !settingsState
    && workspaceHealth?.ready && workspaceHealth.workspace===store.selected()?.workspace,
  saveCheckpoint:async checkpoint=>{reviewCheckpoint=checkpoint;await saveSettings({reviewCheckpoint});}});
function applyObservedPage(event, record = liveSessions.visible) {
  if(!record||record.disposed)return;
  const visible=record===liveSessions.visible;
  if(visible) {
    automationSend.observe(record.project(),event);
    if(!event.reset)observeStartupAccount(event.state);
    if(!record.identity?.assignmentId) reviewContinuation.observe(event);
  }
  if(!event.reset) {
    record.diagnostics?.observePage(event.state);
    if(!record.loading)observeManualConversation(event.state,record);
  }
  record.primaryAutomation?.observe(event);
  record.executor?.observe(event);
  const safety=JSON.stringify([event.documentId,event.state?.url,event.state?.busy,event.state?.lastMessageRole,event.state?.connectionError,
    event.state?.draftPresent,event.state?.editorAvailable,event.state?.writable,event.state?.turnId,event.state?.userTurnId,
    event.state?.assistantRevision,event.state?.userMessagesRevision,event.state?.manualInputRevision,
    event.state?.manualStopRevision,event.state?.manualSendRevision]);
  if(record.identity&&!record.identity.assignmentId&&execution.unwatch.has(record.identity.workspace)&&record.executionSafety!==safety) {
    record.executionSafety=safety;void execution.signal(record.identity.workspace);
  }
  publish();
}
function sessionRuntimeError(record,error) {
  record.error=publicError(error);
  if(record===liveSessions.visible&&!settingsState&&!setupState)report(error);else publish();
}
const liveSessions = new SessionRuntimes({store,runtime:()=>runtime,contextCache,ipc:ipcMain,connectPageState,
  createView:()=>new WebContentsView({webPreferences:{...remotePreferences(),backgroundThrottling:false,
    preload:app.isPackaged?path.join(process.resourcesPath,'resources/chatgpt-page-observer-preload.cjs')
      :path.join(sourceDir,'../resources/chatgpt-page-observer-preload.cjs')}}),
  onChange:record=>{
    if(record===liveSessions.visible)pageLoading=record.loading;record.primaryAutomation?.update();record.executor?.changed();
    if(record.identity&&!record.identity.assignmentId&&execution.unwatch.has(record.identity.workspace)) {
      const stopped=executorPageState(record).stopped;
      if(record.executionStopped!==stopped){record.executionStopped=stopped;void execution.signal(record.identity.workspace);}
    }
    publish();
  },
  onChatBound:record=>{if(record===liveSessions.visible)void syncSelectedSessionTitle({force:true,reason:'chat-bound'});},
  onPage:(record,event)=>applyObservedPage(event,record),onError:sessionRuntimeError,decorate:decorateSessionRuntime});
const executionKit=new ParallelKit({plans:sessionPlans,setup:workspaceSetup});
// The parallel queue has the authoritative Kit confirmation; per-chat plan
// projections must not bind a pre-plan ON while review/transaction is pending.
const authorizedExecutionKit=Object.create(executionKit);
authorizedExecutionKit.read=async workspace=>{
  const facts=await executionKit.read(workspace),plan=facts.plan;
  if(plan.execution_strategy==='parallel'&&facts.confirmed&&plan.execution_scope_status==='ACTIVE')
    projectAutoPlan.sync(workspace,plan.scope_id,{confirmed:true,planRevision:plan.plan_revision,
      originSessionId:plan.execution_origin_session_id});
  return facts;
};
store.git=(workspace,args)=>executionKit.git(workspace,['--no-optional-locks',...args]);
const liveRecord=project=>project&&liveSessions.records.get(sessionRuntimeKey(project));
async function restoreExecutionPage(project,assignment=null) {
  if(liveRecord(project)?.ready&&(!assignment||liveRecord(project).executor))return project;
  if(!project?.chatUrl||(!project.manualStart&&!project.attempt?.sendStartedAtMs&&!['sent','acknowledged'].includes(project.attempt?.state)))
    throw Object.assign(new Error('Сохранённый адрес и отправка не подтверждены. Откройте соответствующий чат и проверьте его; автоматического Send нет.'),{code:'EXECUTOR_CHAT_UNKNOWN'});
  const record=liveSessions.ensure(project);
  if(assignment)configureExecutor(record,{store,enabled:projectAutoPlan.enabled(project.parentWorkspace??project.workspace,project.parentScopeId??project.scopeId),
    inspectPlan:selected=>readAutoPlanState(selected,workspaceSetup.environment),onChange:()=>publish(),
    signal:()=>{void execution.signal(project.parentWorkspace);},
    log:(event,fields)=>record.diagnostics?.log.record('auto-plan',event,fields)});
  if(!record.ready){record.ready=true;await liveSessions.navigate(record,project.chatUrl);}
  return project;
}
const execution=new ParallelExecution({kit:authorizedExecutionKit,book:parallelExecutionBook,
  isEnabled:(workspace,scope)=>projectAutoPlan.enabled(workspace,scope),
  canFinalize:(workspace,scope)=>projectAutoPlan.finalizationAllowed(workspace,scope),
  onComplete:(workspace,scope)=>projectAutoPlan.sync(workspace,scope,{complete:true,confirmed:true}),
  origin:(workspace,id)=>store.project(workspace,id),
  save:async book=>{parallelExecutionBook=book;await saveSettings({parallelExecutionBook:book});},
  onChange:()=>{
    for(const [workspace,watcher] of execution.unwatch){
      watcher.refreshAssignments?.();
    }
    for(const state of execution.states.values())for(const assignment of state.assignments??[])if(assignment.status==='INTEGRATED') {
      const record=liveRecord(store.project(assignment.worktree));
      if(record){record.integrated=true;record.executor?.clock.observe('done');}
    }
    publish();
  },
  watch:(workspace,signal)=>{
    const onError=error=>{if(error)execution.publish(workspace,{phase:'attention',error});};
    const watcher=new ProjectInputWatch({workspace,onSignal:signal,onError});
    const children=new ChildCommandWatches({onSignal:signal,onError});
    const refreshAssignments=()=>{
      const state=execution.view(workspace),origin=store.project(workspace,state.originSessionId);
      // No worktree path from an unconfirmed/foreign assignment is watched.
      children.update((state.assignments??[]).filter(a=>{
        if(a.status==='INTEGRATED'||a.status==='UNKNOWN'||!a.worktree||!origin)return false;
        const child=store.project(a.worktree);
        return child?.assignmentId===a.id&&child.parentWorkspace===workspace
          &&child.parentProjectId===origin.projectId&&child.parentScopeId===state.scopeId
          &&child.executionOriginSessionId===origin.sessionId&&!child.archivedAt;
      }).map(a=>a.worktree));
    };
    watcher.update(['.harness/runtime/command-activity/']);
    const stop=()=>{watcher.close();children.close();};
    stop.update=paths=>{watcher.update(['.harness/runtime/command-activity/',...(paths??[])]);refreshAssignments();};
    stop.refreshAssignments=refreshAssignments;return stop;
  },
  mainState:origin=>{
    const record=liveRecord(origin),page=record?.pageState.current;
    return {...executorPageState(record),documentId:page?.documentId??null,
      lastMessageRole:page?.state?.lastMessageRole??null,
      userMessagesRevision:page?.state?.userMessagesRevision??null,
      manualInputRevision:page?.state?.manualInputRevision??0,
      manualStopRevision:page?.state?.manualStopRevision??0};
  },
  workerState:(assignment,entry)=>executorPageState(liveRecord(store.project(assignment.worktree,entry?.sessionId))),
  restoreOrigin:origin=>restoreExecutionPage(origin),
  restoreWorker:async(assignment,origin,entry,recovery)=>{
    if(!assignment.worktree)return null;
    const project=store.project(assignment.worktree,entry?.sessionId);
    if(!project) {
      if(entry?.sessionId||entry?.phase==='opening'||['RUNNING','READY_FOR_INTEGRATION'].includes(assignment.status))
        throw Object.assign(new Error('Не найдена сохранённая сессия назначения. Проверьте worktree и чат; новая сессия автоматически не создаётся.'),{code:'EXECUTOR_SESSION_MISSING'});
      return null;
    }
    if(project.assignmentId!==assignment.id||project.taskId!==assignment.parent_task_id||project.parentScopeId!==assignment.parent_scope_id
      ||project.executionOriginSessionId!==origin.sessionId||project.parentWorkspace!==origin.workspace||project.parentProjectId!==origin.projectId||project.archivedAt||project.sessionArchivedAt)
      throw Object.assign(new Error('Сессия не соответствует назначению Kit. Откройте её для проверки.'),{code:'EXECUTOR_SESSION_MISMATCH'});
    const restored=await restoreExecutionPage(project,assignment);
    if(recovery)await liveRecord(restored)?.controller.resumePreparation();
    return restored;
  },
  openWorker:async(assignment,origin)=>{
    const project=await store.ensureExecutor(assignment,origin),record=liveSessions.ensure(project);
    configureExecutor(record,{store,enabled:projectAutoPlan.enabled(project.parentWorkspace??project.workspace,project.parentScopeId??project.scopeId),
      inspectPlan:selected=>readAutoPlanState(selected,workspaceSetup.environment),onChange:()=>publish(),
      signal:()=>{void execution.signal(origin.workspace);},
      log:(event,fields)=>record.diagnostics?.log.record('auto-plan',event,fields)});
    record.ready=true;
    await liveSessions.navigate(record,project.chatUrl??chatGPTEntrypoint(project.experience),{freshDraft:!project.attempt&&!project.chatUrl});
    publish();return project;
  },
  sendCorrection:(origin,text,canContinue,onBeforeSend)=>sendExecutionMessage(origin,text,canContinue,onBeforeSend,'correction'),
  sendDiagnostic:(origin,text,canContinue,onBeforeSend)=>sendExecutionMessage(origin,text,canContinue,onBeforeSend,'diagnostic'),
  sendFinalization:(origin,text,canContinue,onBeforeSend)=>sendExecutionMessage(origin,text,canContinue,onBeforeSend,'finalization')});
function sendExecutionMessage(origin,text,canContinue,onBeforeSend,kind) {
  const record=liveRecord(origin),sender=record?.primaryAutomation?.automation;
  if(!sender)return Promise.resolve({state:'cancelled',reason:'PAGE_NOT_READY'});
  return sender.send({selected:origin,page:record.pageState.current?.state,kind,ready:canContinue,
    perform:()=>record.composer.sendUserMessage({text,canContinue,onBeforeSend,waitForAcknowledgement:false,cleanupOnCancel:true})});
}
let setupState = null;
let workspaceHealth = null;
let settingsState = null;
let doctorState = null;
const projectDoctor = new ProjectDoctor({ setup: workspaceSetup, ensureServices: () => runtime.ensure() });
let archiveState = { deletion: null, notice: null, focusWorkspace: null };
let deletion;
const shellBackground = { light: '#f4f6f8', dark: '#1b1d22' };

function applyShellTheme(theme) {
  shellTheme = theme === 'dark' ? 'dark' : 'light';
  nativeTheme.themeSource = shellTheme;
  colorEditor?.publish();
  if (window && !window.isDestroyed()) window.setBackgroundColor(shellBackground[shellTheme]);
}

async function applyToolCallVisibility(view = browser) {
  if (!view || view.webContents.isDestroyed()) return;
  const url = view.webContents.getURL();
  if (!url.startsWith('https://chatgpt.com/')) return;
  await view.webContents.executeJavaScript(toolFilterScript(hideToolCalls), true).catch(() => {});
}

function saveSettings(overrides = {}) {
  // macRuntimeMode is no longer read: it only lets 0.6.90 open on the same backend after a rollback.
  const platformSettings = {
    ...(process.platform === 'darwin' ? { macRuntimeMode: 'app-server' } : {}),
    [legacyRetiredSetting]: legacyRuntimeRetired, ...(legacyRuntimeRetired ? {} : { legacyRuntimeRoots }),
  };
  const settings = { ...platformSettings, chatgptChannel, shellTheme, hideToolCalls, sidebarWidth, chatColors, projectsParent, projectAutoPlan:projectAutoPlan.snapshot(), reviewCheckpoint, automationCheckpoint, parallelExecution, parallelExecutionBook, ...overrides };
  const operation = settingsSaveTail.catch(() => {}).then(async () => {
    await fsp.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(settingsFile + '.tmp', JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    await fsp.rename(settingsFile + '.tmp', settingsFile);
  });
  settingsSaveTail = operation;
  return operation;
}

async function prepareProjectRemoval(job) {
  const workspaces=[job.workspace,...(job.related??[]).map(p=>p.workspace)];
  const records=[...liveSessions.records.values()].filter(r=>workspaces.includes(r.identity?.workspace));
  for(const record of records)if(record.pageState.current?.state.busy||record.controller.pending||record.composer.inFlight)
    throw Object.assign(new Error('Остановите работу чатов удаляемого проекта перед удалением.'),{code:'DELETE_PROJECT_BUSY'});
  for(const workspace of workspaces)await execution.suspend(workspace);
  for(const workspace of workspaces) {
    const activity=await readCommandActivity(workspace),command=activity.commands.find(c=>c.blocksDeletion);
    if(command)throw Object.assign(new Error('Удаление ожидает завершения операции '+command.id+'. '+command.reason+
      '. Для сервера попросите агента остановить его по session ID; неизвестный исход требует диагностики.'),{code:'DELETE_PROJECT_BUSY'});
  }
  job.sessionIds=[...new Set([...(job.sessionIds??[]),...records.map(r=>r.diagnostics?.log.sessionId).filter(Boolean)])];
  for(const record of records)await record.diagnostics?.stop();
  for(const record of records)if(!liveSessions.release(record))
    throw Object.assign(new Error('Чат ещё занят. Повторите удаление после остановки.'),{code:'DELETE_PROJECT_BUSY'});
  await store.mutationTail;
  await settingsSaveTail;
}
async function cleanupDeletedProject(job) {
  const identities=[{workspace:job.workspace,projectId:job.projectId,sessionIds:job.sessionIds??[]},...(job.related??[])];
  const cleaned=removeProjectSettings({projectAutoPlan:projectAutoPlan.snapshot(),parallelExecutionBook,reviewCheckpoint,automationCheckpoint},identities);
  projectAutoPlan.book=cleaned.projectAutoPlan;parallelExecutionBook=cleaned.parallelExecutionBook;execution.book=parallelExecutionBook;
  reviewCheckpoint=cleaned.reviewCheckpoint;automationCheckpoint=cleaned.automationCheckpoint;
  execution.forget(identities.map(p=>p.workspace));
  for(const book of [automationSend.entries,automationSend.cycles,reviewContinuation.flow.checkpoints,reviewContinuation.flow.cycles,reviewContinuation.stops])
    for(const [key,value] of book)if(belongsToProject([key,value],identities))book.delete(key);
  contextCache.clear();workspaceSetup.invalidateReadiness();
  if(identities.some(p=>p.workspace===workspaceHealth?.workspace))workspaceHealth=null;
  await saveSettings();
}

async function setChatColors(colors) {
  chatColors = normalizeChatColors(colors);
  const apply = Promise.all([...liveSessions.records.values()].map(record=>record.colors.set(chatColors)));
  const save = saveSettings();
  await Promise.all([apply, save]);
}

function openSettings(workspace = null) {
  workspace ??= setupState?.workspace ?? store.selected()?.workspace ?? null;
  if (doctorState?.workspace !== workspace) doctorState = { workspace, phase: 'idle' };
  pauseForSetup(); workspaceSetup.clear(); setupState = null; deletion.clear();
  settingsState = { workspace };
}
function closeSettings() {
  deletion.clear(); settingsState = null; startupError = null;
  const current = store.landing(); if (current) void selectWorkspace(current.workspace, { resume: true }).catch(report);
  else if (startupFlow) { startupActive = true; void navigate(null); }
}

function publicError(error) { return { code: error.code ?? 'APP_ERROR', message: String(error.message ?? error).slice(0, 700) }; }
function projectedArchives() {
  return store.snapshot().projects.filter(project => project.archivedAt&&!project.parentWorkspace).map(({ workspace, projectId, name, displayName, archivedAt, sessions }) => ({
    workspace, projectId, name: displayName || name, archivedAt, sessionCount: sessions.length, deletionPending: deletion?.isPending(workspace) ?? false,
  }));
}
function projectedSessionArchives() {
  return store.snapshot().projects.filter(project => !project.archivedAt&&!project.parentWorkspace).flatMap(project => project.sessions
    .filter(session => session.archivedAt)
    .map((session, index) => ({ workspace: project.workspace, projectId: project.projectId, projectName: project.displayName || project.name,
      sessionId: session.sessionId, title: session.title || `Сессия ${index + 1}`, experience: session.experience,
      chatUrl: session.chatUrl, archivedAt: session.archivedAt, createdAt: session.createdAt })));
}
function archiveSnapshot() {
  return { archives: projectedArchives(), sessionArchives: projectedSessionArchives(), deletion: archiveState.deletion, notice: archiveState.notice,
    focusWorkspace: archiveState.focusWorkspace, theme: shellTheme, fixture: smoke };
}
function publishArchive() {
  if (archiveWindow && !archiveWindow.isDestroyed() && !archiveWindow.webContents.isDestroyed())
    archiveWindow.webContents.send('pilot-archive:state-changed', archiveSnapshot());
}
function snapshot() {
  const saved = store.selected();
  const projects=store.snapshot().projects;
  const info = planMonitor.view(saved, controller?.state.projectInfo);
  const selected = saved && { ...saved, attempt: saved.attempt && { protocol: saved.attempt.protocol,
    requestId: saved.attempt.requestId, state: saved.attempt.state }, receipt: undefined,
    ...(info?.workspace === saved.workspace && info.inspectedSessionId === saved.sessionId ? info : {}),
    planReadError: planMonitor.error ?? planMonitor.watchError, agentRun: agentTimer?.view(saved) ?? null };
  return { projects: projects.filter(p => !p.archivedAt&&!p.parentWorkspace)
    .map(({ workspace, projectId, name, displayName, selectedSessionId, expanded, sessions }) => ({
    workspace, projectId, name: displayName || name, selectedSessionId, expanded,
    activity:[...liveSessions.records.values()].some(r=>(r.identity?.workspace===workspace
      ||store.project(r.identity?.workspace)?.parentWorkspace===workspace)&&r.pageState.current?.state.busy)?'working'
      :execution.view(workspace).error||sessions.some(s=>liveRecord({workspace,sessionId:s.sessionId})?.controller.state.error)?'attention':'idle',
    executors:projectExecutors(projects,workspace,execution.view(workspace),liveRecord),
    sessions: activeSessionsNewestFirst(sessions).map(({ sessionId, experience, chatUrl, title, createdAt }) => ({ sessionId, experience, chatUrl, title, createdAt })),
  })),
    executorRecovery:projects.filter(p=>p.parentWorkspace&&!projects.some(parent=>parent.workspace===p.parentWorkspace&&parent.projectId===p.parentProjectId))
      .map(p=>({workspace:p.workspace,projectId:p.projectId,name:p.displayName||p.name,
        message:'Связь с родителем не подтверждена. Для отсутствующих папок можно убрать только локальную запись. Облачные чаты ChatGPT сохраняются.'})),
    archives: projectedArchives(), settings: settingsState, doctor: doctorState, parallelExecution: { ...parallelExecution },
    execution: {...execution.view(saved?.parentWorkspace??saved?.workspace),commands:(execution.view(saved?.parentWorkspace??saved?.workspace).commands??[])
      .map(c=>({...c,projectId:store.project(c.workspace)?.projectId}))},
    conversationRecovery: conversationRecovery?.view() ?? { phase: 'idle', message: '', canRetry: false },
    autoPlan: {...(liveSessions.visible?.executor?.flow.view()??autoPlan.view()),
      enabled:projectAutoPlan.enabled(saved?.parentWorkspace??saved?.workspace,saved?.parentScopeId??info?.scopeId??saved?.scopeId)
        ||projectAutoPlan.enabled(saved?.parentWorkspace??saved?.workspace,null)},
    planReview: {...planReview.view(),...(reviewContinuation.persistenceError?{message:reviewContinuation.flow.state.message,indicator:'attention'}: {})},
    selected, context: controller?.state ?? { phase: 'selected', servicesReady: false, messageSent: false },
    contextPreparation: { busy: selected ? contextCache.isBuilding(selected.workspace) : false },
    runtimeFolder, platform: process.platform,
    // The same view on both systems: the executor, the selected ChatGPT channel and the state of its services.
    localRuntime: {
      label: runtimeLabel(),
      chatgptChannel,
      service: runtime?.lastStatus ? {
        mcpReady: !!runtime.lastStatus.mcp?.ready,
        tunnelReady: !!runtime.lastStatus.tunnel?.ready,
        tunnelConfigured: !!runtime.lastStatus.tunnel?.configured,
      } : null,
      vps: vpsView(runtime?.lastStatus?.vps),
    },
    startup: startupFlow ? { ...startupFlow.snapshot(), clipboard: startupClipboard?.snapshot(), active: startupActive } : null,
    theme: shellTheme, hideToolCalls, sidebarWidth, sidebarMinWidth: SIDEBAR_MIN_WIDTH, pageLoading, startupError, storageError, setup: setupState, workspaceHealth, version: app.getVersion(), fixture: smoke };
}

function publish() {
  planMonitor.observeSelection();
  planReview.observeSelection();
  reviewContinuation.update();
  autoPlan.selectionChanged();
  autoPlan.availabilityChanged();
  observeStartupClipboard();
  rememberSessionTitle();
  rememberScopeTitle();
  const state = snapshot();
  if (sidebarReady && sidebar && !sidebar.webContents.isDestroyed()) {
    const signature = JSON.stringify(state);
    if (signature !== lastSidebarStateSignature) {
      lastSidebarStateSignature = signature;
      if (eventBaseline) runtimeMetrics.ipcSnapshots++;
      sidebar.webContents.send('pilot:state-changed', state);
    }
  }
  publishArchive();
  const record = { phase: state.context.phase, workspace: state.selected?.workspace, sessionId: state.selected?.sessionId,
    requestId: state.selected?.attempt?.requestId, contextSha256: state.context.delivery?.contextSha256,
    planRevision: state.context.projectInfo?.planRevision, errorCode: state.context.error?.code ?? startupError?.code,
    appVersion: app.getVersion(), page: state.startup?.page, pageError: state.startup?.pageError };
  const signature = JSON.stringify(record);
  if (signature !== lastDiagnostic) {
    lastDiagnostic = signature;
    fsp.mkdir(dataDir, { recursive: true, mode: 0o700 })
      .then(() => appendDiagnostic(path.join(dataDir, 'diagnostics.jsonl'), JSON.stringify({ at: new Date().toISOString(), fixture: smoke, ...record }) + '\n'))
      .catch(() => {});
  }
}


function checkEventRuntimeState() {
  if (!eventRuntimeChecker || !chromiumDiagnostics || pageLoading || planMonitor.pending || planMonitor.rerunRequested
      || controller?.pending || controller?.rerunRequested || controller?.inputsChanged) return;
  const generation = navigationId;
  const selected = store.selected();
  const mismatches = [];
  const card = selected ? planMonitor.view(selected) : null;
  const context = controller?.state?.projectInfo ?? null;
  if (selected && controller?.active?.workspace === selected.workspace && controller.active.sessionId === selected.sessionId
      && card && context) {
    for (const key of ['scopeId', 'planRevision', 'nextTaskId', 'deliveryStatus']) {
      if (card[key] !== context[key]) mismatches.push('plan:' + key);
    }
  }
  const observed = pageState.current?.state;
  if (startupActive && startupFlow && observed && isChatGPTOrigin(observed.url)) {
    const startup = startupFlow.snapshot();
    if (!['loading', 'slow'].includes(startup.page) && observed.login !== 'unknown' && startup.account !== observed.login)
      mismatches.push('startup:account');
  }
  if (generation !== navigationId) return;
  const signature = mismatches.sort().join(',');
  if (signature === lastEventRuntimeCheckerMismatch) return;
  const previous = lastEventRuntimeCheckerMismatch;
  lastEventRuntimeCheckerMismatch = signature;
  if (signature) chromiumDiagnostics.log.record('event-checker', 'state-divergence', { generation, mismatches });
  else if (previous) chromiumDiagnostics.log.record('event-checker', 'state-converged', { generation });
}

function rememberSessionTitle() {
  if (!browser?.webContents || browser.webContents.isDestroyed() || pageLoading) return;
  const selected = store.selected();
  if (!selected?.chatUrl || normalizeChatUrl(browser.webContents.getURL()) !== selected.chatUrl) return;
  const title = browser.webContents.getTitle().replace(/\s*[-–—|]\s*ChatGPT$/i, '').trim();
  if (!title || /^(ChatGPT|New chat|Новый чат)$/i.test(title) || selected.title === title) return;
  void store.setSessionTitle(selected.workspace, selected.sessionId, title)
    .then(changed => { if (changed) publish(); }).catch(() => {});
}

function rememberScopeTitle() {
  const selected = store.selected();
  const info = planMonitor.view(selected, controller?.state?.projectInfo);
  if (!selected || !info || info.workspace !== selected.workspace || info.inspectedSessionId !== selected.sessionId
      || !['ACTIVE', 'BLOCKED'].includes(info.scopeStatus)
      || typeof info.scopeId !== 'string' || !info.scopeId || typeof info.objective !== 'string' || !info.objective.trim()) return;
  void store.applyScopeTitle(selected.workspace, selected.sessionId, info)
    .then(changed => {
      if (!changed) return;
      publish();
      void syncSelectedSessionTitle({ force: true, reason: 'scope-title-changed' });
    }).catch(() => {});
}

function selectedTitleCandidate() {
  const selected = store.selected();
  if (!selected?.chatUrl || !selected.title || !['manual', 'scope'].includes(selected.titleSource)) return null;
  return { workspace: selected.workspace, sessionId: selected.sessionId, chatUrl: selected.chatUrl, title: selected.title };
}

function selectedTitleSyncTarget(candidate = selectedTitleCandidate()) {
  if (!candidate || !browser?.webContents || browser.webContents.isDestroyed() || pageLoading) return null;
  if (normalizeChatUrl(browser.webContents.getURL()) !== candidate.chatUrl) return null;
  return candidate;
}

function recordTitleSync(target, result, reason = 'event') {
  chromiumDiagnostics?.log.record('app', 'title-sync', {
    sessionId: target?.sessionId ?? null,
    ok: result?.ok === true,
    code: typeof result?.code === 'string' ? result.code : null,
    status: Number.isInteger(result?.status) ? result.status : null,
    changed: result?.changed === true,
    matched: result?.matched === true,
    reason,
  });
}

async function syncSelectedSessionTitle({ force = false, reason = 'event' } = {}) {
  const candidate = selectedTitleCandidate();
  if (!candidate) return { ok: false, code: 'TITLE_SYNC_NO_EXPLICIT_TITLE' };
  const target = selectedTitleSyncTarget(candidate);
  if (!target) return { ok: false, code: 'TITLE_SYNC_NOT_READY' };
  if (!force && titleSyncSuccess.get(target.sessionId) === target.title)
    return { ok: true, skipped: true, title: target.title };
  const pending = titleSyncPending.get(target.sessionId);
  if (pending) return pending;

  const operation = browser.webContents.executeJavaScript(chatGPTTitleScript({
    expectedUrl: target.chatUrl, title: target.title,
  }), true).then(result => {
    const value = result ?? { ok: false, code: 'TITLE_SYNC_FAILED' };
    recordTitleSync(target, value, reason);
    if (value.ok) titleSyncSuccess.set(target.sessionId, target.title);
    return value;
  }, () => {
    const value = { ok: false, code: 'TITLE_SYNC_EXECUTION_FAILED' };
    recordTitleSync(target, value, reason);
    return value;
  }).finally(() => {
    if (titleSyncPending.get(target.sessionId) === operation) titleSyncPending.delete(target.sessionId);
    const current = selectedTitleCandidate();
    if (current?.sessionId === target.sessionId && current.title !== target.title)
      queueMicrotask(() => void syncSelectedSessionTitle({ force: true, reason: 'title-changed-during-sync' }));
  });
  titleSyncPending.set(target.sessionId, operation);
  return operation;
}

function report(error) { startupError = publicError(error); if (setupState) setupState = { ...setupState, phase: 'error', error: startupError }; publish(); }
function remotePreferences() {
  return { partition, preload: undefined, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true };
}

function isChatGPTOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com' && (!url.port || url.port === '443');
  } catch { return false; }
}

function permissionAllowed(permission, origin, details = {}, contents = null) {
  if (!isChatGPTOrigin(origin)) return false;
  if (permission === 'clipboard-sanitized-write') {
    const primary = browser?.webContents;
    return Boolean(contents && primary && !primary.isDestroyed() && contents.id === primary.id);
  }
  if (permission === 'geolocation' || permission === 'geolocation-approximate') return true;
  if (permission !== 'media') return false;
  const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes
    : details.mediaType ? [details.mediaType] : [];
  return mediaTypes.length > 0 && mediaTypes.every(type => type === 'audio');
}

function secureRemote(contents) {
  contents.on('will-navigate', (event, url) => { if (!url.startsWith('https://')) event.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => ({ action: url.startsWith('https://') ? 'allow' : 'deny',
    overrideBrowserWindowOptions: { width: 980, height: 780, webPreferences: remotePreferences() } }));
  contents.on('did-create-window', child => {
    secureRemote(child.webContents);
    if (contents === browser?.webContents) child.once('closed', () => { void refreshStartupAccount(); });
  });
}

function clampedSidebarWidth(value = sidebarWidth) {
  const windowWidth = window && !window.isDestroyed() ? window.getContentSize()[0] : 1440;
  const max = Math.max(SIDEBAR_MIN_WIDTH, windowWidth - BROWSER_MIN_WIDTH);
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(max, Math.round(Number(value) || SIDEBAR_MIN_WIDTH)));
}

function layout() {
  if (!window || window.isDestroyed()) return;
  const [width, height] = window.getContentSize();
  const effectiveSidebarWidth = clampedSidebarWidth();
  sidebar.setBounds({ x: 0, y: 0, width: effectiveSidebarWidth, height });
  browser.setBounds({ x: effectiveSidebarWidth, y: 0, width: Math.max(0, width - effectiveSidebarWidth), height });
}

function assertLocalSender(event) {
  if (!sidebar || event.sender !== sidebar.webContents || event.senderFrame !== sidebar.webContents.mainFrame
      || event.senderFrame.url !== sidebarUrl) throw Object.assign(new Error('Недопустимый источник команды.'), { code: 'IPC_FORBIDDEN' });
}

function assertArchiveSender(event) {
  if (!archiveWindow || archiveWindow.isDestroyed() || event.sender !== archiveWindow.webContents
      || event.senderFrame !== archiveWindow.webContents.mainFrame || event.senderFrame.url !== archiveUrl)
    throw Object.assign(new Error('Недопустимый источник команды архива.'), { code: 'IPC_FORBIDDEN' });
}

function archiveRecords(items, { single = false } = {}) {
  if (!Array.isArray(items) || !items.length || (single && items.length !== 1)) throw new Error(single ? 'Выберите один проект.' : 'Выберите проекты из архива.');
  const seen = new Set();
  return items.map(item => {
    if (!item || typeof item.workspace !== 'string' || typeof item.projectId !== 'string' || seen.has(item.workspace)) throw new Error('Некорректный выбор архива.');
    seen.add(item.workspace);
    const project = store.project(item.workspace);
    if (!project?.archivedAt || project.projectId !== item.projectId) throw new Error('Список архива изменился. Повторите выбор.');
    return project;
  });
}

function sessionArchiveRecords(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('Выберите сессии из архива.');
  const snapshot = store.snapshot(); const seen = new Set();
  return items.map(item => {
    const key = `${item?.workspace ?? ''}\n${item?.sessionId ?? ''}`;
    if (!item || typeof item.workspace !== 'string' || typeof item.projectId !== 'string' || typeof item.sessionId !== 'string' || seen.has(key))
      throw new Error('Некорректный выбор сессий архива.');
    seen.add(key);
    const project = snapshot.projects.find(project => project.workspace === item.workspace);
    if (!project || project.projectId !== item.projectId || project.archivedAt) throw new Error('Проект сессии изменился. Повторите выбор.');
    const session = project.sessions.find(session => session.sessionId === item.sessionId);
    if (!session?.archivedAt) throw new Error('Сессия больше не находится в архиве.');
    return { project, session };
  });
}

function registerArchiveAction(channel, action) {
  ipcMain.handle(channel, (event, input) => {
    assertArchiveSender(event);
    const operation = actionTail.catch(() => {}).then(async () => {
      try {
        const result = await action(input); publish();
        return { ok: true, state: archiveSnapshot(), result };
      } catch (error) {
        archiveState = { ...archiveState, notice: publicError(error).message }; publishArchive();
        return { ok: false, error: publicError(error), state: archiveSnapshot() };
      }
    });
    actionTail = operation; return operation;
  });
}

function registerAction(channel, action, { navigation = false } = {}) {
  ipcMain.handle(channel, (event, input) => {
    assertLocalSender(event);
    const run = () => actionContext.run({ generation: navigationId }, async () => {
      const owner = actionContext.getStore();
      try {
        const result = await action(input);
        if (navigationCurrent(owner.generation)) publish();
        return { ok: true, state: snapshot(), result };
      } catch (error) {
        if (navigationCurrent(owner.generation)) report(error);
        return { ok: false, error: publicError(error), state: snapshot() };
      }
    });
    if (navigation) return run();
    const operation = actionTail.catch(() => {}).then(run);
    actionTail = operation;
    return operation;
  });
}

async function openArchiveWindow(workspace = null) {
  archiveState = { deletion: null, notice: null, focusWorkspace: workspace }; deletion.clear();
  if (archiveWindow && !archiveWindow.isDestroyed()) { if(smoke)archiveWindow.showInactive();else {archiveWindow.show();archiveWindow.focus();} publishArchive(); return; }
  archiveWindow = new BrowserWindow({ title: 'Архив — Project Web Pilot', width: 780, height: 720, minWidth: 620, minHeight: 480,
    focusable:!smoke,
    backgroundColor: shellBackground[shellTheme], webPreferences: { preload: path.join(sourceDir, 'archive-preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  archiveWindow.setWindowOpenHandler?.(() => ({ action: 'deny' }));
  archiveWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  archiveWindow.webContents.on('will-navigate', event => event.preventDefault());
  archiveWindow.webContents.on('did-finish-load', publishArchive);
  archiveWindow.on('closed', () => { deletion.clear(); archiveWindow = null; archiveState = { deletion: null, notice: null, focusWorkspace: null }; });
  await archiveWindow.loadURL(archiveUrl);
}

function nextNavigation() {
  planMonitor.invalidate();
  const owner = actionContext.getStore();
  // An older async action cannot reclaim navigation after a newer user selection.
  if (owner && owner.generation !== navigationId) return owner.generation;
  const generation = ++navigationId;
  if (owner) owner.generation = generation;
  return generation;
}
function navigationCurrent(generation) {
  return generation === navigationId && window && !window.isDestroyed() && browser && !browser.webContents.isDestroyed();
}
function attachController(project, { freshDraft = false } = {}) {
  const selected = store.selected();
  if (!project || !navigationCurrent(workspaceHealth?.generation) || !workspaceHealth?.ready
      || workspaceHealth.workspace !== project.workspace || workspaceHealth.sessionId !== project.sessionId
      || selected?.workspace !== project.workspace || selected.sessionId !== project.sessionId
      || pageLoading || setupState || settingsState) return false;
  const record=liveSessions.visible;
  if(record?.identity?.workspace!==project.workspace||record.identity.sessionId!==project.sessionId)return false;
  record.ready=true;
  if(!controller.active)controller.attach(project,{freshDraft:freshDraft||record.freshDraft===true});
  record.freshDraft=false;
  return true;
}

async function navigate(project = store.selected(), { refresh = false, generation = null, resume = false, entryUrl = null, freshDraft = false } = {}) {
  if (!project && pageLoading) return;
  const ownNavigation = generation ?? nextNavigation();
  if (!navigationCurrent(ownNavigation)) return;
  const record=selectLiveSession(project);
  if (workspaceHealth?.ready && workspaceHealth.workspace === project?.workspace
      && (generation === null || workspaceHealth.generation === ownNavigation))
    workspaceHealth = { ...workspaceHealth, generation: ownNavigation, sessionId: project.sessionId };
  pageLoading = record.loading; startupFlow?.beginPage(ownNavigation); publish();
  void planMonitor.refresh();
  const target = entryUrl ?? project?.chatUrl
    ?? (project ? chatGPTEntrypoint(project.experience ?? 'chat') : CHATGPT_SIGNIN_ENTRYPOINT);
  const began = Date.now();
  chromiumDiagnostics?.log.record('app', 'navigation-requested', { generation: ownNavigation, url: safeUrl(target),
    browserBounds: browser.getBounds(), windowSize: window.getContentSize() });
  const waiting = setTimeout(() => {
    if (navigationCurrent(ownNavigation) && pageLoading) chromiumDiagnostics?.log.record('app', 'navigation-waiting', {
      generation: ownNavigation, elapsedMs: Date.now() - began, url: safeUrl(target),
      currentUrl: safeUrl(browser.webContents.getURL()), loading: browser.webContents.isLoading(),
    });
  }, 15000);
  waiting.unref?.();
  try {
    const alreadyOpen = !refresh && !entryUrl && record.view.webContents.getURL() === target;
    if (!alreadyOpen) {
      const firstOpening = !project && !record.view.webContents.getURL();
      pageLoading=true;
      if (firstOpening) await openStartupPage(record.view.webContents, target, {
        isCurrent: () => navigationCurrent(ownNavigation),
      });
      else await liveSessions.navigate(record,target,{reload:refresh||!!entryUrl,freshDraft});
    }
    if (!navigationCurrent(ownNavigation)) return;
    pageLoading = false; startupFlow?.finishPage(ownNavigation);
    void refreshStartupAccount();
    if (attachController(project && store.project(project.workspace), { freshDraft })) {
      if (refresh) await controller.retry();
      else void controller.tick();
      if (pageState.current) applyObservedPage({ state: pageState.current.state });
    }
    publish();
    void syncSelectedSessionTitle({ force: true, reason: 'navigation-loaded' });
  } catch (error) {
    if (!navigationCurrent(ownNavigation)) return;
    chromiumDiagnostics?.log.record('app', 'load-url-failed', { generation: ownNavigation, url: safeUrl(target),
      elapsedMs: Date.now() - began, errorCode: Number.isFinite(error.errno) ? error.errno : null,
      errorName: /^(?:ERR|PAGE)_[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : null });
    pageLoading = false; startupFlow?.finishPage(ownNavigation, error.code ?? 'PAGE_LOAD_FAILED');
    const code = /^(?:ERR|PAGE)_[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'PAGE_LOAD_FAILED';
    report(Object.assign(new Error(code === 'PAGE_RESPONSE_TIMEOUT'
      ? 'ChatGPT не ответил за две минуты. Скопируйте диагностику перед повтором.'
      : 'Не удалось открыть сайт ChatGPT. Скопируйте диагностику и повторите открытие.'), { code }));
  } finally { clearTimeout(waiting); }
}

function pauseForSetup() {
  const generation = nextNavigation();
  if (!navigationCurrent(generation)) return false;
  pageLoading = false; startupError = null;
  startupFlow?.beginPage(generation);
  if (!browser.webContents.isLoading()) startupFlow?.finishPage(generation);
  return true;
}
function cancelSetup() {
  workspaceSetup.clear(); setupState = null; startupError = null;
  const current = store.landing(); if (current) void selectWorkspace(current.workspace, { resume: true }).catch(report);
  else if (startupFlow) { startupActive = true; void navigate(null); }
  publish();
}
async function reviewWorkspace(workspace, openReady = false, { generation = null } = {}) {
  if (storageError) throw new Error('Сначала нужно восстановить сохранённый список проектов. Исходный файл оставлен без изменений.');
  const ownNavigation = generation ?? nextNavigation();
  if (!navigationCurrent(ownNavigation)) return false;
  pageLoading = false; startupError = null;
  const canonical = await fsp.realpath(workspace).catch(() => workspace);
  if (!navigationCurrent(ownNavigation)) return false;
  if (store.project(canonical)?.archivedAt) { await openArchiveWindow(canonical); publish(); return false; }
  settingsState = null; deletion.clear();
  const firstSessionExperience = 'chat';
  setupState = { phase: 'checking', mode: 'existing', workspace, firstSessionExperience }; publish();
  const preview = await workspaceSetup.preview({ mode: 'existing', workspace });
  if (!navigationCurrent(ownNavigation)) return false;
  const firstSessionRequired = !store.project(preview.workspace);
  setupState = { ...preview, phase: 'preview', firstSessionRequired, firstSessionExperience: firstSessionRequired ? firstSessionExperience : 'chat' };
  if (preview.ready && openReady) {
    workspaceHealth = { ...preview, phase: 'ready', generation: ownNavigation }; setupState = null; workspaceSetup.clear();
    return true;
  }
  publish(); return false;
}
async function openConnectedSession(input, sessionId = null, { latest = false, resume = false } = {}) {
  const explicitSession = sessionId !== null;
  const generation = nextNavigation();
  const current = () => navigationCurrent(generation);
  if (!current()) return null;
  if (storageError) throw new Error('Сначала нужно восстановить сохранённый список проектов.');
  settingsState = null; setupState = null;
  startupError = null; pageLoading = true;
  workspaceHealth = { workspace: input, sessionId, generation, phase: 'checking', ready: false }; publish();
  try {
    if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('Выберите папку проекта.');
    const workspace = await fsp.realpath(input);
    if (!current()) return null;
    const record = store.snapshot().projects.find(p => p.workspace === workspace);
    if (record?.archivedAt) { pageLoading = false; workspaceHealth = null; await openArchiveWindow(workspace); return null; }
    // Only the first connection needs the complete strict setup path.
    if (!record) {
      if (!await reviewWorkspace(workspace, true, { generation })) return null;
      const project = explicitSession && record
        ? await store.selectSession(workspace, sessionId, { isCurrent: current })
        : await store.select(workspace, { latest, isCurrent: current });
      if (!current()) return null;
      workspaceHealth = { ...workspaceHealth, sessionId: project.sessionId };
      publish(); void navigate(project, { generation, resume, freshDraft: true }); return project;
    }
    sessionId ??= latest ? activeSessionsNewestFirst(record.sessions)[0]?.sessionId : record.selectedSessionId;
    workspaceHealth = { workspace, sessionId, generation, phase: 'checking', ready: false };
    const project = await store.selectSession(workspace, sessionId, { isCurrent: current, expand: latest || explicitSession });
    if (!current() || !project) return null;
    publish();
    const sessionRecord=liveSessions.ensure(project);
    sessionRecord.ready=false;
    const readinessEpoch=++sessionRecord.readinessEpoch;
    void navigate(project, { generation, resume });
    // Inspection runs in the existing worker and never holds the IPC or store queue.
    void workspaceSetup.ready(workspace).then(result => {
      if(sessionRecord.disposed||sessionRecord.readinessEpoch!==readinessEpoch)return;
      sessionRecord.ready=result.ready;
      if(result.ready)liveSessions.tick(sessionRecord);else sessionRecord.controller.cancel();
      if (!current()) return;
      workspaceHealth = { ...result, workspace, sessionId, generation, phase: result.ready ? 'ready' : 'error' };
      if (attachController(project)) void controller.tick();
      publish();
    }).catch(error => {
      if(sessionRecord.disposed||sessionRecord.readinessEpoch!==readinessEpoch)return;
      sessionRecord.ready=false;sessionRecord.error=publicError(error);sessionRecord.controller.cancel();
      if (!current()) return;
      workspaceHealth = { workspace, sessionId, generation, phase: 'error', ready: false, error: publicError(error) }; publish();
    });
    return project;
  } catch (error) {
    if (!current()) return null;
    pageLoading = false;
    workspaceHealth = { ...workspaceHealth, phase: 'error', ready: false, error: publicError(error) };
    report(error); return null;
  }
}
async function selectWorkspace(input, { latest = false, resume = false } = {}) {
  return openConnectedSession(input, null, { latest, resume });
}

// Only display-safe fields: the connector address is already masked by VpsTunnel.
function vpsView(vps) {
  if (!vps) return null;
  return { configured: !!vps.configured, ready: !!vps.ready, running: !!vps.running, conflict: !!vps.conflict,
    portMatches: !!vps.portMatches, mcpPort: vps.mcpPort ?? null, forwardPort: vps.forwardPort ?? null,
    lastError: vps.lastError ? { message: String(vps.lastError.message), at: vps.lastError.at } : null,
    error: vps.error ? String(vps.error) : null, connector: vps.connector ?? null };
}

function appServerSourceFolder() {
  return app.isPackaged ? path.join(process.resourcesPath, 'codex-app-server-mcp')
    : path.join(sourceDir, '../tools/codex-app-server-mcp');
}

function ensureRuntimeSwitcher() {
  if (smoke) return null;
  const windows = process.platform === 'win32';
  appServerRuntime ??= new CodexAppServerRuntime({
    sourceDir: appServerSourceFolder(), sessionPlans, stateDir: runtimeFolder,
    ...(windows
      // Windows has no system Python: the tools of the package and the private Python are prepared first.
      ? { bootstrap: windowsBootstrap }
      // The bundled uv builds the executor's Python on a Mac that has only the system one.
      : { uv: path.join(app.isPackaged ? process.resourcesPath : path.join(sourceDir, '../.harness/runtime'), 'mac-tools', 'uv') }),
  });
  // The forward of the user's own server: a LaunchAgent on macOS, a supervisor of control.py on Windows.
  if (process.platform === 'darwin') vpsTunnel ??= new VpsTunnel();
  else if (windows) vpsTunnel ??= new WindowsVpsTunnel({ control: args => appServerRuntime.vpsControl(args) });
  runtimeSwitcher ??= new MacRuntimeSwitcher({ appServerRuntime, vpsTunnel,
    legacyWindows: windows ? { legacyStateDir: legacyWindowsStateFolder(),
      controlFile: path.join(app.isPackaged ? path.join(process.resourcesPath, 'resources') : path.join(sourceDir, '../resources'),
        'runtime-control', 'windows-control.py') } : null });
  return runtimeSwitcher;
}

// Brings the local services up once per app run. Every caller shares the same attempt; a failed one is
// forgotten, so the next use of the services tries again.
function activateRuntime() {
  if (smoke) return Promise.resolve(null);
  runtimeActivation ??= (async () => {
    const result = await ensureRuntimeSwitcher().activate(runtime, { chatgptChannel,
      retireLegacy: legacyRuntimeRetired || !['darwin', 'win32'].includes(process.platform) ? null : { dataDir, runtimeRoots: legacyRuntimeRoots } });
    if (result.legacyRetired) { legacyRuntimeRetired = true; await saveSettings(); }
    if (process.platform === 'win32') workspaceSetup.setRuntimeEnvironment(await windowsBootstrap.workflowEnvironment());
    contextCache.clear();
    return result.status;
  })().catch(error => { runtimeActivation = null; throw error; });
  return runtimeActivation;
}

function createStartupFlow() {
  if (!startupSupported(process.platform, smoke)) return;
  startupActive = store.snapshot().projects.length === 0;
  startupFlow = new StartupReadiness({
    ...startupPlatformOptions({ platform: process.platform, setup: workspaceSetup,
      bootstrap: appServerRuntime, components: windowsBootstrap,
      ensureRuntime: activateRuntime, control: (...args) => runtime.control(...args),
      inspectGit: () => inspectMacGit(), installGit: () => installMacGit() }),
    onChange: publish,
  });
  startupClipboard = new TunnelClipboard({
    readText: () => clipboard.readText(),
    promptTunnelId: () => appServerRuntime.promptTunnelId(),
    configure: async credentials => {
      await startupFlow.configure(credentials);
      if (!startupFlow.snapshot().tunnel) throw new Error('Tunnel not ready');
    },
    onChange: publish,
  });
}
function observeStartupClipboard() {
  if (!startupClipboard || !startupFlow) return;
  const s = startupFlow.snapshot();
  startupClipboard.observe({
    active: startupActive && !settingsState && !setupState && s.account === 'signed-in' && !s.tunnel,
    ready: s.node && s.git && s.runtime, busy: s.busy,
  });
}
function observeStartupAccount(observation = pageState.current?.state) {
  if (!startupFlow || !startupActive || !observation || !browser || browser.webContents.isDestroyed()) return false;
  const generation = navigationId;
  if (!navigationCurrent(generation) || !isChatGPTOrigin(observation.url) || observation.url !== browser.webContents.getURL()) return false;
  if (['loading', 'slow', 'idle'].includes(startupFlow.snapshot().page)) startupFlow.finishPage(generation);
  startupFlow.observe(generation, observation);
  return true;
}
async function refreshStartupAccount() {
  if (!startupFlow || !startupActive || !browser || browser.webContents.isDestroyed()) return false;
  const generation = navigationId;
  if (!navigationCurrent(generation) || !isChatGPTOrigin(browser.webContents.getURL())) return false;
  try {
    const observation = await browser.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: 'globalThis.__webPilotObserverSnapshot?.()' }]);
    if (!navigationCurrent(generation)) return false;
    return observeStartupAccount(observation) || observeStartupAccount();
  } catch {
    return observeStartupAccount();
  }
}
async function startupAction(action) {
  if (!startupFlow) throw new Error('Начальная настройка недоступна на этой платформе.');
  if (action === 'show') {
    settingsState = null; setupState = null; workspaceSetup.clear(); startupError = null; startupActive = true;
    if (!store.selected()) void navigate(null);
    else void refreshStartupAccount();
    return startupFlow.check({ prepare: process.platform === 'win32' });
  }
  if (!startupActive) throw new Error('Сначала откройте начальную настройку.');
  if (action === 'copy-diagnostics') {
    await clipboard.writeText(await chromiumDiagnostics.startupReport());
    return true;
  }
  if (action === 'check') { await refreshStartupAccount(); return startupFlow.check({ prepare: true }); }
  if (action === 'install-git') return startupFlow.install();
  if (action === 'paste-tunnel-id' || action === 'configure-tunnel') {
    const s = startupFlow.snapshot();
    if (s.busy || !s.node || !s.git || !s.runtime || s.tunnel || s.account !== 'signed-in')
      throw new Error('Завершите вход и подготовку компьютера перед настройкой подключения.');
    if (action === 'paste-tunnel-id') return startupClipboard.pasteTunnelId();
    return startupClipboard.configureManually(credentials => startupFlow.configure(credentials));
  }
  if (action === 'chat' || action === 'signup') { startupError = null; return navigate(null); }
  if (action === 'plugins') { startupError = null; return navigate(null, { entryUrl: 'https://chatgpt.com/plugins' }); }
  const pages = {
    tunnels: 'https://platform.openai.com/settings/organization/tunnels',
    keys: 'https://platform.openai.com/api-keys',
    help: 'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels',
  };
  if (Object.hasOwn(pages, action)) return shell.openExternal(pages[action]);
  if (action === 'continue') {
    await startupFlow.check();
    await refreshStartupAccount();
    const state = startupFlow.snapshot();
    if (state.busy || !state.node || !state.git || !state.runtime || !state.tunnel || state.account !== 'signed-in')
      throw new Error('Завершите вход и проверку подключения перед созданием проекта.');
    startupActive = false; startupError = null; return true;
  }
  throw new Error('Неизвестное действие начальной настройки.');
}

function connectController() {
  for(const record of liveSessions.records.values())record.controller.runtime=runtime;
}
function selectLiveSession(project=null) {
  const record=liveSessions.ensure(project);
  if(project?.planExecution?.execution_strategy==='parallel')execution.observe(project.workspace);
  const changed=liveSessions.visible!==record;
  browser=record.view;controller=record.controller;pageState=record.pageState;
  agentTimer=record.timer;conversationRecovery=record.recovery;
  chromiumDiagnostics=record.diagnostics;chatColorStyles=record.colors;pageLoading=record.loading;
  liveSessions.show(record,window?.contentView);layout();
  if(changed)applyObservedPage(record.pageState.current??{reset:true},record);
  return record;
}
function decorateSessionRuntime(record) {
  configurePrimary(record);
  record.controller.canSendContext=project=>!project.assignmentId||projectAutoPlan.enabled(project.parentWorkspace,project.parentScopeId);
  const contents=record.view.webContents, handlers=[];
  const on=(event,fn)=>{contents.on(event,fn);handlers.push([event,fn]);};
  if(eventBaseline) {
    const execute=contents.executeJavaScript.bind(contents);
    contents.executeJavaScript=(...args)=>{runtimeMetrics.executeJavaScript++;return execute(...args);};
  }
  secureRemote(contents);
  record.colors=new ChatColors(contents,chatColors);
  record.diagnostics=new ChromiumDiagnostics(contents,{file:chromiumDiagnosticsFile,allowFixture:smoke,
    owner:()=>({workspace:record.identity?.workspace,sessionId:record.identity?.sessionId}),
    onConversationRateLimit:(id,seconds)=>record.recovery.rateLimited(id,seconds),
    startupNetwork:!smoke&&!record.identity&&store.snapshot().projects.length===0});
  void record.diagnostics.start({appVersion:app.getVersion(),platform:process.platform,electron:process.versions.electron,
    chromium:process.versions.chrome,fixture:smoke}).catch(()=>{});
  record.composer.onDiagnostic=({event,...fields})=>record.diagnostics.log.record('composer',event,{sessionId:record.identity?.sessionId??null,...fields});
  on('page-title-updated',()=>{if(record===liveSessions.visible)rememberSessionTitle();});
  on('did-start-navigation',(event,_url,inPlace,mainFrame)=>{
    if(record===liveSessions.visible&&(event.isMainFrame??mainFrame)&&!(event.isSameDocument??inPlace)&&startupActive)
      startupFlow?.beginPage(navigationId);
  });
  on('did-navigate-in-page',()=>{
    void applyToolCallVisibility(record.view);void installChatGPTAutoScroll(contents);
    if(record===liveSessions.visible)void syncSelectedSessionTitle({reason:'session-navigated'});
  });
  on('did-finish-load',()=>{
    if(record===liveSessions.visible) {
      pageLoading=false;
      if(startupActive){startupFlow?.finishPage(navigationId);void refreshStartupAccount();}
      attachController(record.project());
    }
    void applyToolCallVisibility(record.view);void installChatGPTAutoScroll(contents,{forceFollow:true});publish();
  });
  return ()=>{
    for(const [event,fn] of handlers)contents.removeListener(event,fn);
    record.colors.dispose();void record.diagnostics.stop().catch(()=>{});
  };
}

function registerIpc() {
  ipcMain.handle('pilot:get-state', event => { assertLocalSender(event); return snapshot(); });
  registerAction('pilot:auto-plan', async enabled => {
    const selected=store.selected(),workspace=selected?.parentWorkspace??selected?.workspace;
    const project=selected?.parentWorkspace?store.project(workspace):selected;
    if(!project){
      if(enabled===true)throw new Error('Выберите проект для автовыполнения.');
      return; // Closing an unselected/legacy OFF state is a harmless no-op.
    }
    const info=project&&await readAutoPlanState(project,workspaceSetup.environment);
    let verified=info?.confirmed===true;
    if(info?.scopeId&&info.planExecution?.execution_strategy==='parallel'){
      const kit=await executionKit.read(workspace);
      verified=kit.confirmed&&kit.plan.project_id===info.projectId
        &&kit.plan.scope_id===info.scopeId&&kit.plan.plan_revision===info.planRevision;
    }
    if(store.selected()?.sessionId!==selected.sessionId||store.selected()?.workspace!==selected.workspace
      ||store.project(workspace)?.projectId!==project.projectId)
      throw new Error('Выбранный проект или сессия изменились во время проверки. Повторите переключение.');
    const scope=verified?info.scopeId:null;
    const done=verified&&info.planView?.tasks?.length>0&&info.planView.tasks.every(t=>t.status==='done');
    projectAutoPlan.sync(workspace,scope,{confirmed:verified,complete:done,
      planRevision:info?.planRevision,originSessionId:info?.planExecution?.execution_origin_session_id});
    const current=projectAutoPlan.state(workspace);
    if(scope&&current?.scopeId!==scope&&enabled===true)
      throw new Error('План изменился во время переключения AutoPlan. Обновите состояние проекта.');
    // Completion is an automatic OFF, never misrecord it as a manual OFF.
    if(!(done&&enabled===true))projectAutoPlan.set(workspace,
      scope&&current?.scopeId!==scope?current.scopeId:scope,enabled===true,project?.sessionId);
    if(workspace)execution.observe(workspace);
    await saveSettings();
  });
  registerAction('pilot:plan-review', input => planReview.setEnabled(input));
  registerAction('pilot:acknowledge-command', async input => {
    const selected=store.selected(),root=selected?.parentWorkspace??selected?.workspace;
    const target=typeof input?.workspace==='string'&&store.project(input.workspace);
    if(!target||target.projectId!==input.projectId||(target.parentWorkspace??target.workspace)!==root)
      throw new Error('Проект операции изменился. Повторите диагностику.');
    const activity=await readCommandActivity(target.workspace),command=activity.commands.find(c=>c.id===input.id);
    if(!command?.canAcknowledge||command.digest!==input.digest)throw new Error('Операция изменилась или исполнитель ещё работает.');
    const answer=await dialog.showMessageBox({type:'warning',buttons:['Отмена','Признать исход неизвестным'],defaultId:0,cancelId:0,
      message:'Операция '+command.id,detail:'Результат утрачен. Это разрешит интеграцию проверенного коммита, но не подтвердит успех команды и не разрешит удаление живого сервера. Продолжайте только после диагностики этой операции.'});
    if(answer.response!==1)return;
    if(store.selected()?.sessionId!==selected.sessionId||store.project(target.workspace)?.projectId!==input.projectId)
      throw new Error('Выбранная сессия изменилась.');
    await acknowledgeUnknownCommand(target.workspace,{...input,confirmation:input.id});
    await execution.signal(root);
  });
  registerAction('pilot:set-parallel-execution', async input => {
    if (!settingsState) throw new Error('Откройте настройки.');
    const next = validateParallelSettings(input ?? null);
    await saveSettings({ parallelExecution: next });
    parallelExecution = next;
  });
  registerAction('pilot:clear-orphan-executor', async input => {
    if (!settingsState) throw new Error('Откройте Настройки для восстановления записи исполнителя.');
    const expected=await deletion.inspectOrphan(input);
    const choice=await dialog.showMessageBox({
      type:'warning',buttons:['Отмена','Убрать запись'],defaultId:0,cancelId:0,noLink:true,
      title:'Восстановление исполнителя',
      message:'Убрать локальную запись исполнителя «'+(store.project(expected.workspace)?.displayName||store.project(expected.workspace)?.name||expected.workspace)+'»?',
      detail:'Путь: '+expected.workspace+'\nБудет удалена только локальная запись и относящиеся к ней настройки и диагностика. Облачные чаты ChatGPT сохраняются. Файлы на диске не удаляются.',
    });
    if(choice.response!==1)return;
    if(!settingsState)throw Object.assign(new Error('Настройки закрыты. Повторите подтверждение.'),{code:'EXECUTOR_RECORD_CHANGED'});
    const checkBusy=async target=>{
      const workspaces=[target.workspace,target.parentWorkspace];
      if([...liveSessions.records.values()].some(record=>workspaces.includes(record.identity?.workspace)))
        throw Object.assign(new Error('Исполнитель или родитель ещё открыт в ChatGPT. Завершите работу.'),{code:'DELETE_PROJECT_BUSY'});
      for(const workspace of workspaces){
        const activity=await readCommandActivity(workspace);
        if(activity.deletionBlocked)throw Object.assign(new Error('Исход команды не подтверждён. Очистка запрещена.'),{code:'DELETE_PROJECT_BUSY'});
      }
      const ledgers=Object.values(parallelExecutionBook);
      if(ledgers.some(ledger=>Object.values(ledger?.assignments??{}).some(entry=>entry.worktree===target.workspace
        && entry.phase!=='integrated'&&entry.integration!=='done')))
        throw Object.assign(new Error('Назначение исполнителя ещё активно или имеет UNKNOWN-состояние.'),{code:'DELETE_PROJECT_BUSY'});
      if([...execution.states.values()].some(state=>(state.assignments??[]).some(entry=>
        entry.worktree===target.workspace&&entry.status!=='INTEGRATED')))
        throw Object.assign(new Error('Исполнение не завершено. Проверьте состояние назначения.'),{code:'DELETE_PROJECT_BUSY'});
    };
    await deletion.clearOrphan(input,{checkBusy,cleanup:cleanupDeletedProject,
      purgeState:(dir,identities)=>{
        settingsSaveTail=queueProjectStatePurge(settingsSaveTail,dir,identities);return settingsSaveTail;
      }});
  });
  registerAction('pilot:reconnect', () => conversationRecovery.requestRetry());
  registerAction('pilot:startup', action => startupAction(action), { navigation: true });
  registerAction('pilot:open-archive-window', input => openArchiveWindow(typeof input === 'string' ? input : null));
  registerAction('pilot:open-settings', () => openSettings());
  registerAction('pilot:open-chat-colors', () => colorEditor.open());
  registerAction('pilot:open-doctor', () => openSettings(setupState?.workspace ?? (workspaceHealth?.phase === 'error' ? workspaceHealth.workspace : null) ?? store.selected()?.workspace));
  const doctorWorkspace = input => {
    if (typeof input !== 'string' || (!store.project(input) && input !== doctorState?.workspace)) throw new Error('Выберите проект в настройках.');
    return input;
  };
  registerAction('pilot:doctor-select', input => {
    if (!settingsState) throw new Error('Откройте настройки.');
    doctorState = { workspace: doctorWorkspace(input), phase: 'idle' };
  });
  registerAction('pilot:doctor-run', async input => {
    if (!settingsState) throw new Error('Откройте настройки.');
    const workspace = doctorWorkspace(input);
    pauseForSetup(); contextCache.clear();
    const result = await projectDoctor.run(workspace, report => { doctorState = report; publish(); });
    doctorState = { ...result, phase: 'done' }; startupError = null;
  });
  registerAction('pilot:doctor-backup', async () => {
    if (!doctorState?.backupPath) throw new Error('Резервная копия ещё не создана.');
    const error = await shell.openPath(doctorState.backupPath);
    if (error) throw new Error('Не удалось открыть папку резервной копии.');
  });
  registerAction('pilot:doctor-review', async () => {
    if (!doctorState?.workspace) throw new Error('Выберите проект.');
    await reviewWorkspace(doctorState.workspace);
  });
  registerAction('pilot:doctor-continue', async mode => {
    if (!['open','chat','work'].includes(mode) || doctorState?.phase !== 'done' || !doctorState.projectReady || !doctorState.servicesReady || doctorState.issues.length) throw new Error('Выберите открытие чата или новую сессию после проверки проекта.');
    const workspace = doctorState.workspace;
    if (!await reviewWorkspace(workspace, true)) return;
    const generation = navigationId, existing = store.project(workspace);
    let project = await store.select(workspace, { experience: mode === 'work' ? 'work' : 'chat', isCurrent: () => navigationCurrent(generation) });
    if (!navigationCurrent(generation) || !project) return;
    if (['chat','work'].includes(mode) && existing) project = await store.newSession(workspace, mode);
    if (!navigationCurrent(generation)) return;
    await navigate(project, { generation, freshDraft: !existing || ['chat','work'].includes(mode) });
  });
  registerAction('pilot:close-settings', closeSettings);
  registerAction('pilot:set-sidebar-width', async input => {
    if (!Number.isFinite(input)) throw new Error('Некорректная ширина сайдбара.');
    const next = clampedSidebarWidth(input);
    if (next === sidebarWidth) { layout(); return next; }
    sidebarWidth = next; layout();
    await saveSettings({ sidebarWidth: next });
    return next;
  });
  registerAction('pilot:set-theme', async input => {
    if (!['light', 'dark'].includes(input)) throw new Error('Неизвестная тема оформления.');
    if (input === shellTheme) return;
    await saveSettings({ shellTheme: input });
    applyShellTheme(input);
  });
  registerAction('pilot:set-hide-tool-calls', async input => {
    if (typeof input !== 'boolean') throw new Error('Некорректная настройка отображения инструментов.');
    if (input === hideToolCalls) return;
    await saveSettings({ hideToolCalls: input });
    hideToolCalls = input;
    await Promise.all([...liveSessions.records.values()].map(record=>applyToolCallVisibility(record.view)));
  });
  registerAction('pilot:set-chatgpt-channel', async input => {
    if (smoke || typeof runtime?.setChannel !== 'function') throw new Error('Выбор канала ChatGPT недоступен на этой платформе.');
    if (!CHATGPT_CHANNELS.includes(input)) throw new Error('Неизвестный канал ChatGPT.');
    if (input === chatgptChannel && runtime.channel === input) return { channel: chatgptChannel };
    try {
      return { channel: input, status: await runtime.setChannel(input) };
    } finally {
      // The selector may already hold the new channel even if starting it failed.
      if (runtime.channel !== chatgptChannel) { chatgptChannel = runtime.channel; await saveSettings({ chatgptChannel }); }
    }
  });
  registerAction('pilot:refresh-chatgpt-channel', async () => {
    if (smoke || typeof runtime?.setChannel !== 'function') throw new Error('Проверка канала ChatGPT недоступна на этой платформе.');
    await runtime.control('status');
  });
  registerAction('pilot:copy-vps-connector-url', async () => {
    ensureRuntimeSwitcher();
    if (!vpsTunnel) throw new Error('Канал VPS недоступен на этой платформе.');
    // The full address goes straight to the clipboard; it is never returned, published or logged.
    await clipboard.writeText(await vpsTunnel.connectorUrl());
    return { copied: true };
  });
  registerAction('pilot:copy-workspace-path', async input => {
    const project = store.project(input);
    if (!project || project.archivedAt) throw new Error('Выберите активный проект.');
    await clipboard.writeText(project.workspace);
    return project.workspace;
  });
  registerAction('pilot:copy-external-client-line', async input => {
    const project = store.project(input);
    if (!project || project.archivedAt) throw new Error('Выберите активный проект.');
    // Clipboard only: nothing is sent to a chat, and the line holds no connector address or key.
    const line = externalClientLine({ name: project.displayName || project.name, workspace: project.workspace });
    await clipboard.writeText(line);
    return line;
  });
  registerAction('pilot:rename-project', async input => {
    if (typeof input?.workspace !== 'string') throw new Error('Выберите активный проект.');
    return store.setProjectDisplayName(input.workspace, input.name);
  });
  registerAction('pilot:rename-session', async input => {
    if (typeof input?.workspace !== 'string' || typeof input?.sessionId !== 'string') throw new Error('Выберите сессию проекта.');
    const changed = await store.renameSession(input.workspace, input.sessionId, input.name);
    if (changed && store.selected()?.workspace === input.workspace && store.selected()?.sessionId === input.sessionId)
      void syncSelectedSessionTitle({ force: true, reason: 'manual-rename' });
    return changed;
  });
  registerAction('pilot:archive-project', async input => {
    const project = store.project(input);
    if (!project || project.archivedAt || storageError) throw new Error('Выберите активный проект.');
    const selected = store.selected()?.workspace === input;
    if (selected) { controller.cancel(); nextNavigation(); }
    const generation = navigationId;
    try { await store.setArchived(input, true); }
    catch (error) { if (selected && navigationCurrent(generation)) await selectWorkspace(project.workspace, { resume: true }); throw error; }
    if (!navigationCurrent(generation)) return;
    startupError = null;
    if (selected) { workspaceHealth = null; await navigate(null, { generation }); }
  });
  registerAction('pilot:archive-session', async input => {
    if (typeof input?.workspace !== 'string' || typeof input?.sessionId !== 'string') throw new Error('Выберите сессию проекта.');
    const current = store.selected(); const selected = current?.workspace === input.workspace && current.sessionId === input.sessionId;
    if (selected) { controller.cancel(); nextNavigation(); }
    const generation = navigationId;
    try { await store.setSessionArchived(input.workspace, input.sessionId, true); }
    catch (error) { if (selected && current && navigationCurrent(generation)) await selectWorkspace(current.workspace, { resume: true }); throw error; }
    if (!navigationCurrent(generation)) return;
    startupError = null;
    if (selected) { const fallback = store.selected(); if (fallback) await selectWorkspace(fallback.workspace); }
  });
  registerAction('pilot:begin-create', () => {
    if (storageError) throw new Error('Сначала нужно восстановить сохранённый список проектов.');
    settingsState = null; deletion.clear(); pauseForSetup(); workspaceSetup.clear();
    setupState = { phase: 'form', mode: 'new', name: '', firstSessionRequired: true, firstSessionExperience: 'chat', parent: projectsParent };
  });
  registerAction('pilot:choose-parent', async input => {
    if (setupState?.mode !== 'new') return;
    const name = typeof input?.name === 'string' ? input.name.slice(0, 120) : setupState.name;
    const result = await dialog.showOpenDialog(window, { title: 'Выбрать расположение папки для проектов', buttonLabel: 'Выбрать папку',
      properties: ['openDirectory'], ...(setupState.parent ? { defaultPath: setupState.parent } : {}) });
    const parent = result.canceled ? setupState.parent : result.filePaths[0];
    if (!result.canceled) {
      if (typeof parent !== 'string' || !path.isAbsolute(parent)) throw new Error('Выберите папку для проектов.');
      await saveSettings({ projectsParent: parent });
      projectsParent = parent;
    }
    setupState = { phase: 'form', mode: 'new', name, firstSessionRequired: true, firstSessionExperience: setupState.firstSessionExperience ?? 'chat', parent };
  });
  registerAction('pilot:preview-new', async input => {
    if (setupState?.mode !== 'new') throw new Error('Сначала нажмите «Создать проект».');
    const parent = setupState.parent, name = input?.name, firstSessionExperience = setupState.firstSessionExperience ?? 'chat';
    if (typeof parent !== 'string' || !path.isAbsolute(parent)) throw new Error('Сначала выберите расположение папки для проектов.');
    setupState = { phase: 'checking', mode: 'new', parent, name, firstSessionRequired: true, firstSessionExperience }; publish();
    const preview = await workspaceSetup.preview({ mode: 'new', parent, name });
    setupState = { ...preview, phase: 'preview', parent, name, firstSessionRequired: true, firstSessionExperience };
  });
  registerAction('pilot:refresh-setup', async () => {
    if (!setupState) return;
    const { mode, parent, name, workspace } = setupState;
    const firstSessionExperience = setupState.firstSessionExperience ?? 'chat';
    setupState = { phase: 'checking', mode, parent, name, workspace, firstSessionRequired: setupState.firstSessionRequired, firstSessionExperience }; startupError = null; publish();
    const preview = await workspaceSetup.preview({ mode, parent, name, workspace });
    const firstSessionRequired = !store.project(preview.workspace);
    setupState = { ...preview, phase: 'preview', parent, name: preview.name, firstSessionRequired, firstSessionExperience: firstSessionRequired ? firstSessionExperience : 'chat' };
  });
  registerAction('pilot:set-first-session-experience', input => {
    if (!setupState?.firstSessionRequired || !['chat', 'work'].includes(input)) throw new Error('Выберите Chat или Work для первой сессии.');
    setupState = { ...setupState, firstSessionExperience: input };
    return input;
  });
  registerAction('pilot:cancel-setup', cancelSetup);
  registerAction('pilot:apply-setup', async input => {
    if (!setupState?.token || input?.token !== setupState.token) throw new Error('Сначала проверьте выбранную папку.');
    if (input.experience !== undefined && !['chat', 'work'].includes(input.experience))
      throw new Error('Выберите Chat или Work для первой сессии.');
    const firstSessionRequired = !!setupState.firstSessionRequired;
    const requestedExperience = input.experience ?? setupState.firstSessionExperience;
    const firstSessionExperience = firstSessionRequired && requestedExperience === 'work' ? 'work' : 'chat';
    setupState = { ...setupState, phase: 'applying', error: null }; startupError = null; publish();
    const generation = navigationId;
    const result = await workspaceSetup.apply(input.token);
    if (!navigationCurrent(generation)) return;
    setupState = { ...result, phase: 'preview', mode: 'existing', firstSessionRequired, firstSessionExperience };
    if (!result.ready) return;
    workspaceHealth = result;
    const project = await store.select(result.workspace, { experience: firstSessionExperience, isCurrent: () => navigationCurrent(generation) });
    if (!navigationCurrent(generation) || !project) return;
    workspaceHealth = { ...workspaceHealth, generation };
    setupState = null; publish(); void navigate(project, { generation, freshDraft: firstSessionRequired });
  });
  registerAction('pilot:choose-workspace', async () => {
    pauseForSetup();
    const result = await dialog.showOpenDialog(window, { title: 'Открыть папку проекта',
      buttonLabel: 'Проверить папку', properties: ['openDirectory'], defaultPath: path.join(os.homedir(), 'VSCODE') });
    if (result.canceled) { cancelSetup(); return; }
    return reviewWorkspace(result.filePaths[0]);
  });
  registerAction('pilot:select-workspace', input => {
    if (typeof input !== 'string' || !store.project(input)) throw new Error('Выберите проект из списка.');
    return store.setExpanded(input,true).then(()=>selectWorkspace(input, { latest: false }));
  }, { navigation: true });
  registerAction('pilot:select-session', async input => {
    if (storageError) throw new Error('Сначала нужно восстановить сохранённый список проектов.');
    if (typeof input?.workspace !== 'string' || typeof input?.sessionId !== 'string') throw new Error('Выберите сессию из дерева проекта.');
    return openConnectedSession(input.workspace, input.sessionId);
  }, { navigation: true });
  registerAction('pilot:set-expanded', input => {
    if (storageError) throw new Error('Сначала нужно восстановить сохранённый список проектов.');
    return store.setExpanded(input?.workspace, input?.expanded);
  });
  registerAction('pilot:new-session', async input => {
    if (typeof input?.workspace !== 'string' || !['chat', 'work'].includes(input?.experience)) throw new Error('Выберите проект и тип новой сессии.');
    if (!store.project(input.workspace)) throw new Error('Выберите активный проект.');
    if (!await reviewWorkspace(input.workspace, true)) return;
    const generation = navigationId;
    await store.select(input.workspace, { isCurrent: () => navigationCurrent(generation) });
    if (!navigationCurrent(generation)) return;
    const project = await store.newSession(input.workspace, input.experience);
    if (!navigationCurrent(generation)) return;
    startupError = null; void navigate(project, { generation, freshDraft: true });
  });
  registerAction('pilot:return-chat', async () => { const current = store.selected(); if (current) await selectWorkspace(current.workspace); }, { navigation: true });
  registerAction('pilot:retry', async () => {
    const selected = store.selected(); if (selected && !await reviewWorkspace(selected.workspace, true)) return;
    startupError = null;
    const current = store.selected();
    if (current) workspaceHealth = { ...workspaceHealth, sessionId: current.sessionId };
    if (attachController(current)) await controller.retry();
  });
  registerAction('pilot:reload', async () => { startupError = null; const current = store.selected(); if (current) await selectWorkspace(current.workspace); else void navigate(); }, { navigation: true });

  ipcMain.handle('archive:get-state', event => { assertArchiveSender(event); return archiveSnapshot(); });
  registerArchiveAction('archive:restore', async input => {
    const projects = archiveRecords(input);
    for (const project of projects) {
      if (deletion.isPending(project.workspace)) throw new Error('Сначала завершите подтверждённое удаление.');
    }
    for (const project of projects) await store.setArchived(project.workspace, false);
    deletion.clear(); archiveState = { deletion: null, notice: `Возвращено в активные: ${projects.length}.`, focusWorkspace: null };
    return projects.length;
  });
  registerArchiveAction('archive:forget', async input => {
    const projects = archiveRecords(input);
    for (const project of projects) if (deletion.isPending(project.workspace)) throw new Error('Сначала завершите подтверждённое удаление.');
    const count = await store.forgetArchivedMany(projects.map(project => ({ workspace: project.workspace, projectId: project.projectId })));
    deletion.clear(); archiveState = { deletion: null, notice: `Убрано из списка: ${count}. Папки на диске сохранены.`, focusWorkspace: null };
    return count;
  });
  registerArchiveAction('archive:restore-sessions', async input => {
    const records = sessionArchiveRecords(input);
    for (const { project, session } of records) await store.setSessionArchived(project.workspace, session.sessionId, false);
    archiveState = { ...archiveState, notice: `Возвращено сессий: ${records.length}.` };
    return records.length;
  });
  registerArchiveAction('archive:delete-sessions', async input => {
    const records = sessionArchiveRecords(input);
    const count = await store.forgetArchivedSessions(records.map(({ project, session }) => ({ workspace: project.workspace, projectId: project.projectId, sessionId: session.sessionId })));
    archiveState = { ...archiveState, notice: `Удалено локальных сессий: ${count}. Облачные чаты ChatGPT сохранены.` };
    return count;
  });
  registerArchiveAction('archive:preview-delete', async input => {
    const [project] = archiveRecords([input], { single: true });
    archiveState = { deletion: null, notice: 'Проверяем содержимое папки…', focusWorkspace: project.workspace }; publishArchive();
    const preview = await deletion.preview(project.workspace);
    archiveState = { deletion: preview, notice: null, focusWorkspace: project.workspace }; return preview;
  });
  registerArchiveAction('archive:cancel-delete', () => { deletion.clear(); archiveState = { ...archiveState, deletion: null, notice: null }; });
  registerArchiveAction('archive:delete-project', async input => {
    if (!archiveState.deletion || input?.token !== archiveState.deletion.token) throw new Error('Откройте подтверждение удаления заново.');
    await deletion.apply(input.token, input.confirmation);
    archiveState = { deletion: null, notice: 'Папка и локальная история удалены. Чаты ChatGPT сохранены.', focusWorkspace: null };
  });
  registerArchiveAction('archive:recover-deletions', async () => {
    const errors = await deletion.recover();
    archiveState = { deletion: null, notice: errors.length ? null : 'Локальная очистка завершена.', focusWorkspace: errors[0]?.workspace ?? null };
    if (errors.length) throw Object.assign(new Error(errors[0].message), { code: errors[0].code });
  });
  ipcMain.handle('archive:close', event => { assertArchiveSender(event); archiveWindow?.close(); return { ok: true }; });
}

async function createWindow() {
  window = new BaseWindow({ name: 'main-window', title: smoke ? 'Project Web Pilot — TEST FIXTURE' : 'Project Web Pilot',
    focusable:!smoke,
    width: 1440, height: 940, minWidth: 980, minHeight: 700, backgroundColor: shellBackground[shellTheme],
    windowStatePersistence: { bounds: true, displayMode: false } });
  sidebar = new WebContentsView({ webPreferences: { preload: path.join(sourceDir, 'preload.cjs'),
    nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  window.contentView.addChildView(sidebar);
  selectLiveSession(null);
  colorEditor = new ChatColorsWindow({
    passive:smoke,
    sourceDir, getBounds: () => window?.getBounds(),
    getState: () => ({ colors: { ...chatColors }, defaults: DEFAULT_COLORS[shellTheme], theme: shellTheme }),
    change: input => { const { key, value } = validateColorChange(input); return setChatColors({ ...chatColors, [key]: value }); },
    reset: () => setChatColors({}),
  });
  sidebar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  sidebar.webContents.on('will-navigate', event => event.preventDefault());
  sidebar.webContents.on('did-start-loading', () => { sidebarReady = false; lastSidebarStateSignature = null; });
  sidebar.webContents.on('did-finish-load', () => { sidebarReady = true; lastSidebarStateSignature = null; publish(); });
  window.on('resize', layout);
  window.on('focus', () => { void planMonitor.refresh(); planReview.refresh(); observeStartupClipboard(); });
  window.on('close',()=>liveSessions.hide());
  window.on('closed', () => {
    try {
      ++navigationId; startupClipboard?.dispose(); startupClipboard = null; startupFlow?.dispose(); startupFlow = null;
      autoPlan.dispose(); execution.dispose(); conversationRecovery.reset(); controller?.cancel(); planMonitor.close();
      reviewContinuation.dispose(); planReview.dispose();
      if (eventRuntimeCheckerTimer !== null) clearInterval(eventRuntimeCheckerTimer);
      eventRuntimeCheckerTimer = null; liveSessions.dispose(); contextCache.clear(); workspaceSetup.invalidateReadiness();
      chromiumDiagnostics = null;
    } finally {
      // Auth/help popups and hidden auxiliary windows must not keep the UI alive.
      // Independent MCP/tunnel processes are deliberately not stopped here.
      for (const child of BrowserWindow.getAllWindows()) if (!child.isDestroyed()) child.destroy();
      for (const view of [sidebar]) if (view && !view.webContents.isDestroyed())
        view.webContents.close({ waitForBeforeUnload: false });
      window = null;
      if (!smoke) app.quit();
    }

  });
  layout();
  // Observe the first request, including failure before a document ever loads.
  if (smoke) {
    await fsp.mkdir(dataDir + '-projects', { recursive: true });
    runtime = await fixture.createRuntime({ browser: browser.webContents, session: session.fromPartition(partition), dataDir });
  } else {
    runtime = ensureRuntimeSwitcher().createRuntime(chatgptChannel, activateRuntime);
    // Installed services are brought up before the window is ready, as before. A computer where they are not
    // installed yet is left to the first-run wizard, which shows progress. A failure here is shown in the
    // sidebar and the next use of the services tries again: it must never keep the app from opening.
    if (await appServerRuntime.prepared() && (process.platform !== 'darwin' || await inspectMacGit()))
      await activateRuntime().catch(error => { startupError = publicError(error); });
  }
  connectController();
  createStartupFlow();
  registerIpc();
  await sidebar.webContents.loadURL(sidebarUrl);
  if (startupFlow) void startupFlow.check({ prepare: startupActive });
  if (eventRuntimeChecker) {
    eventRuntimeCheckerTimer = setInterval(checkEventRuntimeState, 2000);
    eventRuntimeCheckerTimer.unref?.();
  }
  if (smoke) {
    await fixture.run({ app, window, browser: browser.webContents, sidebar: sidebar.webContents,
      store, controller, selectWorkspace, workspaceSetup, snapshot, assertLocalSender, permissionAllowed, dataDir,
      chromiumDiagnostics, chromiumDiagnosticsFile, navigate, openArchiveWindow, getArchiveWindow: () => archiveWindow,
      getColorWindow: () => colorEditor.window, chatColorStyles, eventBaseline, runtimeMetrics, pageState, autoPlan,
      liveSessions,deletion,execution,getLive:()=>({browser:browser.webContents,controller,pageState,chromiumDiagnostics,chatColorStyles}) });
    await chromiumDiagnostics.stop(); chromiumDiagnostics = null;
    window.close(); app.quit();
  } else { const current = store.selected(); if (current && !storageError && !settingsState) void selectWorkspace(current.workspace).catch(report); else void navigate(); }
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Project Web Pilot', submenu: [{ role: 'about', label: 'О Project Web Pilot' }, { type: 'separator' },
      { role: 'hide', label: 'Скрыть' }, { role: 'quit', label: 'Завершить Project Web Pilot' }] },
    { label: 'Правка', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Вид', submenu: [{ label: 'Обновить ChatGPT', accelerator: 'CmdOrCtrl+R', click: () => { const current = store.selected(); if (current) void selectWorkspace(current.workspace).catch(report); else if (browser) void navigate(); } },
      { role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));
}

if (!smoke && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(async () => {
    if (smoke) {
      // Fixture windows must never activate the application or steal the user's desktop focus.
      if(process.platform==='darwin')app.setActivationPolicy('accessory');
      fixture = await import('../tests/electron-smoke.mjs');
      await fixture.prepareStartup({ dataDir });
    }
    try {
      const settings = JSON.parse(await fsp.readFile(settingsFile, 'utf8'));
      // Settings of earlier versions name the folder of the retired runtime; it is only cleaned up now.
      legacyRuntimeRetired = settings[legacyRetiredSetting] === true;
      legacyRuntimeRoots = [...new Set([...(Array.isArray(settings.legacyRuntimeRoots) ? settings.legacyRuntimeRoots : []),
        settings.runtimeFolder, settings.runtimeRegistration?.folder]
        .filter(folder => typeof folder === 'string' && path.isAbsolute(folder)))].slice(0, 8);
      if (CHATGPT_CHANNELS.includes(settings.chatgptChannel)) chatgptChannel = settings.chatgptChannel;
      if (['light', 'dark'].includes(settings.shellTheme)) shellTheme = settings.shellTheme;
      if (typeof settings.hideToolCalls === 'boolean') hideToolCalls = settings.hideToolCalls;
      parallelExecution = validateParallelSettings(settings.parallelExecution);
      if(settings.parallelExecutionBook&&typeof settings.parallelExecutionBook==='object'&&!Array.isArray(settings.parallelExecutionBook))
        parallelExecutionBook=settings.parallelExecutionBook;
      const restored=new ProjectAutoPlan({saved:settings.projectAutoPlan});projectAutoPlan.book=restored.snapshot();
      reviewCheckpoint = settings.reviewCheckpoint ?? null;
      automationCheckpoint = settings.automationCheckpoint ?? null;
      chatColors = normalizeChatColors(settings.chatColors);
      if (Number.isFinite(settings.sidebarWidth)) sidebarWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.round(settings.sidebarWidth));
      if (typeof settings.projectsParent === 'string' && path.isAbsolute(settings.projectsParent)) projectsParent = settings.projectsParent;
    } catch (error) { if (error.code !== 'ENOENT') startupError = { code: 'SETTINGS_INVALID', message: 'Не удалось прочитать локальные настройки Web Pilot. Проверьте настройки подключения.' }; }
    emptyAutoPlan.restore(false);
    execution.book=parallelExecutionBook;
    automationSend.restore(automationCheckpoint);
    reviewContinuation.restore(reviewCheckpoint);
    applyShellTheme(shellTheme);
    try { await store.load(); } catch (error) { startupError = publicError(error); storageError = true; }
    if(!storageError) {
      const before={projectAutoPlan:projectAutoPlan.snapshot(),parallelExecutionBook,reviewCheckpoint,automationCheckpoint};
      const cleaned=pruneOrphanProjectSettings(before,store.snapshot().projects);
      if(JSON.stringify(before)!==JSON.stringify(cleaned)) {
        projectAutoPlan.book=cleaned.projectAutoPlan;parallelExecutionBook=cleaned.parallelExecutionBook;execution.book=parallelExecutionBook;
        reviewCheckpoint=cleaned.reviewCheckpoint;automationCheckpoint=cleaned.automationCheckpoint;
        automationSend.entries.clear();automationSend.cycles.clear();automationSend.restore(automationCheckpoint);
        reviewContinuation.stops.clear();reviewContinuation.restore(reviewCheckpoint);await saveSettings();
      }
    }
    if (!smoke && app.isPackaged && process.platform === 'darwin' && !storageError
        && await offerMacInstallation({ app, dialog, fresh: store.snapshot().projects.length === 0 })) return;
    if (process.platform === 'win32') {
      const payloadFile = app.isPackaged
        ? path.join(process.resourcesPath, 'windows-payload', WINDOWS_RUNTIME_ARCHIVE)
        : path.join(sourceDir, '../.harness/runtime/windows-payload', WINDOWS_RUNTIME_ARCHIVE);
      windowsBootstrap = new WindowsExecutorBootstrap({ payloadFile, stateDir: runtimeFolder });
    }
    deletion = new WorkspaceDeletion({ store, git:store.git, journalDir: path.join(dataDir, 'deletions'), protectedPaths: [app.getAppPath(), runtimeFolder], prepare:prepareProjectRemoval, cleanup:cleanupDeletedProject, purgeState:(dir,identities)=>{
      settingsSaveTail=queueProjectStatePurge(settingsSaveTail,dir,identities);return settingsSaveTail;
    } });
    if (!storageError) {
      const errors = await deletion.recover();
      if (errors.length) { startupError = errors[0]; settingsState = { workspace: errors[0].workspace }; }
    }
    const remoteSession = session.fromPartition(partition);
    remoteSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const origin = details?.securityOrigin ?? details?.requestingUrl ?? contents.getURL();
      callback(permissionAllowed(permission, origin, details, contents));
    });
    remoteSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
      const origin = details?.securityOrigin ?? requestingOrigin ?? details?.requestingUrl;
      return permissionAllowed(permission, origin, details, _contents);
    });
    installMenu();
    await createWindow();
    if(!storageError&&!smoke)for(const [workspace,state] of Object.entries(projectAutoPlan.book))if(state.enabled) {
      const project=store.project(workspace,state.sessionId);
      if(project?.chatUrl&&!project.archivedAt&&!project.sessionArchivedAt)void restoreExecutionPage(project).catch(report);
    }
    if(!storageError&&!smoke)for(const project of store.snapshot().projects)if(!project.parentWorkspace&&!project.archivedAt
      &&(project.sessions.some(s=>s.executionSnapshot?.parallel_allowed)||Object.values(parallelExecutionBook).some(b=>b?.workspace===project.workspace))) {
      execution.observe(project.workspace);void execution.signal(project.workspace);
    }
  }).catch(error => {
    console.error('Project Web Pilot:', smoke ? (error.stack || error) : error.message);
    if (!smoke) dialog.showErrorBox('Project Web Pilot', error.message);
    app.exit(1);
  });
}
