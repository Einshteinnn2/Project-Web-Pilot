# Краткая архитектура проекта

Стек: Workflow Kit 1.7.2, Electron 44.5.1, Node 24.21.0. Последний опубликованный выпуск — **0.6.113**; в `package.json`/`package-lock.json` зафиксирована **0.6.114** с ротацией Chat после заданного числа микрозадач. **Сборка, установка и публикация 0.6.114 ещё не выполнялись.** Установка — [README](../../README.md), работа — current plan и Git; manifest и GitHub Release появятся после delivery. Ограничения — [AGENTS.md](../../AGENTS.md).

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
| AutoPlan и ротация Chat | `auto-plan`, `project-auto-plan`, `project-session-auto-plan`, `chat-session-rotation`, `chat-session-rotation-settings`, `auto-plan-state` | [auto-plan](../modules/auto-plan.md), [отправка](../modules/auto-plan-send.md) |
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
5. AutoPlan независим от Review и других проектов. По умолчанию OFF; явное ON до первого плана ждёт подтверждённой публикации и первого пригодного ответа, не теряется от двух PlanMonitor, stale NONE, read error, Review или restart. Первый scope наследует ON один раз с origin опубликованного плана, не чата кнопки; устаревшие revision не откатывают привязку. WAIT сохраняет ON в `aria-pressed`, а `#auto-plan-message[data-reason]` объясняет причину; busy отображается как RUNNING, не OFF. Последний подтверждённый DONE сохраняет completion-OFF, следующий scope OFF; legacy global ON игнорируется.
6. Sequential отправляет одно «Продолжай» в подтверждённый основной чат на пригодной паузе. OFF→ON в другом основном Chat/Work после Recovery переносит получателя; старый не отправляет дубль. **0.6.114**: для обычного Chat с AutoPlan ON Settings задаёт `chatSessionTaskLimit` **1–10**, default 4. Только подтверждённые Git/Kit DONE этого Chat (включая DOCS/delivery) увеличивают устойчивый счётчик. После N-й задачи и idle-паузы Web Pilot сохраняет запрет старого Send, **однократно** создаёт новую Chat-сессию с тем же планом и доставляет полный Recovery. `ProjectAutoPlan.handoff` держит recipient=`null` до подтверждения delivered/idle assistant и сохранения нового адресата; ошибка fail-closed без повторных Chat/Recovery/Continue и без потери DONE. Последняя DONE завершает план без ротации. OFF/Work/parallel остаются без ротации, ручное создание Chat при ON переносит право после Recovery, простое выделение чата — нет. Фоновые проекты не меняют видимую страницу. [Контракт](../modules/auto-plan.md).
7. Parallel сохраняет origin из плана: задачи получают отдельные worktree, обычный task:start в main запрещён. При активной write-команде очередь удерживает main, предлагает read-only диагностику и ждёт подтверждённый terminal event до merge. Финальная передача вручает основному агенту сверку и ответ. Durable pending выдерживает completion-OFF; ручной Stop/Send, чужая страница, черновик и UNKNOWN защищены. План остаётся READY_FOR_ACCEPTANCE до приёмки пользователя, предпросмотр не останавливается. [Протокол](../modules/parallel-execution.md), [проверки](../modules/parallel-execution-acceptance.md).

## Состояние и безопасность

Наблюдение событийное: PageStateSource, ProjectInputWatch, события служб. Функционального polling в простое нет; ограниченные ожидания/watchdog допустимы. Сбой наблюдения видим, без тихой остановки. При старте до первой страницы панель возвращает пустое восстановление и agentRun=null, не требует runtime.

Адаптер работает с видимым DOM без cookies/localStorage/внутренних функций. Узкое исключение: название через недокументированный `/backend-api/conversation/<id>` в авторизованной странице, fail-closed — [workspace-sessions](../modules/workspace-sessions.md). Пассивная CDP-диагностика не хранит тела и текст. IPC проверяет своё окно/mainFrame/URL; универсального shell/write API нет. Профиль, ключи, адрес коннектора, настройки и пользовательское состояние не попадают в Git и журналы диагностики.

## Платформы и исходники

Единственный backend — Codex App Server, подключения «Codex App Server Local Mac/Windows»: девять MCP tools для команд, stdin, patch, изображений, статуса, watchdog и наблюдения экрана. Управления интерфейсом, модельных ходов и доставки контекста через MCP нет. Codex CLI устанавливает пользователь, версия закреплена в codex-tools.lock.json.

