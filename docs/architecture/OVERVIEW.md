# Краткая архитектура проекта

Стек: Workflow Kit 1.7.2, Electron 44.5.1, Node 24.21.0. Версия **0.6.115** переиздаёт опубликованную базу **0.6.112**; код приложения восстановлен без доработок AutoPlan 0.6.113 и ротации Chat 0.6.114. Будущий рефакторинг выполнения в эту поставку не входит. Установка — [README](../../README.md), состояние работы — current plan и Git, факты готовности пакетов — `release-manifest.json` и GitHub Release. Постоянные ограничения — [AGENTS.md](../../AGENTS.md).

## Назначение

Electron-приложение для macOS и Windows: одно окно, слева локальные проекты, чаты и план, справа ChatGPT Web во встроенном Chromium (`BaseWindow` + `WebContentsView`). Модель работает через веб-аккаунт, без модельного API. Web Pilot доставляет контекст; Codex App Server выполняет локальные команды через MCP, подключённый к ChatGPT через Secure MCP Tunnel или VPS.

Один checkout/worktree имеет один current plan `.harness/plans/todo-plan.md`. Чаты хранят разговор и состояние, но планом не владеют. Sequential-план выполняет основной чат. Parallel-план выдаётся отдельным Chat/Work и worktree, main принимает результаты проверенными последовательными интеграциями. Переключение панели не меняет cwd и не останавливает скрытую страницу.

## Карта модулей

Модули без префикса лежат в `src/`.

| Модуль | Код | Контракт |
| --- | --- | --- |
| Каркас | `main.mjs`, `common.mjs`, `platform.mjs` | этот документ |
| Контекст | `context-session`, `context-inputs`, `session-plans` | [context-delivery](../modules/context-delivery.md) |
| Kit ↔ приложение | вызов recover, проверка пакета | [workflow-kit-recovery](../modules/workflow-kit-recovery.md) |
| Review | `plan-review`, `review-continuation`, Kit review | [plan-review](../modules/plan-review.md) |
| AutoPlan | `auto-plan`, `project-auto-plan` | [auto-plan](../modules/auto-plan.md), [отправка](../modules/auto-plan-send.md) |
| Назначения и интеграции | `parallel-execution`, `parallel-kit`, `executor-session` | [parallel-execution](../modules/parallel-execution.md) |
| Живые страницы | `session-runtime`, `conversation-recovery`, `agent-timer` | [session-runtime](../modules/session-runtime.md) |
| Проекция плана | `plan-monitor`, `project-input-watch` | [plan-view](../modules/plan-view.md) |
| Проекты и чаты | `workspace-session`, `chatgpt-title`, `agent-timer` | [workspace-sessions](../modules/workspace-sessions.md) |
| Сайдбар | `preload.cjs`, `ui/sidebar`, `ui/settings-panel` | [workspace-sidebar-ui](../modules/workspace-sidebar-ui.md) |
| Открытие сессии | `workspace-readiness`, поколения навигации main | [session-opening-performance](../modules/session-opening-performance.md) |
| DOM ChatGPT | `chatgpt-dom/composer/experience`, `chatgpt-page-observer`, `page-state` | [chatgpt-dom-compatibility](../modules/chatgpt-dom-compatibility.md) |
| Диагностика | `chromium-diagnostics`, `startup-network-trace` | [chromium-diagnostics](../modules/chromium-diagnostics.md) |
| Подготовка проекта | `workspace-setup`, `ui/workspace-setup`, `resources/workspace-setup-worker.mjs` | [workspace-setup](../modules/workspace-setup.md) |
| Архив и адресная очистка | `workspace-deletion`, `project-state-cleanup`, `archive-preload.cjs`, `ui/archive*` | [project-archive](../modules/project-archive.md) |
| Доктор | `project-doctor`, `ui/project-doctor`, `resources/project-doctor*` | [project-doctor](../modules/project-doctor.md) |
| Первый запуск | `browser-startup`, `startup-readiness`, `ui/startup` | [first-run-onboarding](../modules/first-run-onboarding.md) |
| Службы | `mac-runtime-switch`, `windows-runtime`, `vps-tunnel`, `zip-archive`, `control.py`, `resources/runtime-control/` | [runtime-lifecycle](../modules/runtime-lifecycle.md) |
| Исполнитель | `tools/codex-app-server-mcp/*`, `scripts/check-codex-tools.mjs`, `command-activity.mjs` | [MCP](../modules/codex-app-server-executor.md), [жизненный цикл команд](../modules/command-activity.md) |
| Выпуск | `scripts/release-*`, `prepare-*-toolchain`, `check-*` | [release](../modules/release.md) |
| Kit | `packages/workflow-kit/**`, `scripts/workflow*` | [workflow-kit-package](../../packages/workflow-kit/docs/modules/workflow-kit-package.md) |

