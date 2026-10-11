import { projectDoctorView } from './project-doctor.mjs';
import { DEFAULT_PARALLEL_SETTINGS, validateParallelSettings } from '../parallel-settings.mjs';
import { DEFAULT_CHAT_SESSION_TASK_LIMIT, validateChatSessionTaskLimit } from '../chat-session-rotation-settings.mjs';

function vpsLine(vps) {
  if (!vps) return 'Состояние VPS ещё не проверено.';
  if (!vps.configured) return 'Свой сервер не настроен.';
  if (vps.conflict) return 'В ~/.ssh/config у vps-mcp-tunnel остался RemoteForward — обновите настройку сервера.';
  if (vps.error) return 'Туннель VPS: ' + vps.error;
  if (vps.ready) return `Туннель VPS работает: сервер → MCP на порту ${vps.mcpPort}.`;
  if (vps.running && !vps.portMatches) return `Туннель VPS ведёт на порт ${vps.forwardPort ?? '—'}, а MCP работает на ${vps.mcpPort ?? '—'}.`;
  const last = vps.lastError ? ` Последняя ошибка (${new Date(vps.lastError.at).toLocaleString('ru-RU')}): ${vps.lastError.message}` : '';
  return 'Туннель VPS не запущен.' + last;
}
export function settingsPanelView(action) {
  const $ = id => document.getElementById(id);
  const doctor = projectDoctorView(action);
  const archiveButton = document.createElement('button');
  archiveButton.id = 'open-archive-window'; archiveButton.type = 'button'; archiveButton.className = 'secondary';
  archiveButton.textContent = 'Архив…'; archiveButton.style.width = '100%'; archiveButton.style.marginTop = '10px';
  $('settings-panel').append(archiveButton);
  archiveButton.addEventListener('click', () => action('openArchive'));
  $('open-chat-colors').addEventListener('click', () => action('openChatColors'));
  $('open-settings').addEventListener('click', () => action(state?.settings ? 'closeSettings' : 'openSettings'));
  $('close-settings').addEventListener('click', () => action('closeSettings'));
  $('theme-light').addEventListener('click', () => action('setTheme', 'light'));
  $('theme-dark').addEventListener('click', () => action('setTheme', 'dark'));
  $('tool-calls-hide').addEventListener('click', () => action('setHideToolCalls', true));
  $('tool-calls-show').addEventListener('click', () => action('setHideToolCalls', false));
  const parallelToggle = $('parallel-allowed'), parallelLimit = $('parallel-max-workers');
  const saveParallel = () => {
    try {
      const value = validateParallelSettings({ parallel_allowed: parallelToggle.checked,
        max_workers: parallelToggle.checked ? parallelLimit.valueAsNumber : (state?.parallelExecution ?? DEFAULT_PARALLEL_SETTINGS).max_workers });
      $('parallel-settings-error').hidden = true;
      parallelLimit.removeAttribute('aria-invalid');
      action('setParallelExecution', value);
    } catch (error) {
      $('parallel-settings-error').textContent = error.message;
      $('parallel-settings-error').hidden = false;
      parallelLimit.setAttribute('aria-invalid', 'true');
    }
  };
  parallelToggle.addEventListener('change', saveParallel);
  parallelLimit.addEventListener('change', saveParallel);
  const chatTaskLimit = $('chat-session-task-limit');
  chatTaskLimit.addEventListener('change', () => {
    try {
      const value = validateChatSessionTaskLimit(chatTaskLimit.valueAsNumber);
      $('chat-session-task-limit-error').hidden = true;
      chatTaskLimit.removeAttribute('aria-invalid');
      action('setChatSessionTaskLimit', value);
    } catch (error) {
      $('chat-session-task-limit-error').textContent = error.message;
      $('chat-session-task-limit-error').hidden = false;
      chatTaskLimit.setAttribute('aria-invalid', 'true');
    }
  });
  $('chatgpt-channel-secure').addEventListener('click', () => action('setChatgptChannel', 'secure-tunnel'));
  $('chatgpt-channel-vps').addEventListener('click', () => action('setChatgptChannel', 'vps'));
  $('chatgpt-channel-refresh').addEventListener('click', () => action('refreshChatgptChannel'));
  $('vps-connector-copy').addEventListener('click', () => action('copyVpsConnectorUrl'));
  let state;
  function render(next, pending) {
    state = next;
    doctor.render(state, pending);
    const theme = state.theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    $('theme-light').setAttribute('aria-pressed', String(theme === 'light'));
    $('theme-dark').setAttribute('aria-pressed', String(theme === 'dark'));
    $('theme-light').disabled = pending; $('theme-dark').disabled = pending;
    $('tool-calls-hide').setAttribute('aria-pressed', String(state.hideToolCalls));
    $('tool-calls-show').setAttribute('aria-pressed', String(!state.hideToolCalls));
    $('tool-calls-hide').disabled = pending; $('tool-calls-show').disabled = pending;
    const parallel = state.parallelExecution ?? DEFAULT_PARALLEL_SETTINGS;
    parallelToggle.checked = parallel.parallel_allowed;
    parallelToggle.disabled = pending;
    $('parallel-options').hidden = !parallel.parallel_allowed;
    parallelLimit.disabled = pending || !parallel.parallel_allowed;
    if (document.activeElement !== parallelLimit) parallelLimit.value = String(parallel.max_workers);
    chatTaskLimit.disabled = pending;
    if (document.activeElement !== chatTaskLimit)
      chatTaskLimit.value = String(state.chatSessionTaskLimit ?? DEFAULT_CHAT_SESSION_TASK_LIMIT);
    // One pair of sections for both systems: the same executor, the same services, the same two channels.
    const isMac = state.platform === 'darwin', isWindows = state.platform === 'win32';
    const supported = isMac || isWindows, system = isWindows ? 'Windows' : 'macOS';
    $('local-runtime-section').hidden = !supported;
    $('chatgpt-channel-section').hidden = !supported;
    if (supported) {
      const localRuntime = state.localRuntime ?? { label: `Codex App Server Local ${isWindows ? 'Windows' : 'Mac'}`, service: null };
      const service = localRuntime.service;
      const viaVps = localRuntime.chatgptChannel === 'vps';
      const ready = !!service?.mcpReady && !!service?.tunnelReady && !!service?.tunnelConfigured;
      $('local-runtime-title').textContent = `Локальные инструменты ${system}`;
      $('local-runtime-help').textContent = `Web Pilot сам устанавливает и запускает локальный MCP. Он запускается при входе в ${system} и при открытии Web Pilot.`;
      $('local-runtime-status').textContent = ready
        ? `${localRuntime.label}: MCP и ${viaVps ? 'канал VPS' : 'Secure MCP Tunnel'} готовы.`
        : `${localRuntime.label}: службы ещё не подтвердили полную готовность.`;
      const vps = localRuntime.vps ?? null;
      $('chatgpt-channel-secure').setAttribute('aria-pressed', String(!viaVps));
      $('chatgpt-channel-vps').setAttribute('aria-pressed', String(viaVps));
      $('chatgpt-channel-secure').disabled = pending;
      // A server that is not set up on this computer, or whose tunnel is down, cannot be chosen;
      // switching back to the tunnel of OpenAI is always possible.
      $('chatgpt-channel-vps').disabled = pending || (!viaVps && !vps?.ready);
      $('chatgpt-channel-refresh').disabled = pending;
      $('chatgpt-channel-status').textContent = viaVps
        ? (service?.tunnelReady ? 'ChatGPT подключается через VPS. Канал готов.' : 'Выбран VPS. Канал ещё не готов — состояние ниже.')
        : (service?.tunnelReady ? 'ChatGPT подключается через Secure MCP Tunnel. Туннель готов.' : 'Выбран Secure MCP Tunnel. Туннель ещё не подтвердил готовность.');
      // The ChatGPT side is a separate plugin per channel; Web Pilot cannot switch it.
      $('chatgpt-channel-hint').textContent = viaVps
        ? 'В ChatGPT включите плагин с адресом своего сервера, а плагин Secure MCP Tunnel отключите.'
        : 'В ChatGPT включите плагин Secure MCP Tunnel, а плагин с адресом своего сервера отключите.';
      $('vps-status').textContent = vpsLine(vps);
      $('vps-status').dataset.ready = String(!!vps?.ready);
      $('vps-connector').hidden = !vps?.connector;
      $('vps-connector-url').textContent = vps?.connector ?? '';
      $('vps-connector-copy').disabled = pending;
    }
    const settings = state.settings;
    const recovery=$('executor-recovery');recovery.hidden=!(state.executorRecovery?.length);
    $('executor-recovery-items').replaceChildren(...(state.executorRecovery??[]).map(item=>{
      const line=document.createElement('div');line.className='executor-recovery-entry';
      const description=document.createElement('p');description.className='description';
      description.textContent=item.name+' · '+item.workspace+' — '+item.message;
      const remove=document.createElement('button');remove.type='button';remove.className='secondary';
      remove.textContent='Убрать запись';remove.disabled=pending||!state.settings;
      remove.setAttribute('aria-label','Убрать локальную запись исполнителя '+item.name);
      remove.addEventListener('click',()=>action('clearOrphanExecutor',{workspace:item.workspace,projectId:item.projectId}));
      line.append(description,remove);return line;
    }));
    $('settings-panel').hidden = !settings; $('active-projects').hidden = !!settings;
    $('open-settings').setAttribute('aria-pressed', String(!!settings));
    $('open-settings').disabled = pending || state.storageError;
    archiveButton.disabled = pending;
    $('open-chat-colors').disabled = pending;
    if (!settings) return;
    $('setup-panel').hidden = true; $('workspace-details').hidden = true; $('session-notice').hidden = true;
  }
  return { render };
}
