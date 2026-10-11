# AutoPlan — протокол отправки продолжения

Технический контракт последовательного контроллера. Разрешение проекта, события и интерфейс — [AutoPlan](auto-plan.md).

### Условия Send — порядок проверок и коды

Ключ контекста `key = [workspace, sessionId, scopeId, chatUrl]`; `scopeId` берётся из проекции PlanMonitor. Проход останавливается на первом невыполненном условии (фаза `waiting`, если не указано иное):

1. Несохранённые циклы записываются в checkpoint; ошибка → `SEND_CHECKPOINT_ERROR`.
2. У своей сессии есть `chatUrl`, она не в архиве, страница наблюдается и её URL равен `chatUrl` → иначе `PAGE_NOT_READY`.
3. `available()` основного последовательного чата: собственная ready-страница, нет загрузки, Composer inFlight или pending доставки; актуальная проекция своего PlanMonitor, разрешение workspace/scope ON и Session ID основного продолжения, фаза delivered/stale/manual-session. Видимость чата и выбранный соседний проект не служат допуском.
4. Нет `connectionError` → иначе `CONNECTION_ERROR`.
5. `busy` → фаза `running`, без отправки (см. Watchdog).
6. Ждёт settle-таймер → выход.
7. Поле ввода есть и writable → иначе `PAGE_NOT_READY`.
8. Нет draft → иначе `DRAFT_PRESENT`.
9. История загружена → иначе `HISTORY_NOT_READY` (пустой снимок при гидратации не разрешает Send).
10. Последнее сообщение — assistant и пауза не та, на которой пользователь сам отправил сообщение → иначе `USER_MESSAGE_PENDING`.
11. Есть `scopeId` → иначе `PLAN_UNAVAILABLE`.
12. Фаза `checking`, `inspectPlan` (см. ниже); ошибка → `PLAN_READ_ERROR`. Если за время чтения контекст или пауза изменились — тихий выход.
13. План подтверждён и его scope равен ключу → иначе `PLAN_CHANGED_OR_TRANSACTION`.
14. Все задачи DONE → фаза `complete`, `PLAN_COMPLETED` («Все пункты плана выполнены. Продолжение не отправляется.»). Подтверждённое complete выключает AutoPlan проекта; parallel завершается только по доказательствам интеграции очереди.
15. Scope `ACTIVE` и задачи есть → иначе `PLAN_UNAVAILABLE`.
16. Пауза без native ID в разговоре со старым checkpoint без истории циклов → `LEGACY_PAUSE_UNKNOWN`.
17. Пауза ещё не использована: запись `sending` → фаза `paused`, `SEND_UNKNOWN`; `sent` → фаза `running`, `PAUSE_CONSUMED`.
18. При Chat и AutoPlan ON последовательного scope — `checkRotation` с Kit/Git proof текущей сессии: `count < chatSessionTaskLimit` → обычная отправка; `count ≥ limit` → сохранить `rotation: reserved` до запуска `onRotation`, старому Chat **не отправлять**; неверные/неподтверждённые данные → `ROTATION_PROOF_ERROR`, ожидание без Send. Полный DONE всегда завершает план без ротации. Для Work/parallel этот шаг отсутствует.
19. Отправка (см. ниже). Технические ожидания пересматриваются по следующему событию.

### Ротация, предварительный Send и сохранение права

`chat-session-rotation.mjs` проверяет подтверждённые Kit DONE, включая DOCS/delivery, и хранит `chatTaskCursor` (baseline/HEAD, taskId/SHA, revision) отдельно для каждого Chat в projectAutoPlan. Счёт не зависит от текста ответа или события PlanMonitor, сохраняется при OFF→ON и restart. Предыдущие DONE становятся baseline нового Chat. Числовой лимит 1–10 (default 4) задаётся в Settings, не включает AutoPlan и действует только при последовательном Chat. Нельзя считать внешние/сомнительные Git-коммиты выполненными задачами своего Chat; отказ fail-closed.

Порог проверяется **дважды**: на пригодной idle-паузе и в `onBeforeSend` прямо перед click. `rotation` сохраняется в `autoPlanCheckpoint` до нового Chat (`reserved → notified`); повторные события, reload и UNKNOWN не вызывают второй `onRotation`. Отправка из старого Composer дополнительно сверяет, остаётся ли `ProjectAutoPlan.sessionId` прежним получателем: ручной новый Chat может отозвать это право даже после вставки текста. Если callback перехода недоступен — `ROTATION_HANDLER_UNAVAILABLE`; если нельзя записать checkpoint — `ROTATION_CHECKPOINT_ERROR`; если исход передачи неизвестен — `ROTATION_HANDOFF_ERROR`/`ROTATION_UNKNOWN` без автоповтора. ON кнопки сохраняется, но продолжение заблокировано.