MCP и туннели живут вне окна, стартуют при входе через LaunchAgent/macOS или HKCU Run/Windows. Предпочтительные порты 17852/17853, при занятости сохраняется свободный; selector/туннель/VPS следуют фактическому адресу. Удалённый VPS-порт 17842. Детали — [runtime-lifecycle](../modules/runtime-lifecycle.md).

`packages/workflow-kit` — единственный источник; `resources/workflow-kit` генерируется stage и не хранится в Git, `.harness/kit` обновляется только installer. `scripts/` может импортировать `src/`, обратное запрещено. Workers/Доктор в resources не импортируют src.

Web Pilot Sidebar — отдельный репозиторий; публичные экспорты и pageScript `chatgpt-dom/composer/experience` переиспользуются по закреплённым SHA. Production Host API не реализован.

## Проверки и документы

`npm start` — исходники; `npm test` — Node suite; `npm run smoke` — Electron TEST FIXTURE; `npm run build` — парный выпуск macOS arm64 + Windows x64. Kit запускает назначенные `verification_ids` при `commit`. Для **0.6.114**: T008 завершил version/preflight (`release-source` и `codex-tools-live`), **DOCS** сверяет постоянные документы, **T009** — единственный `paired-release`, **T010** — установка из staging, **T011** — GitHub без пересборки. `releaseAll` отказывает на незакоммиченных `package*.json`. `sourceCommit` — HEAD после DOCS и до сборки; ручной build и обход Git hooks запрещены. [Релиз](../modules/release.md).

Unit (808 успешных в T007) и Electron TEST FIXTURE проверили N=1/N=4 с Git/Kit DONE, четыре Recovery-вложения, одно продолжение, фоновые и ручные Chat, Work/parallel regressions. Fixtures не подтверждают живой ChatGPT, native Windows или чистую ОС; это [пользовательская приёмка](../modules/release.md). [Отложенный аудит](../modules/technical-audit-followups.md) в выпуск не входит.

README — для пользователя; OVERVIEW — карта; docs/modules — контракты; docs/planning — невыпущенные требования. При DOCS действующее содержание спецификаций переносится в модули, временные документы удаляются; история остаётся в Git. Каждый .md ≤28000 байт UTF-8. Вне текущей задачи документы фиксируются docs:commit.

Сайдбар показывает дерево только выбранного проекта; поиск и фоновые статусы доступны в меню проектов. Смена проекта возвращает его последнюю выбранную сессию, не меняет cwd и работу фоновых страниц. Настройки доступны сверху рядом с номером версии; постоянного блока контекста и повтора пакета в начатый чат нет.

Окончательное удаление координируют `WorkspaceDeletion`, очередь execution, `WorkspaceSessions` и `project-state-cleanup`. Существующий `confirmed`-журнал допускает доведение метаданных, когда исходная папка и карантин уже исчезли, только после проверки identity, опорного каталога/тома и занятости. Пересекающиеся журналы parent/child можно завершать в любом порядке, включая исчезнувшую hashed group; повтор идемпотентен. Worktree принадлежат точным parentProjectId/parentWorkspace и assignment/Git proof; чужие, dirty, UNKNOWN и заменённые папки защищены. Записи с отсутствующим родителем остаются в recovery: только пользователь из Settings может подтвердить адресную очистку после повторных проверок, не по одному ENOENT. Соседи, новый projectId на старом пути и облачные чаты сохраняются ([архив](../modules/project-archive.md), [сессии](../modules/workspace-sessions.md), [UI](../modules/workspace-sidebar-ui.md)).

## Отложенные решения

Удалённая видимость с мобильных устройств требует нового решения: сначала read-only MCP UI с проверкой клиентов, затем при неудаче web-компаньон. Без копии плана, shell и прямой записи; с allowlist проектов и аутентификацией. Electron не собирается под iOS/Android, Secure MCP Tunnel не даёт стороннего HTTP-доступа.

Не возобновлять адаптер ChatGPT MCP App и навигацию нативного ChatGPT: spike не переключил беседу, owner_session_id несовместим с планом checkout. Claude через VPS не проверялся. Сигнал compact ChatGPT не найден, восстановление после него не заявлено.
