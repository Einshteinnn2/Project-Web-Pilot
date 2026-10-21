# Быстрое открытие сессии

Как Web Pilot открывает сохранённую сессию: сначала быстрая проекция плана и загрузка сохранённого URL, полная проверка проекта — в фоне в отдельном процессе, её результат кэшируется в памяти по отпечатку входов. Модуль задаёт порядок, поколения и пределы этого пути; создание и установка проекта — [workspace-setup.md](workspace-setup.md), сборка и отправка пакета — [context-delivery.md](context-delivery.md), данные сессий — [workspace-sessions.md](workspace-sessions.md).

## Код

- `src/main.mjs` — `openConnectedSession`, `selectWorkspace`, `navigate`, `attachController`, `nextNavigation`/`navigationCurrent`, `reviewWorkspace` (строгий путь), `registerAction` (`AsyncLocalStorage` поколения действия; навигационные IPC вне общей очереди).
- `src/workspace-session.mjs` — `readWorkspace` (data-only чтение плана), `selectSession` (чтение вне очереди мутаций, поколение выбора), `mutate`/`save` (проверка поколения до `rename`).
- `src/workspace-setup.mjs` — `WorkspaceSetup.ready`, `invalidateReadiness`, `preview`/`apply`; `src/workspace-readiness.mjs` — `WorkspaceReadiness`.
- `resources/workspace-setup-worker.mjs` — действия `fingerprint` и `inspect` в отдельном Node-процессе.
- `packages/workflow-kit/src/lib/inspection-inputs.mjs` — `inspectionInputs` (отпечаток); `packages/workflow-kit/src/lib/git.mjs` — общий Git-фасад Kit.
- `src/context-inputs.mjs` — `readinessContextKey` (ключ кэша пакета из readiness); `src/context-cache.mjs` — `ContextCache`.

## Контракт

**Вход:** канонический workspace, сохранённый `projectId`, выбранный `sessionId`, поколение навигации. **Выход:** проекция плана выбранного checkout, начало `loadURL` сохранённого URL (или entrypoint по Chat/Work) и отдельное состояние полной проверки `workspaceHealth.phase = checking | ready | error`. Результат устаревшего поколения не меняет новый выбор, в том числе при A→B→A.

### Порядок открытия сохранённой сессии

1. `nextNavigation()`: новое поколение выбора и инвалидация PlanMonitor. Старое async-действие не забирает навигацию у нового выбора. Контроллер, замер и восстановление остаются у своей живой страницы.
2. Выбор сессии: явный sessionId либо последняя выбранная активная сессия проекта (клик, запуск, reload, выход из Settings). Если она недоступна — оставшаяся активная. Архивный родитель открывает архив; неподтверждённый исполнитель не становится обычным проектом.
3. `selectSession`: `readWorkspace` читает `todo-plan.md` до очереди записей; другой `project_id` в папке → `PROJECT_REPLACED` без изменения сохранённых чатов; запись выбора идёт в общей очереди и отменяется, если выбор устарел (при отмене во время `rename` восстанавливается прежний снимок в той же очереди).
4. Сайдбар сразу показывает выбор и план, `workspaceHealth = checking`; show переключает view. loadURL нужен только для ещё не открытого URL или явного reload; IPC его не ждёт.
5. Параллельно `workspaceSetup.ready(workspace)` в worker; итог `ready|error` публикуется, только если поколение актуально.
6. Контроллер доставки прикрепляется при совпадении workspace/session/поколения, готовой readiness и загрузке своей страницы. Навигация отменяет доставку только этой страницы. Подробности — [SessionRuntimes](session-runtime.md).

Быстрое чтение — только разбор JSON-блока плана и H1 нужных документов; JavaScript из папки проекта для показа плана не импортируется и не запускается; неоднозначное состояние не подменяется чужим планом; проекция появляется до полной диагностики и до сети ChatGPT.