## Поток выполнения

1. Пользователь создаёт Chat или Work выбранного проекта. Новая основная сессия сохраняет неизменяемый снимок разрешения параллельности; настройки не меняют уже созданные сессии.
2. Kit строит recovery: Workflow Core, PROTOTYPE, проектный AGENTS, OVERVIEW, план и выбранные документы целиком. Части ≤28000 байт, весь пакет ≤7 частей и ≤180000 байт; превышение даёт CONTEXT_TOO_LARGE без усечения.
3. Web Pilot проверяет пакет, прикрепляет части как файлы и отправляет короткий транспортный текст один раз после их загрузки (до 120 с). UNKNOWN Send не повторяется. Агент читает каждое вложение отдельно и кратко подтверждает проект; MCP в первом ответе основного агента не вызывается. Обычное открытие сохранённого чата контекст повторно не отправляет.
4. Review ON согласует новый план с Claude CLI, каждый успешный отзыв требует сохранённой позиции автора. Ошибки и существенные споры возвращаются пользователю. Получатель Review — явный Session ID, он не владеет планом.
5. AutoPlan независим от Review и других проектов. По умолчанию OFF; явное ON до первого плана ждёт подтверждённой публикации, не теряется от двух PlanMonitor, stale NONE или read error. Первое scope наследует ON один раз с origin опубликованного плана, не чата кнопки; устаревшие revision не откатывают привязку. Последний подтверждённый DONE сохраняет completion-OFF, следующий scope OFF. Разрешение переживает restart; legacy global ON игнорируется.
6. Sequential получает «Продолжай» в собственный основной чат. В parallel задачи получают назначения; обычный task:start в main запрещён. Проверенный source не означает допуск merge: при активной write-команде очередь удерживает main и отправляет исходной сессии одну read-only диагностику; после подтверждённого terminal event очередь делает безопасную интеграцию. Отдельная финальная передача вручает основному агенту оставшиеся операции Kit и итоговый ответ. Durable pending выдерживает completion-OFF; ручной OFF/Stop, чужая страница, черновик и UNKNOWN запрещают повтор. Reply наблюдается по собственным завершённым сообщениям, не по смене pause. План остаётся READY_FOR_ACCEPTANCE, сервер предпросмотра не останавливается. Протокол — [parallel-execution](../modules/parallel-execution.md), [матрица проверок](../modules/parallel-execution-acceptance.md).

## Состояние и безопасность

Наблюдение событийное: PageStateSource, ProjectInputWatch, события служб. Функционального polling в простое нет; ограниченные ожидания/watchdog допустимы. Сбой наблюдения видим, без тихой остановки. При старте до первой страницы панель возвращает пустое восстановление и agentRun=null, не требует runtime.

Адаптер работает с видимым DOM без cookies/localStorage/внутренних функций. Узкое исключение: название через недокументированный `/backend-api/conversation/<id>` в авторизованной странице, fail-closed — [workspace-sessions](../modules/workspace-sessions.md). Пассивная CDP-диагностика не хранит тела и текст. IPC проверяет своё окно/mainFrame/URL; универсального shell/write API нет. Профиль, ключи, адрес коннектора, настройки и пользовательское состояние не попадают в Git и журналы диагностики.

## Платформы и исходники

Единственный backend — Codex App Server, подключения «Codex App Server Local Mac/Windows»: девять MCP tools для команд, stdin, patch, изображений, статуса, watchdog и наблюдения экрана. Управления интерфейсом, модельных ходов и доставки контекста через MCP нет. Codex CLI устанавливает пользователь, версия закреплена в codex-tools.lock.json.

