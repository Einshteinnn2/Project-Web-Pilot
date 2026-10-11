# Активный план — Project Web Pilot

<!-- workflow-state:begin -->
```json
{
  "schema_version": 1,
  "plan_revision": 1801,
  "project_id": "cf944136-d1fc-4bd5-9ea0-e46d1fe230e7",
  "project_name": "Project Web Pilot",
  "scope_id": "chat-session-rotation-20261011",
  "execution_scope_status": "ACTIVE",
  "delivery_status": "IN_PROGRESS",
  "objective": "Настраиваемая ротация Chat каждые 1–10 DONE при AutoPlan ON с безопасным Recovery и парным выпуском 0.6.114.",
  "acceptance_criteria": [
    "Chat при AutoPlan ON меняется после заданного N подтверждённых DONE и без дублей Recovery/Continue.",
    "При OFF/Work/parallel ротации нет, ошибки fail-closed, план и DONE сохранены.",
    "Проверенный парный выпуск 0.6.114 и READY_FOR_ACCEPTANCE."
  ],
  "approved_scope": {
    "functional_paths": [
      "tests/auto-plan.test.mjs",
      "tests/project-auto-plan.test.mjs",
      "src/chat-session-rotation-settings.mjs",
      "src/main.mjs",
      "src/preload.cjs",
      "src/ui/settings-panel.mjs",
      "src/ui/index.html",
      "tests/settings-chat-session-rotation.test.mjs",
      "src/chat-session-rotation.mjs",
      "src/project-auto-plan.mjs",
      "src/auto-plan-state.mjs",
      "tests/chat-session-rotation.test.mjs",
      "src/auto-plan.mjs",
      "src/project-session-auto-plan.mjs",
      "src/workspace-session.mjs",
      "src/session-runtime.mjs",
      "src/context-session.mjs",
      "tests/workspace-session.test.mjs",
      "tests/context-session.test.mjs",
      "tests/session-runtime.test.mjs",
      "src/ui/sidebar.mjs",
      "tests/electron-smoke.mjs",
      "tests/conversation-recovery.test.mjs",
      "package.json",
      "package-lock.json",
      ".harness/workflow.json",
      "scripts/check-installed-release.mjs",
      "scripts/check-github-release.mjs"
    ],
    "documentation_paths": [
      "docs/planning/chat-session-rotation-spec.md",
      "docs/modules/auto-plan.md",
      "docs/modules/auto-plan-send.md",
      "docs/modules/context-delivery.md",
      "docs/modules/workspace-sessions.md",
      "docs/modules/session-runtime.md",
      "docs/modules/workspace-sidebar-ui.md",
      "docs/architecture/OVERVIEW.md",
      "README.md",
      "docs/modules/release.md"
    ]
  },
  "baseline_commit": "acdfda4daab7f8b5aba0be784cdf3d5190cd452f",
  "current_task_id": null,
  "context_pack": {
    "documents": [
      {
        "path": "docs/architecture/OVERVIEW.md",
        "required": true,
        "revision": "WORKTREE"
      },
      {
        "path": "docs/planning/chat-session-rotation-spec.md",
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
        "scope_id": "chat-session-rotation-20261011",
        "task_id": "T001",
        "role": "implementation"
      },
      "dependencies": [],
      "functional_paths": [
        "tests/auto-plan.test.mjs",
        "tests/project-auto-plan.test.mjs"
      ],
      "documentation_paths": [
        "docs/planning/chat-session-rotation-spec.md"
      ],
      "verification_ids": [
        "unit-all"
      ],
      "id": "T001",
      "title": "Зафиксировать исходный жизненный цикл Chat и матрицу ротации",
      "why": "Согласованная ротация и поставка: Зафиксировать исходный жизненный цикл Chat и матрицу ротации",
      "verification_kind": "code",
      "acceptance_criteria": [
        "Только зелёные характеризующие тесты текущих AutoPlan и Recovery; будущие ожидания ротации описаны как todo/skip и не маскируют регрессию."
      ],
      "expected_commit_message": "feat: Зафиксировать исходный жизненный цикл Chat и матрицу ротации",
      "parallel_safe": false,
      "actual_files": [
        "docs/planning/chat-session-rotation-spec.md",
        "tests/auto-plan.test.mjs",
        "tests/project-auto-plan.test.mjs"
      ]
    },
    {
      "implementation_status": "DONE",
      "commit_status": "DONE",
      "commit_ref": {
        "scope_id": "chat-session-rotation-20261011",
        "task_id": "T002",
        "role": "implementation"
      },
      "dependencies": [
        "T001"
      ],
      "functional_paths": [
        "src/chat-session-rotation-settings.mjs",
        "src/main.mjs",
        "src/preload.cjs",
        "src/ui/settings-panel.mjs",
        "src/ui/index.html",
        "tests/settings-chat-session-rotation.test.mjs"
      ],
      "documentation_paths": [
        "docs/planning/chat-session-rotation-spec.md"
      ],
      "verification_ids": [
        "unit-all"
      ],
      "id": "T002",
      "title": "Добавить лимит микрозадач Chat в Settings",
      "why": "Согласованная ротация и поставка: Добавить лимит микрозадач Chat в Settings",
      "verification_kind": "code",
      "acceptance_criteria": [
        "Settings и IPC: 1–10, default 4, persisted restart, неверный ввод fail closed, подсказка Chat при ON; установка N не включает AutoPlan."
      ],
      "expected_commit_message": "feat: Добавить лимит микрозадач Chat в Settings",
      "parallel_safe": false,
      "actual_files": [
        "src/chat-session-rotation-settings.mjs",
        "src/main.mjs",
        "src/preload.cjs",
        "src/ui/index.html",
        "src/ui/settings-panel.mjs",
        "tests/settings-chat-session-rotation.test.mjs"
      ]
    },
    {
      "implementation_status": "DONE",
      "commit_status": "DONE",
      "commit_ref": {
        "scope_id": "chat-session-rotation-20261011",
        "task_id": "T003",
        "role": "implementation"
      },
      "dependencies": [
        "T002"
      ],
      "functional_paths": [
        "src/chat-session-rotation.mjs",
        "src/project-auto-plan.mjs",
        "src/auto-plan-state.mjs",
        "tests/chat-session-rotation.test.mjs",
        "tests/project-auto-plan.test.mjs"
      ],
      "documentation_paths": [
        "docs/planning/chat-session-rotation-spec.md"
      ],
      "verification_ids": [
        "unit-all"
      ],
      "id": "T003",
      "title": "Реализовать устойчивый счёт подтверждённых DONE для Chat",
      "why": "Согласованная ротация и поставка: Реализовать устойчивый счёт подтверждённых DONE для Chat",
      "verification_kind": "code",
      "acceptance_criteria": [
        "Baseline=0 для нового Chat; только подтверждённые task DONE с Git proof от baseline; все типы задач включая DOCS/delivery; restart, двух PlanMonitor и OFF→ON без переучёта; ambiguous external fail closed."
      ],
      "expected_commit_message": "feat: Реализовать устойчивый счёт подтверждённых DONE для Chat",
      "parallel_safe": false,
      "actual_files": [
        "docs/planning/chat-session-rotation-spec.md",
        "src/auto-plan-state.mjs",
        "src/chat-session-rotation.mjs",
        "src/project-auto-plan.mjs",
        "tests/chat-session-rotation.test.mjs",
        "tests/project-auto-plan.test.mjs"
      ]
    },
    {
      "implementation_status": "DONE",
      "commit_status": "DONE",
      "commit_ref": {
        "scope_id": "chat-session-rotation-20261011",
        "task_id": "T004",
        "role": "implementation"
      },
      "dependencies": [
        "T003"
      ],
      "functional_paths": [
        "src/auto-plan.mjs",
        "src/project-session-auto-plan.mjs",
        "src/chat-session-rotation.mjs",
        "tests/auto-plan.test.mjs",
        "tests/chat-session-rotation.test.mjs"
      ],
      "documentation_paths": [
        "docs/planning/chat-session-rotation-spec.md"
      ],
      "verification_ids": [
        "unit-all"
      ],
      "id": "T004",
      "title": "Блокировать старый Send при достижении порога",
      "why": "Согласованная ротация и поставка: Блокировать старый Send при достижении порога",
      "verification_kind": "code",
      "acceptance_criteria": [
        "N DONE блокируют старый Continue до click; работающий busy не прерывается; после idle одна ротация; последний DONE complete без новой сессии; Stop/Send/draft/Review/UNKNOWN защищены."
      ],
      "expected_commit_message": "feat: Блокировать старый Send при достижении порога",
      "parallel_safe": false,
      "actual_files": [
        "docs/planning/chat-session-rotation-spec.md",
        "src/auto-plan.mjs",
        "src/chat-session-rotation.mjs",
        "src/project-session-auto-plan.mjs",
        "tests/auto-plan.test.mjs",
        "tests/chat-session-rotation.test.mjs"
      ]
    },
    {
      "implementation_status": "DONE",
      "commit_status": "DONE",
      "commit_ref": {
        "scope_id": "chat-session-rotation-20261011",
        "task_id": "T005",
        "role": "implementation"
      },
      "dependencies": [
        "T004"
      ],
      "functional_paths": [
        "src/chat-session-rotation.mjs",
        "src/main.mjs",
        "src/workspace-session.mjs",
        "src/session-runtime.mjs",
        "src/context-session.mjs",
        "src/project-auto-plan.mjs",
        "tests/chat-session-rotation.test.mjs",
        "tests/workspace-session.test.mjs",
        "tests/context-session.test.mjs",
        "tests/session-runtime.test.mjs"
      ],
      "documentation_paths": [
        "docs/planning/chat-session-rotation-spec.md"
      ],
      "verification_ids": [
        "unit-all"
      ],
      "id": "T005",
      "title": "Создавать новый Chat и передавать Recovery без повторов",
      "why": "Согласованная ротация и поставка: Создавать новый Chat и передавать Recovery без повторов",
      "verification_kind": "code",
      "acceptance_criteria": [
        "Idempotent operation ID в локальном store до создания, recovery по штатному ContextSession; restart на каждой стадии не создаёт второго Chat/второго пакета. Новый Chat получает собственный runtime и baseline 0.",
        "Ротация фонового проекта выбирает новую сессию лишь внутри его дерева, не меняя видимый проект или чужого Chat; старые чаты сохранены."
      ],
      "expected_commit_message": "feat: Создавать новый Chat и передавать Recovery без повторов",
      "parallel_safe": false,
      "actual_files": [
        "docs/planning/chat-session-rotation-spec.md",
        "src/chat-session-rotation.mjs",
        "src/context-session.mjs",
        "src/main.mjs",
        "src/project-auto-plan.mjs",
        "src/session-runtime.mjs",
        "src/workspace-session.mjs",
        "tests/context-session.test.mjs",
        "tests/session-runtime.test.mjs",
        "tests/workspace-session.test.mjs"
      ]
    },
    {
      "implementation_status": "DONE",
      "commit_status": "DONE",
      "commit_ref": {
        "scope_id": "chat-session-rotation-20261011",
        "task_id": "T006",
        "role": "implementation"
      },
      "dependencies": [
        "T005"
      ],
      "functional_paths": [
        "src/chat-session-rotation.mjs",
        "src/main.mjs",
        "src/project-auto-plan.mjs",
        "src/project-session-auto-plan.mjs",
        "src/context-session.mjs",
        "src/ui/sidebar.mjs",
        "tests/chat-session-rotation.test.mjs",
        "tests/project-auto-plan.test.mjs",
        "tests/context-session.test.mjs"
      ],
      "documentation_paths": [
        "docs/planning/chat-session-rotation-spec.md"
      ],
      "verification_ids": [
        "unit-all"
      ],
      "id": "T006",
      "title": "Перенести право AutoPlan и защитить сбои передачи",
      "why": "Согласованная ротация и поставка: Перенести право AutoPlan и защитить сбои передачи",
      "verification_kind": "code",
      "acceptance_criteria": [
        "Confirmed Recovery + idle assistant → один Continue новому recipient, старый молчит; именно pilot:new-session созданный вручную Chat при ON после Recovery становится единственным recipient, select существующего не переносит; OFF ручное создание не включает автопродолжение.",
        "Creation/attachment/delivery/UNKNOWN/Stop/OFF/restart не теряют Kit DONE, не делают дублей, оставляют видимую ошибку и безопасный ручной выход."
      ],
      "expected_commit_message": "feat: Перенести право AutoPlan и защитить сбои передачи",
      "parallel_safe": false,
      "actual_files": [
        "docs/planning/chat-session-rotation-spec.md",
        "src/chat-session-rotation.mjs",
        "src/context-session.mjs",
        "src/main.mjs",
        "src/project-auto-plan.mjs",
        "src/project-session-auto-plan.mjs",
        "src/ui/sidebar.mjs",
        "tests/chat-session-rotation.test.mjs",
        "tests/project-auto-plan.test.mjs"
      ]
    },
    {
      "implementation_status": "DONE",
      "commit_status": "DONE",
      "commit_ref": {
        "scope_id": "chat-session-rotation-20261011",
        "task_id": "T007",
        "role": "implementation"
      },
      "dependencies": [
        "T006"
      ],
      "functional_paths": [
        "tests/electron-smoke.mjs",
        "tests/auto-plan.test.mjs",
        "tests/chat-session-rotation.test.mjs",
        "tests/settings-chat-session-rotation.test.mjs",
        "tests/conversation-recovery.test.mjs",
        "tests/context-session.test.mjs",
        "tests/session-runtime.test.mjs",
        "tests/project-auto-plan.test.mjs",
        "tests/workspace-session.test.mjs",
        "src/chat-session-rotation.mjs",
        "src/main.mjs",
        "src/project-session-auto-plan.mjs",
        "src/context-session.mjs",
        "src/session-runtime.mjs",
        "src/project-auto-plan.mjs"
      ],
      "documentation_paths": [
        "docs/planning/chat-session-rotation-spec.md"
      ],
      "verification_ids": [
        "unit-all",
        "electron-smoke"
      ],
      "id": "T007",
      "title": "Проверить полную сквозную ротацию и регрессии",
      "why": "Согласованная ротация и поставка: Проверить полную сквозную ротацию и регрессии",
      "verification_kind": "code",
      "acceptance_criteria": [
        "TEST FIXTURE UI Settings→IPC→Kit commit→busy/idle→new Chat→full Recovery→assistant reply→Continue при N=1/N=4; manual Chat, OFF, two projects background, crash/restart, Work/parallel, no extra sends.",
        "Полные unit-all и electron-smoke; интеграционные дефекты в пределах явно разрешённых src; более широкий дефект — сначала task:update/amend по Kit."
      ],
      "expected_commit_message": "feat: Проверить полную сквозную ротацию и регрессии",
      "parallel_safe": false,
      "actual_files": []
    },
    {
      "id": "T007A",
      "title": "Закрепить проверенные изменения сквозной ротации",
      "why": "Workflow Kit исключил исходники и TEST FIXTURE, внесённые до task:start T007. Зафиксировать именно эти уже проверенные изменения штатной микрозадачей до подготовки выпуска, без переписывания истории.",
      "dependencies": [],
      "functional_paths": [
        "src/main.mjs",
        "src/chat-session-rotation.mjs",
        "tests/chat-session-rotation.test.mjs",
        "tests/electron-smoke.mjs"
      ],
      "documentation_paths": [
        "docs/planning/chat-session-rotation-spec.md"
      ],
      "verification_ids": [
        "unit-all",
        "electron-smoke"
      ],
      "verification_kind": "code",
      "acceptance_criteria": [
        "Сохранены проверенные исправления двух гонок: чтение актуального scope Kit и корректная обработка промежуточного Recovery sending.",
        "Сквозной Electron TEST FIXTURE подтверждает N=1 и N=4, фоновый проект, ручной новый Chat, полный Recovery, единственный Continue и сохранение DONE.",
        "Все пять исключённых из T007 файлов включены явным выбором в подтверждённый Git-коммит Kit. Unit-all и electron-smoke проходят, рабочее дерево чистое перед T008."
      ],
      "expected_commit_message": "test: зафиксировать сквозную ротацию Chat и исправления T007",
      "implementation_status": "DONE",
      "commit_status": "DONE",
      "commit_ref": {
        "scope_id": "chat-session-rotation-20261011",
        "task_id": "T007A",
        "role": "implementation"
      },
      "parallel_safe": false,
      "actual_files": [
        "docs/planning/chat-session-rotation-spec.md",
        "src/chat-session-rotation.mjs",
        "src/main.mjs",
        "tests/chat-session-rotation.test.mjs",
        "tests/electron-smoke.mjs"
      ]
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "chat-session-rotation-20261011",
        "task_id": "T008",
        "role": "implementation"
      },
      "dependencies": [
        "T007",
        "T007A"
      ],
      "functional_paths": [
        "package.json",
        "package-lock.json",
        ".harness/workflow.json",
        "scripts/check-installed-release.mjs",
        "scripts/check-github-release.mjs"
      ],
      "documentation_paths": [
        "docs/planning/chat-session-rotation-spec.md"
      ],
      "verification_ids": [
        "unit-all",
        "release-source",
        "codex-tools-live"
      ],
      "id": "T008",
      "title": "Подготовить источник выпуска 0.6.114 и проверки",
      "why": "Согласованная ротация и поставка: Подготовить источник выпуска 0.6.114 и проверки",
      "verification_kind": "code",
      "acceptance_criteria": [
        "Версия source и lock = 0.6.114, Kit=1.7.2; config:apply обновляет release-source и delivery evidence без прямой правки Kit config.",
        "До DOCS пройдены release-source и codex-tools-live; ни один build/sign/install/publish не начат."
      ],
      "expected_commit_message": "feat: Подготовить источник выпуска 0.6.114 и проверки",
      "parallel_safe": false
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "chat-session-rotation-20261011",
        "task_id": "DOCS",
        "role": "implementation"
      },
      "dependencies": [
        "T001",
        "T002",
        "T003",
        "T004",
        "T005",
        "T006",
        "T007",
        "T007A",
        "T008"
      ],
      "functional_paths": [],
      "documentation_paths": [
        "docs/planning/chat-session-rotation-spec.md",
        "docs/modules/auto-plan.md",
        "docs/modules/auto-plan-send.md",
        "docs/modules/context-delivery.md",
        "docs/modules/workspace-sessions.md",
        "docs/modules/session-runtime.md",
        "docs/modules/workspace-sidebar-ui.md",
        "docs/architecture/OVERVIEW.md",
        "README.md",
        "docs/modules/release.md"
      ],
      "verification_ids": [],
      "id": "DOCS",
      "title": "Актуализация всех документов проекта",
      "why": "Сохранить актуальный контекст",
      "verification_kind": "code",
      "acceptance_criteria": [
        "Контракты соответствуют 0.6.114; требования рабочей spec перенесены в действующие docs, временная spec удалена по Workflow Core; до delivery."
      ],
      "expected_commit_message": "docs: актуализировать ротацию Chat",
      "parallel_safe": false
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "chat-session-rotation-20261011",
        "task_id": "T009",
        "role": "implementation"
      },
      "dependencies": [
        "DOCS"
      ],
      "functional_paths": [],
      "documentation_paths": [
        "docs/planning/chat-session-rotation-spec.md"
      ],
      "verification_ids": [
        "paired-release"
      ],
      "id": "T009",
      "title": "Собрать единственный парный выпуск 0.6.114",
      "why": "Согласованная ротация и поставка: Собрать единственный парный выпуск 0.6.114",
      "verification_kind": "package",
      "acceptance_criteria": [
        "После DOCS одна paired-release macOS arm64 + Windows x64, все артефакты в ~/Downloads, sourceCommit и подпись проверены, без изменения исходников."
      ],
      "expected_commit_message": "release: Собрать единственный парный выпуск 0.6.114",
      "parallel_safe": false
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "chat-session-rotation-20261011",
        "task_id": "T010",
        "role": "implementation"
      },
      "dependencies": [
        "T009",
        "DOCS"
      ],
      "functional_paths": [],
      "documentation_paths": [
        "docs/planning/chat-session-rotation-spec.md"
      ],
      "verification_ids": [
        "release-installed"
      ],
      "id": "T010",
      "title": "Установить готовый macOS выпуск 0.6.114 без пересборки",
      "why": "Согласованная ротация и поставка: Установить готовый macOS выпуск 0.6.114 без пересборки",
      "verification_kind": "installed",
      "acceptance_criteria": [
        "Сохранены filesystem identity и подпись постоянной app, установленный результат сверен с manifest без повторной сборки."
      ],
      "expected_commit_message": "release: Установить готовый macOS выпуск 0.6.114 без пересборки",
      "parallel_safe": false
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "chat-session-rotation-20261011",
        "task_id": "T011",
        "role": "implementation"
      },
      "dependencies": [
        "T010",
        "DOCS"
      ],
      "functional_paths": [],
      "documentation_paths": [
        "docs/planning/chat-session-rotation-spec.md"
      ],
      "verification_ids": [
        "github-release"
      ],
      "id": "T011",
      "title": "Опубликовать и сверить GitHub Release 0.6.114",
      "why": "Согласованная ротация и поставка: Опубликовать и сверить GitHub Release 0.6.114",
      "verification_kind": "package",
      "acceptance_criteria": [
        "Remote main, tag v0.6.114 на sourceCommit, шесть assets имена/размеры/digest. План READY_FOR_ACCEPTANCE; живая macOS/Windows проверка пользователем."
      ],
      "expected_commit_message": "release: Опубликовать и сверить GitHub Release 0.6.114",
      "parallel_safe": false
    }
  ],
  "blocked_reason": null,
  "user_decisions": [
    {
      "id": "e40c0503-38e3-4940-8272-7070624d8fcf",
      "text": "11 октября 2026 года пользователь принял архитектуру ротации и поручил подготовить планировочный документ и to-do план.",
      "recorded_at": "2026-10-11T14:02:06.818Z"
    }
  ],
  "parallel_allowed": true,
  "max_workers": 4,
  "execution_strategy": "sequential",
  "execution_reason": "AutoPlan authority, Kit DONE, SessionRuntime и durable handoff совместно меняют один жизненный цикл и общие файлы. Один writer предотвращает двойной Send/Chat; параллельность разрешена снимком, но нецелесообразна.",
  "execution_origin_session_id": "web-pilot-49871068-4307-4ff1-ba04-4c9871a31b47"
}
```
<!-- workflow-state:end -->

