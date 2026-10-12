# Текущий план в панели

Read-only показ current plan checkout (`.harness/plans/todo-plan.md`) в карточке «Текущий план проекта» для выбранной сессии и событийное обновление этой проекции (`PlanMonitor`, `ProjectInputWatch`). Модуль не меняет план (это делает агент через Workflow Kit), не доставляет recovery ([context-delivery.md](context-delivery.md)) и ничего не отправляет в ChatGPT ([auto-plan.md](auto-plan.md)).

## Код

При выборе назначенного исполнителя Web Pilot скрывает общий план и кнопки его управления; карточка назначения показывает только название и состояние его задачи. В основном чате parallel-проекция заменяет устаревший TODO основного checkout статусом назначения и готовности к интеграции. Локальное DONE не подтверждает общий DONE. Parallel-проекция проверяет Git через Kit и скрывает staged DONE без source/integration SHA; обычный readWorkspace остаётся быстрым data-only чтением. Состояния исполнителей и очередь — [parallel-execution](parallel-execution.md).

- `src/workspace-session.mjs` — `readWorkspace(workspace, sessionId)` (data-only разбор плана), `projectPlan` (→ `planView`), `readScopeTitle`; `WorkspaceSessions.inspect`.
- `src/plan-monitor.mjs` — `PlanMonitor` (`observeSelection`, `refresh`, `tick`, `view`, `invalidate`, `close`).
- `src/project-input-watch.mjs` — `ProjectInputWatch` (`update`, `refresh`, `signal`, `close`).
- `src/main.mjs` — создание `PlanMonitor`, реакции `onChange`/`onInputsChanged`/`onError`, `snapshot()` (проекция и `planReadError` в `selected`), `refresh()` при навигации и фокусе окна, `invalidate()` в `nextNavigation()`.
- `src/ui/index.html` (`#plan-card`), `src/ui/sidebar.mjs` (отрисовка карточки).

## Контракт

### Один current plan на checkout (решение пользователя)

- Один Git checkout/worktree = один current plan. Все сессии проекта — старые и новые Chat/Work — показывают одни и те же scope, revision и задачи; `sessionId` на результат не влияет. Независимая параллельная работа — отдельная ветка/worktree со своим `todo-plan.md`. Модель «у каждого чата свой план» пользователь признал архитектурной ошибкой.
- Сессия — только разговор и навигация ([workspace-sessions.md](workspace-sessions.md)). Legacy-поля `planId`, `originSessionId`, `legacyPlanId`, `planBinding` читаются, но план не выбирают.
- Задач в `workspaces.json` нет: `save()` отбрасывает `planView`, `preparedPlans`, `unassignedPlans`, `scopeTitle`. Скалярные поля последней проекции и `watchInputs` в запись проекта попадают (расхождение — [workspace-sessions.md](workspace-sessions.md) § Открыто); снимок для UI (`snapshot()`) убирает и `watchInputs`.
- Подготовленных/привязанных планов нет: в Kit `plan:prepare`/`plan:bind`/`plan:adopt` → `COMMAND_REMOVED` ([workflow-kit-package.md](../../packages/workflow-kit/docs/modules/workflow-kit-package.md)). Прошлый план читается из Git (родитель коммита закрытия), отдельного просмотра нет.

### Чтение плана (`readWorkspace`)

