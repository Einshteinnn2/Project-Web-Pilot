# Проекты и сессии

Модуль ведёт локальный реестр проектов и их сессий: хранилище, жизненный цикл сессий, тип Chat/Work, привязку URL разговора, имена и синхронизацию названия с ChatGPT, время агента, архив сессий. Сессия — один облачный разговор ChatGPT и его навигация; план проекта ей не принадлежит.

Границы модуля: план — [plan-view](plan-view.md), recovery — [context-delivery](context-delivery.md), DOM — [chatgpt-dom](chatgpt-dom-compatibility.md), UI — [sidebar](workspace-sidebar-ui.md), удаление проектов — [archive](project-archive.md), готовность страницы — [opening](session-opening-performance.md). Модель, лимиты OpenAI, MCP и туннель не затрагиваются.

## Код

- `src/workspace-session.mjs` — `WorkspaceSessions` (хранилище и все мутации), `WorkspaceError`, `readWorkspace` (data-only проекция плана), `normalizeChatUrl`, `conversationUrlCompatibleWithExperience`, `activeSessionsNewestFirst`.
- `src/chatgpt-experience.mjs` — entrypoints Chat/Work/входа, `chatGPTExperienceForUrl`, `isPendingChatGPTConversation` (модуль входит в контракт Web Pilot Sidebar — см. chatgpt-dom-compatibility).
- `src/chatgpt-title.mjs` — `chatGPTTitleScript`, `conversationIdFromChatUrl`.
- `src/agent-timer.mjs` — `AgentTimer`, `AGENT_IDLE_GRACE_MS = 5000`.
- `src/main.mjs` — IPC `pilot:*` проектов/сессий, `openConnectedSession`, `rememberSessionTitle`, `rememberScopeTitle`, `syncSelectedSessionTitle`, `observeManualConversation`, `publish`/`snapshot`, проекции архива сессий.
- `src/context-session.mjs` — привязка URL после отправки, фазы `chat-changed`/`manual-session`, `externalClientLine`.

## Хранилище

- Файл `<userData>/workspaces.json` (`userData` — `~/Library/Application Support/Project Web Pilot`, Windows `%APPDATA%\Project Web Pilot`; вне `.app`, поэтому переживает обновления). `schemaVersion: 6`.
- Одна очередь мутаций (`mutate`): изменение делается на копии; если данные не изменились, файл не переписывается (повторные `applyScopeTitle`/`setSessionTitle` на каждом `publish`); иначе атомарная запись — временный `workspaces.json.tmp-<uuid>` (0600), `rename`; каталог создаётся с 0700. Записи сериализованы (`saveTail`). Неудачная запись удаляет свой временный файл.
- Брошенные временные копии (`removeStoreTemporaries`: `workspaces.json`, его `.vN-backup` и `diagnostics.jsonl(.1)` с суффиксом `.tmp` или `.tmp-*`) содержат записи проектов. Их удаляет `load` (один экземпляр приложения, до любой записи; сбой не мешает запуску), а также удаление проекта (`removeTemporaries` в очереди мутаций) и локальное удаление сессий — после ожидающих записей, без гонки со своей. Посторонние файлы не трогаются.
- Проект: `workspace` (realpath, уникален), `projectId` и `name` (= `project_id`/`project_name` Kit), opt. `displayName`, opt. `lastNamedScopeId`, `expanded`, `archivedAt|null`, `selectedSessionId`, `sessions[]`.
- Сессия: `sessionId` (`web-pilot-<uuid>`, уникален), `experience` (`chat|work`, неизменен), `chatUrl|null` (нормализован, уникален по всем проектам, совместим с `experience`), `title`, `titleSource` (`page|manual|scope|null`), `lastNamedScopeId`, `createdAt`, `lastOpenedAt`, `archivedAt|null`, `attempt`, `receipt`, opt. `manualStart`, opt. `agentTime {totalMs,lastMs}` (целые ≥0, `lastMs ≤ totalMs`). Legacy-поля `planId`, `originSessionId`, `legacyPlanId` (проверяется формат) и `planBinding` хранятся, но ничего не выбирают.
- Инварианты при загрузке: у проекта ≥1 активная сессия, выбранная сессия активна; нарушение, повреждённый JSON или неизвестная версия → `SESSIONS_INVALID`, файл не перезаписывается, приложение открывается с `storageError` (создание, подключение и выбор заблокированы до восстановления файла).
- Миграции v1→v6 выполняются цепочкой при загрузке. Исходник сохраняется в `workspaces.json.v<N>-backup` с флагом `wx` (0600): существующая копия не перезаписывается, повторной миграции нет. v3→v4: `/work/...` → `work`, иначе `chat`; v4→v5: `archivedAt = null` у сессий; v5→v6: legacy-поля плана, `legacyPlanId` только при единственной сессии с отправленным пакетом этого scope (иначе не угадывается), удаляются проектные `planView/preparedPlans/unassignedPlans/scopeTransition`. Устаревший `tokenEstimate` удаляется при загрузке. Требование пользователя: миграция без потери URL, попыток отправки, имён, Chat/Work, дат и архива.
- `updateSession` принимает `attempt`, `receipt`, `manualStart`, `conversationRecovery`, иначе `INVALID_SESSION_PATCH`. Фоновая запись требует точных workspace/sessionId. `executionSnapshot` основной сессии неизменен. Исполнитель хранит parentProjectId/parentWorkspace/scope/task/assignment/origin, снимок, `executionAutomation` и `executionTime`; его запись и сессия принадлежат одному подтверждённому родителю.

