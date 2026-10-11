# Активный план — Project Web Pilot

<!-- workflow-state:begin -->
```json
{
  "schema_version": 1,
  "plan_revision": 1763,
  "project_id": "cf944136-d1fc-4bd5-9ea0-e46d1fe230e7",
  "project_name": "Project Web Pilot",
  "scope_id": "autoplan-lifecycle-recovery-20261011",
  "execution_scope_status": "ACTIVE",
  "delivery_status": "IN_PROGRESS",
  "objective": "Автовыполнение сохраняет явный ON до первого плана и без повторного переключения возобновляет незавершённый план в восстановленной основной сессии; подтверждено end-to-end fixtures и парным выпуском.",
  "acceptance_criteria": [
    "Включённое до планирования AutoPlan не выключается после создания ACTIVE и начинает выполнение после первого пригодного ответа без второго клика.",
    "После OFF и Recovery другого основного чата явное ON при частично выполненном sequential-плане отправляет одно продолжение на существующей idle-паузе без OFF→ON; старый чат не продолжает.",
    "Явное OFF прекращает новые автоматические отправки, а NONE/stale/read error/Review/restart/смена страницы не отменяют ON.",
    "Сохранены подтверждение Kit, защита pending/unknown/sent, проверка projectId, блокировка черновика и отсутствие дублирующих Send или parallel merge.",
    "Unit, полная Node suite и Electron TEST FIXTURE проходят; пользователь получает парный выпуск с указанием ограничений живой приёмки."
  ],
  "approved_scope": {
    "functional_paths": [
      "src/project-auto-plan.mjs",
      "src/project-session-auto-plan.mjs",
      "src/auto-plan.mjs",
      "src/auto-plan-state.mjs",
      "src/plan-monitor.mjs",
      "src/main.mjs",
      "src/session-runtime.mjs",
      "src/ui/sidebar.mjs",
      "tests/project-auto-plan.test.mjs",
      "tests/auto-plan.test.mjs",
      "tests/electron-smoke.mjs",
      "tests/plan-monitor.test.mjs",
      "tests/parallel-finalization.test.mjs",
      "package.json",
      "package-lock.json",
      ".harness/workflow.json",
      "release-manifest.json",
      "tests/parallel-execution-recovery.test.mjs"
    ],
    "documentation_paths": [
      "docs/planning/autoplan-lifecycle-recovery-spec.md",
      "docs/modules/auto-plan.md",
      "docs/modules/auto-plan-send.md",
      "docs/modules/workspace-sessions.md",
      "docs/modules/plan-view.md",
      "docs/modules/parallel-execution.md",
      "docs/modules/release.md",
      "docs/architecture/OVERVIEW.md",
      "README.md"
    ]
  },
  "baseline_commit": "a1cd02424932d4666fd43cbcd6a61a7f2d5e2a31",
  "current_task_id": null,
  "context_pack": {
    "documents": [
      {
        "path": "docs/planning/autoplan-lifecycle-recovery-spec.md",
        "required": true,
        "revision": "WORKTREE"
      },
      {
        "path": "docs/modules/auto-plan.md",
        "required": true,
        "revision": "WORKTREE"
      },
      {
        "path": "docs/modules/auto-plan-send.md",
        "required": true,
        "revision": "WORKTREE"
      },
      {
        "path": "docs/architecture/OVERVIEW.md",
        "required": true,
        "revision": "WORKTREE"
      }
    ],
    "include_last_completed_task": false,
    "dependency_task_ids": []
  },
  "tasks": [
    {
      "implementation_status": "DONE",
      "commit_status": "DONE",
      "commit_ref": {
        "scope_id": "autoplan-lifecycle-recovery-20261011",
        "task_id": "T001",
        "role": "implementation"
      },
      "dependencies": [],
      "functional_paths": [
        "tests/project-auto-plan.test.mjs",
        "tests/auto-plan.test.mjs",
        "tests/electron-smoke.mjs",
        "tests/parallel-execution-recovery.test.mjs"
      ],
      "documentation_paths": [],
      "verification_ids": [
        "project-lifecycle",
        "unit-all",
        "electron-smoke"
      ],
      "id": "T001",
      "title": "Зафиксировать оба отказа на изолированных сквозных fixtures",
      "why": "Определить причинный порядок ON, публикации scope, Recovery, page idle и Send, не исправляя симптом повторной кнопкой.",
      "acceptance_criteria": [
        "Зафиксированы два воспроизводимых сценария: ON перед новой сессией/планом и OFF→новый Recovery→ON на частично DONE; известен точный переход, на котором теряется авторизация или пробуждение.",
        "Тестовый путь включает настоящий sidebar/preload/IPC на fixture; не использует живые чаты, а контрольный тест не требует второго клика для ожидаемого будущего контракта.",
        "Характеризующие assertions текущего поведения зелёные; требуемые новые assertions явно обозначены для следующих задач; защищены отдельные проекты, idempotency и сохранённые checkpoints."
      ],
      "expected_commit_message": "test: characterize AutoPlan planning and recovery gaps",
      "parallel_safe": false,
      "actual_files": [
        "tests/auto-plan.test.mjs",
        "tests/electron-smoke.mjs",
        "tests/parallel-execution-recovery.test.mjs",
        "tests/project-auto-plan.test.mjs"
      ]
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "autoplan-lifecycle-recovery-20261011",
        "task_id": "T002",
        "role": "implementation"
      },
      "dependencies": [
        "T001"
      ],
      "functional_paths": [
        "src/project-auto-plan.mjs",
        "src/project-session-auto-plan.mjs",
        "src/main.mjs",
        "tests/project-auto-plan.test.mjs",
        "tests/electron-smoke.mjs"
      ],
      "documentation_paths": [],
      "verification_ids": [
        "project-lifecycle",
        "unit-all",
        "electron-smoke"
      ],
      "id": "T002",
      "title": "Сохранить ON при создании сессии и публикации первого плана",
      "why": "Устранить потерю ожидания и неверную привязку scope/origin между NONE, Review и ACTIVE.",
      "acceptance_criteria": [
        "Путь click ON→NONE/новый Chat или Work→Review→публикация ACTIVE сохраняет одно permission и выбирает подтверждённый origin, затем начинает выполнение по завершении первого ответа без второго ON.",
        "Ожидание выдерживает restart, stale NONE, ошибку чтения, два монитора и смену revision; старый завершённый scope и другой projectId не наследуют разрешение.",
        "UI/сохранённая запись/controller не показывают противоречивого OFF при действующем ожидании."
      ],
      "expected_commit_message": "fix: retain AutoPlan authorization across plan publication",
      "parallel_safe": false
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "autoplan-lifecycle-recovery-20261011",
        "task_id": "T003",
        "role": "implementation"
      },
      "dependencies": [
        "T002"
      ],
      "functional_paths": [
        "src/project-session-auto-plan.mjs",
        "src/auto-plan.mjs",
        "src/main.mjs",
        "src/session-runtime.mjs",
        "src/plan-monitor.mjs",
        "tests/project-auto-plan.test.mjs",
        "tests/auto-plan.test.mjs"
      ],
      "documentation_paths": [],
      "verification_ids": [
        "unit-all",
        "electron-smoke"
      ],
      "id": "T003",
      "title": "Возобновлять частично выполненный план после Recovery одним ON",
      "why": "Адресовать восстановленную основную сессию, устранить пропущенное событие готовности и потребность повторного OFF→ON.",
      "acceptance_criteria": [
        "Частично DONE → пользовательский OFF → новый Chat/Work с Recovery и ответом assistant → ON отправляет одно Продолжай в новый чат в том же цикле событий; старый чат молчит.",
        "ON до завершения Recovery, во время busy, гидратации и при уже idle-паузе автоматически пробуждается на первом допустимом событии без повторного нажатия.",
        "Нет повторного Send после sent/UNKNOWN, при ручном Stop/Send, черновике, транзакции, активном Review и после выключения; параллельный origin не перехватывается."
      ],
      "expected_commit_message": "fix: wake AutoPlan in recovered session on first authorization",
      "parallel_safe": false
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "autoplan-lifecycle-recovery-20261011",
        "task_id": "T004",
        "role": "implementation"
      },
      "dependencies": [
        "T003"
      ],
      "functional_paths": [
        "tests/electron-smoke.mjs",
        "tests/project-auto-plan.test.mjs",
        "tests/auto-plan.test.mjs",
        "tests/parallel-finalization.test.mjs"
      ],
      "documentation_paths": [],
      "verification_ids": [
        "unit-all",
        "electron-smoke"
      ],
      "id": "T004",
      "title": "Завершить сквозную матрицу AutoPlan и регрессию смежных сценариев",
      "why": "Проверить поведение через пользовательский вход, а не только внутренние контроллеры.",
      "acceptance_criteria": [
        "Реальные на fixture sidebar click→IPC→settings→Kit/PlanMonitor→Composer пройдены для обоих пользовательских сценариев с **одним** ON.",
        "В WAIT проверены aria-pressed=true и непустая причина в #auto-plan-message[data-reason] (план не опубликован, busy, черновик); техническое ожидание не отображается как OFF.",
        "Матрица из спецификации охватывает Review, sequential и parallel, restart/reload, смену проекта/чата, race, OFF, no-duplicate и UNKNOWN; тесты не изменяют пользовательские данные.",
        "Полный Node suite и Electron smoke зелёные; ограничения отсутствия живого ChatGPT/native Windows/чистой ОС явно зафиксированы."
      ],
      "expected_commit_message": "test: cover AutoPlan lifecycle and recovered session end to end",
      "parallel_safe": false
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "autoplan-lifecycle-recovery-20261011",
        "task_id": "T005",
        "role": "implementation"
      },
      "dependencies": [
        "T004"
      ],
      "functional_paths": [
        "package.json",
        "package-lock.json",
        ".harness/workflow.json"
      ],
      "documentation_paths": [],
      "verification_ids": [
        "release-source"
      ],
      "id": "T005",
      "title": "Зафиксировать версию 0.6.113 и проверки поставки",
      "why": "Перед DOCS и сборкой получить непротиворечивые версию, source preflight и условия проверки готовых пакетов.",
      "acceptance_criteria": [
        "Версия 0.6.113 закреплена в обоих package manifests, Workflow Kit остаётся 1.7.2 без несанкционированного обновления.",
        "Evidence release-source/paired-release/release-installed/github-release обновлены на 0.6.113 и точные этапы T006 (build), T007 (install), T008 (GitHub); никакая сборка или публикация здесь не запускается."
      ],
      "expected_commit_message": "chore: prepare 0.6.113 release source and checks",
      "parallel_safe": false
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "autoplan-lifecycle-recovery-20261011",
        "task_id": "DOCS",
        "role": "implementation",
        "iteration": 1
      },
      "id": "DOCS",
      "title": "Актуализация всех документов проекта",
      "why": "Перед выпуском сверить README, OVERVIEW и действующие контракты модулей с результатом; обновить устаревшее.",
      "dependencies": [
        "T001",
        "T002",
        "T003",
        "T004",
        "T005"
      ],
      "functional_paths": [],
      "documentation_paths": [
        "docs/architecture/OVERVIEW.md"
      ],
      "acceptance_criteria": [
        "Документы описывают текущий результат, существенное из выпущенных рабочих спецификаций перенесено в контракты модулей; история остаётся в Git."
      ],
      "verification_ids": [],
      "expected_commit_message": "docs: актуализировать документацию проекта",
      "parallel_safe": false
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "autoplan-lifecycle-recovery-20261011",
        "task_id": "T006",
        "role": "implementation"
      },
      "dependencies": [
        "T005",
        "DOCS"
      ],
      "functional_paths": [
        "release-manifest.json"
      ],
      "documentation_paths": [],
      "verification_ids": [
        "paired-release"
      ],
      "id": "T006",
      "title": "Собрать единственный парный выпуск 0.6.113",
      "why": "Получить воспроизводимые готовые пакеты двух платформ из проверенного sourceCommit.",
      "verification_kind": "package",
      "acceptance_criteria": [
        "DOCS завершена, sourceCommit зафиксирован, один paired-release собрал macOS arm64 и Windows x64, manifest и контрольные суммы совпали.",
        "Проверены комплектность, подпись и Kit 1.7.2 без повторной сборки; ограничения native Windows и живого ChatGPT не скрыты."
      ],
      "expected_commit_message": "build: package verified 0.6.113 pair",
      "parallel_safe": false
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "autoplan-lifecycle-recovery-20261011",
        "task_id": "T007",
        "role": "implementation"
      },
      "dependencies": [
        "T006",
        "DOCS"
      ],
      "functional_paths": [
        "release-manifest.json"
      ],
      "documentation_paths": [],
      "verification_ids": [
        "release-installed"
      ],
      "id": "T007",
      "title": "Установить готовый macOS выпуск без пересборки",
      "why": "Сохранить постоянную app identity и пользовательские TCC-разрешения, не затронув работающий экземпляр.",
      "verification_kind": "installed",
      "acceptance_criteria": [
        "Установка из готового staging без сборки подтверждена check-installed-release, пути/symlink, подпись и identity сохранены.",
        "Работающее приложение принудительно не перезапускать; чистую ОС подтверждает только пользователь."
      ],
      "expected_commit_message": "release: install verified macOS 0.6.113",
      "parallel_safe": false
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "autoplan-lifecycle-recovery-20261011",
        "task_id": "T008",
        "role": "implementation"
      },
      "dependencies": [
        "T007",
        "DOCS"
      ],
      "functional_paths": [
        "release-manifest.json"
      ],
      "documentation_paths": [],
      "verification_ids": [
        "github-release"
      ],
      "id": "T008",
      "title": "Опубликовать и сверить GitHub Release 0.6.113",
      "why": "Обеспечить одну версию, один тег и шесть проверяемых assets обоих платформ.",
      "verification_kind": "package",
      "acceptance_criteria": [
        "Remote main, тег v0.6.113 на sourceCommit, release, шесть assets и все digest/размеры сверены с manifest без пересборки.",
        "Названы живые шаги приёмки ON до плана и ON после Recovery, ограничения macOS/Windows; план оставлен READY_FOR_ACCEPTANCE."
      ],
      "expected_commit_message": "release: publish verified 0.6.113 assets",
      "parallel_safe": false
    }
  ],
  "blocked_reason": null,
  "user_decisions": [
    {
      "id": "ef5868db-31dd-4de6-9d54-e5e036cc3987",
      "text": "Пользователь поручил тщательно исследовать два сбоя AutoPlan, подготовить спецификацию и to-do план их исправления с обязательными регрессионными тестами.",
      "recorded_at": "2026-10-11T11:31:58.345Z"
    }
  ],
  "execution_origin_session_id": "web-pilot-2973324c-d554-486a-8f53-4ec49c2cd48e",
  "parallel_allowed": true,
  "max_workers": 4,
  "execution_strategy": "sequential",
  "execution_reason": "Общие переходы ProjectAutoPlan, получателя Send, PlanMonitor и main IPC; параллельные исправления одной машины состояний мешают воспроизвести гонки и безопасно интегрировать изменения."
}
```
<!-- workflow-state:end -->

