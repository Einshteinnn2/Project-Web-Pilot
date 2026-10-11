# Активный план — Project Web Pilot

<!-- workflow-state:begin -->
```json
{
  "schema_version": 1,
  "plan_revision": 1743,
  "project_id": "cf944136-d1fc-4bd5-9ea0-e46d1fe230e7",
  "project_name": "Project Web Pilot",
  "scope_id": "archive-deletion-recovery-20261011",
  "execution_scope_status": "ACTIVE",
  "delivery_status": "IN_PROGRESS",
  "objective": "Исправить восстановление подтверждённого удаления после исчезновения исходных каталогов и безопасно устранять потерянные записи executor-worktree без повреждения соседних проектов и пользовательских данных; выпустить 0.6.112.",
  "acceptance_criteria": [
    "Валидный confirmed-журнал при отсутствии исходного каталога и карантина заканчивается адресной очисткой метаданных, записи архива и журнала; повторение и restart идемпотентны.",
    "Каскад по подтверждённому parentProjectId/parentWorkspace удаляет ровно своих детей, даже если их папок уже нет; пересечения журналов родителя и ребёнка безопасно повторяемы.",
    "Потерянные записи без подтверждённого удаления остаются безопасным recovery и могут удаляться только адресно, после явного подтверждения пользователя и новой проверки отсутствия папки, занятости и идентичности.",
    "Подмена пути/identity, чужие или изменённые worktree, живые и UNKNOWN-команды защищены; локальные и облачные чаты соседей, браузерный профиль, ключи и рабочий проект не затронуты.",
    "Автоматические unit, project-lifecycle и Electron fixture-проверки проходят; документация завершена до единственного парного выпуска 0.6.112, установки и публикации на GitHub. Живая macOS/native Windows приёмка не подменяется fixture."
  ],
  "approved_scope": {
    "functional_paths": [
      "src/workspace-deletion.mjs",
      "src/workspace-session.mjs",
      "src/project-state-cleanup.mjs",
      "src/main.mjs",
      "src/preload.cjs",
      "src/ui/settings-panel.mjs",
      "src/ui/index.html",
      "tests/workspace-deletion.test.mjs",
      "tests/workspace-session.test.mjs",
      "tests/project-state-cleanup.test.mjs",
      "tests/settings-parallel-execution.test.mjs",
      "tests/sidebar.test.mjs",
      "tests/electron-smoke.mjs",
      "package.json",
      "package-lock.json",
      ".harness/workflow.json",
      "release-manifest.json"
    ],
    "documentation_paths": [
      "docs/planning/archive-deletion-recovery-spec.md",
      "README.md",
      "docs/architecture/OVERVIEW.md",
      "docs/modules/project-archive.md",
      "docs/modules/workspace-sessions.md",
      "docs/modules/workspace-sidebar-ui.md",
      "docs/modules/chromium-diagnostics.md",
      "docs/modules/release.md"
    ]
  },
  "baseline_commit": "cf6b42da5749dc04bc4e8988217121d52268f5df",
  "current_task_id": null,
  "context_pack": {
    "documents": [
      {
        "path": "docs/architecture/OVERVIEW.md",
        "required": true,
        "revision": "WORKTREE"
      },
      {
        "path": "docs/planning/archive-deletion-recovery-spec.md",
        "required": true,
        "revision": "WORKTREE"
      },
      {
        "path": "docs/modules/project-archive.md",
        "required": false,
        "revision": "WORKTREE"
      },
      {
        "path": "docs/modules/workspace-sessions.md",
        "required": false,
        "revision": "WORKTREE"
      },
      {
        "path": "docs/modules/workspace-sidebar-ui.md",
        "required": false,
        "revision": "WORKTREE"
      },
      {
        "path": "docs/modules/chromium-diagnostics.md",
        "required": false,
        "revision": "WORKTREE"
      },
      {
        "path": "docs/modules/release.md",
        "required": false,
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
        "scope_id": "archive-deletion-recovery-20261011",
        "task_id": "T001",
        "role": "implementation"
      },
      "dependencies": [],
      "functional_paths": [
        "tests/workspace-deletion.test.mjs",
        "tests/workspace-session.test.mjs"
      ],
      "documentation_paths": [],
      "verification_ids": [
        "project-lifecycle",
        "unit-all"
      ],
      "id": "T001",
      "title": "Воспроизвести оба сбоя в изолированных fixture",
      "why": "Зафиксировать текущее поведение confirmed без папок, перекрывающихся журналов и пяти потерянных исполнителей; не трогать реальное хранилище.",
      "acceptance_criteria": [
        "Тестовый сценарий по данным инцидента: два confirmed журнала, удалённые родитель и ребёнок, оставшиеся записи; второй сценарий — родителя в базе нет, пять детей без папок и все их сессии сохранены.",
        "Характеризующие тесты подтверждают текущий отказ/recovery и остаются зелёными до T002–T004; ожидаемое успешное поведение описано явными будущими assertions, без отключения suite.",
        "Проверены соседний проект, новая папка по старому пути и неизменность реального userData."
      ],
      "expected_commit_message": "test: воспроизвести зависший журнал и потерянных исполнителей",
      "parallel_safe": false,
      "actual_files": [
        "tests/workspace-deletion.test.mjs",
        "tests/workspace-session.test.mjs"
      ]
    },
    {
      "implementation_status": "DONE",
      "commit_status": "DONE",
      "commit_ref": {
        "scope_id": "archive-deletion-recovery-20261011",
        "task_id": "T002",
        "role": "implementation"
      },
      "dependencies": [
        "T001"
      ],
      "functional_paths": [
        "src/workspace-deletion.mjs",
        "tests/workspace-deletion.test.mjs"
      ],
      "documentation_paths": [],
      "verification_ids": [
        "project-lifecycle"
      ],
      "id": "T002",
      "title": "Доводить confirmed без исходной папки и карантина",
      "why": "Устранить DELETE_PATH_CHANGED после частично завершённого удаления, сохранив проверку разрешения и identity.",
      "acceptance_criteria": [
        "Матрица confirmed/original/quarantine/missing и removing покрыта; при отсутствии обоих объектов завершается только очистка локальных данных по валидному журналу без какого-либо удаления с диска.",
        "Повторный recover, ошибка сохранения стадии, сбой после удаления и рестарт идемпотентны; старый или новый каталог по прежнему пути не удалён.",
        "Подменённая identity, невалидный журнал, защищённый каталог, занятая/UNKNOWN-команда сохраняют запрет и адресную ошибку.",
        "ENOENT при отсутствующей точке монтирования или недоступном стабильном родителе не запускает очистку; штатно удалённая hashed group worktree допускается только при доказанно доступных внешнем контейнере и томе, с fixture-регрессией."
      ],
      "expected_commit_message": "fix: восстановить confirmed удаление после исчезновения каталога",
      "parallel_safe": false,
      "actual_files": [
        "src/workspace-deletion.mjs",
        "tests/workspace-deletion.test.mjs"
      ]
    },
    {
      "implementation_status": "DONE",
      "commit_status": "DONE",
      "commit_ref": {
        "scope_id": "archive-deletion-recovery-20261011",
        "task_id": "T003",
        "role": "implementation"
      },
      "dependencies": [
        "T002"
      ],
      "functional_paths": [
        "src/workspace-deletion.mjs",
        "src/workspace-session.mjs",
        "src/project-state-cleanup.mjs",
        "tests/workspace-deletion.test.mjs",
        "tests/workspace-session.test.mjs",
        "tests/project-state-cleanup.test.mjs"
      ],
      "documentation_paths": [],
      "verification_ids": [
        "project-lifecycle",
        "unit-all"
      ],
      "id": "T003",
      "title": "Завершать каскад с отсутствующими детьми и пересекающимися журналами",
      "why": "Не оставлять записи executor и служебные ключи после безопасного завершения удаления родителя.",
      "acceptance_criteria": [
        "При двух журналах родителя/дочернего исполнителя и уже отсутствующих папках оба recover завершаются независимо от безопасного порядка, без ложных DELETE_RECORD_CHANGED и двойной записи.",
        "Полная очистка точных child workspace/projectId/sessionIds из workspaces, settings, migration backups, AutoPlan/Review/automation checkpoints и diagnostics; соседние записи сохранены.",
        "Доказательство ownership обязательно, неинтегрированные, dirty, подменённые, чужие и неизвестно занятые worktree не каскадируются; повтор после частичного сбоя безопасен."
      ],
      "expected_commit_message": "fix: довести каскад удалений и очистку состояния исполнителей",
      "parallel_safe": false,
      "actual_files": [
        "src/project-state-cleanup.mjs",
        "src/workspace-deletion.mjs",
        "tests/project-state-cleanup.test.mjs",
        "tests/workspace-deletion.test.mjs",
        "tests/workspace-session.test.mjs"
      ]
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "archive-deletion-recovery-20261011",
        "task_id": "T004",
        "role": "implementation"
      },
      "dependencies": [
        "T003"
      ],
      "functional_paths": [
        "src/workspace-session.mjs",
        "src/workspace-deletion.mjs",
        "src/main.mjs",
        "src/preload.cjs",
        "src/ui/settings-panel.mjs",
        "src/ui/index.html",
        "tests/workspace-session.test.mjs",
        "tests/workspace-deletion.test.mjs",
        "tests/settings-parallel-execution.test.mjs",
        "tests/sidebar.test.mjs"
      ],
      "documentation_paths": [],
      "verification_ids": [
        "unit-all"
      ],
      "id": "T004",
      "title": "Добавить адресную очистку потерянной записи в Настройках",
      "why": "Дать пользователю безопасный способ убрать запись без родителя и без папки, не превращая ENOENT в автоматическое согласие на удаление.",
      "acceptance_criteria": [
        "В блоке recovery для конкретной записи без существующего parent и child каталога доступно явное действие с подтверждением, понятным названием и предупреждением о сохранении облачных чатов.",
        "Main сверяет sender, точные workspace/projectId, состояние папки/родителя, pending journal, живую/UNKNOWN-команду и заново проверяет условия перед адресной атомарной мутацией; нет общего shell/write IPC.",
        "Удаляются только локальная запись и точные настройки/диагностика, повтор даёт предсказуемый результат; существующий worktree, новый projectId, соседние чаты и облачный профиль сохранены.",
        "При неясной принадлежности или невозможности проверки показана причина, автоматического удаления при старте нет.",
        "Отдельный pending-журнал родителя, в котором исполнитель указан в related[], запрещает ручную очистку; отсутствующий том/корень группы worktree не считается удалённой папкой до проверки доступного опорного каталога и тома."
      ],
      "expected_commit_message": "feat: безопасно убирать потерянную запись исполнителя",
      "parallel_safe": false
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "archive-deletion-recovery-20261011",
        "task_id": "T005",
        "role": "implementation"
      },
      "dependencies": [
        "T004"
      ],
      "functional_paths": [
        "tests/electron-smoke.mjs",
        "tests/sidebar.test.mjs",
        "tests/workspace-deletion.test.mjs",
        "src/main.mjs"
      ],
      "documentation_paths": [
        "docs/planning/archive-deletion-recovery-spec.md",
        "README.md",
        "docs/modules/project-archive.md",
        "docs/modules/workspace-sessions.md",
        "docs/modules/workspace-sidebar-ui.md",
        "docs/modules/chromium-diagnostics.md"
      ],
      "verification_ids": [
        "project-lifecycle",
        "unit-all",
        "electron-smoke"
      ],
      "id": "T005",
      "title": "Сквозная регрессия архива, настроек и восстановления",
      "why": "Убедиться, что исправленные API работают через реальные пользовательские точки входа Electron TEST FIXTURE.",
      "acceptance_criteria": [
        "Архив: подтверждение→прерывание→Повторить очистку→нет зависшей строки; повтор без эффекта; ошибки видны и не удаляют чужую папку.",
        "Настройки: потерянные исполнители появляются лишь в recovery; подтверждённая адресная очистка убирает строку в той же сессии и после рестарта; refusal при живой папке/команде.",
        "Проверены Windows-совместимые пути в unit fixture без заявления native Windows; независимое сохранение соседних проектов, ссылок и пользовательского профиля."
      ],
      "expected_commit_message": "test: закрепить полный цикл восстановления удаления в Electron",
      "parallel_safe": false
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "archive-deletion-recovery-20261011",
        "task_id": "T006",
        "role": "implementation"
      },
      "dependencies": [
        "T005"
      ],
      "functional_paths": [
        "package.json",
        "package-lock.json",
        ".harness/workflow.json"
      ],
      "documentation_paths": [
        "docs/modules/release.md"
      ],
      "verification_ids": [
        "release-source"
      ],
      "id": "T006",
      "title": "Зафиксировать версию 0.6.112 и условия проверок релиза",
      "why": "До DOCS и единственной сборки закоммитить согласованные package manifests и обновить версионные preflight/evidence.",
      "acceptance_criteria": [
        "package.json, package-lock.json и package-lock root package согласованы на 0.6.112; Workflow Kit остаётся 1.7.2.",
        "Через штатный config:apply обновлены версия и evidence/preflight release-source/paired-release/release-installed/github-release с сохранением всех иных проверок и ограничений.",
        "Коммит версии предшествует DOCS и build; вручную npm run build, установку и публикацию не запускать."
      ],
      "expected_commit_message": "chore: закрепить источник выпуска 0.6.112",
      "parallel_safe": false
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "archive-deletion-recovery-20261011",
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
        "T005",
        "T006"
      ],
      "functional_paths": [],
      "documentation_paths": [
        "docs/architecture/OVERVIEW.md",
        "docs/planning/archive-deletion-recovery-spec.md",
        "README.md",
        "docs/modules/project-archive.md",
        "docs/modules/workspace-sessions.md",
        "docs/modules/workspace-sidebar-ui.md",
        "docs/modules/chromium-diagnostics.md",
        "docs/modules/release.md"
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
        "scope_id": "archive-deletion-recovery-20261011",
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
        "paired-release"
      ],
      "id": "T007",
      "title": "Собрать единственный парный выпуск 0.6.112",
      "why": "Получить проверенный macOS arm64 и Windows x64 пакет на одном зафиксированном sourceCommit после DOCS.",
      "verification_kind": "package",
      "acceptance_criteria": [
        "После завершённой DOCS проверка paired-release из commit --task запускает ровно одну сборку обеих ОС, без ручного предварительного build.",
        "Manifest, staging, SHA256SUMS, version/sourceCommit, macOS подпись, шесть release assets проверены; живой ChatGPT/native Windows не объявляются проверенными."
      ],
      "expected_commit_message": "build: подготовить парный выпуск исправления удаления 0.6.112",
      "parallel_safe": false
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "archive-deletion-recovery-20261011",
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
        "release-installed"
      ],
      "id": "T008",
      "title": "Установить готовый macOS выпуск без пересборки",
      "why": "Сохранить filesystem identity, подпись и действующие разрешения постоянного приложения.",
      "verification_kind": "installed",
      "acceptance_criteria": [
        "Установлен готовый проверенный staging без пересборки, app path/inode identity, версия, подпись и manifest сверены.",
        "Работающий экземпляр не перезапускается принудительно; требуется пользовательская живая приёмка после полного выхода."
      ],
      "expected_commit_message": "release: установить готовый выпуск 0.6.112",
      "parallel_safe": false
    },
    {
      "implementation_status": "TODO",
      "commit_status": "PENDING",
      "commit_ref": {
        "scope_id": "archive-deletion-recovery-20261011",
        "task_id": "T009",
        "role": "implementation"
      },
      "dependencies": [
        "T008",
        "DOCS"
      ],
      "functional_paths": [
        "release-manifest.json"
      ],
      "documentation_paths": [],
      "verification_ids": [
        "github-release"
      ],
      "id": "T009",
      "title": "Опубликовать и сверить GitHub Release 0.6.112",
      "why": "Завершить одну поставку двух платформ с проверяемым соответствием Git, тега и файлов выпуска.",
      "verification_kind": "package",
      "acceptance_criteria": [
        "DOCS завершена; origin/main, тег v0.6.112 на sourceCommit, release и шесть assets проверены по именам, размерам и digest без новой сборки.",
        "Ограничения macOS живой приёмки, native Windows и чистой установки названы; план оставлен READY_FOR_ACCEPTANCE до подтверждения пользователя."
      ],
      "expected_commit_message": "release: опубликовать и проверить 0.6.112",
      "parallel_safe": false
    }
  ],
  "blocked_reason": null,
  "user_decisions": [
    {
      "id": "b5d2b09f-739b-433e-856f-13f691736a3a",
      "text": "Пользователь 11 октября 2026 поручил подготовить планировочный документ и to-do plan для выявленных ошибок зависшего удаления и оставшихся записей исполнителей; выполнение микрозадач и выпуск остаются отдельным следующим этапом.",
      "recorded_at": "2026-10-11T08:11:47.990Z"
    }
  ],
  "parallel_allowed": true,
  "max_workers": 4,
  "execution_strategy": "sequential",
  "execution_origin_session_id": "web-pilot-7306ee13-fe94-43ca-8bd3-82e33d1c1e95",
  "execution_reason": "Общий мутируемый реестр, жизненный цикл журнала удаления, связанные settings/diagnostics и единый Electron UI требуют последовательных изменений с регрессией между этапами; независимые исполнители создадут конкурирующие записи и избыточную координацию."
}
```
<!-- workflow-state:end -->