## Связь с планом

Один checkout/worktree — один current plan; все сессии проекта видят один план, новая сессия свой план не создаёт (решение пользователя: сессии — только разговоры и навигация). Чтение и коды ошибок `readWorkspace` — [plan-view.md](plan-view.md); `sessionId` на результат не влияет. Другой `project_id` в папке → `PROJECT_REPLACED`, сохранённые чаты не меняются. Параллельная работа над другим планом — отдельная ветка/worktree.

## Жизненный цикл

**Первая сессия.** При создании проекта и первом подключении незнакомой папки пользователь явно выбирает Chat или Work до финального действия (`pilot:set-first-session-experience`, `applySetup(token, experience)`), по умолчанию Chat, выбор между проектами не запоминается. Повторное открытие известного проекта сессию не создаёт и выбор не показывает.

**Новая сессия** — операция проекта: «Новый Chat»/«Новый Work» в меню проекта или продолжение Доктора `chat|work`. IPC `pilot:new-session {workspace, experience}`: строгая проверка папки, затем `newSession(workspace, experience)` добавляет запись, выбирает её, раскрывает проект и открывает entrypoint с разовым разрешением очистить восстановленный черновик (`freshDraft`). Старые сессии не заменяются. Ошибки: `WORKSPACE_REQUIRED`, `PROJECT_ARCHIVED`, `SESSION_EXPERIENCE`. Черновик очищается только для новой сессии, только на entrypoint без сообщений, со сверкой документа в том же вызове; другая страница → `chat-changed`, неудачная очистка → `NEW_SESSION_DRAFT_CLEAR_FAILED`. Reopen и повтор черновик не трогают; clipboard, storage и аккаунт не очищаются (детали — context-delivery).

**Выбор.** `pilot:select-workspace` возвращает последнюю выбранную активную сессию (`latest:false`); при недоступной записи выбирается оставшаяся активная. Отдельный API `latest:true` сохранён для явного выбора новейшей. Стрелка только раскрывает дерево. Выбор сессии, reload, возврат к чату и Settings сохраняют точные workspace/sessionId; поколения навигации отбрасывают устаревшее A→B→A. Фоновые страницы продолжают работать со своим cwd.

**Порядок.** Активные сессии — по `createdAt` убыв., при равенстве — поздняя запись выше (`activeSessionsNewestFirst`). Открытие старой сессии меняет только `lastOpenedAt`, порядок не меняется. Архивные в дереве не показываются.

**Чужие чаты** не импортируются: сессии создаёт только Web Pilot. `ensureExecutor` создаёт одну фоновую сессию назначения с унаследованным Chat/Work, не меняя выбранную строку. Это подчинённое задание общего плана, не отдельный пользовательский план.

## Chat/Work и URL