## Состояние

Execution Scope Status: ACTIVE
Delivery Status: IN_PROGRESS
Scope: autoplan-lifecycle-recovery-20261011
Current Task: нет
Revision: 1763

## Цель

Автовыполнение сохраняет явный ON до первого плана и без повторного переключения возобновляет незавершённый план в восстановленной основной сессии; подтверждено end-to-end fixtures и парным выпуском.

## Критерии приёмки

- Включённое до планирования AutoPlan не выключается после создания ACTIVE и начинает выполнение после первого пригодного ответа без второго клика.
- После OFF и Recovery другого основного чата явное ON при частично выполненном sequential-плане отправляет одно продолжение на существующей idle-паузе без OFF→ON; старый чат не продолжает.
- Явное OFF прекращает новые автоматические отправки, а NONE/stale/read error/Review/restart/смена страницы не отменяют ON.
- Сохранены подтверждение Kit, защита pending/unknown/sent, проверка projectId, блокировка черновика и отсутствие дублирующих Send или parallel merge.
- Unit, полная Node suite и Electron TEST FIXTURE проходят; пользователь получает парный выпуск с указанием ограничений живой приёмки.

## Микрозадачи

Выполнение: sequential; разрешено: true; лимит: 4
Причина: Общие переходы ProjectAutoPlan, получателя Send, PlanMonitor и main IPC; параллельные исправления одной машины состояний мешают воспроизвести гонки и безопасно интегрировать изменения.

