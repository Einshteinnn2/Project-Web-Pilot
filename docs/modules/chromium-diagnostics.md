# Диагностика Chromium

Пассивные журналы Electron/CDP, телеметрия и composer, стартовая сетевая трасса, фазы приложения и отчёт «Скопировать диагностику». Они не определяют compact и не инициируют recovery. Единственная функциональная связь — HTTP 429 для [ConversationRecovery](context-delivery.md).

## Код
- `src/chromium-diagnostics.mjs` — `ChromiumDiagnostics` (`start`, `stop`, `observePage`, `startupReport`, `flush`, поле `log`), `DiagnosticJsonl`, `safeUrl`, `payloadMetadata`, `contextTelemetry`, `contextServiceMetadata`.
- `src/startup-network-trace.mjs` — `StartupNetworkTrace`, `summarizeStartupNetwork`.
- `src/main.mjs` — создание в `createWindow`, записи `app`/`composer`/`auto-plan`/`event-checker`, `publish()` → `diagnostics.jsonl`, действие `copy-diagnostics` в `pilot:startup`.
- `src/chatgpt-composer.mjs` — `trace()`/`traceDelivery()`; очистка `diagnostics.jsonl` — `src/workspace-deletion.mjs`, `src/workspace-session.mjs`.

## Поведение

### Файлы
Каталог данных: macOS `~/Library/Application Support/Project Web Pilot`, Windows `%APPDATA%\Project Web Pilot`; smoke — временный профиль.
- `diagnostics/chromium-events.jsonl` — каталог 0700, файл 0600, JSONL `{ts, seq, diagnosticSession, source, event, …}`; `diagnosticSession` — новый UUID на страницу; строки зарегистрированной страницы содержат workspace и Session ID. При превышении 25 MiB файл переносится в `.1` (одна копия). Запись и очистка используют общую очередь файла с ротацией, ошибки записи глушатся (best-effort). Подтверждённое удаление и отдельная подтверждённая очистка потерянной записи исполнителя удаляют строки по точным workspace/projectId/sessionIds и связанные diagnosticSession из текущего файла и ротации, сохраняя соседние страницы. Живую страницу/UNKNOWN-команду сначала нужно остановить: простое ENOENT этого не разрешает.
- `diagnostics.jsonl` (0600) — строка из `publish()` только при изменении сигнатуры: фаза доставки, workspace, sessionId, requestId, `contextSha256`, `planRevision`, код ошибки, версия, страница старта. Ротация `appendDiagnostic` (`src/common.mjs`): при 4 МиБ файл становится `diagnostics.jsonl.1` (одна предыдущая копия). Удаление проекта/сессии либо адресная очистка orphan-исполнителя вычищает только строки указанного владельца из обоих файлов, не содержимое облачных бесед.
- `diagnostics/startup-network.json` — сырой netLog только на время захвата, всегда удаляется.

### Жизненный цикл
- Свой экземпляр на каждом живом ChatGPT WebContents; popup и сайдбар не наблюдаются. start вызывается до навигации, CDP не задерживает её; занятый отладчик даёт attach-skipped, сбой — attach-failed. HTTP 429 адресуется recovery своей страницы, Composer добавляет sessionId. Переключение панели диагностику скрытой страницы не снимает; освобождение runtime вызывает stop.
- stop при освобождении страницы/закрытии приложения снимает обработчики, отключает только свой CDP, завершает трассу и пишет session-stop. Первичная сетевая трасса остаётся у стартовой страницы без проекта.

### Что записывается
- `webContents`: навигация, `dom-ready`, `main-document-response` (status), `did-fail-load`/`did-fail-provisional-load` (код и имя `ERR_*`), загрузка, `render-process-gone` (reason, exitCode), `unresponsive`/`responsive`.
- `cdp`: `request`/`response` (метод, тип ресурса, status, mimeType, протокол, URL по правилам ниже), `loading-finished`/`loading-failed`, WebSocket и EventSource (метаданные payload), `lifecycle`, `browser-log` (source, level, URL, строка — без текста сообщения); прочие методы — только имя, шумные игнорируются.
- `dom/state` — пульс по снимкам наблюдателя страницы, только при изменении: URL, число сообщений пользователя, busy, наличие поля, visibility, ревизии ручного Stop и ответа, короткие hex-идентификаторы хода, источник идентичности, роль последнего сообщения, `connectionError`. DOM-код для этого не выполняется.
- `app`: `navigation-requested` (размеры окна и view), `navigation-waiting` (через 15 с), `load-url-failed`, `title-sync` (код и статус без токена и названия); `auto-plan` — состояния, паузы, отправки и watchdog без текста ([AutoPlan](auto-plan.md)); `event-checker` — только с `--event-runtime-checker` в непакетном запуске.
- `composer`: `delivery-start` (операция, `requestId`, длина текста), `delivery-result`, `delivery-error` (только код вида `[A-Z_]`, иначе `UNCLASSIFIED`), `before-send-start/complete`; при наличии текста сообщения также `action-start` и `observation` (дедуплицируется по сигнатуре: длины, вид первого расхождения, счётчики переводов строк/табов/nbsp/невидимых, состояние кнопки, `attachmentsPresent/Ready/Failed`, исход, причина). Сбой журнала Send не блокирует.