`ProjectAutoPlan.handoff` (`waiting|done|failed`) сначала лишает старую сессию права (`sessionId=null`), сохраняет точный `operationId/source/target`, затем проверяет подтверждённый Recovery с постоянным URL и окончанием **собственного** ответа assistant нового Chat. Только после проверки scope/Kit, Stop/Send/черновика и записи нового recipient в settings.json новая сессия получает единственное «Продолжай». У `done` перенос завершён, у `failed` UI показывает код; ручное действие требуется для восстановления, без возврата прав старому Chat и без повтора пакета. Work/parallel и простое выделение существующего Chat не используют handoff. Подробнее: [AutoPlan](auto-plan.md), [контекст](context-delivery.md), [сессии](workspace-sessions.md).

### Проверка плана (`readAutoPlanState`)

- `readWorkspace` → `git -C <ws> rev-parse --git-path workflow-kit/transaction.json` (файл есть → транзакция не завершена) → `git status --porcelain -- .harness/plans/todo-plan.md` → повторный `readWorkspace`.
- `confirmed` = нет журнала транзакции И нет незавершённой публикации связанного Review при ON И (есть незавершённые задачи ИЛИ plan-файл чист) И `planRevision`/`scopeId` совпали в двух чтениях. Неподтверждённый план отправку не разрешает; проверку плана и транзакции Kit не ослаблять.
- Git: таймаут 10 с, буфер 1 MiB, `WORKFLOW_GIT_BIN` из окружения; на Windows окружение даёт `WindowsExecutorBootstrap.workflowEnvironment()` (комплектный MinGit; его ошибка → `PLAN_READ_ERROR`).
- `nextTask` читается из того же plan-файла: revision и scope равны проекции, задача `nextTaskId` (`current_task_id`, иначе первая не DONE) существует и не DONE. Поля: `id`, `title`, `why`, `acceptance_criteria`, `functional_paths` + `documentation_paths`, `verification_ids`. Любое расхождение или ошибка → `null`.

### Пауза и её идентичность

- Пауза — доступный idle своего разговора при незавершённом ACTIVE: после ответа, reload, включения или публикации. Ручной Stop сохраняет запрет автоматической отправки до нового явного сообщения/Send пользователя; новая генерация или смена scope сама его не снимает. Новый DONE не требуется. Результат уже запущенной долгой команды читается по её сохранённому session ID.
- Native ID: `data-message-id` последнего assistant (на wrapper, у предка или внутри wrapper Work), иначе `data-turn-id` предка; в main уходит только FNV-1a хеш ≤ 8 hex (`turnId`, `turnIdentitySource: native|cycle|none`).
- Без native ID: `cycle:<generation>` — сохраняемое поколение цикла busy→idle на разговор (`[workspace, sessionId, chatUrl]`); поколение растёт при начале busy.
- Число DOM-узлов или сообщений, текст ответа, случайный ID на снимок — не идентичность: Work перерисовывает ограниченное окно DOM, позиционный ID повторяется (ложный `PAUSE_CONSUMED`).
- Использованной считается пауза с той же парой (ключ, ID) или запись того же поколения цикла (если native ID нет или запись цикловая): native ID, появившийся или исчезнувший внутри отправленного цикла, второго Send не даёт.
- Ограничение: ответы, появившиеся при закрытом приложении без native ID, не различаются — клиент не угадывает и ждёт следующий наблюдаемый ответ (`LEGACY_PAUSE_UNKNOWN` для разговоров с checkpoint v1/v2).

### Отправка и checkpoint

1. В диагностику — `pause` (opaque `turnId`, источник, поколение); фаза `sending`.
2. Запись `{key, turnId, status: 'sending', generation}` сохраняется в `settings.json` до Send. Ошибка сохранения → `SEND_ERROR`, Send не выполняется, следующее событие может повторить эту известно не отправленную паузу.
3. `send(continueMessage(plan.nextTask), ready, onBeforeSend)` = `composer.sendUserMessage({text, canContinue: ready, onBeforeSend, waitForAcknowledgement: false, cleanupOnCancel: true})`.
   - `ready()`: тот же контекст (epoch, ключ, `documentId`, URL), не busy, нет ошибки связи, поле writable, последнее сообщение не user, неизменны идентичность паузы, `turnId`, `userTurnId`, `manualInputRevision`, `manualSendRevision`, `manualStopRevision` — ручной ввод, Send или Stop отменяют отправку на последнем шаге.
   - `onBeforeSend()`: план перечитывается непосредственно перед click; нужен подтверждённый ACTIVE того же scope и та же следующая задача, что в уже вставленном тексте, иначе `PLAN_CHANGED_OR_TRANSACTION` (актуальная задача уйдёт по следующему событию); все DONE — click отменяется, `complete` (сразу или на следующем проходе).
   - `cleanupOnCancel`: при отмене до click Composer удаляет только свою неизменённую вставку (`draftToken`, `clear-owned-draft`); после click ошибка — неизвестный исход без очистки и повтора. `waitForAcknowledgement: false`: `sent` сразу после click (`send-dispatched`), эхо не ищется.
