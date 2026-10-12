# Активный план — Project Web Pilot

<!-- workflow-state:begin -->
```json
{
  "schema_version": 1,
  "plan_revision": 1769,
  "project_id": "cf944136-d1fc-4bd5-9ea0-e46d1fe230e7",
  "project_name": "Project Web Pilot",
  "scope_id": "rollback-112-release-115-20261012",
  "execution_scope_status": "ACTIVE",
  "delivery_status": "IN_PROGRESS",
  "objective": "Подвести черту: новая парная поставка 0.6.115 из базы 0.6.112 и синхронизация GitHub main перед рефакторингом.",
  "acceptance_criteria": [
    "Исходники приложения соответствуют базе 0.6.112, новый номер 0.6.115.",
    "DOCS предшествует единственной сборке, установка и GitHub используют её шесть проверенных assets.",
    "GitHub main синхронизирован с новой линией посредством точного force-with-lease; прошлые теги/релизы и пользовательские данные сохранены."
  ],
  "approved_scope": {
    "functional_paths": [
      "package.json",
      "package-lock.json"
    ],
    "documentation_paths": [
      "docs/planning/rollback-112-release-115-spec.md",
      "README.md",
      "docs/architecture/OVERVIEW.md",
      "docs/modules/release.md",
      "docs/modules/auto-plan.md",
      "docs/modules/auto-plan-send.md",
      "docs/modules/context-delivery.md",
      "docs/modules/session-runtime.md",
      "docs/modules/workspace-sessions.md",
      "docs/modules/workspace-sidebar-ui.md",
      "docs/modules/project-archive.md",
      "docs/modules/chromium-diagnostics.md",
      "docs/planning/archive-deletion-recovery-spec.md",
      "docs/modules/parallel-execution-acceptance.md",
      "docs/modules/plan-view.md",
      "docs/modules/release-verification.md"
    ]
  },
  "baseline_commit": "a1cd02424932d4666fd43cbcd6a61a7f2d5e2a31",
  "current_task_id": null,
  "context_pack": {
    "documents": [
      {
        "path": "docs/planning/rollback-112-release-115-spec.md",
        "required": true,
        "revision": "b3117fc7b402d8da46e8440da2d67758bfa1feb0"
      },
      {
        "path": "docs/modules/release.md",
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
        "scope_id": "rollback-112-release-115-20261012",
        "task_id": "T001",
        "role": "implementation"
      },
      "dependencies": [],
      "functional_paths": [
        "package.json",
        "package-lock.json"
      ],
      "documentation_paths": [
        "docs/planning/rollback-112-release-115-spec.md"
      ],
      "verification_ids": [
        "unit-all",
        "electron-smoke",
        "codex-tools-live",
        "release-source"
      ],
      "id": "T001",
      "title": "Подготовить восстановленную базу и источник 0.6.115",
      "why": "Подготовить восстановленную базу и источник 0.6.115",
      "acceptance_criteria": [
        "src/scripts/resources/tools/Kit побайтно совпадают с a1cd02424932; версии package/lock = 0.6.115, Kit 1.7.2.",
        "Чтение копии сохранённых settings/workspaces кодом 112 проверено без записи реальных данных; назначенные проверки прошли.",
        "Через config:apply полной конфигурацией args/kind release-source обновлены на test/0.6.115/Kit 1.7.2 и Git-сверку a1cd02424932 -- src scripts resources tools packages/workflow-kit; evidence delivery относится к T002/T003/T004 и 0.6.115; сборка не запускалась.",
        "Копии settings/workspaces загрузить и сохранить кодом базы в tmp вне Git; сравнить данные до/после без вывода секретов. Незапланированная потеря значимых полей блокирует поставку; реальные данные не писать, временные копии удалить."
      ],
      "expected_commit_message": "chore: Подготовить восстановленную базу и источник 0.6.115",
      "parallel_safe": false,
      "actual_files": [
        "package.json",
        "package-lock.json"
      ]
    },
    {
      "implementation_status": "DONE",
      "commit_status": "DONE",
      "commit_ref": {
        "scope_id": "rollback-112-release-115-20261012",
        "task_id": "DOCS",
        "role": "implementation"
      },
      "dependencies": [
        "T001"
      ],
      "functional_paths": [],
      "documentation_paths": [
        "README.md",
        "docs/architecture/OVERVIEW.md",
        "docs/modules/release.md",
        "docs/modules/auto-plan.md",
        "docs/modules/auto-plan-send.md",
        "docs/modules/context-delivery.md",
        "docs/modules/session-runtime.md",
        "docs/modules/workspace-sessions.md",
        "docs/modules/workspace-sidebar-ui.md",
        "docs/modules/project-archive.md",
        "docs/modules/chromium-diagnostics.md",
        "docs/planning/archive-deletion-recovery-spec.md",
        "docs/planning/rollback-112-release-115-spec.md",
        "docs/modules/parallel-execution-acceptance.md",
        "docs/modules/plan-view.md",
        "docs/modules/release-verification.md"
      ],
      "verification_ids": [],
      "id": "DOCS",
      "title": "Актуализация всех документов проекта",
      "why": "Актуализировать документы восстановленной поставки",
      "acceptance_criteria": [
        "Все действующие документы сверены с базой 112 и новой версией; уже актуальные не переписаны.",
        "Удалить archive-deletion-recovery-spec.md после сверки контрактов. Правила rollback-112-release-115-spec.md перенести в release.md, удалить spec с закреплением required ссылки на Git blob Kit.",
        "release.md фиксирует разовое разрешение force-with-lease для 0.6.115; при отказе GitHub защиту ветки не менять.",
        "Будущий рефакторинг не объявлен реализованным; DOCS закончена до сборки."
      ],
      "expected_commit_message": "docs: Актуализировать документы восстановленной поставки",
      "parallel_safe": false,
      "actual_files": [
        "README.md",
        "docs/architecture/OVERVIEW.md",
        "docs/modules/auto-plan.md",
        "docs/modules/parallel-execution-acceptance.md",
        "docs/modules/plan-view.md",
        "docs/modules/release.md",
        "docs/modules/release-verification.md",
        "docs/planning/archive-deletion-recovery-spec.md",
        "docs/planning/rollback-112-release-115-spec.md"
      ]
    },
    {
      "implementation_status": "DONE",
      "commit_status": "DONE",
      "commit_ref": {
        "scope_id": "rollback-112-release-115-20261012",
        "task_id": "T002",
        "role": "implementation"
      },
      "dependencies": [
        "DOCS"
      ],
      "functional_paths": [],
      "documentation_paths": [
        "docs/modules/release.md"
      ],
      "verification_ids": [
        "paired-release"
      ],
      "id": "T002",
      "title": "Собрать единственный парный выпуск 0.6.115",
      "why": "Собрать единственный парный выпуск 0.6.115",
      "acceptance_criteria": [
        "Единственная парная сборка после DOCS: macOS arm64 + Windows x64, шесть assets, manifest/sourceCommit, подпись и постоянное корневое app подтверждены.",
        "Ошибки разобраны без слепой пересборки; материалы разработки и пользовательские данные не упакованы."
      ],
      "expected_commit_message": "release: Собрать единственный парный выпуск 0.6.115",
      "parallel_safe": false,
      "verification_kind": "package",
      "actual_files": []
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "rollback-112-release-115-20261012",
        "task_id": "T003",
        "role": "implementation"
      },
      "dependencies": [
        "T002",
        "DOCS"
      ],
      "functional_paths": [],
      "documentation_paths": [
        "docs/modules/release.md"
      ],
      "verification_ids": [
        "release-installed"
      ],
      "id": "T003",
      "title": "Установить готовый macOS выпуск 0.6.115",
      "why": "Установить готовый macOS выпуск 0.6.115",
      "acceptance_criteria": [
        "/Applications обновлена из staging T002 без пересборки, app identity/signature и manifest проверены; работающий app/MCP не перезапущены."
      ],
      "expected_commit_message": "release: Установить готовый macOS выпуск 0.6.115",
      "parallel_safe": false,
      "verification_kind": "installed"
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "rollback-112-release-115-20261012",
        "task_id": "T004",
        "role": "implementation"
      },
      "dependencies": [
        "T003",
        "DOCS"
      ],
      "functional_paths": [],
      "documentation_paths": [
        "docs/modules/release.md"
      ],
      "verification_ids": [
        "github-release"
      ],
      "id": "T004",
      "title": "Опубликовать 0.6.115 и синхронизировать новую линию main",
      "why": "Опубликовать 0.6.115 и синхронизировать новую линию main",
      "acceptance_criteria": [
        "Перемещение main только с lease d2509018cd54a848897e35aa9740379aef9665d3; изменение remote не затирается.",
        "Тег на sourceCommit, Release не draft/prerelease, опубликован с make_latest=true; отдельный GET releases/latest подтверждает v0.6.115. Шесть assets проверены по имени/размеру/digest; remote main после коммита задачи совпадает с local HEAD.",
        "При несовпадении lease или отказе защиты GitHub остановиться и сообщить пользователю, защиту ветки не менять.",
        "Старые теги и Releases сохранены; ограничения живой приёмки названы; READY_FOR_ACCEPTANCE."
      ],
      "expected_commit_message": "release: Опубликовать 0.6.115 и синхронизировать новую линию main",
      "parallel_safe": false,
      "verification_kind": "package"
    }
  ],
  "blocked_reason": null,
  "user_decisions": [
    {
      "id": "rollback-main-20261012",
      "text": "Пользователь поручил возврат main к 0.6.112, новый полный выпуск и синхронизацию GitHub. Разовое перемещение main — с точным force-with-lease; старые теги и Releases сохраняются.",
      "recorded_at": "2026-10-12T07:02:02.000Z"
    },
    {
      "id": "e2b87d9d-71ba-4999-bb73-4ca9e9c3d82c",
      "text": "Пользователь прямо поручил вернуть репозиторий к 0.6.112, выпустить новый релиз, обновить установки и GitHub; переписывание main разрешено обсуждением. Исходники уже возвращены штатным git reset на чистом checkout.",
      "recorded_at": "2026-10-12T07:12:37.788Z"
    }
  ],
  "parallel_allowed": true,
  "max_workers": 4,
  "execution_strategy": "sequential",
  "execution_reason": "Все задачи поставки зависят друг от друга и используют общий main/staging/manifest; отдельные исполнители не дают независимой работы.",
  "execution_origin_session_id": "web-pilot-6566e6d4-8401-4870-9601-33d957076ed5"
}
```
<!-- workflow-state:end -->