## Состояние

Execution Scope Status: ACTIVE
Delivery Status: IN_PROGRESS
Scope: chat-session-rotation-20261011
Current Task: нет
Revision: 1801

## Цель

Настраиваемая ротация Chat каждые 1–10 DONE при AutoPlan ON с безопасным Recovery и парным выпуском 0.6.114.

## Критерии приёмки

- Chat при AutoPlan ON меняется после заданного N подтверждённых DONE и без дублей Recovery/Continue.
- При OFF/Work/parallel ротации нет, ошибки fail-closed, план и DONE сохранены.
- Проверенный парный выпуск 0.6.114 и READY_FOR_ACCEPTANCE.

## Микрозадачи

Выполнение: sequential; разрешено: true; лимит: 4
Причина: AutoPlan authority, Kit DONE, SessionRuntime и durable handoff совместно меняют один жизненный цикл и общие файлы. Один writer предотвращает двойной Send/Chat; параллельность разрешена снимком, но нецелесообразна.

- [DONE] T001: Зафиксировать исходный жизненный цикл Chat и матрицу ротации — Завершено
  - Git Commit: [DONE] feat: Зафиксировать исходный жизненный цикл Chat и матрицу ротации
  - Reference: chat-session-rotation-20261011 / T001 / implementation
  - Файлы: tests/auto-plan.test.mjs, tests/project-auto-plan.test.mjs, docs/planning/chat-session-rotation-spec.md
  - Параллельность: исключительное выполнение
  - Зависимости: нет
