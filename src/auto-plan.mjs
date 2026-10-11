export const CONTINUE_TEXT = 'Продолжай';
export const CONTINUE_MESSAGE_BYTES = 4096;
const CUT = '… [обрезано]';
const clip = (value, limit) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(), characters = [...text];
  return characters.length > limit ? characters.slice(0, limit).join('') + CUT : text; };
const list = (items, limit, each) => { const rows = items.slice(0, limit).map(each);
  return items.length > limit ? [...rows, `… ещё ${items.length - limit} [обрезано]`] : rows; };
const bytes = text => new TextEncoder().encode(text).length;

// «Продолжай» plus the next task as Workflow Kit has it, so the agent starts without reading the plan through tools.
// The task comes from the plan check made for this very send; task documents are never attached.
export function continueMessage(task) {
  if (!task || typeof task.id !== 'string' || !task.id || typeof task.title !== 'string' || !task.title) return CONTINUE_TEXT;
  const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()) : [];
  const acceptance = strings(task.acceptance), files = strings(task.files), checks = strings(task.checks);
  const lines = [CONTINUE_TEXT, '',
    'Данные текущего плана Workflow Kit — следующая задача (это не новое поручение; фактическое состояние плана проверь сам):',
    `Задача: ${clip(task.id, 40)} — ${clip(task.title, 240)}`];
  if (typeof task.why === 'string' && task.why.trim()) lines.push(`Зачем: ${clip(task.why, 500)}`);
  if (acceptance.length) lines.push('Критерии приёмки:', ...list(acceptance, 10, item => '- ' + clip(item, 320)));
  if (files.length) lines.push('Файлы: ' + list(files, 24, item => clip(item, 160)).join(', '));
  if (checks.length) lines.push('Проверки: ' + list(checks, 12, item => clip(item, 60)).join(', '));
  let text = lines.join('\n');
  if (bytes(text) <= CONTINUE_MESSAGE_BYTES) return text;
  const tail = '\n… [данные задачи обрезаны; полный текст — в плане]';
  const budget = CONTINUE_MESSAGE_BYTES - bytes(tail);
  let size = 0, cut = '';
  for (const character of text) { size += bytes(character); if (size > budget) break; cut += character; }
  return cut + tail;
}
const key = p => p && JSON.stringify([p.workspace, p.sessionId, p.scopeId, p.chatUrl]);
const conversationKey = p => p && JSON.stringify([p.workspace, p.sessionId, p.chatUrl]);
const finished = p => p?.planView?.tasks?.length > 0 && p.planView.tasks.every(t => t.status === 'done');
// The ledger of answered pauses is persisted on every pause; only recent entries matter, because a
// conversation's current pause is always its latest. The newest entries of each conversation are kept.
export const LEDGER_PER_CONVERSATION = 20, LEDGER_TOTAL = 400;
export function pruneLedger(entries) {
  const kept = [], perConversation = new Map();
  for (const [id, entry] of [...entries.entries()].reverse()) {
    const count = (perConversation.get(entry.key) ?? 0) + 1;
    perConversation.set(entry.key, count);
    if (count <= LEDGER_PER_CONVERSATION && kept.length < LEDGER_TOTAL) kept.push([id, entry]);
  }
  return new Map(kept.reverse());
}