## Состояние

Execution Scope Status: ACTIVE
Delivery Status: IN_PROGRESS
Scope: archive-deletion-recovery-20261011
Current Task: нет
Revision: 1743

## Цель

Исправить восстановление подтверждённого удаления после исчезновения исходных каталогов и безопасно устранять потерянные записи executor-worktree без повреждения соседних проектов и пользовательских данных; выпустить 0.6.112.

## Критерии приёмки

- Валидный confirmed-журнал при отсутствии исходного каталога и карантина заканчивается адресной очисткой метаданных, записи архива и журнала; повторение и restart идемпотентны.
- Каскад по подтверждённому parentProjectId/parentWorkspace удаляет ровно своих детей, даже если их папок уже нет; пересечения журналов родителя и ребёнка безопасно повторяемы.
- Потерянные записи без подтверждённого удаления остаются безопасным recovery и могут удаляться только адресно, после явного подтверждения пользователя и новой проверки отсутствия папки, занятости и идентичности.
- Подмена пути/identity, чужие или изменённые worktree, живые и UNKNOWN-команды защищены; локальные и облачные чаты соседей, браузерный профиль, ключи и рабочий проект не затронуты.
- Автоматические unit, project-lifecycle и Electron fixture-проверки проходят; документация завершена до единственного парного выпуска 0.6.112, установки и публикации на GitHub. Живая macOS/native Windows приёмка не подменяется fixture.