### Правила приватности
- URL — `safeUrl`: origin, path с заменой UUID и длинных (≥ 20 символов `[A-Za-z0-9_-]`) сегментов на `:id`, только ключи query; значения query и fragment не пишутся; `data:` — `[redacted]`.
- Никогда не пишутся: cookies, заголовки и authorization, тела запросов, значения query, текст сообщений и черновиков, recovery и имена/содержимое вложений, HTML, тексты исключений, токены и ключи, адрес коннектора и данные туннеля.
- WebSocket/SSE — размер, SHA-256, формат, верхние ключи JSON (≤ 40) и пары `key=value` только для ключей `type/event/event_type/eventType/method/kind/op/action` со значением-идентификатором (≤ 96 символов `[A-Za-z0-9_.:/-]`).
- Телеметрия — только числа из allowlist (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`, `model_context_window`, `context_window` и подобные), фиксированные маркеры (`token_count`, `compacted`, `ContextCompaction`, …), признаки присутствия (`compaction_response_id`, `window_id`, …) и пути ключей с `token|context|usage|window|compact` (число либо только факт наличия). Поддеревья `message`, `content`, `parts`, `text`, `replacement_history`, `guardian_history`, `tool_output`, `output_text`, `input_text` не обходятся. Пределы глубины 10, 800 узлов, вложенный JSON ≤ 256 KiB, ≤ 12 вложенных разборов — граница приватности и DoS.
- Тело ответа `/backend-api/f/conversation` с `text/event-stream` читается через `Network.getResponseBody` только в памяти: пишутся размер, SHA-256 и телеметрия. `GET /backend-api/models` — только `max_tokens` модели `gpt-5-6-thinking`; объект разговора (`/backend-api/conversation/<id>`, как и устаревший `conversations/<id>`) — лишь наличие и тип `context_truncation_continuation`, наличие `summary_metadata`, `has_previous_page`.
- Запись `telemetry/context`: `inputTokens`, `modelContextWindow`, `usedPercent`, `compactSignal` (`direct`; `token-reset`/`token-drop` после заполнения ≥ 75 %) — только для анализа; в UI и логику не попадает.

### HTTP 429
Ответ 429 на `https://chatgpt.com/backend-api/conversation(s)/<id>` вызывает `onConversationRateLimit(id, секунды)` (Retry-After в секундах или дате, по умолчанию 60) → пауза ConversationRecovery 60–300 с.

### Стартовая сетевая трасса и отчёт
- `StartupNetworkTrace` работает только при запуске без проектов и не в smoke. Chromium netLog `captureMode:'default'`: собственный предел netLog (`maxFileSize`) в изолированном сетевом сервисе даёт `ERR_INSUFFICIENT_RESOURCES`, поэтому пределы держит приложение, sandbox не отключается. Уже идущий netLog не перехватывается.
- Старт ждётся ≤ 1 с (дольше — захват сворачивается, навигация не ждёт). Остановка: `dom-ready` непустой страницы, сбой загрузки main frame, 125 с, файл ≥ 4 MiB (проверка раз в 250 мс), запрос отчёта, закрытие. Файл > 8 MiB не разбирается; сырой файл удаляется всегда.
- Сводка в памяти: этапы из allowlist (старт запроса, proxy, DNS, TCP, TLS, HTTP stream/transaction, HTTP/2, QUIC), связанные с запросом `https://chatgpt.com/` или `/auth/login`; время от первого события, фаза, `net_error`, IP-адреса (только литералы, ≤ 8), HTTP-status, протокол; ≤ 160 событий (первые 120 и последние 40). URL, заголовки, параметры и тела не сохраняются.
- `startupReport()` — JSON: первые 31 и последние 30 стартовых событий текущей диагностической сессии, `eventsOmitted`, сводка сети; без телеметрии чата и прежних сессий. Кнопка «Скопировать диагностику» мастера первого запуска ([онбординг](first-run-onboarding.md)) кладёт его в clipboard; нужна и при успешном старте.

## Решения и запреты
- Журнал введён по поручению пользователя как пассивный: собрать признаки предполагаемого auto-compact и сетевых сбоев. Он не определяет compact, не запускает обновление контекста и не влияет на готовность и перерисовку панели.
- Пульс событийный с дедупликацией (без периодического опроса); CDP подключается сразу при старте, не после `did-finish-load`.

### Не возвращать
- Индикатор «Контекстное окно» и счётчик токенов в UI: ChatGPT Web не отдаёт браузеру занятость окна, токенизация видимого текста серверное окно не отражает. Без поручения и новых данных не возвращать.
- Сохранение сырых payload, тел ответов, текста или summary разговора (raw-capture).

## Проверки
- `unit-all`: `tests/chromium-diagnostics.test.mjs` (`safeUrl` без значений query и id, метаданные payload, телеметрия без содержимого, маркеры compact в SSE, метаданные сервисов, ротация, сбой первой навигации до успешной, ограниченный стартовый отчёт без телеметрии чата, CDP не блокирует навигацию, дедупликация DOM-событий, `data:` не попадает в журнал), `tests/startup-network-trace.test.mjs` (связь запроса с DNS/TCP/TLS, начало и конец сводки, default-режим и удаление сырого файла, чужой netLog не трогается, поздний старт, предел размера).
- `electron-smoke` проходит журнал в TEST FIXTURE.
- Вручную (пользователь): при сбое запуска — «Скопировать диагностику»; при подозрении на compact — сопоставить `telemetry/context` и `dom/state` до и после. Пауза, reconnect, число сообщений и новый пакет compact не доказывают.

## Открыто
- `model-limit` пишется только для закреплённого в коде slug `gpt-5-6-thinking`; для другой модели предела в журнале нет.
- Сигнал auto-compact не найден; восстановление после compact — открытое требование ([доставка](context-delivery.md)).
