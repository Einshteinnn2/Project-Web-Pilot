# Доставка контекста

Web Pilot сам передаёт в ChatGPT Web полный recovery текущего checkout: одно стартовое сообщение с коротким транспортным текстом и частями пакета во вложениях. Модуль владеет ContextCache, попыткой отправки (attempt), привязкой разговора, однократностью Send, ConversationRecovery и транспортом автопродолжения. Состав и пределы пакета задаёт Kit ([граница Kit](workflow-kit-recovery.md)), DOM — [адаптер](chatgpt-dom-compatibility.md), паузы — [AutoPlan](auto-plan.md). MCP исполнителя контекст не доставляет.

## Код
- `src/context-session.mjs` — `ContextSession`, `startupMessage`, `externalClientLine`, `packetMatchesProject`, `rotationRecoveryStatus`; `src/context-cache.mjs` — `ContextCache`; `src/context-inputs.mjs` — `readinessContextKey`; `src/session-plans.mjs` — `SessionPlans.loadContext`; `src/mcp-runtime.mjs` — `validateContextPacket`, `CONTEXT_PROTOCOL`.
- `src/chatgpt-composer.mjs` — `ChatGPTComposer.deliver`, `sendUserMessage`, `waitForSendReady`, `clearNewSessionDraft`; действия `pageOperation` `attach`, `fill`/`paste`, `send`, `select-experience`, `clear-new-draft`.
- `src/conversation-recovery.mjs` — `ConversationRecovery`; `src/auto-plan.mjs` — `continueMessage`; `src/mac-runtime-switch.mjs` — `EXECUTOR_TOOL_RULES`.
- `src/main.mjs` — `attachController`, `navigate`, `observeManualConversation`, IPC `pilot:retry`, `pilot:reconnect`, `pilot:copy-external-client-line`; фазы в UI — `src/ui/sidebar.mjs`, `src/ui/progress.mjs`.

## Поведение

### Когда пакет отправляется
- Полный пакет доставляется при старте новой Chat/Work (меню, первый проект, Doctor или назначенный исполнитель). Незавершённая подготовка до Send может безопасно продолжиться. Просмотр, переключение, reload, restart и старый retry IPC не повторяют recovery в начатый/manual/legacy/sending/sent/UNKNOWN чат.
- ContextSession подключается при подтверждённой readiness папки и актуальном поколении своей страницы. Setup/Doctor приостанавливают выбранную доставку; фоновые исполнители сохраняют собственный контроллер независимо от Settings и выбора.
- Session ID — идентичность чата и навигации, план не выбирает: все сессии checkout получают recovery одного current plan. Смена проекта не меняет cwd работающего чата. Сохранённый `sent`/legacy/`unknown` чат не вызывает `runtime.ensure()`, прогрев и `recover`.
- **Ротация Chat (0.6.114)**: после N Kit DONE Web Pilot отзывает Send старого чата; новый получает тот же полный Recovery штатным `ContextSession`, не через MCP. `attempt` сохраняется до click; sent/UNKNOWN не повторяются. Пассивная `rotationRecoveryStatus` консервативна (`sending/unknown` — `blocked`), но **фактический handoff** проверяет `chatHandoffDecision`: текущее `sending` ждёт, после restart `send-unknown` останавливает цепочку. Продолжение допускается только после delivered, постоянного URL, idle assistant и сохранения recipient. [AutoPlan](auto-plan.md).

### Получение и проверка пакета
- `node <workspace>/scripts/workflow.mjs recover --format packet` (Kit проекта, 120 с, 4 MiB); старый Kit с `SESSION_REQUIRED` — повтор с `--session/--plan` ([граница Kit](workflow-kit-recovery.md)).
- `validateContextPacket` (в runtime, кеше и ContextSession; поля — [граница Kit](workflow-kit-recovery.md)):
  - не `inline-context-v1`, `ack_required !== false`, нет `parts` или неверный `budget.document_bytes` (28000 по умолчанию) — `MCP_UPDATE_REQUIRED`; чужой `workspace` — `MCP_CONTEXT_MISMATCH`;
  - не `ready`/`COMPLETE`, нет `context`/`signature`/`generated_at_ms`, не ровно 8 `facts`, есть `probe_id`/`challenge` — `MCP_CONTEXT_INCOMPLETE`;
  - `context` > 180000 байт — `MCP_CONTEXT_TOO_LARGE`;
  - не сходятся `context_bytes`/`context_sha256` или части (`index 1..N`, `total N`, точные `bytes`/`sha256`, `bytes ≤ document_bytes`, `join('\n\n') === context`) — `MCP_CONTEXT_DAMAGED`.