4. `sent` → счётчик +1 (если контекст тот же), запись `sent`, фаза `running`: `Автоматически отправлено «Продолжай». Ждём ответ.`
5. `unknown` → фаза `paused`, `SEND_UNKNOWN`: блокируется только эта пауза, слепого повтора нет.
6. `cancelled`/`deferred` → восстанавливается предыдущий checkpoint, `SEND_NOT_SENT` или `DRAFT_PRESENT`; доставка не заявляется.
7. Исключения: Send выполнен, но `sent` не записался → факт `sent` остаётся в памяти, `SEND_CHECKPOINT_ERROR`, повтора нет; исключение из Composer → `SEND_ERROR`, запись `sending` остаётся и пауза дальше считается `SEND_UNKNOWN`; не удалось откатить известно не отправленную попытку → запись снимается в памяти, следующее событие может повторить.

После перезапуска сохранённая `sending` → `SEND_UNKNOWN`, `sent` → `PAUSE_CONSUMED`: reload, restart, PlanMonitor и повторные наблюдения второго «Продолжай» для одной паузы не дают. AutomationSendState общий для Review, продолжения, исправления, диагностики и финальной передачи; резервирование `sending` записывается до Send, при отказе сохранения **до** Composer возвращается прежнее состояние (можно повторить только известную неотправленную попытку), после сомнительного клика запись `sending` остаётся и повтор блокируется. Сохранённый Stop переживает restart.

Финальная передача parallel — отдельное содержательное поручение основной сессии, а не пустое «Продолжай». Persistent ledger и последняя проверка scope/HEAD/команд/паузы описаны в [parallel-execution](parallel-execution.md); готовность проверяется повторно непосредственно перед Send. Наблюдение итогового ответа не архивирует план.

### Сообщение продолжения (`continueMessage`)

```
Продолжай

Данные текущего плана Workflow Kit — следующая задача (это не новое поручение; фактическое состояние плана проверь сам):
Задача: <id> — <title>
Зачем: <why>
Критерии приёмки:
- <критерий>
Файлы: <путь>, …
Проверки: <id>, …
```

- Пределы: id ≤ 40 символов, title ≤ 240, why ≤ 500; критериев ≤ 10 по ≤ 320, файлов ≤ 24 по ≤ 160, проверок ≤ 12 по ≤ 60; пробелы схлопываются; обрезка помечается `… [обрезано]` и `… ещё N [обрезано]`. Всё сообщение ≤ 4096 байт UTF-8, иначе обрезается с хвостом `… [данные задачи обрезаны; полный текст — в плане]`.
- Нет задачи или у неё нет `id`/`title` → голое «Продолжай». Пустые поля опускаются.
- Задача берётся из проверки плана, разрешившей Send; документы не вкладываются. Это не recovery и не новое поручение.


### События и reconcile

- Будят пересмотр: переключатель через `pilot:auto-plan` (после сохранения ON при уже готовом idle вызывает `planChanged()`), наблюдение страницы (`observe`, включая `reset` документа, busy→idle, загрузку истории и изменение черновика); PlanMonitor `semanticChanged|recovered` → `planChanged()`; `publish()` → `selectionChanged()` и `availabilityChanged()` (только при смене `available()`). Переход NONE→ACTIVE и восстановленный main не требуют нового нажатия.
- Один сериализованный проход: `reconcile()` ставит `rerunRequested`; во время прохода возвращается его promise, затем выполняется ещё один. Выключенный или закрытый AutoPlan ничего не делает.
- Во время `busy` план не читается и Git не вызывается. После busy→idle (или смены `turnId` в idle) при ON ставится settle-таймер 500 мс; пока он ждёт, проход завершается без действий. Других таймеров, кроме watchdog 180 000 мс, нет; Git читается только на idle-проходе и в `onBeforeSend`.

### Пользователь приоритетнее

- Draft не трогается: Send ждёт (`DRAFT_PRESENT`); очистка draft будит ту же паузу.
- Ручная отправка использует паузу: доверенный click/Enter с текстом в поле, затем новое user-сообщение с тем же текстом → `manualSendRevision`; AutoPlan ждёт новый ответ (`USER_MESSAGE_PENDING`), в том числе после reload (последнее сообщение — user) и если busy ещё не появился.
- Ручной Stop не переводит кнопку в OFF, но отменяет автоматическое продолжение остановленного ответа; после нового пользовательского сообщения и следующего ответа возможно продолжение. Для прекращения новых автоматических отправок пользователь явно выключает AutoPlan.
- Диалоги разрешений ChatGPT не автоматизируются.