MCP и туннели живут вне окна, стартуют при входе через LaunchAgent/macOS или HKCU Run/Windows. Предпочтительные порты 17852/17853, при занятости сохраняется свободный; selector/туннель/VPS следуют фактическому адресу. Удалённый VPS-порт 17842. Детали — [runtime-lifecycle](../modules/runtime-lifecycle.md).

`packages/workflow-kit` — единственный источник; `resources/workflow-kit` генерируется stage и не хранится в Git, `.harness/kit` обновляется только installer. `scripts/` может импортировать `src/`, обратное запрещено. Workers/Доктор в resources не импортируют src.

Web Pilot Sidebar — отдельный репозиторий; публичные экспорты и pageScript `chatgpt-dom/composer/experience` переиспользуются по закреплённым SHA. Production Host API не реализован.

## Проверки и документы

`npm start` запускает исходники; `npm test` — Node suite; `npm run smoke` — Electron TEST FIXTURE; `npm run build` — парный выпуск macOS arm64 + Windows x64. Назначенные `verification_ids` запускает Kit при `commit`. Для **0.6.115** **T001** закрепляет package manifests, сверку исходников с базой 0.6.112 и `release-source` типа test; **DOCS** актуализирует контракты; **T002** выполняет единственный `paired-release`, **T003** устанавливает готовый пакет, **T004** синхронизирует новую линию main и GitHub без пересборки. `releaseAll` отказывает на незакоммиченных `package*.json`. `sourceCommit` — HEAD после DOCS непосредственно перед сборкой. Разовое перемещение remote main допускается только с точным lease по прямому поручению пользователя; обычные push остаются fast-forward. Контракт — [release](../modules/release.md).

Fixtures не подтверждают живой ChatGPT, native Windows или чистую ОС; это [пользовательская приёмка](../modules/parallel-execution-acceptance.md). [Отложенный аудит](../modules/technical-audit-followups.md) в выпуск не входит.

README — для пользователя; OVERVIEW — карта; docs/modules — контракты; docs/planning — невыпущенные требования. При DOCS действующее содержание спецификаций переносится в модули, временные документы удаляются; история остаётся в Git. Каждый .md ≤28000 байт UTF-8. Вне текущей задачи документы фиксируются docs:commit.

Сайдбар показывает дерево только выбранного проекта; поиск и фоновые статусы доступны в меню проектов. Смена проекта возвращает его последнюю выбранную сессию, не меняет cwd и работу фоновых страниц. Настройки доступны сверху рядом с номером версии; постоянного блока контекста и повтора пакета в начатый чат нет.

Окончательное удаление координируют `WorkspaceDeletion`, очередь execution, `WorkspaceSessions` и `project-state-cleanup`. Существующий `confirmed`-журнал допускает доведение метаданных, когда исходная папка и карантин уже исчезли, только после проверки identity, опорного каталога/тома и занятости. Пересекающиеся журналы parent/child можно завершать в любом порядке, включая исчезнувшую hashed group; повтор идемпотентен. Worktree принадлежат точным parentProjectId/parentWorkspace и assignment/Git proof; чужие, dirty, UNKNOWN и заменённые папки защищены. Записи с отсутствующим родителем остаются в recovery: только пользователь из Settings может подтвердить адресную очистку после повторных проверок, не по одному ENOENT. Соседи, новый projectId на старом пути и облачные чаты сохраняются ([архив](../modules/project-archive.md), [сессии](../modules/workspace-sessions.md), [UI](../modules/workspace-sidebar-ui.md)).

## Отложенные решения

Удалённая видимость с мобильных устройств требует нового решения: сначала read-only MCP UI с проверкой клиентов, затем при неудаче web-компаньон. Без копии плана, shell и прямой записи; с allowlist проектов и аутентификацией. Electron не собирается под iOS/Android, Secure MCP Tunnel не даёт стороннего HTTP-доступа.

Не возобновлять адаптер ChatGPT MCP App и навигацию нативного ChatGPT: spike не переключил беседу, owner_session_id несовместим с планом checkout. Claude через VPS не проверялся. Сигнал compact ChatGPT не найден, восстановление после него не заявлено.
