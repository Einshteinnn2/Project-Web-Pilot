import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { getRuntimeRoot } from '@webpilot/workflow-kit';
import { emptyPlan, writePlan, readPlan, FINAL_DOCUMENTATION_TASK_TITLE, PROJECT_CONTINUATION_OBJECTIVE } from '@webpilot/workflow-kit/lib/plan';
import { defaultConfig } from '@webpilot/workflow-kit/lib/validate';
import { createScope, startTask, applyPlan, archive, commitDocumentation } from '@webpilot/workflow-kit/lib/actions';
import { commitTask } from '@webpilot/workflow-kit/lib/transaction';
import { recover, splitText, recoveryParts } from '@webpilot/workflow-kit/lib/recovery';
import { inspectionInputs } from '@webpilot/workflow-kit/lib/inspection-inputs';

const env = { ...process.env, GIT_AUTHOR_NAME: 'Workflow Test', GIT_AUTHOR_EMAIL: 'workflow@example.invalid',
  GIT_COMMITTER_NAME: 'Workflow Test', GIT_COMMITTER_EMAIL: 'workflow@example.invalid' };
function git(root, ...args) { return execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim(); }

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-recovery-v2-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.harness/plans'), { recursive: true });
  await fs.mkdir(path.join(root, '.harness/kit'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs/modules'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs/architecture'), { recursive: true });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.copyFile(path.join(getRuntimeRoot(), 'WORKFLOW.md'), path.join(root, '.harness/kit/WORKFLOW.md'));
  // Recovery delivers the canonical work rules and stage forms together with WORKFLOW.md.
  await fs.cp(path.join(getRuntimeRoot(), 'templates'), path.join(root, '.harness/kit/templates'), { recursive: true });
  await fs.writeFile(path.join(root, '.harness/workflow.json'), JSON.stringify({...defaultConfig(),checks:[{id:'package',kind:'package',executable:process.execPath,args:['-e','process.exit(0)'],required:false,timeout_ms:10000,evidence:'fixture delivery'}]}, null, 2) + '\n');
  writePlan(root, emptyPlan('Recovery Fixture'));
  await fs.writeFile(path.join(root, 'docs/architecture/OVERVIEW.md'), '# Краткая архитектура проекта\n\nOVERVIEW_REQUIRED\n');
  await fs.writeFile(path.join(root,'README.md'),'# Recovery fixture\nREADME_REQUIRED\n');
  await fs.writeFile(path.join(root,'AGENTS.md'),'<!-- workflow-kit:begin -->\nKIT_LOCATOR_DO_NOT_INLINE\n<!-- workflow-kit:end -->\nPROJECT_CONSTRAINT\n');
  await fs.writeFile(path.join(root, 'docs/MODULES.md'), '# Модули проекта\n\nFixture module map.\n');
  await fs.writeFile(path.join(root, 'docs/modules/module.md'), '# Module Specification — Fixture\n\nMODULE_REQUIRED\n');
  await fs.writeFile(path.join(root, 'docs/optional.md'), '# Optional\n\nOPTIONAL_SECRET_BODY_SHOULD_NOT_BE_COPIED\n');
  await fs.writeFile(path.join(root, 'docs/notes.md'), '# Notes\n\ninitial\n');
  await fs.writeFile(path.join(root, 'docs/DOCUMENTATION_INDEX.md'), '# Каталог документации\n\ndocs/architecture/OVERVIEW.md\ndocs/MODULES.md\ndocs/modules/module.md\ndocs/optional.md\ndocs/notes.md\n');
  await fs.writeFile(path.join(root, 'src/module.mjs'), 'export const value = 1;\n');
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Workflow Test'); git(root, 'config', 'user.email', 'workflow@example.invalid');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'baseline');
  return root;
}
function scopeInput(valid = true) {
  return {
    scope_id: 'module-change-001', objective: 'Изменить fixture module', approval_note: 'Пользователь согласовал контракт fixture module.',
    acceptance_criteria: ['Контракт реализован'],
    approved_scope: { functional_paths: ['src/module.mjs'], documentation_paths: ['docs/modules/module.md', 'docs/notes.md'], max_functional_files_per_task: 3 },
    context_pack: { documents: valid ? [
      { path: 'docs/architecture/OVERVIEW.md', heading_path: ['Краткая архитектура проекта'], required: true, revision: 'WORKTREE' },
      { path: 'docs/modules/module.md', heading_path: ['Module Specification — Fixture'], required: true, revision: 'WORKTREE' },
      { path: 'docs/optional.md', heading_path: ['Optional'], required: false, revision: 'WORKTREE' },
    ] : [], include_last_completed_task: false, dependency_task_ids: [] },
    tasks: [
      { id: 'T001', title: 'Уточнить specification', why: 'Подготовить контракт', dependencies: [], functional_paths: [], documentation_paths: ['docs/modules/module.md'], acceptance_criteria: ['Specification уточнена'], verification_ids: [], expected_commit_message: 'docs: уточнить specification' },
      { id: 'T002', title: 'Записать независимую заметку', why: 'Создать более поздний unrelated commit', dependencies: ['T001'], functional_paths: [], documentation_paths: ['docs/notes.md'], acceptance_criteria: ['Заметка записана'], verification_ids: [], expected_commit_message: 'docs: записать заметку' },
      { id: 'T003', title: 'Реализовать модуль', why: 'Реализовать согласованный контракт', dependencies: ['T001'], functional_paths: ['src/module.mjs'], documentation_paths: ['docs/modules/module.md'], acceptance_criteria: ['Код соответствует specification'], verification_ids: [], expected_commit_message: 'feat: реализовать модуль' },
    ],
  };
}
function continuityScopeInput() {
  return {
    scope_id: 'continuity-acceptance-001', objective: 'Проверить lifecycle универсального проекта',
    approval_note: 'Пользователь согласовал проверку continuity lifecycle.', acceptance_criteria: ['Этап проходит через DOCS и пользовательскую приёмку'],
    approved_scope: { functional_paths: [], documentation_paths: ['docs/notes.md'], max_functional_files_per_task: 3 },
    context_pack: { documents: [], include_last_completed_task: false, dependency_task_ids: [] },
    tasks: [{ id: 'T001', title: 'Подготовить результат этапа', why: 'Создать проверяемое изменение проекта', dependencies: [],
      functional_paths: [], documentation_paths: ['docs/notes.md'], acceptance_criteria: ['Результат подготовлен'], verification_ids: [], expected_commit_message: 'docs: подготовить результат этапа' },
      {id:'T900',title:'Delivery',why:'Publish fixture',dependencies:[],functional_paths:[],documentation_paths:['docs/notes.md'],acceptance_criteria:['Delivered'],verification_ids:['package'],verification_kind:'package',expected_commit_message:'chore: deliver fixture'}],
  };
}