- [DONE] T002: Добавить лимит микрозадач Chat в Settings — Завершено
  - Git Commit: [DONE] feat: Добавить лимит микрозадач Chat в Settings
  - Reference: chat-session-rotation-20261011 / T002 / implementation
  - Файлы: src/chat-session-rotation-settings.mjs, src/main.mjs, src/preload.cjs, src/ui/settings-panel.mjs, src/ui/index.html, tests/settings-chat-session-rotation.test.mjs, docs/planning/chat-session-rotation-spec.md
  - Параллельность: исключительное выполнение
  - Зависимости: T001
- [DONE] T003: Реализовать устойчивый счёт подтверждённых DONE для Chat — Завершено
  - Git Commit: [DONE] feat: Реализовать устойчивый счёт подтверждённых DONE для Chat
  - Reference: chat-session-rotation-20261011 / T003 / implementation
  - Файлы: src/chat-session-rotation.mjs, src/project-auto-plan.mjs, src/auto-plan-state.mjs, tests/chat-session-rotation.test.mjs, tests/project-auto-plan.test.mjs, docs/planning/chat-session-rotation-spec.md
  - Параллельность: исключительное выполнение
  - Зависимости: T002
- [DONE] T004: Блокировать старый Send при достижении порога — Завершено
  - Git Commit: [DONE] feat: Блокировать старый Send при достижении порога
  - Reference: chat-session-rotation-20261011 / T004 / implementation
  - Файлы: src/auto-plan.mjs, src/project-session-auto-plan.mjs, src/chat-session-rotation.mjs, tests/auto-plan.test.mjs, tests/chat-session-rotation.test.mjs, docs/planning/chat-session-rotation-spec.md
  - Параллельность: исключительное выполнение
  - Зависимости: T003