Сохранённый чат открывается для просмотра без запуска служб, прогрева и сборки пакета. Ошибка фоновой проверки видима с «Повторить проверку» (или «Обновить Workflow Kit» при устаревшем Kit) и «Доктор проекта», чат при этом не закрывается и доступен для просмотра. Settings и отмена подготовки возвращают к уже загруженному документу без перезагрузки, черновик и ответ сохраняются.

### Строгий путь

Первое подключение незнакомой папки, создание/установка, новая сессия, «Обновить/Проверить контекст», upgrade Kit и продолжение Доктора идут через `reviewWorkspace` → `WorkspaceSetup.preview`: полная проверка в worker с инвалидацией readiness этого workspace и одноразовым токеном. Manifest согласуется только доверенным upgrade или Доктором.

### Readiness в памяти

`WorkspaceReadiness` (`maxEntries = 4`):
- кэшируются только готовые результаты, LRU до 4 workspace; ошибки и транзакции не кэшируются;
- один выполняемый worker, последний ожидающий выбор UI и удерживаемая FIFO-очередь фонового контекста (retain=true); одинаковые запросы объединяются; только вытесненный UI-запрос получает READINESS_SUPERSEDED; CONCURRENT_CHANGE при inspect допускает один повтор;
- перед каждым использованием worker заново считает ключ; совпадение с кэшем — без `inspect`; при новой проверке ключ до и после должен совпасть, иначе один повтор, затем `READINESS_CHANGED`;
- активная транзакция Kit → `READINESS_BUSY`;
- `preview` и `apply` очищают кэш и ожидание своего workspace, `invalidateReadiness()` при закрытии окна — всё (ожидающий получает `READINESS_CHANGED`, выполняемый результат отбрасывается); перезапуск начинается с пустого кэша;
- readiness не разрешает отправку: перед вставкой и Send доставка заново проверяет готовность, ключ и поколение, ошибка ключа запрещает сборку и не заменяется TTL (context-delivery).

### Отпечаток входов

`inspectionInputs` считает worker, не Electron main. В ключ входят: HEAD, `git status` (porcelain, все untracked, `-c core.fsmonitor=false`), refs, индекс (`ls-files --stage`, обычный и split index), Git config с origin, глобальные attributes/excludes; содержимое current plan, `workflow.json`, manifest и owned-файлов, required- и context-документов, путей задач, `README.md`, `AGENTS.md`, `docs/architecture/OVERVIEW.md`, всех `docs/planning/**/*.md`, манифестов проекта (≤64 КиБ), hooks, launcher `scripts/workflow{,.cmd,.mjs}`, `.gitignore/.gitattributes` по путям, установленного и выполняющего Kit; служебные файлы Git и Kit (transaction, last-verification, installation, recovery, MERGE/CHERRY_PICK/REVERT_HEAD); исполняемые node/git — по realpath, dev, inode, mode, size, mtimeNs, ctimeNs (исключение: Windows Node `.harness/runtime/node.exe` и Node текущего worker — без нестабильного `ctimeNs`, который меняется даже при запуске бинарника; каждый readiness не хеширует большие исполняемые файлы); версия Kit. Посторонние файлы учитываются только именем и статусом, поэтому чужие symlink, submodule и большие файлы проверку не блокируют. `INSPECTION_INPUT` — вход не обычный файл или больше 16 МиБ, symlink либо больше 10000 файлов в деревьях Kit; идущий rebase → `GIT_OPERATION_ACTIVE`. TTL, mtime или число файлов актуальность не доказывают — только содержимое. Исторические планы в ключ не входят и открытие не блокируют.

### Полная проверка