## Состояние

Execution Scope Status: ACTIVE
Delivery Status: IN_PROGRESS
Scope: rollback-112-release-115-20261012
Current Task: нет
Revision: 1769

## Цель

Подвести черту: новая парная поставка 0.6.115 из базы 0.6.112 и синхронизация GitHub main перед рефакторингом.

## Критерии приёмки

- Исходники приложения соответствуют базе 0.6.112, новый номер 0.6.115.
- DOCS предшествует единственной сборке, установка и GitHub используют её шесть проверенных assets.
- GitHub main синхронизирован с новой линией посредством точного force-with-lease; прошлые теги/релизы и пользовательские данные сохранены.

## Микрозадачи

Выполнение: sequential; разрешено: true; лимит: 4
Причина: Все задачи поставки зависят друг от друга и используют общий main/staging/manifest; отдельные исполнители не дают независимой работы.

- [DONE] T001: Подготовить восстановленную базу и источник 0.6.115 — Завершено
  - Git Commit: [DONE] chore: Подготовить восстановленную базу и источник 0.6.115
  - Reference: rollback-112-release-115-20261012 / T001 / implementation
  - Файлы: package.json, package-lock.json, docs/planning/rollback-112-release-115-spec.md
  - Параллельность: исключительное выполнение
  - Зависимости: нет