- [DONE] T005: Создавать новый Chat и передавать Recovery без повторов — Завершено
  - Git Commit: [DONE] feat: Создавать новый Chat и передавать Recovery без повторов
  - Reference: chat-session-rotation-20261011 / T005 / implementation
  - Файлы: src/chat-session-rotation.mjs, src/main.mjs, src/workspace-session.mjs, src/session-runtime.mjs, src/context-session.mjs, src/project-auto-plan.mjs, tests/chat-session-rotation.test.mjs, tests/workspace-session.test.mjs, tests/context-session.test.mjs, tests/session-runtime.test.mjs, docs/planning/chat-session-rotation-spec.md
  - Параллельность: исключительное выполнение
  - Зависимости: T004
- [DONE] T006: Перенести право AutoPlan и защитить сбои передачи — Завершено
  - Git Commit: [DONE] feat: Перенести право AutoPlan и защитить сбои передачи
  - Reference: chat-session-rotation-20261011 / T006 / implementation
  - Файлы: src/chat-session-rotation.mjs, src/main.mjs, src/project-auto-plan.mjs, src/project-session-auto-plan.mjs, src/context-session.mjs, src/ui/sidebar.mjs, tests/chat-session-rotation.test.mjs, tests/project-auto-plan.test.mjs, tests/context-session.test.mjs, docs/planning/chat-session-rotation-spec.md
  - Параллельность: исключительное выполнение
  - Зависимости: T005