- Entrypoints: Chat `https://chatgpt.com/`, Work `https://chatgpt.com/work/`, без проекта — `https://chatgpt.com/auth/login`. Открывается сохранённый `chatUrl`, иначе entrypoint по `experience`. `/?surface=work|tpp` считается Work. Модель и reasoning Web Pilot не выбирает.
- Режим подтверждается нативным переключателем страницы до первого recovery, потому что URL его не доказывает (ChatGPT помнит режим и может открыть Work на `/`). Несовпадение — нативный клик и перечитывание; неподтверждённый режим → фаза `waiting-experience` (`EXPERIENCE_UNCONFIRMED`), подготовка и отправка блокируются, черновик сохраняется. Cookies, localStorage и внутренние функции ChatGPT не используются. Селекторы — chatgpt-dom-compatibility.
- Fail-closed по фазе (несвязанная сессия): до начатой отправки Work открывается только в Work, Chat — только в Chat, иначе `CHATGPT_EXPERIENCE_MISMATCH` без сборки и Send; появившийся посторонний разговор → `chat-changed`. После начатой отправки временные `/c/WEB:<uuid>` и `/c/local-chatgpt:<uuid>` допустимы (`waiting-chat`/`send-unknown`), но не сохраняются; привязка ждёт постоянный URL без повтора отправки. Причина: созданный Work живёт на общем `/c/<id>`, поэтому истина — сохранённый `experience` и точный `chatUrl`, режим из пути не выводится.
- `normalizeChatUrl`: только `https://chatgpt.com` без порта и учётных данных; пути `/c/<id>`, `/work/c/<id>`, `/work/<id>`, `/g/<gizmo>/c/<id>`, id ≥8 символов `[A-Za-z0-9_-]`; хвостовой `/` снимается. Chat не принимает `/work/...`; Work принимает `/work/...` и `/c/<id>`. Entrypoint не сохраняется.
- `bindChat`: `CHAT_URL_INVALID`, `CHAT_EXPERIENCE_MISMATCH`, `CHAT_CHANGED` (у сессии уже другой URL), `CHAT_IN_USE` (URL у другой сессии); отказы — `SESSION_CHANGED`, `PROJECT_ARCHIVED`. У связанной сессии другой URL на странице → фаза `chat-changed`, перепривязки нет. `experience` не меняется никогда.
- Ручной первый Send (своё сообщение пользователя на entrypoint без recovery этой сессии) привязывает URL с `manualStart: true` и даёт фазу `manual-session` без доставки.
- Просмотр сохранённого/ручного/legacy чата не запускает recovery. Полный пакет получает только новая сессия; retry до первого Send сохраняет requestId/вложения, sending/sent/unknown не сбрасывается. Начатый чат не обновляется повторным пакетом.

## Имена

- Проект: `displayName` — только локальный псевдоним (`pilot:rename-project`, ≤160 символов после схлопывания пробелов, пусто → `PROJECT_NAME_INVALID`). Папка, `workspace`, `project_id`, `project_name` Kit не меняются; агент `displayName` не меняет (каноническое `project_name` меняет только команда Kit `project:rename`). В снимке и архиве показывается `displayName || name`.
- Сессия: `title` + `titleSource`. Приоритет `manual` > `scope` > `page`; ручное имя не перетирается ничем и переживает restart и архив. `pilot:rename-session` — `titleSource = manual`; архивная сессия → `SESSION_ARCHIVED`, архивный проект → `PROJECT_ARCHIVED`.
- Лимит имени сессии — 80 символов и 200 байт UTF-8 (схлопывание пробелов, обрезка, снятие хвостовых тире/пробелов; пусто → `TITLE_INVALID`), потому что ChatGPT отвечал 422 на более длинные названия; лечится длиной, не повтором.
- Page title (`page-title-updated`, без суффикса «- ChatGPT»; «ChatGPT», «New chat», «Новый чат» игнорируются) — только fallback и только когда открыт ровно `chatUrl` выбранной сессии.
- Имя scope: H1 первого required-документа `docs/planning/*.md` из `context_pack` плана, затем `docs/modules/*.md`, иначе `objective`. Применяется только при `execution_scope_status` `ACTIVE|BLOCKED`, непустых `scope_id` и `objective`. Заголовок scope транзиентен, в store не пишется.
- `applyScopeTitle` (вызывается из `publish`): scope именует сессию один раз на проект — ту, что выбрана при первом наблюдении scope (`lastNamedScopeId` у проекта и сессии). Переход на существующую соседнюю сессию имя не переносит, чтобы старый чат не получал имя текущего плана. Повторный вызов той же сессии обновляет scope-имя, если изменился канонический заголовок; ревизии и смена задачи не переименовывают. Ручное имя остаётся, но scope помечается использованным.
- `newSession` при scope `ACTIVE|BLOCKED` с непустым `objective` сразу даёт новой сессии scope-имя.
- Новых MCP-инструментов и модельных вызовов для имён нет.

