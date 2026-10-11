// A durable per-Chat cursor over *verified* Workflow Kit task commits. This
// deliberately does not create sessions or intercept Composer: those are the
// responsibilities of the later rotation/handoff stages.
import { createHash } from 'node:crypto';
const sha = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);
const error = (code, message) => Object.assign(new Error(message), { code });
const copy = value => structuredClone(value);

// No random second identity: a crash before the caller saves the destination
// must not cause a second session to appear for the same confirmed boundary.
export function rotationOperationId({ workspace, projectId, scopeId, sessionId, boundary }) {
  if (typeof workspace !== 'string' || !workspace || typeof projectId !== 'string' || !projectId
      || typeof scopeId !== 'string' || !scopeId || typeof sessionId !== 'string' || !sessionId || !sha(boundary))
    throw error('ROTATION_OPERATION_INVALID', 'Не удалось определить подтверждённую границу смены Chat.');
  return 'rotation-' + createHash('sha256').update(JSON.stringify([workspace,projectId,scopeId,sessionId,boundary])).digest('hex');
}

// Only the persisted, *delivered* ContextSession and a completed assistant turn
// can give the new chat the project's single continuation recipient. Neither
// creating a session nor dispatching startup Send is sufficient.
export function chatHandoffDecision({project,handoff,phase,page,blocked=false}={}) {
  if(!project||!handoff||handoff.status!=='waiting'||handoff.targetSessionId!==project.sessionId)
    return {status:'wait'};
  if(project.manualStart||['error','send-unknown','manual-session'].includes(phase)
      ||project.attempt?.state==='unknown'
      ||['chat-changed','legacy-session','stale'].includes(phase)&&!!project.attempt?.sendStartedAtMs)
    return {status:'fail',reason:'ROTATION_RECOVERY_FAILED'};
  // 'sending' is an expected intermediate phase while ContextSession is
  // actually delivering. After restart its ambiguous outcome becomes
  // 'send-unknown', which is terminal and cannot be replayed.
  if(project.attempt?.state==='sending')return {status:'wait'};
  if(phase!=='delivered'||!project.chatUrl||project.attempt?.state!=='sent')return {status:'wait'};
  if(blocked||page?.connectionError||(page?.manualStopRevision??0)>0
      ||(page?.manualSendRevision??0)>0||(page?.manualInputRevision??0)>0)
    return {status:'fail',reason:'ROTATION_MANUAL_INTERVENTION'};
  if(!page||page.busy||page.draftPresent||page.lastMessageRole!=='assistant'||page.url!==project.chatUrl)
    return {status:'wait'};
  return {status:'ready'};
}

// Called after the existing AutoPlan eligibility gates and again immediately
// before Composer click. Checking quota never creates a Chat by itself.
export function chatRotationDecision({ selected, plan, count, limit, blocked = false }) {
  if (selected?.experience !== 'chat' || plan?.planExecution?.execution_strategy !== 'sequential')
    return { status: 'continue' };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10)
    return { status: 'wait', reason: 'ROTATION_SETTING_INVALID' };
  if (blocked) return { status: 'wait', reason: 'MANUAL_STOP' };
  if (!plan?.confirmed || plan.scopeId !== selected.scopeId || plan.scopeStatus !== 'ACTIVE')
    return { status: 'wait', reason: 'PLAN_CHANGED_OR_TRANSACTION' };
  if (!Number.isSafeInteger(count) || count < 0)
    return { status: 'wait', reason: 'ROTATION_PROOF_ERROR' };
  if (plan.planView?.tasks?.length > 0 && plan.planView.tasks.every(task => task.status === 'done'))
    return { status: 'complete' };
  if (count < limit) return { status: 'continue' };
  // Boundary is an immutable confirmed task SHA; a plan revision alone is not
  // a safe idempotency key for the subsequent session handoff.
  return { status: 'rotate' };
}

function validateProof(proof) {
  if (!proof || proof.confirmed !== true || !proof.workspace || !proof.projectId || !proof.sessionId || !proof.scopeId
      || proof.experience !== 'chat' || proof.executionStrategy !== 'sequential'
      || !sha(proof.head) || !sha(proof.baselineCommit) || !Number.isSafeInteger(proof.planRevision)
      || !Array.isArray(proof.done) || !Array.isArray(proof.history))
    throw error('ROTATION_PROOF_UNAVAILABLE', 'Нет подтверждённой последовательной Chat-сессии и истории Kit.');
  const tasks = new Set(), commits = new Set();
  for (const task of proof.done) {
    if (!task || typeof task.id !== 'string' || !task.id || !sha(task.sha)
        || tasks.has(task.id) || commits.has(task.sha))
      throw error('ROTATION_PROOF_AMBIGUOUS', 'Доказательство DONE отсутствует или неоднозначно.');
    tasks.add(task.id); commits.add(task.sha);
  }
  const history = new Set();
  for (const commit of proof.history) {
    if (!sha(commit?.sha) || history.has(commit.sha))
      throw error('ROTATION_PROOF_AMBIGUOUS', 'История Git неполна или неоднозначна.');
    history.add(commit.sha);
  }
  if ((proof.history.at(-1)?.sha ?? proof.baselineCommit) !== proof.head)
    throw error('ROTATION_PROOF_AMBIGUOUS', 'HEAD не соответствует завершающему коммиту проверенной истории.');
  if (!proof.done.every(task => proof.history.some(commit => commit.sha === task.sha
      && commit.scopeId === proof.scopeId && commit.taskId === task.id && commit.role === 'implementation')))
    throw error('ROTATION_PROOF_AMBIGUOUS', 'Завершённая задача не подтверждена коммитом Workflow Kit.');
}