- Число частей (≤ 7) и предел `min(hard_bytes, 180000)` обеспечивает Kit (`CONTEXT_TOO_LARGE`, без усечения); Web Pilot дублирует только потолок 180000.
- После сборки проект перечитывается: 8 facts должны совпасть с проекцией плана (`packetMatchesProject`), иначе `CONTEXT_CHANGED`; другой `project_id` — `PROJECT_REPLACED`. Чтение проекции — до 3 попыток (паузы 25/100 мс), затем `PROJECT_READ_FAILED`.

### ContextCache
- Адрес — workspace; ≤ 4 полных пакетов в памяти (LRU), на диск не пишется. Параллельные `load` объединяются; у каждой отправки свой `requestId`.
- Ключ — `sha256({version:4, workspace, readiness: inputKey})`, `inputKey` — от `WorkspaceSetup.ready()` (Kit `inspectionInputs`). Readiness не подтверждена или ключ пуст — `CONTEXT_INPUTS_UNAVAILABLE`; возраст пакета ключ не заменяет (300 с — только в ветке без кеша для тестов).
- Сборка: ключ до → build → ключ после; изменился ключ или кеш очищен — ещё одна попытка, затем `CONTEXT_CHANGED`; нестабильный пакет не кэшируется. Пакет с неизменными входами переиспользуется без предела возраста, в том числе новыми сессиями.
- Кеш очищают Doctor, активация служб и закрытие окна. `warm` — событийный: отложенный старт (черновик, генерация, нет поля) и `projectChanged()` ([план](plan-view.md)); одинаковые запросы делят промис, ошибка — `CONTEXT_WARM_FAILED`, повтор явный. Polling отсутствует.

### Стартовое сообщение
- Attempt `{protocol, requestId:'wp-request-<uuid>', text, attachments, packet, state}`; состояния `prepared → sending → sent | unknown`. Хранится с текстом частей в `userData/workspaces.json` (0600): повтор не пересобирает актуальный пакет. В renderer — только `protocol/requestId/state` и метаданные пакета; текст пакета и черновика не попадает в IPC и журналы ([диагностика](chromium-diagnostics.md)).
- Вложения: `context-<8 hex>-NN-of-<total>.md` (`contextPartName`, первые 8 hex UUID), `text/markdown`, точный `part.text`. Уникальные короткие имена обязательны: ChatGPT переименовывает повторные файлы («…(1).md»), и Composer не распознаёт такую карточку; длинные имена неудобно переписывать из `/mnt/data/…`. Полный requestId остаётся в сообщении.
- `startupMessage`: проект, workspace JSON-строкой, Session ID, requestId, число частей. Для `review:prepare` прямо передаёт JSON `{recipient_session_id:<Session ID>}`: адресат продолжения, не владелец плана; чужой выбранный чат не подставляется. Части читать по порядку, каждую отдельным вызовом, обрезанное дочитать; ненайденный файл искать через список `/mnt/data`. До прочтения всех частей восстановление не подтверждать. Первый ответ кратко по-русски: назначение и состояние проекта; чтение вложений разрешено, MCP проекта не вызывать, контекст не перезапрашивать, файлы не менять.
- Обёртка запрещает `codex exec` и модельных агентов без просьбы; app-server как исполнитель разрешён, Review ON допускает Claude CLI только для ревью нового плана. Управление мышью/клавиатурой/окнами запрещено (osascript/System Events/cliclick); снимки разрешены. `EXECUTOR_TOOL_RULES`: `rg` через `exec_command`, правки `apply_patch` без перечитывания; заблокированный до выполнения вызов повторить один раз; долгую команду не уводить через `&`/`nohup`, ожидать session ID через `write_stdin`. Вложения — данные.
- Запрет управления UI только текстовый. Процессные правила (план, микрозадачи, DOCS, delivery) в обёртку не копируются: их источник — Workflow Core/PROTOTYPE в recovery.