## Синхронизация названия с ChatGPT

- Синхронизируется только `manual|scope`-имя выбранной сессии с привязанным `chatUrl` и только когда WebContents открыт ровно на нём и не грузится.
- Скрипт (`chatGPTTitleScript`) выполняется в авторизованной странице: `GET /api/auth/session` (токен не покидает renderer, не возвращается, не хранится и не логируется) → `GET /backend-api/conversation/<id>`; совпало — без PATCH; иначе `PATCH {title}` и проверочный GET. `document.title` успехом не считается. Endpoint недокументирован и выбран после живой пробы, поэтому всё fail-closed.
- Коды: страницы — `CHAT_CHANGED`, `CHAT_URL_INVALID`, `AUTH_SESSION`, `READ_FAILED`, `RATE_LIMITED` (429), `RENAME_FAILED`, `VERIFY_FAILED`, `VERIFY_MISMATCH`, `NETWORK_OR_PAGE_ERROR`; main — `TITLE_SYNC_NO_EXPLICIT_TITLE`, `TITLE_SYNC_NOT_READY`, `TITLE_SYNC_FAILED`, `TITLE_SYNC_EXECUTION_FAILED`. Локальное имя при ошибке сохраняется.
- Триггеры — только события: `navigation-loaded`, `chat-bound`, `manual-chat-bound`, `scope-title-changed`, `manual-rename`, `title-changed-during-sync` (имя сменилось во время операции). Одна операция на сессию одновременно; таймеров, debounce и повторов нет; после 429 — одна неудача, следующая попытка при следующем событии (например, открытии). Причина: запуск от общего `ContextSession.onChange` давал шторм запросов в обход backoff и 429.
- Итог пишется в Chromium diagnostics (`title-sync`: sessionId, ok, code, status, changed, matched, reason) без токена и текста названия ([chromium-diagnostics.md](chromium-diagnostics.md)).

## Время агента

- Работа агента = кнопка Stop ChatGPT (busy наблюдателя своей страницы, без сети и опроса). Замер стартует на busy; idle запускает grace 5 с, busy в пределах grace продолжает задание. Конец — начало последнего idle после grace, новый документ или освобождение страницы. Переключение панели замер не обрывает; архивная сессия не замеряется. У исполнителя дополнительно раздельные часы работы/ожидания — [параллельное выполнение](parallel-execution.md).
- Идущий замер живёт в памяти main (`agentTimer.view` → `selected.agentRun`); завершённый добавляется `recordAgentTime(workspace, sessionId, ms)` к `agentTime` своей сессии, даже если выбрана уже другая. Некорректное значение → `INVALID_AGENT_TIME`; некорректный `agentTime` в файле → `SESSIONS_INVALID`. Показ — workspace-sidebar-ui.

Окончательное удаление основного проекта использует forgetDeletedProject: вместе с родителем убираются связанные executor-записи, даже если они не архивировались отдельно. Отдельное архивирование и «Убрать из списка» сохраняют прежний смысл. Полная очистка разрешений, журналов и worktree описана в [project-archive](project-archive.md).

## Архив и удаление сессий

- `pilot:archive-session`: только у неархивного проекта; последнюю активную нельзя (`SESSION_LAST_ACTIVE`). Если архивируется выбранная — выбор переходит на последнюю открытую из оставшихся, и она открывается. Restore (`archive:restore-sessions`) возвращает `archivedAt = null`, `experience`/`chatUrl`/имя не меняет, выбор не трогает.
- Локальное удаление (`archive:delete-sessions`) — только архивных (`SESSION_NOT_ARCHIVED`), набор проверяется целиком до изменений (`PROJECT_REPLACED`, `SESSION_ARCHIVE`). Удаляются запись сессии, её копии в `workspaces.json.v1..v5-backup`, строки `diagnostics.jsonl` этой сессии и брошенные временные копии хранилища (backup без массива `projects` → `SESSION_LOCAL_CLEANUP`). Папка, Git, WorkspaceDeletion и облачные чаты не затрагиваются — удалять облачные чаты запрещено.
- Окно «Архив», вкладка «Сессии»: только сессии неархивных проектов (название, Chat/Work, проект, время архивации), выбор click/Shift/⌘/Ctrl, пакетный возврат, локальное удаление после подтверждения с текстом, что облачные разговоры ChatGPT останутся. Архив проектов — независимый жизненный цикл ([project-archive.md](project-archive.md)).