function validateCursor(cursor) {
  if (!cursor || cursor.version !== 1 || !cursor.workspace || !cursor.projectId || !cursor.sessionId || !cursor.scopeId
      || !sha(cursor.baselineCommit) || !sha(cursor.head) || !Number.isSafeInteger(cursor.planRevision)
      || !Array.isArray(cursor.baselineDone) || !Array.isArray(cursor.counted))
    throw error('ROTATION_CURSOR_INVALID', 'Сохранённый счётчик Chat повреждён; автоматический переход заблокирован.');
  for (const values of [cursor.baselineDone, cursor.counted]) {
    if (values.some(item => !item || typeof item.id !== 'string' || !item.id || !sha(item.sha))
        || new Set(values.map(item => item.id)).size !== values.length
        || new Set(values.map(item => item.sha)).size !== values.length)
      throw error('ROTATION_CURSOR_INVALID', 'Сохранены повторные или недостоверные коммиты задач.');
  }
  if (cursor.baselineDone.some(task => cursor.counted.some(item => item.id === task.id || item.sha === task.sha)))
    throw error('ROTATION_CURSOR_INVALID', 'Исходные и новые микрозадачи пересеклись.');
}

export function advanceChatSessionTaskCounter(previous, proof) {
  validateProof(proof);
  const address = ['workspace', 'projectId', 'sessionId', 'scopeId'];
  if (previous !== null && previous !== undefined) {
    validateCursor(previous);
    if (address.some(field => previous[field] !== proof[field]) || previous.baselineCommit !== proof.baselineCommit)
      throw error('ROTATION_CURSOR_OWNER_CHANGED', 'Проект, план или Chat отличаются от исходной границы.');
    if (proof.planRevision < previous.planRevision)
      throw error('ROTATION_PROOF_STALE', 'Ревизия плана меньше подтверждённой ранее.');
  }
  const current = previous ? copy(previous) : {
    version: 1, ...Object.fromEntries(address.map(field => [field, proof[field]])),
    baselineCommit: proof.baselineCommit, head: proof.head, planRevision: proof.planRevision,
    baselineDone: copy(proof.done), counted: [],
  };
  if (!previous) return { cursor: current, count: 0, added: [] };

  // Kit history arrives oldest-to-newest. The previously seen Git HEAD must
  // still be an ancestor; the current HEAD may include harmless documentation
  // commits but never a foreign task or an unverified task completion.
  const boundary = proof.history.findIndex(commit => commit.sha === current.head);
  const previousHeadIsBaseline = current.head === proof.baselineCommit;
  if (boundary < 0 && !previousHeadIsBaseline && proof.head !== current.head)
    throw error('ROTATION_PROOF_REWRITTEN', 'Предыдущая граница Git исчезла из истории; требуется проверка пользователя.');
  if (boundary < 0 && !previousHeadIsBaseline && proof.head === current.head) {
    // A proof from the same head with inconsistent history is not trustworthy.
    throw error('ROTATION_PROOF_REWRITTEN', 'Ранее сохранённый HEAD больше не подтверждается историей.');
  }
  const tail = proof.history.slice(previousHeadIsBaseline ? 0 : boundary + 1);
  if ((tail.at(-1)?.sha ?? current.head) !== proof.head && current.head !== proof.head)
    throw error('ROTATION_PROOF_REWRITTEN', 'Граница HEAD и порядок Git-коммитов не совпадают.');
  const known = new Map([...current.baselineDone, ...current.counted].map(task => [task.id, task.sha]));
  const observed = new Map(proof.done.map(task => [task.id, task.sha]));
  for (const [id, hash] of known) if (observed.get(id) !== hash)
    throw error('ROTATION_PROOF_REWRITTEN', 'Ранее подтверждённая задача исчезла или её коммит изменился.');

  const additions = proof.done.filter(task => !known.has(task.id));
  if (additions.length && proof.planRevision <= previous.planRevision)
    throw error('ROTATION_PROOF_STALE', 'Новые DONE не подтверждены возросшей ревизией плана.');
  const fresh = new Map(additions.map(task => [task.sha, task]));
  for (const commit of tail) {
    if (commit.role === 'documentation' || commit.role === 'scope-plan') continue;
    if (commit.role !== 'implementation' || commit.scopeId !== proof.scopeId
        || !fresh.has(commit.sha) || fresh.get(commit.sha).id !== commit.taskId)
      throw error('ROTATION_PROOF_EXTERNAL', 'Обнаружена посторонняя или неоднозначная Git-операция после границы Chat.');
    fresh.delete(commit.sha);
  }
  if (fresh.size) throw error('ROTATION_PROOF_EXTERNAL', 'Не удалось связать новые DONE с Git-историей текущего Chat.');
  current.counted.push(...additions);
  current.head = proof.head;
  current.planRevision = proof.planRevision;
  return { cursor: current, count: current.counted.length, added: copy(additions) };
}