- [DONE] T001: Зафиксировать оба отказа на изолированных сквозных fixtures — Завершено
  - Git Commit: [DONE] test: characterize AutoPlan planning and recovery gaps
  - Reference: autoplan-lifecycle-recovery-20261011 / T001 / implementation
  - Файлы: tests/project-auto-plan.test.mjs, tests/auto-plan.test.mjs, tests/electron-smoke.mjs, tests/parallel-execution-recovery.test.mjs
  - Параллельность: исключительное выполнение
  - Зависимости: нет
- [TODO] T002: Сохранить ON при создании сессии и публикации первого плана — Ожидает
  - Git Commit: [PENDING] fix: retain AutoPlan authorization across plan publication
  - Reference: autoplan-lifecycle-recovery-20261011 / T002 / implementation
  - Файлы: src/project-auto-plan.mjs, src/project-session-auto-plan.mjs, src/main.mjs, tests/project-auto-plan.test.mjs, tests/electron-smoke.mjs
  - Параллельность: исключительное выполнение
  - Зависимости: T001
- [TODO] T003: Возобновлять частично выполненный план после Recovery одним ON — Ожидает
  - Git Commit: [PENDING] fix: wake AutoPlan in recovered session on first authorization
  - Reference: autoplan-lifecycle-recovery-20261011 / T003 / implementation
  - Файлы: src/project-session-auto-plan.mjs, src/auto-plan.mjs, src/main.mjs, src/session-runtime.mjs, src/plan-monitor.mjs, tests/project-auto-plan.test.mjs, tests/auto-plan.test.mjs
  - Параллельность: исключительное выполнение
  - Зависимости: T002