## Микрозадачи

Выполнение: sequential; разрешено: true; лимит: 4
Причина: Общий мутируемый реестр, жизненный цикл журнала удаления, связанные settings/diagnostics и единый Electron UI требуют последовательных изменений с регрессией между этапами; независимые исполнители создадут конкурирующие записи и избыточную координацию.

- [DONE] T001: Воспроизвести оба сбоя в изолированных fixture — Завершено
  - Git Commit: [DONE] test: воспроизвести зависший журнал и потерянных исполнителей
  - Reference: archive-deletion-recovery-20261011 / T001 / implementation
  - Файлы: tests/workspace-deletion.test.mjs, tests/workspace-session.test.mjs
  - Параллельность: исключительное выполнение
  - Зависимости: нет
- [DONE] T002: Доводить confirmed без исходной папки и карантина — Завершено
  - Git Commit: [DONE] fix: восстановить confirmed удаление после исчезновения каталога
  - Reference: archive-deletion-recovery-20261011 / T002 / implementation
  - Файлы: src/workspace-deletion.mjs, tests/workspace-deletion.test.mjs
  - Параллельность: исключительное выполнение
  - Зависимости: T001
- [DONE] T003: Завершать каскад с отсутствующими детьми и пересекающимися журналами — Завершено
  - Git Commit: [DONE] fix: довести каскад удалений и очистку состояния исполнителей
  - Reference: archive-deletion-recovery-20261011 / T003 / implementation
  - Файлы: src/workspace-deletion.mjs, src/workspace-session.mjs, src/project-state-cleanup.mjs, tests/workspace-deletion.test.mjs, tests/workspace-session.test.mjs, tests/project-state-cleanup.test.mjs
  - Параллельность: исключительное выполнение
  - Зависимости: T002