export class AutoPlan {
  constructor({ selected, inspectPlan, send, onChange = () => {}, log = () => {},
    schedule = setTimeout, cancel = clearTimeout, settleMs = 500, stallMs = 180000,
    available = () => true, saveCheckpoint = async () => {}, onComplete = () => {},
    checkRotation = null, onRotation = null }) {
    Object.assign(this, { onComplete, selected, inspectPlan, send, onChange, log, schedule, cancel, settleMs, stallMs, available, saveCheckpoint, checkRotation, onRotation });
    this.page = null; this.run = null; this.epoch = 0; this.timer = null; this.watchdog = null;
    this.state = { phase: 'off', message: '', active: false, reason: null };
    this.continuations = 0; this.continuationOwner = null;
    this.enabled = false; this.checkpoints = new Map(); this.cycles = new Map(); this.cyclesDirty = false; this.closed = false;
    this.rotation = null;
    this.pending = null; this.rerunRequested = false; this.lastAvailability = false;
    this.selectionKey = key(this.selected()); this.manualWaiting = null;
  }
  view() { return { ...this.state, enabled: this.enabled,
    warning: this.run?.stallWarning ? 'STALL_WARNING' : null,
    continuations: this.continuationOwner === key(this.selected()) ? this.continuations : 0 }; }
  get checkpoint() { return [...this.checkpoints.values()].findLast(entry => entry.key === key(this.selected())) ?? null; }
  checkpointState(entries = this.checkpoints) {
    return entries.size || this.cycles.size || this.rotation ? { version: 3, entries: [...entries.values()],
      cycles: [...this.cycles.values()], ...(this.rotation ? { rotation: this.rotation } : {}) } : null;
  }
  observeCycle(p) {
    const owner = conversationKey(this.selected());
    if (!owner || p.url !== this.selected()?.chatUrl || (!p.busy && !p.lastMessageRole)) return;
    let cycle = this.cycles.get(owner);
    if (!cycle) {
      const legacy = [...this.checkpoints.values()].some(entry => entry.key === key(this.selected()));
      cycle = { key: owner, generation: 0, busy: false, legacy };
    }
    if (p.busy && !cycle.busy) cycle = { ...cycle, generation: cycle.generation + 1, busy: true };
    else if (!p.busy && p.lastMessageRole === 'assistant') cycle = { ...cycle, busy: false };
    if (JSON.stringify(cycle) !== JSON.stringify(this.cycles.get(owner))) {
      this.cycles.set(owner, cycle); this.cyclesDirty = true;
    }
  }
  pauseIdentity(p = this.page) {
    return p?.turnId || 'cycle:' + (this.cycles.get(conversationKey(this.selected()))?.generation ?? 0);
  }
  async writeCheckpoint(owner, checkpoint, replacingTurnId = checkpoint?.turnId) {
    const next = new Map(this.checkpoints);
    next.delete(JSON.stringify([owner, replacingTurnId]));
    if (checkpoint) next.set(JSON.stringify([owner, checkpoint.turnId]), checkpoint);
    const pruned = pruneLedger(next);
    await this.saveCheckpoint(this.checkpointState(pruned));
    this.checkpoints = pruned;
  }
  restore(enabled, checkpoint = null) {
    this.epoch++; this.clearTimer(); this.clearWatchdog(); this.run = null; this.manualWaiting = null;
    this.closed = false; this.enabled = enabled === true; this.checkpoints = new Map(); this.cycles = new Map(); this.cyclesDirty = false;
    const rotation = checkpoint?.rotation;
    this.rotation = rotation && typeof rotation.key === 'string' && typeof rotation.boundary === 'string'
      && /^[a-f0-9]{40,64}$/.test(rotation.boundary) && ['reserved','notified'].includes(rotation.status)
      ? { key: rotation.key, boundary: rotation.boundary, status: rotation.status } : null;
    const entries = [2, 3].includes(checkpoint?.version) && Array.isArray(checkpoint.entries) ? checkpoint.entries : [checkpoint];
    for (const entry of entries) {
      if (entry && typeof entry.key === 'string' && typeof entry.turnId === 'string'
          && ['sending', 'sent'].includes(entry.status))
        this.checkpoints.set(JSON.stringify([entry.key, entry.turnId]), { key: entry.key, turnId: entry.turnId, status: entry.status,
          ...(Number.isSafeInteger(entry.generation) && entry.generation >= 0 ? { generation: entry.generation } : {}) });
    }
    for (const cycle of checkpoint?.version === 3 && Array.isArray(checkpoint.cycles) ? checkpoint.cycles : []) {
      if (typeof cycle.key === 'string' && Number.isSafeInteger(cycle.generation) && cycle.generation >= 0
          && typeof cycle.busy === 'boolean')
        this.cycles.set(cycle.key, { key: cycle.key, generation: cycle.generation, busy: cycle.busy, legacy: cycle.legacy === true });
    }
    this.set(this.enabled ? 'waiting' : 'off', this.enabled ? 'Автовыполнение включено. Ждём разговор и план.' : '');
  }
  start() { this.closed = false; this.enabled = true; return this.reconcile(); }
  disable({manual=false}={}) {
    this.enabled = false; this.epoch++; this.clearTimer(); this.clearWatchdog(); this.run = null;
    this.set('off', manual?'Автовыполнение выключено пользователем.':'Разрешение автовыполнения отсутствует.',
      false,manual?'MANUAL_OFF':'AUTHORIZATION_OFF');
  }
  // Compatibility for explicit recovery; publish uses availabilityChanged instead.
  recover() { return this.reconcile(); }
  planChanged() { return this.reconcile(); }
  availabilityChanged() {
    const available = !!this.available();
    if (available === this.lastAvailability) return;
    this.lastAvailability = available;
    void this.reconcile();
  }
  set(phase, message, active = false, reason = null) {
    const next = { phase, message, active, reason };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    this.log('state', { phase, ...(reason ? { reason } : {}) }); this.onChange();
  }
  clearTimer() { if (this.timer !== null) this.cancel(this.timer); this.timer = null; }
  clearWatchdog() { if (this.watchdog !== null) this.cancel(this.watchdog); this.watchdog = null; }
  watch(run) {
    this.clearWatchdog();
    if (run.stallWarning) { run.stallWarning = false; this.log('progress-resumed', { reason: 'STALL_WARNING' }); }
    this.watchdog = this.schedule(() => {
      this.watchdog = null;
      if (this.run !== run || !this.enabled || !this.page?.busy) return;
      run.stallWarning = true;
      this.log('progress-timeout', { reason: 'STALL_WARNING' });
      this.set('running', 'Агент ещё работает. Давно не было новых данных; ждём завершения ответа.', true, 'STALL_WARNING');
    }, this.stallMs);
    this.watchdog?.unref?.();
  }
  wait(reason, message) {
    this.clearWatchdog();
    if (this.run) this.run.stallWarning = false;
    this.set('waiting', message, false, reason);
  }
  pause(message = 'Автовыполнение приостановлено.', reason = 'MANUAL_OFF') {
    this.clearTimer(); this.clearWatchdog();
    this.set('paused', message, false, reason);
  }
  complete() {
    this.enabled = false;
    this.clearTimer(); this.clearWatchdog();
    if (this.run) this.run.stallWarning = false;
    this.set('complete', 'Все пункты плана выполнены. Продолжение не отправляется.', false, 'PLAN_COMPLETED');
    this.onComplete();
  }
  rotationWait() {
    return this.pause(this.rotation?.status === 'notified'
      ? 'Лимит задач Chat достигнут. Переход в новую сессию ожидается.'
      : 'Переход Chat был подготовлен, но его исход неизвестен. Требуется проверка пользователя.',
      this.rotation?.status === 'notified' ? 'ROTATION_PENDING' : 'ROTATION_UNKNOWN');
  }
  async reserveRotation(owner, decision, ready) {
    if (!ready()) return;
    if (this.rotation?.key === owner) return this.rotationWait();
    if (typeof this.onRotation !== 'function')
      return this.pause('Автоматическая смена Chat недоступна. Продолжение не отправлено.', 'ROTATION_HANDLER_UNAVAILABLE');
    const previous = this.rotation;
    this.rotation = { key: owner, boundary: decision.boundary, status: 'reserved' };
    try { await this.saveCheckpoint(this.checkpointState()); }
    catch {
      this.rotation = previous;
      return this.pause('Не удалось сохранить запрет отправки в старый Chat.', 'ROTATION_CHECKPOINT_ERROR');
    }
    if (!ready()) return this.rotationWait();
    try { await this.onRotation({ selected: this.selected(), boundary: decision.boundary, count: decision.count }); }
    catch { return this.pause('Не удалось передать переход в новую Chat-сессию. Проверьте состояние вручную.', 'ROTATION_HANDOFF_ERROR'); }
    this.rotation.status = 'notified';
    try { await this.saveCheckpoint(this.checkpointState()); }
    catch { return this.pause('Переход запущен, но подтверждение его сохранения отсутствует.', 'ROTATION_CHECKPOINT_ERROR'); }
    this.rotationWait();
  }
  selectionChanged() {
    const selectedKey = key(this.selected());
    if (selectedKey === this.selectionKey) return;
    this.selectionKey = selectedKey; this.epoch++;
    this.clearTimer(); this.clearWatchdog(); this.run = null;
    if (this.manualWaiting?.key !== conversationKey(this.selected())) this.manualWaiting = null;
    void this.reconcile();
  }
  observe(event) {
    const previous = this.page;
    if (event.reset) {
      this.page = null; this.epoch++; this.clearTimer(); this.clearWatchdog(); this.run = null;
      void this.reconcile(); return;
    }
    this.page = { ...event.state, documentId: event.documentId ?? previous?.documentId };
    this.selectionChanged();
    const p = this.page;
    if (previous?.documentId === p.documentId && (p.manualSendRevision ?? 0) > (previous.manualSendRevision ?? 0)) {
      this.manualWaiting = { key: conversationKey(this.selected()), turnId: this.pauseIdentity(previous) };
    }
    this.observeCycle(p);
    if (this.run && (this.run.key !== key(this.selected()) || this.run.documentId !== p.documentId)) {
      this.epoch++; this.clearWatchdog(); this.run = null;
    }
    if (p.busy) {
      this.clearTimer();
      if (this.run && (this.run.lastActivityRevision !== p.assistantRevision || !previous?.busy)) {
        this.run.lastActivityRevision = p.assistantRevision; this.watch(this.run);
      }
    } else if (this.enabled && previous && (previous.busy || previous.turnId !== p.turnId) && this.timer === null) {
      this.clearWatchdog();
      if (this.run) this.run.stallWarning = false;
      this.timer = this.schedule(() => { this.timer = null; void this.reconcile(); }, this.settleMs);
      this.timer?.unref?.();
    }
    void this.reconcile();
  }
  // One serialized event-driven pass. No interval and no scheduled Git reads.
  reconcile() {
    if (this.closed || !this.enabled) return Promise.resolve();
    this.rerunRequested = true;
    if (this.pending) return this.pending;
    const work = Promise.resolve().then(async () => {
      while (this.rerunRequested && this.enabled && !this.closed) {
        this.rerunRequested = false;
        await this.reconcileOnce();
      }
    });
    this.pending = work.finally(() => {
      this.pending = null;
      if (this.rerunRequested && this.enabled && !this.closed) void this.reconcile();
    });
    return this.pending;
  }
  async reconcileOnce() {
    this.selectionChanged();
    if (this.page) this.observeCycle(this.page);
    if (this.cyclesDirty) {
      this.cyclesDirty = false;
      try { await this.saveCheckpoint(this.checkpointState()); }
      catch { this.cyclesDirty = true; return this.wait('SEND_CHECKPOINT_ERROR', 'Не удалось сохранить состояние ответа.'); }
    }
    const selected = this.selected(), p = this.page, owner = key(selected), epoch = this.epoch;
    if (!selected?.chatUrl || selected.sessionArchivedAt || !p || p.url !== selected.chatUrl)
      return this.wait('PAGE_NOT_READY', 'Ждём выбранный разговор.');
    if (!this.available()) return this.wait('PAGE_NOT_READY', 'Ждём готовности страницы.');
    if (p.connectionError) return this.wait('CONNECTION_ERROR', 'Ждём восстановления связи с ChatGPT.');
    if (!this.run) this.run = { key: owner, documentId: p.documentId, lastActivityRevision: p.assistantRevision };
    const run = this.run;
    if (p.busy) {
      if (this.watchdog === null && !run.stallWarning) this.watch(run);
      return this.set('running', run.stallWarning ? 'Агент ещё работает. Давно не было новых данных; ждём завершения ответа.'
        : 'Автовыполнение включено. Агент работает.', true, run.stallWarning ? 'STALL_WARNING' : null);
    }
    if (this.timer !== null) return;
    if (!p.editorAvailable || !p.writable) return this.wait('PAGE_NOT_READY', 'Ждём готовности поля ввода.');
    if (p.draftPresent) return this.wait('DRAFT_PRESENT', 'Ждём вашего сообщения. Черновик сохранён.');
    if (!p.lastMessageRole)
      return this.wait('HISTORY_NOT_READY', 'Ждём загрузки сообщений разговора.');
    if (p.lastMessageRole === 'user')
      return this.wait('USER_MESSAGE_PENDING', 'Ваше сообщение отправлено. Ждём ответ.');
    if (this.manualWaiting?.key === conversationKey(selected)) {
      if (this.pauseIdentity(p) === this.manualWaiting.turnId)
        return this.wait('USER_MESSAGE_PENDING', 'Ваше сообщение отправлено. Ждём ответ.');
      this.manualWaiting = null;
    }
    if (!selected.scopeId) return this.wait('PLAN_UNAVAILABLE', 'Ждём незавершённый текущий план.');
    const observedPause = this.pauseIdentity(p);
    const currentContext = () => this.enabled && !this.closed && epoch === this.epoch && key(this.selected()) === owner
      && this.page?.documentId === p.documentId && this.page?.url === selected.chatUrl;
    const ready = () => currentContext() && !this.page.busy && !this.page.connectionError
      && this.page.editorAvailable && this.page.writable && this.page.lastMessageRole !== 'user'
      && this.pauseIdentity() === observedPause
      && (this.page.turnId ?? '') === (p.turnId ?? '')
      && (this.page.userTurnId ?? '') === (p.userTurnId ?? '')
      && (this.page.manualInputRevision ?? 0) === (p.manualInputRevision ?? 0)
      && (this.page.manualSendRevision ?? 0) === (p.manualSendRevision ?? 0)
      && (this.page.manualStopRevision ?? 0) === (p.manualStopRevision ?? 0);
    this.set('checking', 'Проверяем текущий план…', true);
    let plan;
    try { plan = await this.inspectPlan(selected); }
    catch { if (currentContext()) this.wait('PLAN_READ_ERROR', 'Ждём возможности прочитать план.'); return; }
    if (!ready() || !this.available() || this.page.draftPresent) return;
    if (!plan.confirmed) return this.wait('PLAN_CHANGED_OR_TRANSACTION', 'Ждём завершения Git-операции.');
    if (plan.scopeId !== selected.scopeId) return this.wait('PLAN_CHANGED_OR_TRANSACTION', 'Ждём актуальный текущий план.');
    if (finished(plan)) return this.complete();
    if (plan.scopeStatus !== 'ACTIVE' || !plan.planView?.tasks?.length)
      return this.wait('PLAN_UNAVAILABLE', 'Ждём незавершённый активный план.');
    run.completedAtStart ??= plan.planView.tasks.filter(t => t.status === 'done').map(t => t.id);
    // A persisted busy cycle distinguishes completed replies even when Work
    // replaces a fixed-size DOM window with no native message IDs.
    const previousCheckpoint = this.checkpoint;
    const pauseId = this.pauseIdentity(p);
    const cycle = this.cycles.get(conversationKey(selected));
    if (!p.turnId && cycle?.legacy && cycle.generation === 0)
      return this.wait('LEGACY_PAUSE_UNKNOWN', 'Старая пауза не имеет надёжного ID. Ждём следующий ответ.');
    const consumed = this.checkpoints.get(JSON.stringify([owner, pauseId]))
      ?? [...this.checkpoints.values()].findLast(entry => entry.key === owner
        && entry.generation === cycle?.generation && (!p.turnId || entry.turnId.startsWith('cycle:')));
    if (consumed)
      return this.set(consumed.status === 'sending' ? 'paused' : 'running',
        consumed.status === 'sending' ? 'Исход отправки для этой паузы неизвестен. Повтор не отправляется.'
          : '«Продолжай» уже отправлено. Ждём ответ.', consumed.status === 'sent',
        consumed.status === 'sending' ? 'SEND_UNKNOWN' : 'PAUSE_CONSUMED');
    if (this.rotation?.key === owner) return this.rotationWait();
    const checkRotation = async checked => {
      if (!this.checkRotation) return false;
      let decision;
      try { decision = await this.checkRotation(selected, checked); }
      catch {
        if (ready()) this.pause('Не удалось проверить подтверждённые задачи Chat. Автопродолжение заблокировано.', 'ROTATION_PROOF_ERROR');
        return true;
      }
      if (!ready()) return true;
      if (decision?.status === 'continue') return false;
      if (decision?.status === 'complete') { this.complete(); return true; }
      if (decision?.status === 'rotate') {
        if (!/^[a-f0-9]{40,64}$/.test(decision.boundary ?? '')) {
          this.pause('Нет подтверждённой границы коммита для смены Chat.', 'ROTATION_PROOF_ERROR');
          return true;
        }
        await this.reserveRotation(owner, decision, ready); return true;
      }
      this.wait(decision?.reason ?? 'ROTATION_PROOF_ERROR',
        decision?.reason === 'MANUAL_STOP' ? 'Ручная остановка запрещает смену Chat.'
          : 'Переход Chat ожидает подтверждения плана или действий пользователя.');
      return true;
    };
    if (await checkRotation(plan)) return;
    if (this.continuationOwner !== owner) { this.continuationOwner = owner; this.continuations = 0; }
    const checkpoint = { key: owner, turnId: pauseId, status: 'sending', generation: cycle?.generation ?? 0 };
    this.log('pause', { turnId: p.turnId || '', identitySource: p.turnId ? 'native' : 'cycle', generation: cycle?.generation ?? 0 });
    this.set('sending', 'Отправляем «Продолжай»…', true);
    let sendInvoked = false, delivered = false, knownUnsent = false;
    try {
      await this.writeCheckpoint(owner, checkpoint);
      let result = { state: 'cancelled' };
      if (ready() && this.available() && !this.page.draftPresent) {
        sendInvoked = true;
        result = await this.send(continueMessage(plan.nextTask), ready, async () => {
          const latest = await this.inspectPlan(selected);
          if (!ready()) return false;
          if (!latest.confirmed || latest.scopeId !== selected.scopeId || latest.scopeStatus !== 'ACTIVE') {
            this.wait('PLAN_CHANGED_OR_TRANSACTION', 'Ждём актуальный подтверждённый план.'); return false;
          }
          // The text already in the field names a task: it is sent only while that task is still the next one.
          if ((latest.nextTask?.id ?? null) !== (plan.nextTask?.id ?? null)) {
            this.wait('PLAN_CHANGED_OR_TRANSACTION', 'Ждём актуальный текущий план.'); return false;
          }
          if (finished(latest)) { this.complete(); return false; }
          if (await checkRotation(latest)) return false;
          return !!latest.planView?.tasks?.length;
        });
      }
      if (result.state === 'sent') {
        delivered = true;
        if (key(this.selected()) === owner) { this.continuations++; this.log('send', { kind: 'continue', continuations: this.continuations }); }
        await this.writeCheckpoint(owner, { ...checkpoint, status: 'sent' });
        if (currentContext()) this.set('running', 'Автоматически отправлено «Продолжай». Ждём ответ.', true);
      } else if (result.state === 'unknown') {
        if (currentContext()) this.pause('Исход отправки неизвестен. Для этой паузы повтор не отправляется.', 'SEND_UNKNOWN');
      } else {
        knownUnsent = true;
        await this.writeCheckpoint(owner, previousCheckpoint, checkpoint.turnId);
        if (currentContext() && this.state.phase === 'sending') this.wait(
          result.reason === 'DRAFT_PRESENT' ? 'DRAFT_PRESENT' : 'SEND_NOT_SENT',
          result.reason === 'DRAFT_PRESENT' ? 'Ждём вашего сообщения. Черновик сохранён.' : 'Продолжение не отправлено. Ждём следующего события.');
      }
    } catch {
      if (delivered) this.checkpoints.set(JSON.stringify([owner, pauseId]), { ...checkpoint, status: 'sent' });
      else if (!sendInvoked || knownUnsent) this.checkpoints.delete(JSON.stringify([owner, pauseId]));
      if (currentContext()) this.wait(delivered ? 'SEND_CHECKPOINT_ERROR' : 'SEND_ERROR',
        delivered ? '«Продолжай» отправлено. Не удалось сохранить подтверждение; повтор для этой паузы исключён.'
          : 'Ошибка отправки. Ждём следующего события; неизвестный Send не повторяется.');
    }
  }
  dispose() {
    this.closed = true; this.epoch++; this.clearTimer(); this.clearWatchdog(); this.run = null;
    this.rerunRequested = false;
  }
}