## Снимок состояния для UI

`publish()` строит один снимок и шлёт его сайдбару (`pilot:state-changed`) только при изменении сигнатуры; новый сайдбар получает начальный снимок после загрузки. Проекты в снимке — неархивные, сессии — активные newest-first с полями `sessionId, experience, chatUrl, title, createdAt`; у выбранной сессии `attempt` урезан до `protocol/requestId/state`, `receipt` скрыт. `diagnostics.jsonl` (0600) дописывается только при изменении сводной записи (фаза, сессия, `requestId`, sha пакета, revision, код ошибки, состояние страницы), без текста сообщений.

## Не возвращать

- Счётчик токенов сессии (js-tiktoken, догрузка истории, `tokenEstimate`): сумма истории ≠ заполнению окна и тормозила готовность.
- Индикатор «Контекстное окно»: ChatGPT Web не отдаёт занятость окна.
- Планы сессий, выбор плана по `planId/originSessionId/legacyPlanId`, кнопку «Принять» и автосоздание сессии после закрытия плана (полный список — [plan-view.md](plan-view.md)).
- Для имён: retry/backoff/debounce и запуск от `ContextSession.onChange`; LLM-вызов; MCP-инструмент переименования; внешний сервис, API key, расширение браузера или Tampermonkey (`chatgpt-triage` — не зависимость); массовое ретро-переименование; `window.prompt()` (в Electron не показывался); формат «objective — nextTaskTitle».
- Импорт чужих чатов и удаление облачных разговоров; выбор модели.

## Проверки

- Автоматические (`unit-all` = `npm test`, `electron-smoke` = `npm run smoke`): `tests/workspace-session.test.mjs` (миграции и backup, брошенные временные копии, валидация, порядок, выбор, A→B→A, архив, удаление, имена, время агента), `tests/chatgpt-title.test.mjs`, `tests/agent-timer.test.mjs`, `tests/chatgpt-experience.test.mjs`, `tests/context-session.test.mjs` (привязка, fail-closed), `tests/sidebar.test.mjs`; smoke — переименование через диалог, удаление `tokenEstimate`. Smoke работает на TEST FIXTURE и живой ChatGPT не доказывает.
- Ручные (пользователь, на установленной версии): новые Chat и Work в живом ChatGPT — подтверждение режима, привязка постоянного `/c/<id>`, нет повторной отправки; переоткрытие сохранённой сессии без отправки; restart возвращает выбранную сессию и её URL; переименование и автоимя доходят до названия разговора в аккаунте; архив/возврат/локальное удаление сессии не трогают облачный чат.

## Принадлежность исполнителей

`ownedExecutor` сверяет parentProjectId/parentWorkspace; legacy без Git/assignment proof остаётся в `recovery`. `forgetDeletedProject` адресно убирает своих детей из `related[]`. `forgetOrphanExecutor({workspace,projectId,parentWorkspace,parentProjectId,sessionIds})` удаляет ровно одну запись атомарной мутацией после проверок Main; изменение родителя, ID или сессий → `EXECUTOR_RECORD_CHANGED`. Папки и облачные чаты сохраняются. [Условия](project-archive.md).

## Открыто

- Синхронизация названия на native Windows не проверена (как и весь Windows-клиент до приёмки пользователем).
- Расхождение: в запись проекта сохраняются поля последней проекции плана (`scopeId`, `planId`, `planRevision`, `scopeStatus`, `objective`, `nextTaskTitle`, `watchInputs`, `inspectedSessionId` и др.) — задачи не пишутся, но «проекция транзиентна» выполняется лишь частично; `save()` и `snapshot()` исключают разные наборы полей.
- Мелкое расхождение: поле диалога переименования ограничено 80 символами и для проекта, хотя хранилище допускает 160.