- [TODO] T004: Добавить адресную очистку потерянной записи в Настройках — Ожидает
  - Git Commit: [PENDING] feat: безопасно убирать потерянную запись исполнителя
  - Reference: archive-deletion-recovery-20261011 / T004 / implementation
  - Файлы: src/workspace-session.mjs, src/workspace-deletion.mjs, src/main.mjs, src/preload.cjs, src/ui/settings-panel.mjs, src/ui/index.html, tests/workspace-session.test.mjs, tests/workspace-deletion.test.mjs, tests/settings-parallel-execution.test.mjs, tests/sidebar.test.mjs
  - Параллельность: исключительное выполнение
  - Зависимости: T003
- [TODO] T005: Сквозная регрессия архива, настроек и восстановления — Ожидает
  - Git Commit: [PENDING] test: закрепить полный цикл восстановления удаления в Electron
  - Reference: archive-deletion-recovery-20261011 / T005 / implementation
  - Файлы: tests/electron-smoke.mjs, tests/sidebar.test.mjs, tests/workspace-deletion.test.mjs, src/main.mjs, docs/planning/archive-deletion-recovery-spec.md, README.md, docs/modules/project-archive.md, docs/modules/workspace-sessions.md, docs/modules/workspace-sidebar-ui.md, docs/modules/chromium-diagnostics.md
  - Параллельность: исключительное выполнение
  - Зависимости: T004