- Вход — абсолютный путь (иначе `WORKSPACE_REQUIRED`), берётся `realpath`. Нужны `.harness/plans/todo-plan.md` и `scripts/workflow.mjs`, иначе `WORKFLOW_NOT_INSTALLED`.
- Разбирается JSON между `<!-- workflow-state:begin -->` и `<!-- workflow-state:end -->`. Требуются `schema_version: 1`, непустой `project_id`, строка `project_name`, целый `plan_revision`, массив `tasks`; у задачи — `id`, `title`, `implementation_status ∈ TODO|IN_PROGRESS|DONE`, `commit_status ∈ PENDING|DONE`. Нарушение → `WORKFLOW_PLAN_INVALID`.
- Только данные: JS из папки проекта не импортируется и не запускается, Kit CLI не вызывается, статусы не меняются, потому что проекция показывается до полной проверки проекта и должна быть быстрой и безопасной ([session-opening-performance.md](session-opening-performance.md)).
- Выход: `projectId`, `name`, `planRevision`, `scopeId` (= `planId`), `scopeTitle` (H1 первого required-документа `docs/planning/*.md`, затем `docs/modules/*.md` из `context_pack`), `objective`, `scopeStatus`, `deliveryStatus`, `archivedScopeId`, `nextTaskId`/`nextTaskTitle` (`current_task_id`, иначе первая с `commit_status` ≠ DONE), `planView`, `watchInputs` (пути `docs/…` из `context_pack` плана и задач, без `..`), `inspectedSessionId`; для совместимости `preparedPlans: []`, `unassignedPlans: []`, `originSessionId: null`.
- `planView = {state, completed, total, tasks: [{id, title, status}], blockedReason}`. Статус задачи: `commit_status DONE` → `done`; `IN_PROGRESS` → `current`; иначе `pending`.
- `state`: `BLOCKED` → `blocked` (с `blocked_reason`); `ACTIVE` + `READY_FOR_ACCEPTANCE` + все задачи `done` (задач > 0) → `awaiting-acceptance`; прочий `ACTIVE` → `working`; не ACTIVE с `archived_scope_id` → `closed`; иначе `not-created`.
- `planRevision` нужен для свежести пакета и проверки AutoPlan; в карточке плана не выводится. Сведения о доставленном пакете находятся в Settings. Каждая строка задачи разделяет ID, название, запланированный способ выполнения и текущий статус. plannedExecution показывает последовательную задачу, независимую, исключительную либо «после …» по зависимостям; это не фактический RUNNING/DONE. Заголовок задачи не разбирается для определения статуса.

### PlanMonitor

- Data-only проекция выбранного проекта: не зависит от браузера, доставки, MCP и readiness; recovery не шлёт, Kit не вызывает.
- `observeSelection()` вызывается на каждом `publish()`. При смене ключа выбора (workspace, projectId, sessionId) — новое поколение, закрытие прежнего watcher, создание `ProjectInputWatch` (сначала наблюдение, затем чтение), затем `tick()`.
- `tick()`: один проход за раз; сигнал во время прохода ставит `rerunRequested` → ещё один проход. Поколения отбрасывают поздние результаты при смене выбора и после `invalidate()` из навигации (включая A→B→A); результат чужой сессии/проекта не принимается.
- Чтение: до двух повторов через 25 и 100 мс, затем `PLAN_READ_FAILED` (сообщение ≤ 500 символов) → `onError`. Последняя корректная проекция остаётся на экране вместе с ошибкой; бесконечного повтора нет; следующее успешное чтение даёт `recovered`.
- После чтения `watcher.update(info.watchInputs)`: если набор входов изменился — ещё один проход, чтобы закрыть окно между первым чтением и регистрацией нового документа.
- `onChange(info, {semanticChanged | recovered | initial})` — только при смене сигнатуры проекции (scope, заголовок, objective, revision, статусы, следующая задача, `planView`), без повторных уведомлений.
- Реакции main: `publish()`; `semanticChanged`/`recovered` → `autoPlan.planChanged()`; `semanticChanged` вне загрузки/подготовки/Настроек → `controller.tick()`; сигнал входов при тех же условиях → `controller.projectChanged()` (прогрев ContextCache и признак устаревшего пакета — [context-delivery.md](context-delivery.md)). Изменение плана recovery не отправляет. Сигнал входов также обновляет PlanReviewClient; ReviewContinuation отдельно реагирует на поколение review state.
- `refresh()` — при навигации (открытие, перезагрузка) и фокусе окна: явное перевооружение watcher (сброс счётчика повторов), сигнал входов, `tick()`. `close()` — при закрытии окна.
- `view(selected, fallback)`: из проекции PlanMonitor и проекции контроллера доставки (`controller.state.projectInfo`) того же scope показывается более новая revision, иначе — PlanMonitor. Карточка отделена от контроллера чата, потому что при общей привязке UI залипал на раннем плане после отмены контроллера навигацией.

