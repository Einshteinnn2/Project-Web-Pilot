import fs from 'node:fs/promises';
import { readReview } from '@webpilot/workflow-kit/lib/plan-review';
export const reviewBlocksExecution=(review,scopeId)=>review?.enabled && review.scope_id===scopeId && review.stage!=='PUBLISHED';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readWorkspace } from './workspace-session.mjs';
import { readPlan } from '@webpilot/workflow-kit/lib/plan';
import { resolveReferences } from '@webpilot/workflow-kit/lib/validate';
import { head, commitHistory } from '@webpilot/workflow-kit/lib/git';
const execute = promisify(execFile);
// The next unfinished task with the fields an agent needs to continue. Read together with the plan check;
// a plan that changed in between gives no task, and the continuation falls back to the plain text.
async function readNextTask(view) {
  try {
    const text = await fs.readFile(path.join(view.workspace, '.harness/plans/todo-plan.md'), 'utf8');
    const plan = JSON.parse(text.match(/<!-- workflow-state:begin -->\s*```json\s*([\s\S]*?)```\s*<!-- workflow-state:end -->/)?.[1] ?? '');
    if (plan.plan_revision !== view.planRevision || plan.scope_id !== view.scopeId) return null;
    const task = plan.tasks.find(candidate => candidate?.id === view.nextTaskId);
    if (!task || task.commit_status === 'DONE') return null;
    const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item) : [];
    return { id: task.id, title: task.title, why: typeof task.why === 'string' ? task.why : '',
      acceptance: strings(task.acceptance_criteria),
      files: [...strings(task.functional_paths), ...strings(task.documentation_paths)],
      checks: strings(task.verification_ids) };
  } catch { return null; }
}

// Only on relevant idle events and immediately before Send; never a Git polling loop.
export async function readAutoPlanState(selected, environment = process.env) {
  const { workspace, sessionId } = selected;
  const before = await readWorkspace(workspace, sessionId);
  const git = async args => (await execute(environment.WORKFLOW_GIT_BIN || 'git', ['-C', workspace, ...args],
    { env: environment, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trim();
  const journal = path.join(await git(['rev-parse', '--absolute-git-dir']), 'workflow-kit', 'transaction.json');
  let pending = false;
  try { await fs.access(journal); pending = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const dirty = await git(['status', '--porcelain', '--', '.harness/plans/todo-plan.md']);
  const after = await readWorkspace(workspace, sessionId);
  return { ...after, nextTask: await readNextTask(after), confirmed: after.planExecution?.execution_strategy !== 'parallel'
    && !pending && !reviewBlocksExecution(readReview(workspace),after.scopeId) && (!after.planView.tasks.every(t => t.status === 'done') || !dirty) && before.planRevision === after.planRevision
    && before.scopeId === after.scopeId };
}

// Opt-in proof for the Chat task counter. Existing AutoPlan Send retains its
// lightweight inspection: canonical Workflow Kit verification is invoked only
// when a rotation controller observes a relevant plan/session event.
export async function readChatSessionTaskProof(selected, environment = process.env) {
  if (selected?.experience !== 'chat') return { confirmed: false, reason: 'NOT_CHAT' };
  const checked = await readAutoPlanState(selected, environment);
  if (!checked.confirmed || !checked.scopeId || checked.planExecution?.execution_strategy !== 'sequential')
    return { confirmed: false, reason: 'PLAN_UNCONFIRMED' };
  const workspace = checked.workspace;
  const startHead = head(workspace);
  // resolveReferences checks each DONE against the actual task-scoped Git
  // commit, its committed plan, dependencies and allowed changed paths.
  const plan = readPlan(workspace);
  if (plan.scope_id !== checked.scopeId || plan.project_id !== checked.projectId
      || plan.plan_revision !== checked.planRevision || plan.execution_strategy !== 'sequential')
    return { confirmed: false, reason: 'PLAN_CHANGED' };
  const resolved = resolveReferences(workspace, plan, null, startHead);
  const done = plan.tasks.filter(task => task.commit_status === 'DONE').map(task => ({
    id: task.id, sha: resolved[task.id]?.sha,
  }));
  if (done.some(task => !task.sha))
    return { confirmed: false, reason: 'DONE_NOT_COMMITTED' };
  const history = commitHistory(workspace, plan.baseline_commit, startHead).reverse().map(commit => ({
    sha: commit.sha,
    scopeId: commit.trailers['Workflow-Scope']?.length === 1 ? commit.trailers['Workflow-Scope'][0] : null,
    taskId: commit.trailers['Workflow-Task']?.length === 1 ? commit.trailers['Workflow-Task'][0] : null,
    role: commit.trailers['Workflow-Role']?.length === 1 ? commit.trailers['Workflow-Role'][0] : null,
  }));
  const verified = await readAutoPlanState(selected, environment);
  if (!verified.confirmed || verified.scopeId !== checked.scopeId
      || verified.projectId !== checked.projectId || verified.planRevision !== checked.planRevision
      || head(workspace) !== startHead)
    return { confirmed: false, reason: 'PLAN_CHANGED' };
  return { confirmed: true, workspace, projectId: plan.project_id, sessionId: selected.sessionId,
    experience: 'chat', executionStrategy: plan.execution_strategy,
    scopeId: plan.scope_id, planRevision: plan.plan_revision, baselineCommit: plan.baseline_commit,
    head: startHead, done, history };
}