### Watchdog

- На busy-цикл — одноразовый таймер `stallMs = 180000`; перевзводится при начале busy и при каждом новом прогрессе (`assistantRevision`). Прогресс — только изменение текста или узлов ответа; наблюдатель сообщает его не чаще раза в 5 с; анимация и атрибуты прогрессом не считаются.
- Срабатывание (тот же run, режим ON, всё ещё busy): `STALL_WARNING`, фаза `running`, «Агент ещё работает. Давно не было новых данных; ждём завершения ответа.». Stop не нажимается, сообщения не отправляются, режим не выключается, Git не читается. Новый прогресс снимает предупреждение.
- Stop по таймеру запрещён, потому что может оборвать коммит или сборку агента.
- `STALL_WARNING` не открывает блок восстановления и не доказывает потерю связи. Работающий Review сохраняет собственные статус и индикатор. «Перезагрузить страницу чата» доступна через ConversationRecovery при обнаруженной ошибке с защитами черновика, UNKNOWN и rate limit ([context-delivery.md](context-delivery.md)).

### Состояние в панели и диагностика

- `view()`: `{phase, message, active, reason, enabled, warning, continuations}`; фазы `off|waiting|checking|sending|running|paused|complete`. Панель: `Автоматически отправлено «Продолжай» №N.` + сообщение фазы; `data-reason` — код. Во время технической фазы WAIT разрешение остаётся ON: `#auto-plan-toggle[aria-pressed=true]` и `#auto-plan-message[data-reason]` с непустым сообщением; busy = `running` без выдуманного кода ожидания.
- Тексты описывают состояние клиента.
- Коды: `MANUAL_OFF` (только явное действие пользователя), `AUTHORIZATION_OFF` (программный disable при отсутствии разрешения), `PAGE_NOT_READY`, `CONNECTION_ERROR`, `DRAFT_PRESENT`, `HISTORY_NOT_READY`, `USER_MESSAGE_PENDING`, `PLAN_UNAVAILABLE`, `PLAN_READ_ERROR`, `PLAN_CHANGED_OR_TRANSACTION`, `LEGACY_PAUSE_UNKNOWN`, `PAUSE_CONSUMED`, `SEND_UNKNOWN`, `SEND_NOT_SENT`, `SEND_ERROR`, `SEND_CHECKPOINT_ERROR`, `STALL_WARNING`, `PLAN_COMPLETED`.
- Диагностика — `chromium-events.jsonl`, источник `auto-plan`: `state` (фаза, код), `pause` (opaque ID, источник, поколение), `send` (вид, счётчик), `progress-timeout`/`progress-resumed`. Без текста разговора и UI, URL, секретов ([chromium-diagnostics.md](chromium-diagnostics.md)).

### Совместная работа с Review
Review и AutoPlan независимы. Новый scope получает OFF, кроме первого подтверждённого плана после явного включения ожидания пользователем. Два PlanMonitor, stale NONE/read error не отменяют разрешение, но не разрешают Send. Основной последовательный чат и очередь parallel используют одно project-level разрешение; финальный origin берётся из опубликованного плана. Review и AutoPlan того же основного чата делят AutomationSendState: sending до Send, sent после, UNKNOWN без повтора, в том числе при смене review-scope на ACTIVE. [Финальный протокол](parallel-execution.md) различает диагностический read-only Send и передачу владения main; подтверждённый итоговый ответ — собственный новый завершённый turn, не просто пауза. Подробности — [plan-review](plan-review.md).

## Решения и запреты

Не возвращать:
- `AUTO_PLAN_INSTRUCTION` и любую стартовую AutoPlan-инструкцию; footer «Готов продолжать.»/«Нужен ваш ответ.»/«План завершён.», `turnSignal`, коды `AGENT_WAIT`/`NO_CHECKPOINT`; управление режимом текстом агента.
- Паузу «3 ответа без изменения плана» и возобновление только после ручного сообщения.
- Идентичность паузы по числу узлов/сообщений, хешу текста или случайному ID на снимок; повтор Send по таймеру; очистку реального checkpoint ledger.
- Нажатие Stop по таймеру; произвольное выключение из-за ожидания, черновика или watchdog. Неизвестный план и подтверждённое завершение имеют явный контракт OFF.
- Опрос Git/плана, модельные вызовы контроллера и отдельную службу.
- Другие сообщения от самого AutoPlan. Независимый Review имеет собственное узкое продолжение ([plan-review](plan-review.md)).