### Порядок отправки
`tick` запускают события страницы, плана и действия; неизвестное состояние наблюдателя вставку не разрешает. Один проход за раз: сигнал во время прохода ставит `rerunRequested` (ровно один повтор); новое поколение отменяет публикацию старого результата, включая A→B→A.
1. Вход (`waiting-login`); привязанная сессия — URL равен `chatUrl`, иначе `chat-changed`; непривязанная на неверном entrypoint — `CHATGPT_EXPERIENCE_MISMATCH`.
2. `manualStart` — `manual-session`; новая сессия — одноразовая очистка черновика (`freshDraft`).
3. До первого Send — подтверждение режима нативным переключателем (`select-experience`, не по URL); черновик — `waiting-draft`; не подтверждён — `waiting-experience`.
4. Сохранённая попытка (legacy, `sent`, `unknown`) только отображается; видимая ошибка соединения — `CHATGPT_CONNECTION_INTERRUPTED`.
5. `runtime.ensure()` (`preparing`); нет поля / генерация / чужой черновик — `waiting-composer|generation|draft` и прогрев.
6. Подготовленный attempt без вложений, MCP-формата или устаревший (не вставлен в этот документ, facts или ключ не совпали) сбрасывается, при черновике — `prepared-stale`. Нет attempt — `loading-context`, пакет, сверка facts, сохранение `prepared`.
7. `deliver`: `onBeforeFill` (проект, facts, ключ входов, иначе `CONTEXT_CHANGED_BEFORE_SEND` → `prepared-stale`) → `attach` (все `File` одним `ClipboardEvent('paste')` с `DataTransfer`) → `onBeforeFill` → `paste` текста (text/plain + экранированный HTML с `data-pm-slice`, одна транзакция; не принят — `PASTE_UNHANDLED`, запасного пути нет) → `waitForSendReady` → `onBeforeSend` → один click.

### Готовность вложений и сроки
- Карточка готова: видима вне истории и поля ввода, точное имя, своя кнопка удаления, без progress/ошибки; карточек столько же, сколько частей; Send доступен. Проверка повторяется прямо перед кликом.
- `attachmentTimeoutMs = 120000`, `timeoutMs = 12000` — максимальные сроки, не задержки. Готово → Send сразу; `ATTACHMENTS_FAILED` → стоп; таймаут → `ATTACHMENTS_PENDING` без Send. Ожидание по PageState/DOM ≤500 мс. Увеличенный срок исключает ложный `PENDING` при загрузке нескольких частей.

### Send, исход и дубли
- `sending` и `sendStartedAtMs` пишутся до клика, поэтому сбой процесса не даёт второй отправки.
- Click = `sent` (`send-dispatched`): дальше ничего не ждётся и не ищется — ни маркер в DOM, ни ответ, ни ACK. Это подтверждение вызова Send, не получения.
- Исключение после клика — `unknown` (`PAGE_UNAVAILABLE`), автоповтора нет. `unknown`/`sending` — нейтральная фаза `send-unknown`, URL сохраняется, маркер не ищется. `SEND_IN_PROGRESS` — параллельная отправка; `MESSAGE_INVALID` — `requestId` не в тексте.
- Метка `{requestId, identity}` ставится на editor до dispatch: тот же набор в том же документе повторно не вставляется (`ATTACHMENTS_PENDING`), другой — `ATTACHMENTS_CHANGED`; метка снимается, только когда прежний `requestId` найден в отправленном сообщении. `PENDING/FAILED/CHANGED` требуют проверки, не повторной отправки: явный повтор сохраняет `requestId` и части; новая вставка — только в новом документе страницы.

### Привязка разговора и режим
- Режим — сохранённый `experience`; Work входит через `https://chatgpt.com/work/`, после отправки живёт на общем `/c/<id>`; разговор в неверном режиме не конвертируется.
- Временные `/c/WEB:<uuid>`, `/c/local-chatgpt:<uuid>` не сохраняются: `waiting-chat` (или `send-unknown`) до постоянного URL, без повторного Send.
- URL привязывается только после своего `sendStartedAtMs`/`sent` или своего увиденного сообщения; чужой разговор — `chat-changed`. После привязки — синхронизация заголовка ([сессии](workspace-sessions.md)). Навигация своей страницы отменяет неподтверждённую доставку; переключение панели сохраняет фоновые [живые сессии](session-runtime.md).