test('NONE plan keeps project navigation and code-only scope does not add DOCS', async t => {
  const root = await fixture(t);
  const none = readPlan(root);
  assert.equal(none.objective, PROJECT_CONTINUATION_OBJECTIVE);
  assert.deepEqual(none.context_pack.documents.slice(0, 3).map(doc => doc.path), [
    'docs/architecture/OVERVIEW.md',
  ]);
  createScope(root, scopeInput(true));
  const active = readPlan(root);
  assert.deepEqual(active.tasks.map(t=>t.id), ['T001','T002','T003']);
  assert.ok(!active.context_pack.documents.some(doc => doc.path === 'README.md'));
  for (const required of ['docs/architecture/OVERVIEW.md']) {
    assert.ok(active.context_pack.documents.some(doc => doc.path === required && doc.required));
  }
});

test('READY_FOR_ACCEPTANCE requires DOCS and archive returns a contextual NONE plan', async t => {
  const root = await fixture(t);
  createScope(root, continuityScopeInput());
  let plan = readPlan(root);
  assert.equal(plan.delivery_status, 'IN_PROGRESS');
  assert.equal(plan.tasks.at(-2).id, 'DOCS');
  assert.deepEqual(plan.tasks.at(-2).dependencies, ['T001']);

  startTask(root, 'T001');
  await fs.appendFile(path.join(root, 'docs/notes.md'), '\nRESULT_READY\n');
  const implementation = commitTask(root, 'T001');
  plan = readPlan(root);
  assert.equal(plan.delivery_status, 'IN_PROGRESS');
  assert.equal(plan.tasks.find(task => task.id === 'DOCS').commit_status, 'PENDING');

  startTask(root, 'DOCS');
  const docsPacket = recover(root, 'manual');
  assert.match(docsPacket.text, /OVERVIEW_REQUIRED/, 'DOCS receives the current project overview');
  assert.equal(docsPacket.included.includes(implementation.sha), false, 'DOCS ordering dependency is not copied as commit diff');
  assert.doesNotMatch(docsPacket.text, /RESULT_READY/, 'DOCS recovery does not replay completed implementation diff');
  commitTask(root, 'DOCS');
  startTask(root,'T900');commitTask(root,'T900');
  plan = readPlan(root);
  assert.equal(plan.execution_scope_status, 'ACTIVE');
  assert.equal(plan.delivery_status, 'READY_FOR_ACCEPTANCE');
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.match(recover(root, 'manual').text, /Все задачи выполнены/);

  archive(root, plan.scope_id, 'Пользователь принял результат и поручил закрыть этот scope.');
  const none = readPlan(root);
  assert.equal(none.execution_scope_status, 'NONE');
  assert.equal(none.archived_scope_id, 'continuity-acceptance-001');
  assert.equal(none.objective, PROJECT_CONTINUATION_OBJECTIVE);
  assert.deepEqual(none.tasks, []);
  for (const required of ['docs/architecture/OVERVIEW.md']) {
    assert.ok(none.context_pack.documents.some(doc => doc.path === required && doc.required));
  }
  const packet = recover(root, 'startup');
  assert.match(packet.text, /OVERVIEW_REQUIRED/);
  // Workflow Kit 1.5.4: navigation maps and forms are read on demand outside the final DOCS.
  assert.doesNotMatch(packet.text, /Fixture module map/);
  assert.doesNotMatch(packet.text,/README_REQUIRED/);
  assert.doesNotMatch(packet.text, /--- ДАННЫЕ: \.harness\/kit\/templates\/PLAN\.md ---/);
  assert.ok(packet.text.includes('plan:create --help'));
  assert.ok(packet.text.includes(PROJECT_CONTINUATION_OBJECTIVE));
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('READY_FOR_ACCEPTANCE can reopen for corrections and rerun DOCS with an unambiguous iteration', async t => {
  const root = await fixture(t);
  createScope(root, continuityScopeInput());
  startTask(root, 'T001');
  await fs.appendFile(path.join(root, 'docs/notes.md'), '\nFIRST_RESULT\n');
  commitTask(root, 'T001');
  startTask(root, 'DOCS');
  const firstDocs = commitTask(root, 'DOCS');
  startTask(root,'T900');commitTask(root,'T900');
  let plan = readPlan(root);
  assert.equal(plan.delivery_status, 'READY_FOR_ACCEPTANCE');
  const completed = structuredClone(plan.tasks);

  const correction = { id: 'T002', title: 'Исправить результат после проверки', why: 'Учесть замечание пользователя',
    dependencies: ['T001'], functional_paths: [], documentation_paths: ['docs/notes.md'],
    acceptance_criteria: ['Исправление внесено'], verification_ids: [], expected_commit_message: 'docs: исправить результат',
    implementation_status: 'TODO', commit_status: 'PENDING',
    commit_ref: { scope_id: plan.scope_id, task_id: 'T002', role: 'implementation' } };
  const delivery={...structuredClone(plan.tasks.at(-1)),id:'T901',dependencies:[],implementation_status:'TODO',commit_status:'PENDING',commit_ref:{scope_id:plan.scope_id,task_id:'T901',role:'implementation'}};
  delete delivery.actual_files;
  applyPlan(root, { tasks: [...plan.tasks, correction,delivery] }, plan.plan_revision);
  plan = readPlan(root);
  assert.equal(plan.delivery_status, 'IN_PROGRESS');
  assert.deepEqual(plan.tasks.slice(0,completed.length),completed);
  assert.equal(plan.tasks.at(-2).id, 'DOCS-2');
  assert.equal(plan.tasks.at(-2).commit_status, 'PENDING');
  assert.equal(plan.tasks.at(-2).commit_ref.iteration, 2);
  assert.deepEqual(plan.tasks.at(-2).dependencies, ['T002']);

  startTask(root, 'T002');
  await fs.appendFile(path.join(root, 'docs/notes.md'), '\nCORRECTED_RESULT\n');
  commitTask(root, 'T002');
  startTask(root, 'DOCS-2');
  assert.doesNotThrow(() => recover(root, 'manual'));
  const secondDocs = commitTask(root, 'DOCS-2');
  startTask(root,'T901');commitTask(root,'T901');
  plan = readPlan(root);
  assert.equal(plan.delivery_status, 'READY_FOR_ACCEPTANCE');
  assert.equal(plan.tasks.at(-2).commit_ref.iteration, 2);
  assert.notEqual(secondDocs.sha, firstDocs.sha);
  const log = git(root, 'log', '--format=%B', plan.baseline_commit + '..HEAD');
  assert.match(log, /Workflow-Task: DOCS-2[\s\S]*Workflow-Iteration: 2/);
  assert.equal((log.match(/Workflow-Task: DOCS/g) ?? []).length, 2);
  assert.doesNotThrow(() => recover(root, 'manual'));
});

test('functional scope requires compact overview and module specification', async t => {
  const root = await fixture(t);
  assert.throws(() => createScope(root, scopeInput(false)), error => error?.code === 'MODULE_CONTEXT_REQUIRED');
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('Recovery sends whole required documents, optional references and all tasks without commit diffs', async t => {
  const root = await fixture(t);
  createScope(root, scopeInput(true));
  startTask(root, 'T001');
  await fs.appendFile(path.join(root, 'docs/modules/module.md'), '\nT001_CHANGE\n');
  const first = commitTask(root, 'T001');
  startTask(root, 'T002');
  await fs.appendFile(path.join(root, 'docs/notes.md'), '\nT002_UNRELATED_CHANGE\n');
  const second = commitTask(root, 'T002');
  const packet = recover(root, 'startup');
  assert.equal(packet.next_task_id, 'T003');
  assert.equal(packet.soft_exceeded, undefined);
  assert.equal(packet.size.tokens, undefined);
  assert.equal(packet.token_method, undefined);
  assert.equal(packet.size.characters,[...packet.text].length);
  assert.match(packet.text, /## Workflow Core/);
  assert.ok(packet.text.includes('Build/package/sign/notarize/release/publish'));
  assert.match(packet.text, /DOCS выполняется до явного delivery-хвоста/);
  assert.equal(packet.text.split('Если задачу нельзя завершить в этом ответе').length - 1, 1, 'safe stop rule is delivered once');
  assert.match(packet.text, /Долгую команду веди в фоне с идентификатором процесса/);
  assert.doesNotMatch(packet.text, /## Обязательные правила/);
  assert.match(packet.text, /OVERVIEW_REQUIRED/);
  assert.match(packet.text, /MODULE_REQUIRED/);
  assert.match(packet.text,/PROJECT_CONSTRAINT/);
  assert.doesNotMatch(packet.text,/KIT_LOCATOR_DO_NOT_INLINE/);
  assert.match(packet.text, /docs\/optional\.md @ WORKTREE/);
  assert.doesNotMatch(packet.text, /OPTIONAL_SECRET_BODY_SHOULD_NOT_BE_COPIED/);
  assert.match(packet.text, new RegExp(first.sha));
  assert.doesNotMatch(packet.text, new RegExp('ДАННЫЕ: commit ' + second.sha + ' / T002'));
  assert.doesNotMatch(packet.text, /T002_UNRELATED_CHANGE/);
  assert.ok(packet.size.bytes < 60000, `unexpected recovery size: ${packet.size.bytes}`);
});

test('completeness lists AGENTS.md only when its project part is delivered', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root,'AGENTS.md'),'<!-- workflow-kit:begin -->\nKIT_LOCATOR_DO_NOT_INLINE\n<!-- workflow-kit:end -->\n');
  const kitOnly = recover(root, 'startup');
  assert.doesNotMatch(kitOnly.text, /KIT_LOCATOR_DO_NOT_INLINE/);
  assert.ok(!kitOnly.included.includes('AGENTS.md'), 'empty project part is not reported as included');
  await fs.appendFile(path.join(root,'AGENTS.md'),'PROJECT_CONSTRAINT\n');
  const withProject = recover(root, 'startup');
  assert.match(withProject.text, /PROJECT_CONSTRAINT/);
  assert.ok(withProject.included.includes('AGENTS.md'));
});

test('Recovery v2 reports largest sections when required context exceeds transport budget', async t => {
  const root = await fixture(t);
  createScope(root, scopeInput(true));
  startTask(root, 'T001');
  await fs.appendFile(path.join(root, 'docs/modules/module.md'), '\n' + 'x'.repeat(190000));
  assert.throws(() => recover(root), error => {
    assert.equal(error?.code, 'CONTEXT_TOO_LARGE');
    assert.equal(error.details?.budget?.hard_bytes, 180000);
    assert.ok(error.details?.largest_sections?.[0]?.bytes > 180000);
    assert.ok(error.details.largest_sections.some(section => /required:docs\/modules\/module\.md/.test(section.label)));
    return true;
  });
});

test('all chat identities recover the same current checkout plan without session ownership', async t => {
  const { withSessionPlan } = await import('@webpilot/workflow-kit/lib/session-plans');
  const { contextPacket } = await import('@webpilot/workflow-kit/lib/recovery');
  const root = await fixture(t);
  createScope(root, { ...continuityScopeInput(), scope_id: 'current-checkout', objective: 'ONLY_CURRENT_CHECKOUT' });

  for (const session of ['session-a','session-b','empty']) {
    const packet = withSessionPlan(root, { sessionId: session }, () => contextPacket(root));
    assert.equal(packet.session_id, null);
    assert.equal(packet.plan_id, 'current-checkout');
    assert.equal(packet.facts.scope_id, 'current-checkout');
    assert.equal(packet.facts.execution_scope_status, 'ACTIVE');
    assert.match(packet.context, /ONLY_CURRENT_CHECKOUT/);
    assert.match(packet.context, /Новый chat\/client продолжает этот же checkout plan/);
    assert.doesNotMatch(packet.context, new RegExp('--session ' + session));
    assert.equal(packet.context_bytes, Buffer.byteLength(packet.context));
  }
});

test('batched Git trailers retain parse semantics, Unicode, duplicates, unfolding and patch dividers', async t => {
  const root = await fixture(t);
  const { commitHistory } = await import('@webpilot/workflow-kit/lib/git');
  const messages = [
    'plain message without trailers',
    'subject\n\nWorkflow-Scope: scope-α\nWorkflow-Task: T001\nWorkflow-Task: T002\nWorkflow-Iteration: 2\n',
    'subject\n\nWorkflow-Task: длинное\n продолжение\n\tстроки\n',
    'subject\n\nWorkflow-Task:\n',
    'subject\n\nWorkflow-Task: before\n---\npatch\nWorkflow-Task: after\n',
    'subject\n\nText with record separator \x1e survives\n\nWorkflow-Task: T001\n',
  ];
  for (const message of messages) git(root, 'commit', '--allow-empty', '--cleanup=verbatim', '-m', message);
  const history = commitHistory(root, null);
  assert.equal(history.length, messages.length + 1);
  for (const record of history) {
    const parsed = execFileSync('git', ['interpret-trailers', '--parse'], { cwd: root, env, input: record.body, encoding: 'utf8' }).trim();
    const expected = {};
    for (const line of parsed.split('\n').filter(Boolean)) {
      const colon = line.indexOf(':'); if (colon < 0) continue;
      (expected[line.slice(0, colon)] ??= []).push(line.slice(colon + 1).trim());
    }
    assert.deepEqual(record.trailers, expected, record.body);
  }
  assert.deepEqual(history.find(r => r.body.includes('scope-α')).trailers['Workflow-Task'], ['T001', 'T002']);
  assert.equal(history.find(r => r.body.includes('patch')).trailers['Workflow-Task'][0], 'before');
  assert.throws(() => commitHistory(root, '0'.repeat(40)), { code: 'BASELINE_MISMATCH' });
});

test('batched ancestry follows merge graph and changed replacement refs', async t => {
  const root = await fixture(t);
  const { areAncestors, commitHistory } = await import('@webpilot/workflow-kit/lib/git');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-b', 'side');
  git(root, 'commit', '--allow-empty', '-m', 'side'); const side = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', 'main');
  git(root, 'commit', '--allow-empty', '-m', 'main'); const main = git(root, 'rev-parse', 'HEAD');
  assert.equal(areAncestors(root, [base, side], main), false);
  git(root, 'merge', '--no-ff', 'side', '-m', 'merge');
  const merged = git(root, 'rev-parse', 'HEAD');
  assert.equal(areAncestors(root, [base, side, main], merged), true);
  assert.equal(areAncestors(root, [], merged), true);
  const replacement = git(root, 'commit-tree', merged + '^{tree}', '-p', main, '-m', 'replacement\n\nWorkflow-Task: replacement');
  git(root, 'replace', merged, replacement);
  assert.equal(areAncestors(root, [base, side], merged), false);
  assert.deepEqual(commitHistory(root, base)[0].trailers['Workflow-Task'], ['replacement']);
  git(root, 'replace', '-d', merged);
  assert.equal(areAncestors(root, [base, side], merged), true);
});

const sourceText = (packet, source, revision = 'WORKTREE') => packet.parts.flatMap(part=>part.sources)
  .filter(fragment=>fragment.source===source&&fragment.revision===revision).map(fragment=>fragment.content).join('');

test('legacy navigation references retain validated path, revision and bytes, never their bodies', async t => {
  const root=await fixture(t), sha=git(root,'rev-parse','HEAD');
  const plan=readPlan(root);
  for(const file of ['docs/MODULES.md','docs/DOCUMENTATION_INDEX.md']) {
    const old=await fs.readFile(path.join(root,file),'utf8');
    const current='# Legacy\n'+'LEGACY_BODY_NOT_DELIVERED'.repeat(2000);
    await fs.writeFile(path.join(root,file),current);
    plan.context_pack.documents.push({path:file,required:true,revision:'WORKTREE'},{path:file,required:true,revision:sha});
    writePlan(root,plan);
    const packet=recover(root);
    for(const [revision,text] of [['WORKTREE',current],[sha,old]]) {
      const ref=packet.omitted.find(d=>d.path===file&&d.revision===revision);
      assert.equal(ref.bytes,Buffer.byteLength(text));assert.equal(ref.reason,'LEGACY_REFERENCE_ONLY');
      assert.ok(packet.text.includes(file+' @ '+revision+' — '+ref.bytes+' байт'));
      assert.equal(sourceText(packet,'required:'+file,revision),'');
    }
    assert.doesNotMatch(packet.text,/LEGACY_BODY_NOT_DELIVERED/);
    await fs.unlink(path.join(root,file));
    assert.throws(()=>recover(root),{code:'MISSING_FILE'});
    await fs.writeFile(path.join(root,file),current);
  }
  plan.context_pack.documents.find(d=>d.path==='docs/MODULES.md'&&d.revision===sha).revision='0'.repeat(40);
  writePlan(root,plan);assert.throws(()=>recover(root),{code:'CONTEXT_REVISION'});
});

test('seven parts are complete; an eighth fails even below the total byte budget', async t => {
  const root=await fixture(t), plan=readPlan(root);
  for(let i=1;i<=6;i++) {
    const file='docs/modules/part-'+i+'.md';
    await fs.writeFile(path.join(root,file),'я'.repeat(11000));
    plan.context_pack.documents.push({path:file,required:true});
  }
  writePlan(root,plan);
  const seven=recover(root);
  assert.equal(seven.parts.length,7);assert.ok(seven.size.bytes<180000);
  for(let i=1;i<=6;i++) assert.equal(sourceText(seven,'required:docs/modules/part-'+i+'.md'),'я'.repeat(11000));
  const file='docs/modules/part-7.md';await fs.writeFile(path.join(root,file),'я'.repeat(11000));
  plan.context_pack.documents.push({path:file,required:true});writePlan(root,plan);
  assert.throws(()=>recover(root),error=>{
    assert.equal(error.code,'CONTEXT_TOO_LARGE');assert.equal(error.details.parts,8);
    assert.equal(error.details.max_parts,7);assert.ok(error.details.bytes<180000);return true;
  });
});

test('splitter preserves exact Unicode content at headings, paragraphs, lines and character boundaries', () => {
  for (const text of [
    '# A\n'+'я'.repeat(25)+'\n# B\n'+'ю'.repeat(40)+'\n',
    'первая\n\n'+'вторая '.repeat(50), 'строка\n'.repeat(60), '😀漢я'.repeat(100),
    '# Long section\n'+('строка 😀\r\n'.repeat(90))+'\nEND'
  ]) {
    const pieces=splitText(text,75);
    assert.equal(pieces.join(''),text);
    assert.ok(pieces.every(piece=>Buffer.byteLength(piece)<=75&&!piece.includes('\ufffd')));
  }
  assert.equal(splitText('# A\n123456\n# B\nabcdef',18)[0],'# A\n123456\n');
  assert.equal(splitText('aaaa\n\nbbbbbbbbbbbb',12)[0],'aaaa\n\n');
  assert.equal(splitText('aaaa\nbbbbbbbbbbbb',12)[0],'aaaa\n');
  const text='# Большой документ\n'+'😀строка'.repeat(9000);
  const parts=recoveryParts([{label:'long.md',text,document:true}],28000);
  assert.equal(parts.flatMap(part=>part.sources).map(fragment=>fragment.content).join(''),text);
  assert.ok(parts.every(part=>part.bytes<=28000&&part.bytes===Buffer.byteLength(part.text)));
  assert.ok(parts.every(part=>part.text.includes('разделить при следующей правке')));
  const whole=recoveryParts([{label:'small.md',text:'# Whole\nshort\n',document:true}],28000);
  assert.equal(whole[0].sources[0].total,1);
  assert.throws(()=>recoveryParts([{label:'long-name',text:'x'}],20),{code:'CONTEXT_PART_LIMIT'});
});

test('whole documents use exact revisions and pair deduplication with required winning', async t => {
  const root=await fixture(t), file='docs/modules/module.md', sha=git(root,'rev-parse','HEAD');
  const historical=await fs.readFile(path.join(root,file),'utf8');
  await fs.appendFile(path.join(root,file),'\n# Outside old heading\nWHOLE_DOCUMENT_TAIL\n');
  const plan=readPlan(root);
  plan.context_pack.documents.push(
    {path:file,required:false,heading_path:['nonexistent']},
    {path:file,required:true,revision:'WORKTREE',heading_path:['also nonexistent']},
    {path:file,required:true,revision:sha},
    {path:file,required:false,revision:sha});
  writePlan(root,plan);
  const packet=recover(root);
  assert.equal(sourceText(packet,'required:'+file),await fs.readFile(path.join(root,file),'utf8'));
  assert.equal(sourceText(packet,'required:'+file,sha),historical);
  assert.equal(packet.parts.flatMap(part=>part.sources).filter(s=>s.source==='required:'+file).length,2);
  await fs.unlink(path.join(root,file));
  assert.throws(()=>recover(root),{code:'MISSING_FILE'},'historical revision must not hide a missing WORKTREE source');
  plan.context_pack.documents=plan.context_pack.documents.filter(doc=>doc.path!==file);
  plan.context_pack.documents.push({path:file,required:true,revision:'0'.repeat(40)});
  writePlan(root,plan);
  assert.throws(()=>recover(root),{code:'CONTEXT_REVISION'});
  plan.context_pack.documents.at(-1).revision=sha;
  plan.context_pack.documents.at(-1).path='docs/never-existed.md';writePlan(root,plan);
  assert.throws(()=>recover(root),{code:'MISSING_FILE'});
  plan.context_pack.documents.at(-1).path='.env';writePlan(root,plan);
  assert.throws(()=>recover(root),{code:'PRIVATE_CONTEXT'});
});

test('large task and legacy document are complete; changes are path lists without diff or untracked bodies', async t => {
  const root=await fixture(t);
  const input=scopeInput();
  input.tasks[0].acceptance_criteria=['😀Критерий'.repeat(3500)+'CRITERION_END'];
  createScope(root,input);
  startTask(root,'T001');
  const legacy='# Legacy\n'+'Я😀'.repeat(7000)+'LEGACY_END';
  await fs.writeFile(path.join(root,'docs/modules/module.md'),legacy);
  await fs.writeFile(path.join(root,'src/module.mjs'),'STAGED_PAYLOAD_MUST_NOT_APPEAR');
  git(root,'add','src/module.mjs');
  await fs.writeFile(path.join(root,'src/module.mjs'),'UNSTAGED_PAYLOAD_MUST_NOT_APPEAR');
  await fs.writeFile(path.join(root,'foreign.txt'),'UNTRACKED_PAYLOAD_MUST_NOT_APPEAR');
  const packet=recover(root);
  assert.equal(sourceText(packet,'required:docs/modules/module.md'),legacy);
  assert.ok(sourceText(packet,'task:T001').includes(input.tasks[0].acceptance_criteria[0]));
  assert.match(packet.text,/разделить при следующей правке/);
  assert.match(packet.text,/STAGED:\n/);assert.match(packet.text,/UNSTAGED:\n/);assert.match(packet.text,/UNTRACKED:\nforeign.txt/);
  assert.ok(sourceText(packet,'foreign').split('\n').includes('foreign.txt'));
  assert.doesNotMatch(packet.text,/PAYLOAD_MUST_NOT_APPEAR|diff --git|CHANGE_CONTENT_ON_DEMAND|"implementation_status"/);
  assert.ok(packet.parts.every(part=>part.bytes<=28000));
});

test('planning inventory and real inspection key change on repeated dirty edits and invalidate a stale recovery', async t => {
  const root=await fixture(t);
  await fs.mkdir(path.join(root,'docs/planning'));
  const file=path.join(root,'docs/planning/discussion.md');
  await fs.writeFile(file,'# Discussion\nBODY_NOT_INCLUDED_1');
  const first=inspectionInputs(root).key;
  await fs.writeFile(file,'# Discussion\nBODY_NOT_INCLUDED_2');
  const second=inspectionInputs(root).key;
  assert.notEqual(first,second,'same path/status/size still changes content key');
  let packet=recover(root);
  assert.match(packet.text,/docs\/planning\/discussion.md — Discussion — 32 байт/);
  assert.doesNotMatch(packet.text,/BODY_NOT_INCLUDED/);
  assert.throws(()=>recover(root,'manual',{beforeRecheck:attempt=>{
    execFileSync(process.execPath,['-e','require("fs").appendFileSync(process.argv[1],process.argv[2])',file,String(attempt)]);
  }}),{code:'CONCURRENT_CHANGE'});
  packet=recover(root,'manual',{beforeRecheck:attempt=>{
    if(attempt===0) execFileSync(process.execPath,['-e','require("fs").writeFileSync(process.argv[1],"# Updated\\nbody")',file]);
  }});
  assert.match(packet.text,/discussion.md — Updated/);
  await fs.unlink(file);
  assert.notEqual(inspectionInputs(root).key,second);
  assert.match(recover(root).text,/Предыдущего закрытого плана нет/);
});

test('NONE carries verified closure, all previous tasks and immutable specification references', async t => {
  const root=await fixture(t), input=scopeInput();
  input.tasks=input.tasks.slice(0,1);
  createScope(root,input);
  startTask(root,'T001');
  await fs.appendFile(path.join(root,'docs/modules/module.md'),'\nRELEASED_SPEC\n');
  const implementation=commitTask(root,'T001');
  const closing=archive(root,readPlan(root).scope_id,'User explicitly accepts and closes this scope.');
  await fs.unlink(path.join(root,'docs/modules/module.md'));
  commitDocumentation(root,['docs/modules/module.md'],'docs: remove released specification');
  const packet=recover(root);
  assert.match(packet.text,new RegExp('Коммит закрытия: '+closing.sha));
  assert.match(packet.text,new RegExp('docs/modules/module.md @ '+implementation.sha));
  assert.equal(sourceText(packet,'previous-tasks',implementation.sha),
    'T001 — '+input.tasks[0].title+' — DONE / DONE — '+implementation.sha);
  assert.ok(!packet.parts.flatMap(part=>part.sources).some(source=>source.source.startsWith('previous-task:')));
  assert.doesNotMatch(packet.text,/Зачем:|Фактические файлы:|Сообщение коммита:/);
  assert.doesNotMatch(packet.text,/RELEASED_SPEC/,'closed specification is a Git reference, not automatic history replay');
});

test('installed hooks pin deleted required documents atomically and preserve edits after a failed commit', async t => {
  const {installer}=await import('@webpilot/workflow-kit');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'workflow-recovery-delete-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  git(root,'init','-b','main');git(root,'config','user.name','Workflow Test');git(root,'config','user.email','workflow@example.invalid');
  await fs.writeFile(path.join(root,'README.md'),'# Fixture\n');git(root,'add','.');git(root,'commit','-m','baseline');
  installer.install({project:root,mode:'existing'});
  await fs.mkdir(path.join(root,'docs/planning'),{recursive:true});
  const file='docs/planning/current.md';
  await fs.writeFile(path.join(root,file),'# Current spec\nSAVED_SPEC');
  const input=continuityScopeInput();
  input.tasks=input.tasks.slice(0,1);
  input.tasks[0].documentation_paths=[file];
  input.tasks[0].context_pack={documents:[{path:file,required:true}]};
  input.approved_scope.documentation_paths=[file];
  input.context_pack.documents=[{path:file,required:true},{path:file,required:false}];
  createScope(root,input);
  startTask(root,'T001');
  const before=git(root,'rev-parse','HEAD');
  const originalPlan=await fs.readFile(path.join(root,'.harness/plans/todo-plan.md'),'utf8');
  await fs.unlink(path.join(root,file));
  await fs.writeFile(path.join(root,'too-big.md'),'x'.repeat(28001));
  assert.throws(()=>commitTask(root,'T001'),error=>error.code==='COMMIT_FAILED'&&error.details.output.includes('DOCUMENT_TOO_LARGE'));
  assert.equal(git(root,'rev-parse','HEAD'),before);
  assert.equal(await fs.readFile(path.join(root,'.harness/plans/todo-plan.md'),'utf8'),originalPlan);
  await assert.rejects(fs.stat(path.join(root,file)),{code:'ENOENT'});
  assert.equal((await fs.stat(path.join(root,'too-big.md'))).size,28001);
  await fs.writeFile(path.join(root,'too-big.md'),'# Corrected\n');
  process.env.WORKFLOW_TEST_FAILPOINT='prepared';
  try { assert.throws(()=>commitTask(root,'T001'),{code:'TEST_INTERRUPTION'}); }
  finally { delete process.env.WORKFLOW_TEST_FAILPOINT; }
  const pending=recover(root);
  assert.equal(pending.transaction_pending,true);
  assert.match(pending.text,/COMMIT_PENDING/);
  assert.match(pending.text,/SAVED_SPEC/);
  const committed=commitTask(root,'T001');
  const plan=readPlan(root);
  assert.ok(plan.context_pack.documents.filter(doc=>doc.path===file).every(doc=>doc.revision===before));
  assert.equal(plan.tasks[0].context_pack.documents[0].revision,before);
  assert.match(git(root,'show',committed.sha+':.harness/plans/todo-plan.md'),new RegExp(before));
  assert.match(recover(root).text,/SAVED_SPEC/);
  // Required file created then removed before a commit has no recoverable blob.
  const missing='docs/planning/never-committed.md';
  plan.context_pack.documents.push({path:missing,required:true});
  writePlan(root,plan);
  await fs.writeFile(path.join(root,missing),'uncommitted');await fs.unlink(path.join(root,missing));
  await fs.writeFile(path.join(root,'notes.md'),'# Other selected edit\n');
  const damaged=await fs.readFile(path.join(root,'.harness/plans/todo-plan.md'),'utf8');
  const index=git(root,'write-tree');
  assert.throws(()=>commitDocumentation(root,[missing,'notes.md'],'docs: invalid deletion'),{code:'MISSING_FILE'});
  assert.equal(git(root,'write-tree'),index);
  assert.equal(await fs.readFile(path.join(root,'.harness/plans/todo-plan.md'),'utf8'),damaged);
});

test('Windows Node execution does not invalidate Workflow Kit inspection', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t);
  const directory = path.join(root, '.harness/runtime');
  await fs.mkdir(directory, { recursive: true });
  const localNode = path.join(directory, 'node.exe');
  await fs.copyFile(process.execPath, localNode);
  const before = inspectionInputs(root).key;

  execFileSync(localNode, ['--version'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(inspectionInputs(root).key, before, 'launching project Node must not invalidate inspection');

  execFileSync(process.execPath, ['--version'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(inspectionInputs(root).key, before, 'launching worker Node must not invalidate inspection');

  await fs.appendFile(localNode, Buffer.from([0]));
  assert.notEqual(inspectionInputs(root).key, before, 'changing the Node binary must invalidate inspection');
});