- [TODO] T004: Завершить сквозную матрицу AutoPlan и регрессию смежных сценариев — Ожидает
  - Git Commit: [PENDING] test: cover AutoPlan lifecycle and recovered session end to end
  - Reference: autoplan-lifecycle-recovery-20261011 / T004 / implementation
  - Файлы: tests/electron-smoke.mjs, tests/project-auto-plan.test.mjs, tests/auto-plan.test.mjs, tests/parallel-finalization.test.mjs
  - Параллельность: исключительное выполнение
  - Зависимости: T003
- [TODO] T005: Зафиксировать версию 0.6.113 и проверки поставки — Ожидает
  - Git Commit: [PENDING] chore: prepare 0.6.113 release source and checks
  - Reference: autoplan-lifecycle-recovery-20261011 / T005 / implementation
  - Файлы: package.json, package-lock.json, .harness/workflow.json
  - Параллельность: исключительное выполнение
  - Зависимости: T004
- [TODO] DOCS: Актуализация всех документов проекта — Ожидает
  - Git Commit: [PENDING] docs: актуализировать документацию проекта
  - Reference: autoplan-lifecycle-recovery-20261011 / DOCS / implementation
  - Файлы: docs/architecture/OVERVIEW.md
  - Параллельность: исключительное выполнение
  - Зависимости: T001, T002, T003, T004, T005