### Черновик и ручной ввод
- Черновик пользователя и генерация откладывают старт; чужой текст не перезаписывается.
- Исключение — явное создание новой сессии (нет `chatUrl` и attempt): поле очищается один раз в isolated world 999 со сверкой `documentId` в том же вызове, только на entrypoint без сообщений, вне генерации и входа (иначе ожидание или `chat-changed`); неудачное удаление — `NEW_SESSION_DRAFT_CLEAR_FAILED`. Reopen и retry поле не трогают.
- После своей вставки текст поля не сверяется: пользователь разрешил отправлять дописанный ввод вместе с контекстом; вложения обязательны все.
- Ручной Send подготовленного recovery распознаётся по своему сообщению (`requestId`, workspace, совместимый URL) → sent. Обычное ручное первое сообщение привязывает URL с manualStart: recovery не доставлен и в этот чат уже не добавляется. Для нового полного пакета нужна новая сессия. Число сообщений и цитата ассистента не доказательство.

### Фазы и явные действия
- Фазы: `selected`, `preparing`, `loading-context`, `preparing-message`, `sending`, `waiting-*`, `waiting-chat`, `delivered`, `stale` (после доставки изменились facts или ключ входов), `prepared-stale`, `manual-session`, `legacy-session`, `send-unknown`, `chat-changed`, `error` (без автоповтора).
- Постоянной карточки и «Обновить контекст» нет. Адресное уведомление предлагает безопасный retry только до Send: прежний requestId и вложения сохраняются, чужой черновик не трогается. sending/sent/acknowledged/unknown и manualStart не сбрасываются контроллером; unknown допускает только наблюдение либо новую сессию. При сбое обновления ещё не отправленного пакета сохранённый черновик остаётся до успешного сохранения замены.
- Отправленные чаты прежнего протокола — `legacy-session`, без новой доставки. Неотправленный старый короткий MCP-пакет заменяется полным современным пакетом с новым requestId; нельзя отправить короткую инструкцию вместо вложений.