План, Git references, required-документы, manifest/owned files, hooks и launcher проверяются в изолированном доверенном worker `resources/workspace-setup-worker.mjs`, не в Electron main. Внутри Kit — одна согласованная операция inspect/recover (изменение входов во время проверки: один повтор, затем `CONCURRENT_CHANGE`) и пакетные Git-операции: trailers одним `git log -z … %(trailers:only,unfold)` (сообщения с `---` — через `interpret-trailers --parse`), зависимости одним `rev-list`, фасад всегда с `-c diff.autoRefreshIndex=false`, потому что `git diff` переписывал stat-cache индекса и давал ложную смену отпечатка с повторной инспекцией. Контракт Git-фасада — [пакет Kit](../../packages/workflow-kit/docs/modules/workflow-kit-package.md).

### Очереди и поколения

Тяжёлые чтения не держат очередь записей store и очередь IPC: навигационные действия (`pilot:select-workspace`, `pilot:select-session`, `pilot:reload`, `pilot:return-chat`, `pilot:startup`) выполняются сразу, следующий клик доходит до main без ожидания. Поколение действия хранится в `AsyncLocalStorage`, поэтому старый обработчик не перехватывает новый выбор, а собственная актуальная ошибка не теряется после `await`. Закрытие окна увеличивает поколение и отменяет все публикации и колбэки.

## Бюджет и границы

- Локально, без сети и MCP, на текущем Mac пользователя: p95 показа свежего плана и начала `loadURL` ≤1 с на 30 переключениях сессий/проектов; ≤2 с от готовности оболочки на каждом из 5 запусков. Сетевая загрузка ChatGPT и MCP round trip в бюджет не входят; полный запуск до плана измеряется отдельно.
- Полная проверка не должна регрессировать к процессу Git на каждый коммит или зависимость: пакетные операции и одна инспекция обязательны.
- Source/CI-замеры не выдаются за packaged; native Windows и чистые VM не объявляются измеренными без запуска.
- Без новых зависимостей и постоянной службы кэша; installed Kit проекта и packaged runtime происходят из одного canonical package.

## Проверки

- Автоматические (`unit-all`): `tests/workspace-readiness.test.mjs` (объединение, свежий ключ при reuse, предел памяти, отмена, ошибки и транзакции не кэшируются, один активный + последний ожидающий, изменение required-документа), `tests/workspace-setup.test.mjs` (входы отпечатка, один повтор → `CONCURRENT_CHANGE`, исторические планы не блокируют), `tests/workspace-session.test.mjs` (медленная проекция не держит мутации, A→B→A, отмена во время сохранения), `tests/sidebar.test.mjs` (быстрый A→B→A доходит до IPC сразу), `tests/session-opening-performance.test.mjs` (реальные изменения документа, индекса, HEAD, плана и транзакции блокируют вставку), `tests/context-cache.test.mjs` (ключ пакета из readiness, отказ при чужой/неуспешной readiness). Бюджет времени автоматически не проверяется.
- Замер source (агент): изолированный клон `git clone --no-hardlinks` во временной папке; число Git-процессов — через `GIT_TRACE2_EVENT` с вложенными вызовами; драйвер preview → `selectSession`, остановка перед `loadURL`; копия main с отдельным userData, скрытым окном, отключённым стартом служб и записывающей заглушкой вместо `loadURL`, без сети. Не измеряет сеть ChatGPT, отрисовку и ответы. `npm run smoke -- --event-runtime-baseline` (только непакетная сборка) считает executeJavaScript, IPC-снимки и запуски worker.
- Живой замер: настоящий Electron с исходными файлами, отдельные userData/sessionData; инспектор только задаёт профиль и наблюдателей; клики через CDP с `isTrusted=true`; DOM считается свежим только при точных workspace, сессии, плане, ревизии, названии, задачах и активной строке; `loadURL` подтверждается нативным событием навигации; сеть настоящего ChatGPT — отдельный неавторизованный профиль и не локальная метрика; задержка readiness ≠ время запуска UI.

## Открыто

- Время открытия на native Windows не измерялось.
- Бюджет p95 не закреплён автоматической проверкой: регресс заметен только при ручном замере.