- [TODO] T006: Зафиксировать версию 0.6.112 и условия проверок релиза — Ожидает
  - Git Commit: [PENDING] chore: закрепить источник выпуска 0.6.112
  - Reference: archive-deletion-recovery-20261011 / T006 / implementation
  - Файлы: package.json, package-lock.json, .harness/workflow.json, docs/modules/release.md
  - Параллельность: исключительное выполнение
  - Зависимости: T005
- [TODO] DOCS: Актуализация всех документов проекта — Ожидает
  - Git Commit: [PENDING] docs: актуализировать документацию проекта
  - Reference: archive-deletion-recovery-20261011 / DOCS / implementation
  - Файлы: docs/architecture/OVERVIEW.md, docs/planning/archive-deletion-recovery-spec.md, README.md, docs/modules/project-archive.md, docs/modules/workspace-sessions.md, docs/modules/workspace-sidebar-ui.md, docs/modules/chromium-diagnostics.md, docs/modules/release.md
  - Параллельность: исключительное выполнение
  - Зависимости: T001, T002, T003, T004, T005, T006
- [TODO] T007: Собрать единственный парный выпуск 0.6.112 — Ожидает
  - Git Commit: [PENDING] build: подготовить парный выпуск исправления удаления 0.6.112
  - Reference: archive-deletion-recovery-20261011 / T007 / implementation
  - Файлы: release-manifest.json
  - Параллельность: исключительное выполнение
  - Зависимости: T006, DOCS
- [TODO] T008: Установить готовый macOS выпуск без пересборки — Ожидает
  - Git Commit: [PENDING] release: установить готовый выпуск 0.6.112
  - Reference: archive-deletion-recovery-20261011 / T008 / implementation
  - Файлы: release-manifest.json
  - Параллельность: исключительное выполнение
  - Зависимости: T007, DOCS
- [TODO] T009: Опубликовать и сверить GitHub Release 0.6.112 — Ожидает
  - Git Commit: [PENDING] release: опубликовать и проверить 0.6.112
  - Reference: archive-deletion-recovery-20261011 / T009 / implementation
  - Файлы: release-manifest.json
  - Параллельность: исключительное выполнение
  - Зависимости: T008, DOCS

## Context Pack For This Cycle

- docs/architecture/OVERVIEW.md
- docs/planning/archive-deletion-recovery-spec.md
- docs/modules/project-archive.md
- docs/modules/workspace-sessions.md
- docs/modules/workspace-sidebar-ui.md
- docs/modules/chromium-diagnostics.md
- docs/modules/release.md

Служебные состояния меняются только командами workflow. Приёмка не архивирует scope.