### ProjectInputWatch

- Следит не за Git-деревом и не за всем `.harness/plans/`, а за именованными файлами: `fs.watch` их каталогов (нерекурсивно, `persistent: false`) по цепочке до корня workspace и его родителя — поэтому удалённый или заменённый workspace перевооружается.
- Постоянные входы: `.harness/plans/todo-plan.md`, `scripts/workflow`, `scripts/workflow.mjs`, `scripts/workflow.cmd`, `.harness/workflow.json`, `.harness/kit-manifest.json`, `.harness/runtime/plan-review/state.json`; плюс `watchInputs` плана (документы `context_pack`, в том числе источник H1 для имени scope).
- Событие с именем входа, без `filename` или с именем самого каталога → сигнал; debounce 20 мс → перевооружение и `onSignal`.
- Идентичность каталога `dev:ino`: каталог, заменённый новым inode, наблюдается заново (`fs.watch` может остаться на unlinked inode).
- Ошибка наблюдения (кроме `ENOENT`/`ENOTDIR`) → `PLAN_WATCH_FAILED` «Автообновление проекта недоступно (<код>). Повторите проверку или вернитесь в окно проекта.»; ограниченные повторы через 25 и 100 мс, затем ожидание явного `refresh` (выбор, фокус, навигация). Успешное перевооружение снимает ошибку.
- `fs.watch` только сигнализирует о перечитывании; данные плана берутся чтением файла. Неизвестное состояние watcher вставку и Send не разрешает: ContextSession сверяет отпечаток входов, AutoPlan — подтверждённый план. Полный паритет на сетевых ФС не заявляется.

### Карточка «Текущий план проекта»

- Видна при выбранном проекте; `aria-live="polite"`. В заголовке справа — таймер агента `#agent-time` (`role="timer"`, [workspace-sidebar-ui.md](workspace-sidebar-ui.md)).
- Заголовок `#plan-title` — `objective`; скрыт без `scopeId`.
- Статус `#plan-status` (`data-state`):

| `state` | Текст |
|---|---|
| `working` | «В работе · X из N выполнено» |
| `blocked` | «План заблокирован · X из N выполнено» |
| `awaiting-acceptance` | «Все N задач выполнены» (склонение по N) |
| `closed` | «Scope завершён и архивирован» + примечание «Проект готов к следующему новому плану.» |
| `not-created` | «План ещё не создан» (одно сообщение) |

- `#plan-reason`: сообщение ошибки чтения/наблюдения (`PLAN_READ_FAILED`, `PLAN_WATCH_FAILED`) важнее `blocked_reason`.
- `#plan-tasks` («Микрозадачи плана»): все задачи по порядку плана, метки `✓` done / `●` current / `○` pending, текущая выделена фоном; показывается только название — без id, revision и слов «Revision/версия».
- Известное ограничение последовательной проекции базы 0.6.112, переизданной как 0.6.115: `projectPlan` читает `commit_status` рабочего файла, а Kit записывает DONE кандидата до запуска pre-commit проверок. Поэтому галочка может появиться при незавершённой транзакции. При обычном отказе Kit восстанавливает исходный план; при прерывании нужен штатный repair. Галочка не доказывает успешный коммит: он подтверждается Kit/Git после проверок. Подтверждённая parallel-проекция интеграции имеет отдельную проверку истории; этот дефект здесь не исправляется.
- Под задачами — независимые AutoPlan ([auto-plan.md](auto-plan.md)) и Review ([plan-review.md]), доступные при NONE. Обе кнопки зелёные при ON, обычные при OFF, с aria-pressed и названием действия. У Review рядом стадия, раунд и индикатор работы/успеха/внимания.