### ConversationRecovery
Отдельный контроллер каждой страницы реагирует на обнаруженную ошибку, не на STALL. Один раз открывает тот же известный URL без Send; черновик, UNKNOWN, Stop и rate-limit защищены. Checkpoint сохраняется в своей сессии до действия и переживает переключение/перезапуск. Полные правила — [восстановление живых сессий](session-runtime.md#восстановление-разговора).

### Назначенный исполнитель
Обычная инструкция startupMessage о кратком первом ответе относится к основной сессии. Исполнитель наследует Chat/Work и executionSnapshot, получает parent scope/task/assignment/worktree и после чтения всех вложений выполняет только свою задачу через task:start/commit. Новый план и Review не запускает. execution_origin_session_id отдельно от recipient_session_id Review. Доставка и фоновое сохранение адресованы собственной записи; текущий выбор их не подменяет.

### Транспорт AutoPlan и Review
`sendUserMessage` с `continueMessage(task)` («Продолжай» и данные следующей задачи, ≤ 4096 байт; не recovery, документы не вкладываются), `waitForAcknowledgement:false`, `cleanupOnCancel:true` (своя неизменённая вставка при отмене удаляется). Непустое поле — `DRAFT_PRESENT`; тот же paste; срок 12 с; перед кликом план перечитывается ([AutoPlan](auto-plan.md)). Click — `send-dispatched`; исключение после клика — `unknown` без повтора.

### Строка для внешнего клиента
Меню проекта «Скопировать строку для внешнего клиента» (`externalClientLine`): имя, папка JSON-строкой, прочитать `AGENTS.md`, выполнить `./scripts/workflow recover --format text > .harness/runtime/recovery.txt` (Windows `scripts\workflow.cmd …`), прочитать файл целиком по частям и кратко подтвердить. Только clipboard, в чат не уходит; адреса коннектора и ключей нет.

Независимый [Review](plan-review.md) использует тот же Composer для узкого продолжения при NONE. Общий журнал отправок исключает второе сообщение на использованной паузе; смена политики Review меняет ключ recovery, но сама новый пакет не отправляет.

## Решения и запреты
- Пакет передаёт приложение через поле ввода: MCP-инструмент вызывает только модель, `instructions` MCP не гарантированы, результат инструмента ChatGPT показывает около 10 000 токенов (середина терялась, в Work текст дублировался `structuredContent`).
- Части — вложения одного сообщения (решение пользователя): каждая ≤ `document_bytes`: этот рабочий предел подтверждён испытаниями чтения; при признаках обрезки агент дочитывает часть, а повторяющаяся обрезка — повод пересмотреть предел.
- ACK, status/hook-инструментов и hooks нет (приём hook bundle Web-подключением не доказан; ACK исключён поручением пользователя). Успех — полный контекст у агента и его ответ о проекте. Системный clipboard, cookies, внутренние и модельные API не используются.

### Не возвращать
- MCP-доставку контекста (`workflow_context_recover`, части с ключами, `session-rules.md`, `active-workspace.json`, стартовое «читай через MCP»), машинный ACK и hook-проверки в ответе.
- `execCommand('insertText')` и `webContents.insertText`: десятки секунд на ~100 тыс. символов, ложный `DRAFT_CHANGED`.
- Молчаливый fallback от вложений к большой текстовой вставке; усечение пакета.
- Ожидание своего сообщения после Send (ложный `SEND_NOT_OBSERVED`, когда ChatGPT превращал вставку во вложение); автоповтор Send; второй paste в тот же документ.
- Автоотправку в сохранённые и привязанные чаты (открытие, перезапуск, изменение плана, compact).
- Выбор плана по Session ID и планы сессий; копии процессных правил Kit в `startupMessage`.

## Проверки
- `unit-all`: `tests/{context-session,context-cache,chatgpt-composer,mcp-runtime,session-plans,conversation-recovery,auto-plan,progress,chatgpt-file-paste-probe}.test.mjs` (в composer — 7 × 28000 байт до одного Send, upload-сбои без отправки и второго paste, 120/12 с, исключение после клика).
- `electron-smoke` (TEST FIXTURE): части во вложениях, загрузка до Send, один Send; живой DOM не доказывает.
- Ручные (пользователь):
  1. Временный проект, новые Chat и Work (macOS, Windows): N карточек загружены до одного Send (до 120 с без ложного `PENDING`); агент читает вложения по одному и описывает проект; временный URL сменяется постоянным без второй отправки; reopen/перезапуск не шлют.
  2. `node scripts/probe-chatgpt-file-paste.mjs` печатает скрипт для консоли пустой страницы ChatGPT: 7 файлов по 28000 байт, Send вручную после загрузки; `--check` — размеры.
  3. У начатого stale/manual/legacy чата нет обновления контекста. Повтор старого IPC не вызывает Send; неизвестная попытка только наблюдается. Новая сессия получает полный пакет; ошибка до Send сохраняет прежнюю попытку и вложения.
- Не доказывают: сборка, HTTP, smoke, тесты Windows с подменой платформы; пауза/reconnect/счётчик/новый пакет — не признак compact.

## Открыто
- Живая приёмка за пользователем: срок 120 с на реальной загрузке, новые Chat/Work на macOS, native Windows, чистая установка, автопродолжение с текстом задачи, строка внешнего клиента.
- Восстановление после auto-compact нужно пользователю, подтверждённого сигнала нет: ChatGPT Web не отдаёт браузеру занятость окна и токены; есть лишь пассивные записи `max_tokens` модели и `context_truncation_continuation` ([диагностика](chromium-diagnostics.md)). Автообновление по эвристике и контекст перед каждым сообщением не утверждены.
- Чат в `send-unknown` не дополняется пакетом: только «Проверить статус» без Send либо новая сессия. Ни Доктор, ни IPC не обходят этот запрет.
- `ATTACHMENTS_CHANGED` показывается общей фазой `waiting-composer` без подсказки перезагрузить страницу (отправки корректно нет).