- [TODO] T006: Собрать единственный парный выпуск 0.6.113 — Ожидает
  - Git Commit: [PENDING] build: package verified 0.6.113 pair
  - Reference: autoplan-lifecycle-recovery-20261011 / T006 / implementation
  - Файлы: release-manifest.json
  - Параллельность: исключительное выполнение
  - Зависимости: T005, DOCS
- [TODO] T007: Установить готовый macOS выпуск без пересборки — Ожидает
  - Git Commit: [PENDING] release: install verified macOS 0.6.113
  - Reference: autoplan-lifecycle-recovery-20261011 / T007 / implementation
  - Файлы: release-manifest.json
  - Параллельность: исключительное выполнение
  - Зависимости: T006, DOCS
- [TODO] T008: Опубликовать и сверить GitHub Release 0.6.113 — Ожидает
  - Git Commit: [PENDING] release: publish verified 0.6.113 assets
  - Reference: autoplan-lifecycle-recovery-20261011 / T008 / implementation
  - Файлы: release-manifest.json
  - Параллельность: исключительное выполнение
  - Зависимости: T007, DOCS

## Context Pack For This Cycle

- docs/planning/autoplan-lifecycle-recovery-spec.md
- docs/modules/auto-plan.md
- docs/modules/auto-plan-send.md
- docs/architecture/OVERVIEW.md

Служебные состояния меняются только командами workflow. Приёмка не архивирует scope.
