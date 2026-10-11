import { createProgress, operationLabel } from './progress.mjs';
import { settingsPanelView } from './settings-panel.mjs';
import { workspaceSetupView } from './workspace-setup.mjs';
import { executionFinalStages } from '../execution-projection.mjs';
const $ = id => document.getElementById(id);
const api = window.webPilot;
let lastProjects = '';
let currentState;
let actionPending = false, pendingAction = null, actionGeneration = 0;
const navigationActions = new Set(['selectWorkspace', 'selectSession', 'reload', 'returnToChat']);
const progress = createProgress($('operation-progress'));
window.addEventListener('pagehide', () => progress.destroy());
const sessionScroll = new Map();
const renameDialog = $('rename-dialog');
const renameInput = $('rename-dialog-input');
const renameDialogTitle = $('rename-dialog-title');
const renameDialogLabel = $('rename-dialog-label');
const renameSave = $('rename-dialog-save');
const renameCancel = $('rename-dialog-cancel');
let renameRequest = null, renameSaving = false;

function openRenameDialog({ kind, workspace, sessionId = null, value }) {
  closeTreeMenus();
  renameRequest = { kind, workspace, sessionId };
  renameDialogTitle.textContent = kind === 'session' ? 'Переименовать сессию' : 'Переименовать проект';
  renameDialogLabel.textContent = kind === 'session' ? 'Название сессии' : 'Название проекта в Web Pilot';
  renameInput.value = value ?? '';
  renameSave.disabled = false; renameCancel.disabled = false; renameSaving = false;
  renameDialog.showModal();
  requestAnimationFrame(() => { renameInput.focus(); renameInput.select(); });
}

function closeRenameDialog() {
  if (renameDialog.open) renameDialog.close();
  renameRequest = null; renameSaving = false; renameSave.disabled = false; renameCancel.disabled = false;
}

async function submitRenameDialog() {
  if (!renameRequest || renameSaving) return;
  const value = renameInput.value.trim();
  if (!value) { renameInput.setCustomValidity('Введите название.'); renameInput.reportValidity(); return; }
  renameInput.setCustomValidity(''); renameSaving = true; renameSave.disabled = true; renameCancel.disabled = true;
  try {
    const response = renameRequest.kind === 'session'
      ? await api.renameSession(renameRequest.workspace, renameRequest.sessionId, value)
      : await api.renameProject(renameRequest.workspace, value);
    if (!response?.ok) throw new Error(response?.error?.message || 'Не удалось переименовать.');
    if (response.state) render(response.state);
    closeRenameDialog();
  } catch (error) {
    $('error-banner').hidden = false; $('error-banner').textContent = error.message;
    renameSaving = false; renameSave.disabled = false; renameCancel.disabled = false; renameInput.focus();
  }
}

renameSave.addEventListener('click', submitRenameDialog);
renameCancel.addEventListener('click', closeRenameDialog);
renameDialog.addEventListener('cancel', event => { event.preventDefault(); closeRenameDialog(); });
renameInput.addEventListener('input', () => renameInput.setCustomValidity(''));
renameInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); void submitRenameDialog(); }
  if (event.key === 'Escape') { event.preventDefault(); closeRenameDialog(); }
});

function treeIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'tree-icon'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `#tree-${name}`); svg.append(use);
  return svg;
}
function closeTreeMenus() {
  for (const menu of document.querySelectorAll('.project-menu:popover-open, .session-menu:popover-open')) menu.hidePopover();
}
function bindTreeMenu(button, menu, label) {
  menu.setAttribute('popover', 'auto'); menu.setAttribute('aria-label', label);
  button.setAttribute('aria-label', label); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-haspopup', 'true');
  menu.addEventListener('toggle', event => button.setAttribute('aria-expanded', String(event.newState === 'open')));
  button.addEventListener('click', () => {
    if (menu.matches(':popover-open')) { menu.hidePopover(); return; }
    $('project-actions').open = false;
    menu.showPopover();
    const rect = button.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, rect.bottom + menu.offsetHeight + 14 <= innerHeight ? rect.bottom + 6 : rect.top - menu.offsetHeight - 6)}px`;
  });
}
document.addEventListener('click', event => { if (!$('project-actions').contains(event.target)) $('project-actions').open = false; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') $('project-actions').open = false; });
document.addEventListener('scroll', event => { if (!event.target.closest?.('[popover]')) closeTreeMenus(); }, true);
window.addEventListener('resize', closeTreeMenus);
$('project-actions').addEventListener('toggle', () => { if ($('project-actions').open) {closeTreeMenus();$('project-search').focus();} });
$('toggle-projects').addEventListener('click', async () => {
  if (actionPending || !currentState) return;
  const root=currentState.selected?.parentWorkspace??currentState.selected?.workspace;
  const project=currentState.projects.find(p=>p.workspace===root);
  if(project)await action('setExpanded',project.workspace,!project.expanded);
});
let pickerSignature='';
function renderProjectChoices(state) {
  const selected=state.selected?.parentWorkspace??state.selected?.workspace,query=$('project-search').value.trim().toLocaleLowerCase();
  const signature=JSON.stringify([state.projects.map(p=>[p.workspace,p.name,p.activity]),selected,query]);
  if(signature===pickerSignature)return;
  pickerSignature=signature;
  const focused=document.activeElement?.dataset?.projectChoice;
  const choices=state.projects.filter(p=>(p.name+' '+p.workspace).toLocaleLowerCase().includes(query));
  $('project-options').replaceChildren(...choices.map(project=>{
    const button=document.createElement('button');button.type='button';button.dataset.projectChoice=project.workspace;
    button.title=project.workspace;
    if(project.workspace===selected)button.setAttribute('aria-current','page');
    const title=document.createElement('span');title.textContent=project.name;
    const status=document.createElement('small');
    status.textContent=[project.workspace===selected?'Выбран':null,project.activity==='working'?'Работает в фоне':project.activity==='attention'?'Требует внимания':null].filter(Boolean).join(' · ');
    button.append(title);if(status.textContent)button.append(status);
    button.addEventListener('click',()=>{$('project-actions').open=false;action('selectWorkspace',project.workspace);});
    return button;
  }));
  $('project-search-empty').hidden=choices.length>0;
  if(focused)[...$('project-options').children].find(b=>b.dataset.projectChoice===focused)?.focus();
}
$('project-search').addEventListener('input',()=>{if(currentState)renderProjectChoices(currentState);});
$('project-archive').addEventListener('click',()=>{$('project-actions').open=false;action('openArchive');});
$('project-actions').addEventListener('keydown',event=>{
  if(!['ArrowDown','ArrowUp','Escape'].includes(event.key))return;
  if(event.key==='Escape'){$('project-actions').open=false;$('project-actions').querySelector('summary').focus();return;}
  const choices=[...$('project-options').querySelectorAll('button')];if(!choices.length)return;
  event.preventDefault();const position=choices.indexOf(document.activeElement),direction=event.key==='ArrowDown'?1:-1;
  choices[(position+direction+choices.length)%choices.length].focus();
});

const phases = {
  selected: ['Готов к началу', 'Войдите в ChatGPT справа и выберите папку проекта слева.', 'neutral'],
  preparing: ['Подготавливаем подключение', 'Проверяем локальные инструменты и связь с ChatGPT.', 'working'],
  'loading-context': ['Получаем контекст проекта', 'Готовим полный пакет для первого сообщения.', 'working'],
  'waiting-login': ['Войдите в ChatGPT', 'После входа Web Pilot продолжит автоматически.', 'working'],
  'waiting-experience': ['Не удалось определить режим ChatGPT', 'Откройте новый Chat или Work. Web Pilot ожидает подтверждения выбранного режима.', 'working'],
  'waiting-composer': ['Ожидаем поле сообщения', 'Откройте доступное поле ChatGPT. Старт продолжится автоматически.', 'working'],
  'waiting-draft': ['В поле есть черновик', 'Закончите или уберите свой черновик. Стартовое сообщение подождёт.', 'working'],
  'waiting-generation': ['Ждём завершения ответа', 'ChatGPT отвечает. Передача контекста начнётся, когда поле освободится.', 'working'],
  'preparing-message': ['Вставляем контекст', 'Передаём подготовленный пакет редактору ChatGPT.', 'working'],
  sending: ['Передаём контекст', 'Отправляем полный контекст проекта одним сообщением.', 'working'],
  'waiting-chat': ['Контекст отправлен', 'Можно продолжать разговор. Адрес чата сохранится при его появлении.', 'success'],
  delivered: ['Контекст передан', 'Полный пакет отправлен в этот чат. Агент кратко подтвердит получение и опишет проект.', 'success'],
  stale: ['Разговор сохранён', 'План изменился. Новый стартовый пакет доступен в новой сессии.', 'neutral'],
  'prepared-stale': ['Пакет в поле устарел', 'Уберите подготовленный черновик и повторите подготовку. Отправка приостановлена.', 'working'],
  'manual-session': ['Разговор сохранён', 'Для полного стартового пакета создайте новую сессию.', 'neutral'],
  'legacy-session': ['Сохранённый чат проекта', 'Для полного стартового пакета создайте новую сессию.', 'neutral'],
  'send-unknown': ['Исход отправки неизвестен', 'Проверьте сообщения в этом чате. Повторной отправки нет; для нового полного пакета создайте новую сессию.', 'neutral'],
  'chat-changed': ['Открыт другой чат', 'Этот чат пока не связан с проектом. Вернитесь к сессии проекта или создайте новую через меню проекта.', 'working'],
  error: ['Не удалось подготовить сессию', 'После исправления причины повторите подготовку.', 'error'],
};

const setupView = workspaceSetupView(action);
const settingsView = settingsPanelView(action);

const splitter = $('sidebar-splitter');
let splitterDrag = null, resizeFrame = 0, requestedSidebarWidth = null;
function requestSidebarWidth(width) {
  requestedSidebarWidth = width;
  if (resizeFrame) return;
  resizeFrame = requestAnimationFrame(async () => {
    resizeFrame = 0;
    const value = requestedSidebarWidth; requestedSidebarWidth = null;
    try {
      const result = await api.setSidebarWidth(value);
      if (result?.state) render(result.state);
    } catch (error) { $('error-banner').hidden = false; $('error-banner').textContent = error.message; }
  });
}
splitter.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  splitterDrag = { pointerId: event.pointerId, startX: event.screenX, startWidth: currentState?.sidebarWidth ?? 312 };
  splitter.classList.add('dragging');
  try { splitter.setPointerCapture(event.pointerId); } catch {}
  event.preventDefault();
});
splitter.addEventListener('pointermove', event => {
  if (!splitterDrag || event.pointerId !== splitterDrag.pointerId) return;
  requestSidebarWidth(splitterDrag.startWidth + event.screenX - splitterDrag.startX);
});
function finishSplitter(event) {
  if (!splitterDrag || event.pointerId !== splitterDrag.pointerId) return;
  requestSidebarWidth(splitterDrag.startWidth + event.screenX - splitterDrag.startX);
  splitterDrag = null; splitter.classList.remove('dragging');
}
splitter.addEventListener('pointerup', finishSplitter);
splitter.addEventListener('pointercancel', finishSplitter);
splitter.addEventListener('keydown', event => {
  if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
  event.preventDefault(); requestSidebarWidth((currentState?.sidebarWidth ?? 312) + (event.key === 'ArrowRight' ? 24 : -24));
});

async function action(method, ...args) {
  if (actionPending) return;
  closeTreeMenus();
  $('project-actions').open = false;
  if (['selectWorkspace', 'newSession'].includes(method)) {
    sessionScroll.set(args[0], 0);
    for (const list of $('projects').querySelectorAll('.sessions')) if (list.dataset.workspace === args[0]) list.scrollTop = 0;
  }
  const generation = ++actionGeneration, navigation = navigationActions.has(method);
  if (!navigation) { actionPending = true; pendingAction = method; }
  render(currentState);
  try {
    const result = await api[method](...args);
    if (generation === actionGeneration && result?.state) render(result.state);
  } catch (error) {
    if (generation === actionGeneration) {
      $('error-banner').hidden = false;
      $('error-banner').textContent = error.message;
    }
  } finally {
    if (!navigation) { actionPending = false; pendingAction = null; }
    if (generation === actionGeneration) render(currentState);
  }
}

// Agent time: current (or last) request and the session total, in minutes and seconds.
let agentTicker = null;
let executorTicker = null;
const agentClock = ms => { const seconds = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0'); };
const agentSpoken = ms => { const seconds = Math.max(0, Math.floor(ms / 1000)); return Math.floor(seconds / 60) + ' мин ' + seconds % 60 + ' с'; };
function renderAgentTime(selected) {
  const node = $('agent-time'), run = selected?.agentRun ?? null;
  const saved = selected?.agentTime ?? { totalMs: 0, lastMs: 0 };
  clearInterval(agentTicker); agentTicker = null;
  node.hidden = !selected;
  if (!selected) return;
  const running = !!run && !run.paused;
  const paint = () => {
    const current = run ? Math.max(0, (running ? Date.now() : run.lastBusyAt) - run.startedAt) : saved.lastMs;
    const total = saved.totalMs + (run ? current : 0);
    node.textContent = agentClock(current) + ' · Σ ' + agentClock(total);
    node.setAttribute('aria-label', 'Время работы агента: ' + (run ? 'текущее' : 'последнее') + ' задание ' + agentSpoken(current) + ', всего за сессию ' + agentSpoken(total));
  };
  node.dataset.running = String(running);
  node.title = 'Время, которое агент работает над заданием (идёт, пока ChatGPT отвечает). Σ — сумма за эту сессию.';
  paint();
  if (running) agentTicker = setInterval(paint, 1000);
}
function kitUpgradeNeeded(health) {
  return health?.phase === 'error' && health.action === 'upgrade' && !health.error && !health.issues?.length;
}

function renderExecutorTimes() {
  clearInterval(executorTicker);executorTicker=null;
  const nodes=[...document.querySelectorAll('[data-executor-time]')];
  const paint=()=>{for(const node of nodes) {
    const time=node.executorTime??{},delta=Math.max(0,Date.now()-(time.asOf??Date.now()));
    const active=(time.activeMs??0)+(time.phase==='working'?delta:0),waiting=(time.waitingMs??0)+(time.phase==='waiting'?delta:0);
    node.textContent='Работа '+agentClock(active)+' · ожидание '+agentClock(waiting);
    node.setAttribute('aria-label','Наблюдаемая работа '+agentSpoken(active)+', ожидание '+agentSpoken(waiting));
  }};
  paint();if(nodes.some(node=>['working','waiting'].includes(node.executorTime?.phase)))executorTicker=setInterval(paint,1000);
}

function render(state) {
  progress.show(operationLabel(state ?? {}, pendingAction));
  if (!state) return;
  $('prototype-version').textContent = state.version ?? '';
  renderProjectChoices(state);
  for (const list of $('projects').querySelectorAll('.sessions')) {
    if (!list.closest('[hidden]')) sessionScroll.set(list.dataset.workspace, list.scrollTop);
  }
  const previousProjects = currentState?.projects ?? [];
  currentState = state;
  splitter.setAttribute('aria-valuemin', String(state.sidebarMinWidth ?? 312));
  splitter.setAttribute('aria-valuenow', String(state.sidebarWidth ?? 312));
  const selected = state.selected;
  const context = state.context;
  const signature = JSON.stringify([state.projects, selected?.workspace, selected?.sessionId]);
  if (signature !== lastProjects) {
    lastProjects = signature;
    const outerScroll = $('projects').scrollTop;
    const executorDisclosure=new Map([...$('projects').querySelectorAll('[data-executor-group]')].map(node=>[node.dataset.executorGroup,node.open]));
    const oldProject = previousProjects.find(project => project.workspace === selected?.workspace);
    if (selected && !oldProject?.sessions.some(session => session.sessionId === selected.sessionId)) sessionScroll.set(selected.workspace, 0);
    closeTreeMenus();
    const fragment = document.createDocumentFragment();
    const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    for (const project of state.projects.filter(p=>p.workspace===(selected?.parentWorkspace??selected?.workspace))) {
      const item = document.createElement('li'); item.className = 'workspace-tree';
      const activeProject = project.workspace === (selected?.parentWorkspace??selected?.workspace);
      const row = document.createElement('div'); row.className = 'workspace-row' + (activeProject ? ' active' : '');
      const toggle = () => action('setExpanded', project.workspace, !project.expanded);
      const arrow = document.createElement('button'); arrow.className = 'expand-project';
      arrow.append(treeIcon('chevron-right'));
      arrow.setAttribute('aria-label', `${project.expanded ? 'Свернуть' : 'Раскрыть'} сессии ${project.name}`);
      arrow.setAttribute('aria-expanded', String(project.expanded));
      arrow.addEventListener('click', toggle);
      const button = document.createElement('button');
      button.className = 'project' + (activeProject ? ' active' : '');
      button.dataset.workspace = project.workspace;
      button.setAttribute('aria-pressed', String(activeProject));
      button.setAttribute('aria-expanded', String(project.expanded));
      button.title = `${project.workspace}\nОткрыть последнюю сессию`;
      const label = document.createElement('span'); label.className = 'project-copy';
      const name = document.createElement('strong'); name.textContent = project.name;
      const caption = document.createElement('small');
      const count = project.sessions.length;
      caption.textContent = `${count} ${count % 10 === 1 && count % 100 !== 11 ? 'сессия' : count % 10 >= 2 && count % 10 <= 4 && !(count % 100 >= 12 && count % 100 <= 14) ? 'сессии' : 'сессий'}`;
      label.append(name, caption); button.append(treeIcon(project.expanded ? 'folder-open' : 'folder'), label);
      button.addEventListener('click', () => action('selectWorkspace', project.workspace));
      button.addEventListener('keydown', event => {
        if ((event.key === 'ArrowRight' && !project.expanded) || (event.key === 'ArrowLeft' && project.expanded)) { event.preventDefault(); toggle(); }
      });
      const menuButton = document.createElement('button'); menuButton.className = 'icon-button project-menu-button'; menuButton.append(treeIcon('ellipsis'));
      const menu = document.createElement('div'); menu.className = 'project-menu';
      bindTreeMenu(menuButton, menu, `Меню проекта ${project.name}`);
      const menuAction = (className, text, handler) => {
        const control = document.createElement('button'); control.className = `secondary ${className}`; control.textContent = text;
        control.addEventListener('click', () => { closeTreeMenus(); handler(); });
        menu.append(control);
      };
      menuAction('new-project-chat', 'Новый Chat', () => action('newSession', project.workspace, 'chat'));
      menuAction('new-project-work', 'Новый Work', () => action('newSession', project.workspace, 'work'));
      const separator = document.createElement('div'); separator.className = 'menu-separator'; separator.setAttribute('aria-hidden', 'true'); menu.append(separator);
      menuAction('rename-project', 'Переименовать', () => openRenameDialog({
        kind: 'project', workspace: project.workspace, value: project.name,
      }));
      menuAction('copy-workspace-path', 'Скопировать полный путь', () => action('copyWorkspacePath', project.workspace));
      menuAction('copy-external-client-line', 'Скопировать строку для внешнего клиента', () => action('copyExternalClientLine', project.workspace));
      menuAction('archive-project', 'Перенести в архив', () => action('archiveProject', project.workspace));
      row.append(arrow, button, menuButton); item.append(row, menu);
      const sessions = document.createElement('ul'); sessions.className = 'sessions'; sessions.hidden = !project.expanded;
      sessions.dataset.workspace = project.workspace;
      sessions.setAttribute('aria-label', `Сессии ${project.name}, новые сверху`);
      sessions.tabIndex = 0;
      sessions.addEventListener('scroll', () => {
        if (sessions.isConnected && !sessions.closest('[hidden]')) sessionScroll.set(project.workspace, sessions.scrollTop);
      }, { passive: true });
      for (const session of project.sessions) {
        const entry = document.createElement('li');
        const row = document.createElement('div'); row.className = 'session-row';
        const choice = document.createElement('button');
        const active = activeProject && selected?.sessionId === session.sessionId;
        choice.className = 'session' + (active ? ' active' : '');
        choice.dataset.sessionId = session.sessionId;
        if (active) choice.setAttribute('aria-current', 'page');
        const copy = document.createElement('span'); copy.className = 'session-copy';
        const title = document.createElement('strong'); title.textContent = session.title || 'Новая сессия';
        const date = document.createElement('small');
        date.textContent = dateFormat.format(new Date(session.createdAt)) + (session.chatUrl ? '' : ' · новая');
        copy.append(title, date);
        const experience = document.createElement('span'); experience.className = 'session-experience'; experience.dataset.experience = session.experience ?? 'chat'; experience.textContent = session.experience === 'work' ? 'Work' : 'Chat';
        choice.title = `${session.title || 'Новая сессия'} · ${experience.textContent}\n${new Date(session.createdAt).toLocaleString('ru-RU')}`;
        choice.append(copy, experience);
        choice.addEventListener('click', () => action('selectSession', project.workspace, session.sessionId));
        const menuButton = document.createElement('button'); menuButton.className = 'icon-button session-menu-button'; menuButton.append(treeIcon('ellipsis'));
        const menu = document.createElement('div'); menu.className = 'session-menu';
        bindTreeMenu(menuButton, menu, `Меню сессии ${session.title || 'Новая сессия'}`);
        const rename = document.createElement('button'); rename.className = 'secondary rename-session'; rename.textContent = 'Переименовать';
        rename.addEventListener('click', () => openRenameDialog({
          kind: 'session', workspace: project.workspace, sessionId: session.sessionId, value: session.title || 'Новая сессия',
        }));
        const archive = document.createElement('button'); archive.className = 'secondary archive-session'; archive.textContent = 'Перенести в архив';
        archive.addEventListener('click', () => { closeTreeMenus(); action('archiveSession', project.workspace, session.sessionId); });
        menu.append(rename, archive);
        row.append(choice, menuButton); entry.append(row, menu); sessions.append(entry);
      }
      item.append(sessions);
      const origins=[...new Set((project.executors??[]).map(executor=>executor.originSessionId))];
      for(const origin of origins) {
        const group=document.createElement('details');group.className='executor-group';group.hidden=!project.expanded;
        group.dataset.executorGroup=project.workspace+'\n'+origin;
        group.open=executorDisclosure.get(group.dataset.executorGroup)??true;
        const heading=document.createElement('summary');
        const source=project.sessions.find(session=>session.sessionId===origin);
        heading.textContent='Исполнители · '+(source?.title||'основная сессия');group.append(heading);
        const list=document.createElement('ul');list.className='executor-list';list.setAttribute('aria-label','Исполнители основной сессии');
        for(const executor of project.executors.filter(entry=>entry.originSessionId===origin)) {
          const row=document.createElement('li'),choice=document.createElement('button');choice.className='executor-row';
          choice.dataset.sessionId=executor.sessionId;choice.dataset.phase=executor.phase;
          if(executor.sessionId===selected?.sessionId)choice.setAttribute('aria-current','page');
          const name=document.createElement('strong');name.textContent=executor.title||executor.taskId;
          const caption=document.createElement('span');caption.textContent=executor.taskId+' · worktree · '+(executor.experience==='work'?'Work':'Chat');
          const status=document.createElement('span');status.className='executor-status';status.textContent=executor.label;
          const time=document.createElement('span');time.dataset.executorTime=executor.sessionId;time.executorTime=executor.time;
          choice.title=executor.workspace;choice.append(name,caption,status,time);
          choice.addEventListener('click',()=>action('selectSession',executor.workspace,executor.sessionId));
          row.append(choice);list.append(row);
        }
        group.append(list);item.append(group);
      }
      fragment.append(item);
    }
    if (!selected) {
      const empty = document.createElement('li'); empty.className = 'empty';
      empty.textContent = 'Откройте меню «Ваши проекты», чтобы создать проект или выбрать его папку.'; fragment.append(empty);
    }
    $('projects').replaceChildren(fragment);
    $('projects').scrollTop = outerScroll;
    for (const workspace of sessionScroll.keys()) if (!state.projects.some(project => project.workspace === workspace)) sessionScroll.delete(workspace);
  }
  const collapseAll = state.projects.some(project => project.workspace===(selected?.parentWorkspace??selected?.workspace)&&project.expanded);
  $('toggle-projects').title = collapseAll ? 'Свернуть сессии проекта' : 'Раскрыть сессии проекта';
  $('toggle-projects').setAttribute('aria-label', $('toggle-projects').title);
  $('plan-card').hidden = !selected || !!selected.assignmentId;
  $('assignment-card').hidden = !selected?.assignmentId;
  const assigned = selected?.assignmentId && state.projects.flatMap(project => project.executors ?? [])
    .find(item => item.assignmentId === selected.assignmentId && item.workspace === selected.workspace);
  $('assignment-title').textContent = assigned?.title ?? selected?.taskId ?? '';
  $('assignment-status').textContent = assigned?.label ?? 'Состояние назначения ещё не подтверждено.';
  renderExecutorTimes();
  const execution=state.execution??{};
  const commandIssues=$('command-issues');
  commandIssues.replaceChildren();
  for(const command of execution.commands??[])if(command.state==='unknown'||command.state==='acknowledged_unknown') {
    const line=document.createElement('p');line.className='description';
    line.textContent=command.reason+' · '+command.id;commandIssues.append(line);
    if(command.canAcknowledge) {
      const button=document.createElement('button');button.className='secondary';button.textContent='Разобрать неизвестный исход';
      button.addEventListener('click',()=>action('acknowledgeCommand',{workspace:command.workspace,projectId:command.projectId,id:command.id,digest:command.digest}));
      commandIssues.append(button);
    }
  }
  const parallel=selected?.planExecution?.execution_strategy==='parallel'||!!selected?.assignmentId;
  $('execution-actions').hidden=!parallel;
  const stages=executionFinalStages(execution);
  const stageList=$('execution-stages');
  stageList.replaceChildren();
  for(const [key,label] of [['source','Источник'],['main','Общий main'],['diagnostic','Диагностика'],
    ['final','Финальное поручение'],['reply','Итоговый ответ']]) {
    const line=document.createElement('li');line.dataset.stage=key;line.dataset.status=stages[key].status;
    const heading=document.createElement('strong');heading.textContent=label;
    const description=document.createElement('span');description.textContent=stages[key].text;
    line.append(heading,description);stageList.append(line);
  }
  $('execution-next-action').textContent=stages.action;
  $('execution-next-action').dataset.attention=String(['unknown','blocked'].includes(stages.main.status)
    ||['unknown'].includes(stages.diagnostic.status)||['unknown'].includes(stages.final.status));
  $('execution-message').textContent=execution.error?.message??({sending:'Поручение исправления отправляется…',sent:'Поручение исправления отправлено. Ждём основной чат.',unknown:'Исход отправки исправления неизвестен. Повтор не отправляется.'}[execution.correctionStatus])??({preparing:'Подготавливаем исполнителей…',merging:'Проверяем слияние в main…',
    complete:'Все результаты интегрированы. Ожидается приёмка.',integration:'Интеграция удерживает main. Другие слияния ждут.',
    paused:'Автовыполнение проекта выключено. Новые задачи и сообщения не запускаются.',waiting:'Состояния исполнителей показаны в дереве. Пауза не означает вопрос пользователя.'}[execution.phase]??'Включите автовыполнение этого проекта для запуска готовых задач.');
  if(execution.finalizationStatus&&!execution.error)$('execution-message').textContent=({
    pending:'Итоговое поручение ожидает готовности основного чата.',
    sending:'Передаём завершение основному чату…',sent:'Ждём итоговый ответ основного чата.',
    unknown:'Исход итоговой отправки неизвестен. Повтор не отправляется.',
    'reply-observed':'Итоговый ответ завершён. Ожидается приёмка.',
  })[execution.finalizationStatus]??$('execution-message').textContent;
  const auto = state.autoPlan ?? { phase: 'off', active: false, message: '' };
  $('auto-plan-toggle').textContent = auto.enabled ? 'Выключить автовыполнение' : 'Включить автовыполнение';
  $('auto-plan-toggle').disabled = actionPending;
  $('auto-plan-toggle').setAttribute('aria-pressed', String(auto.enabled));
  const review=state.planReview??{enabled:false,supported:false,message:''};
  $('plan-review-toggle').textContent=review.enabled?'Выключить Review':'Включить Review';
  $('plan-review-toggle').setAttribute('aria-pressed',String(review.enabled));
  $('plan-review-toggle').disabled=actionPending || !review.supported || !!review.error;
  $('plan-review-message').hidden=!review.message;
  $('plan-review-text').textContent=review.message;
  const reviewIndicator=review.indicator??'none';
  $('plan-review-indicator').hidden=reviewIndicator==='none';
  $('plan-review-indicator').dataset.state=reviewIndicator;
  $('plan-review-indicator').textContent=({success:'✓',attention:'!',waiting:'·'})[reviewIndicator]??'';
  const autoMessage=parallel?(auto.enabled?'Автовыполнение этого проекта включено.':'Автовыполнение этого проекта выключено.'):auto.message;
  const autoSent = !parallel&&auto.continuations > 0 ? `Автоматически отправлено «Продолжай» №${auto.continuations}.` : '';
  $('auto-plan-message').hidden = !autoMessage && !autoSent;
  $('auto-plan-message').textContent = [autoSent, autoMessage].filter(Boolean).join(' ');
  $('auto-plan-message').dataset.reason = auto.reason ?? '';
  $('auto-plan-message').setAttribute('role',auto.phase==='paused'&&auto.reason?.startsWith('ROTATION_')?'alert':'status');

  renderAgentTime(selected);
  const plan = (selected?.planExecution?.execution_strategy==='parallel' ? execution.planView
    : selected?.planView) ?? { state: 'not-created', completed: 0, total: 0, tasks: [], blockedReason: null };
  if (selected) {
    const plural = count => count % 10 === 1 && count % 100 !== 11 ? 'задача'
      : count % 10 >= 2 && count % 10 <= 4 && !(count % 100 >= 12 && count % 100 <= 14) ? 'задачи' : 'задач';
    const completedText = count => count === 1 ? 'Задача выполнена'
      : plural(count) === 'задача' ? `Все ${count} задача выполнена` : `Все ${count} ${plural(count)} выполнены`;
    const statusText = plan.state === 'awaiting-acceptance' ? completedText(plan.total)
      : plan.state === 'blocked' ? `План заблокирован · ${plan.completed} из ${plan.total} выполнено`
        : plan.state === 'closed' ? 'Scope завершён и архивирован'
          : plan.state === 'not-created' ? 'План ещё не создан'
            : `В работе · ${plan.completed} из ${plan.total} выполнено`;
    $('plan-title').hidden = !selected.scopeId;
    $('plan-title').textContent = selected.assignmentId ? execution.objective??'Общий план проекта' : selected.scopeId ? selected.objective : '';
    $('plan-status').textContent = statusText; $('plan-status').dataset.state = plan.state;
    $('plan-note').hidden = plan.state !== 'closed';
    $('plan-note').textContent = plan.state === 'closed' ? 'Проект готов к следующему новому плану.' : '';
    const planReason = selected.planReadError?.message ?? plan.blockedReason ?? '';
    $('plan-reason').hidden = !planReason; $('plan-reason').textContent = planReason;
    $('plan-tasks').replaceChildren(...plan.tasks.map(task => {
      const item = document.createElement('li'); item.className = 'plan-task'; item.dataset.status = task.status;
      const mark = document.createElement('span'); mark.className = 'plan-task-state'; mark.setAttribute('role', 'img');
      // The mark alone means nothing to a screen reader: its status is spoken as text.
      mark.setAttribute('aria-label', task.status === 'done' ? 'выполнена' : task.status === 'current' ? 'текущая' : 'не начата');
      mark.textContent = task.status === 'done' ? '✓' : task.status === 'current' ? '●' : '○';
      const body = document.createElement('div'), title = document.createElement('strong');
      const id=document.createElement('span');id.className='plan-task-id';id.textContent=task.id;
      title.textContent = task.title;
      const mode=document.createElement('small');mode.className='plan-task-mode';mode.textContent=task.executionLabel??'Последовательно';
      const status=document.createElement('small');status.className='plan-task-status';
      status.textContent=task.label??({done:'Выполнена',current:'В работе',pending:'Не начата'})[task.status]??'Состояние не подтверждено';
      body.append(id,title,mode,status);
      item.append(mark, body); return item;
    }));
  } else { $('plan-tasks').replaceChildren(); $('plan-note').hidden = true; $('plan-reason').hidden = true; }
  const [title, detail] = phases[context.phase] ?? phases.selected;
  const attention=['error','prepared-stale','waiting-draft','waiting-login','waiting-experience','chat-changed','send-unknown'].includes(context.phase);
  const started=selected?.manualStart||context.messageSent||['sending','unknown','sent','acknowledged'].includes(selected?.attempt?.state);
  $('session-notice').hidden=!selected||!attention||!!state.setup||!!state.settings;
  $('session-notice-title').textContent=(selected?.title||'Текущая сессия')+' · '+title;
  $('session-notice-detail').textContent=context.error?.message??detail;
  $('retry-context').hidden=started||!['error','prepared-stale'].includes(context.phase);
  $('observe-context').hidden=context.phase!=='send-unknown';
  $('new-context-session').hidden=!started&&context.phase!=='send-unknown';
  $('return-chat').hidden = context.phase !== 'chat-changed';
  $('connection-detail').textContent = state.localRuntime ? `${state.localRuntime.label} · встроенный MCP` : state.runtimeFolder;
  const delivery = context.delivery;
  $('session-detail').textContent = selected ? `Сессия: ${selected.sessionId}`
    + (delivery ? `\nПередано ${(delivery.contextBytes / 1024).toFixed(1)} КБ · план ${delivery.facts.plan_revision}\n${new Date(delivery.sentAtMs).toLocaleString('ru-RU')}` : '')
    + (Number.isFinite(delivery?.preparationMs) ? `\nПодготовка: ${Math.round(delivery.preparationMs)} мс${delivery.cacheHit ? ' · пакет готов заранее' : ''}` : '')
    + (Number.isFinite(delivery?.deliveryMs) ? `\nОтправка: ${(delivery.deliveryMs / 1000).toFixed(2)} с` : '') : '';
  if (state.fixture) $('connection-detail').textContent = 'TEST FIXTURE · без реального аккаунта и MCP';
  const health = state.workspaceHealth;
  const checking = health?.phase === 'checking', unhealthy = health?.phase === 'error';
  $('workspace-health').hidden = !checking && !unhealthy;
  const kitUpgrade = kitUpgradeNeeded(health);
  $('workspace-health-message').textContent = checking ? 'Проверяем проект в фоне…'
    : unhealthy ? (health.error?.message ?? health.issues?.[0]?.reason ?? (kitUpgrade
      ? `Проект использует Workflow Kit ${health.version}. Обновите его до ${health.kitVersion}: планы и документы сохранятся, перед заменой создаётся резервная копия. До обновления чат доступен только для просмотра.`
      : 'Проверка проекта не пройдена. Чат доступен для просмотра.')) : '';
  $('workspace-health-retry').textContent = kitUpgrade ? 'Обновить Workflow Kit' : 'Повторить проверку';
  $('workspace-health-actions').hidden = !unhealthy;
  const error = state.startupError;
  $('error-banner').hidden = !error;
  $('error-banner').textContent = error ? `${error.message} (${error.code})` : '';
  for (const button of document.querySelectorAll('button')) {
    if (button.closest('#startup-panel') || button.id==='open-startup') continue;
    button.disabled = actionPending || (state.storageError && ['create-workspace', 'add-workspace', 'retry-context'].includes(button.id));
  }
  const recovery = state.conversationRecovery;
  $('conversation-recovery').hidden = !recovery || recovery.phase === 'idle' || !!state.setup || !!state.settings;
  $('conversation-recovery-message').textContent = recovery?.message ?? '';
  // A quiet response can be normal tool/review work, not evidence of a connection failure.
  $('reconnect-chat').hidden = !recovery?.canRetry;
  $('reconnect-chat').disabled = actionPending || !recovery?.canRetry;
  setupView.render(state, actionPending);
  settingsView.render(state, actionPending);
  const guidedStartup = !!state.startup?.active && !state.setup && !state.settings;
  $('active-projects').hidden = guidedStartup || !!state.setup || !!state.settings;
  if (guidedStartup) { $('session-notice').hidden = true; $('workspace-health').hidden = true; }

  // Setup briefly hides the tree while checking a folder. Restore only after it is visible.
  for (const list of $('projects').querySelectorAll('.sessions')) {
    if (!list.closest('[hidden]')) {
      const top = sessionScroll.get(list.dataset.workspace) ?? 0;
      if (list.scrollTop !== top) list.scrollTop = top;
    }
  }
}

$('add-workspace').addEventListener('click', () => action('chooseWorkspace'));
$('reload-chat').addEventListener('click', () => action('reload'));
// An outdated Kit opens the regular upgrade preview; the user confirms it there.
$('workspace-health-retry').addEventListener('click', () => action(kitUpgradeNeeded(currentState?.workspaceHealth) ? 'retry' : 'reload'));
$('workspace-health-doctor').addEventListener('click', () => action('openDoctor'));
$('auto-plan-toggle').addEventListener('click', () => action('setAutoPlan', !currentState?.autoPlan?.enabled));
$('plan-review-toggle').addEventListener('click', () => action('setPlanReview', {workspace:currentState?.selected?.workspace,enabled:!currentState?.planReview?.enabled}));
$('reconnect-chat').addEventListener('click', () => action('reconnect'));
$('retry-context').addEventListener('click', () => action('retry'));
$('observe-context').addEventListener('click', () => action('retry'));
$('new-context-session').addEventListener('click', () => {
  const selected=currentState?.selected;
  if(selected&&!selected.assignmentId)action('newSession',selected.workspace,selected.experience??'chat');
});
$('return-chat').addEventListener('click', () => action('returnToChat'));
api.onState(render);
api.getState().then(render).catch(error => { $('error-banner').hidden = false; $('error-banner').textContent = error.message; });