- [DONE] T007: Проверить полную сквозную ротацию и регрессии — Завершено
  - Git Commit: [DONE] feat: Проверить полную сквозную ротацию и регрессии
  - Reference: chat-session-rotation-20261011 / T007 / implementation
  - Файлы: tests/electron-smoke.mjs, tests/auto-plan.test.mjs, tests/chat-session-rotation.test.mjs, tests/settings-chat-session-rotation.test.mjs, tests/conversation-recovery.test.mjs, tests/context-session.test.mjs, tests/session-runtime.test.mjs, tests/project-auto-plan.test.mjs, tests/workspace-session.test.mjs, src/chat-session-rotation.mjs, src/main.mjs, src/project-session-auto-plan.mjs, src/context-session.mjs, src/session-runtime.mjs, src/project-auto-plan.mjs, docs/planning/chat-session-rotation-spec.md
  - Параллельность: исключительное выполнение
  - Зависимости: T006
- [DONE] T007A: Закрепить проверенные изменения сквозной ротации — Завершено
  - Git Commit: [DONE] test: зафиксировать сквозную ротацию Chat и исправления T007
  - Reference: chat-session-rotation-20261011 / T007A / implementation
  - Файлы: src/main.mjs, src/chat-session-rotation.mjs, tests/chat-session-rotation.test.mjs, tests/electron-smoke.mjs, docs/planning/chat-session-rotation-spec.md
  - Параллельность: исключительное выполнение
  - Зависимости: нет