### Завершение плана и приёмка

- После всех DONE Kit оставляет план в `READY_FOR_ACCEPTANCE`; карточка показывает «Все N задач выполнены» и все `✓`. Web Pilot ничего не отправляет, сессию не создаёт, план не архивирует и выбор Chat/Work не предлагает.
- Закрытие — только по явному поручению пользователя, означающему приёмку: агент выполняет `archive` Kit. Готовность к приёмке закрытие не разрешает. После архива план — NONE, новый scope автоматически не создаётся; карточка — `closed`.
- Новые задачи добавляет агент через Kit (`plan:extend`, `plan:create`) по поручению в разговоре; оценка результата — часть диалога, не кнопка.

## Решения и запреты

Не возвращать (решения пользователя):
- Кнопку «Принять» (`#accept-plan`, `planAcceptance`, «Принять и завершить / Принять и продолжить»), переход после scope (`continueAfterScope`, `scopeTransition` — старое поле store только проверяется и удаляется миграцией) и автовопрос «План закрыт. Открыть новую сессию?».
- Кнопку «+ Задача» и любой параллельный менеджер задач / `TODO.md`.
- Планы сессий: «План этой сессии», «План следующей сессии», «Создать сессию с этим планом», карточки `prepared-card`/`plan-origin`, prepared-plan IPC, `fromPrepared`, bind/adopt; HTML-прототип навигации планов как отдельное приложение.
- Revision в карточке плана.
- Опрос плана по таймеру и наблюдение всего Git-дерева.
- Привязку карточки к контроллеру доставки чата.

## Проверки

Автоматические (id из `.harness/workflow.json`):
- `unit-all`: `tests/workspace-session.test.mjs` (`planView` без revision; старые и новые сессии видят один план; legacy-метаданные не выбирают план), `tests/plan-monitor.test.mjs` (без повторных уведомлений и вызовов доставки; поздние результаты; ограниченные повторы и `PLAN_READ_FAILED`; схлопывание сигналов), `tests/project-input-watch.test.mjs` (именованные входы и H1, атомарная замена плана, Git-дерево игнорируется, удаление/возврат каталога, `PLAN_WATCH_FAILED`, A→B→A), `tests/sidebar.test.mjs` (один план для выбранного чата, нет `prepared-card`/`plan-origin`, таймер).
- `electron-smoke`: `tests/electron-smoke.mjs` — NONE → «План ещё не создан» без заголовка; ACTIVE → «В работе · 1 из 3 выполнено», метки и названия; нет revision; `awaiting-acceptance` со всеми `✓`; `#accept-plan` отсутствует; завершение ничего не отправляет.

Ручные: в реальном проекте коммит агента обновляет карточку без перезагрузки; после ошибки наблюдения фокус окна восстанавливает обновление; тексты `blocked`, `closed` и «Все N задач выполнены» на живых планах (тестами текст не сверяется, только `data-state`).

## Решения
- Предложение новой сессии Chat/Work после архивирования плана снято решением пользователя: после архива карточка показывает «Проект готов к следующему новому плану.», новая сессия — «Новый Chat»/«Новый Work» в меню проекта. Архивирование — только по поручению пользователя.
- Статус задачи читается экранным диктором: метка `✓/●/○` — `role="img"` с `aria-label` «выполнена»/«текущая»/«не начата». Итог READY_FOR_ACCEPTANCE согласуется с числом: «Задача выполнена», «Все 2 задачи выполнены», «Все 21 задача выполнена», «Все 5 задач выполнены».

## Открыто

- Read-only просмотр исторического плана чата — «если понадобится»; сейчас прошлый план читается из Git.