- [DONE] DOCS: Актуализация всех документов проекта — Завершено
  - Git Commit: [DONE] docs: Актуализировать документы восстановленной поставки
  - Reference: rollback-112-release-115-20261012 / DOCS / implementation
  - Файлы: README.md, docs/architecture/OVERVIEW.md, docs/modules/release.md, docs/modules/auto-plan.md, docs/modules/auto-plan-send.md, docs/modules/context-delivery.md, docs/modules/session-runtime.md, docs/modules/workspace-sessions.md, docs/modules/workspace-sidebar-ui.md, docs/modules/project-archive.md, docs/modules/chromium-diagnostics.md, docs/planning/archive-deletion-recovery-spec.md, docs/planning/rollback-112-release-115-spec.md, docs/modules/parallel-execution-acceptance.md, docs/modules/plan-view.md, docs/modules/release-verification.md
  - Параллельность: исключительное выполнение
  - Зависимости: T001
- [DONE] T002: Собрать единственный парный выпуск 0.6.115 — Завершено
  - Git Commit: [DONE] release: Собрать единственный парный выпуск 0.6.115
  - Reference: rollback-112-release-115-20261012 / T002 / implementation
  - Файлы: docs/modules/release.md
  - Параллельность: исключительное выполнение
  - Зависимости: DOCS
- [TODO] T003: Установить готовый macOS выпуск 0.6.115 — Ожидает
  - Git Commit: [PENDING] release: Установить готовый macOS выпуск 0.6.115
  - Reference: rollback-112-release-115-20261012 / T003 / implementation
  - Файлы: docs/modules/release.md
  - Параллельность: исключительное выполнение
  - Зависимости: T002, DOCS
- [TODO] T004: Опубликовать 0.6.115 и синхронизировать новую линию main — Ожидает
  - Git Commit: [PENDING] release: Опубликовать 0.6.115 и синхронизировать новую линию main
  - Reference: rollback-112-release-115-20261012 / T004 / implementation
  - Файлы: docs/modules/release.md
  - Параллельность: исключительное выполнение
  - Зависимости: T003, DOCS

## Context Pack For This Cycle

- docs/planning/rollback-112-release-115-spec.md
- docs/modules/release.md
- docs/architecture/OVERVIEW.md

Служебные состояния меняются только командами workflow. Приёмка не архивирует scope.