- [TODO] T008: Подготовить источник выпуска 0.6.114 и проверки — Ожидает
  - Git Commit: [PENDING] feat: Подготовить источник выпуска 0.6.114 и проверки
  - Reference: chat-session-rotation-20261011 / T008 / implementation
  - Файлы: package.json, package-lock.json, .harness/workflow.json, scripts/check-installed-release.mjs, scripts/check-github-release.mjs, docs/planning/chat-session-rotation-spec.md
  - Параллельность: исключительное выполнение
  - Зависимости: T007, T007A
- [TODO] DOCS: Актуализация всех документов проекта — Ожидает
  - Git Commit: [PENDING] docs: актуализировать ротацию Chat
  - Reference: chat-session-rotation-20261011 / DOCS / implementation
  - Файлы: docs/planning/chat-session-rotation-spec.md, docs/modules/auto-plan.md, docs/modules/auto-plan-send.md, docs/modules/context-delivery.md, docs/modules/workspace-sessions.md, docs/modules/session-runtime.md, docs/modules/workspace-sidebar-ui.md, docs/architecture/OVERVIEW.md, README.md, docs/modules/release.md
  - Параллельность: исключительное выполнение
  - Зависимости: T001, T002, T003, T004, T005, T006, T007, T007A, T008
- [TODO] T009: Собрать единственный парный выпуск 0.6.114 — Ожидает
  - Git Commit: [PENDING] release: Собрать единственный парный выпуск 0.6.114
  - Reference: chat-session-rotation-20261011 / T009 / implementation
  - Файлы: docs/planning/chat-session-rotation-spec.md
  - Параллельность: исключительное выполнение
  - Зависимости: DOCS
- [TODO] T010: Установить готовый macOS выпуск 0.6.114 без пересборки — Ожидает
  - Git Commit: [PENDING] release: Установить готовый macOS выпуск 0.6.114 без пересборки
  - Reference: chat-session-rotation-20261011 / T010 / implementation
  - Файлы: docs/planning/chat-session-rotation-spec.md
  - Параллельность: исключительное выполнение
  - Зависимости: T009, DOCS
- [TODO] T011: Опубликовать и сверить GitHub Release 0.6.114 — Ожидает
  - Git Commit: [PENDING] release: Опубликовать и сверить GitHub Release 0.6.114
  - Reference: chat-session-rotation-20261011 / T011 / implementation
  - Файлы: docs/planning/chat-session-rotation-spec.md
  - Параллельность: исключительное выполнение
  - Зависимости: T010, DOCS

## Context Pack For This Cycle

- docs/architecture/OVERVIEW.md
- docs/planning/chat-session-rotation-spec.md

Служебные состояния меняются только командами workflow. Приёмка не архивирует scope.
