# Исполнитель Codex App Server

Локальный MCP-сервер `tools/codex-app-server-mcp` поверх официального Codex App Server без модельных ходов — единственный backend Web Pilot на macOS и Windows. Отдаёт ChatGPT ровно девять инструментов: команды, патч, просмотр изображения, статус, watchdog и наблюдение экрана без управления. Службы, `control.py`, порты, автозапуск, Secure MCP Tunnel и VPS — [runtime-lifecycle.md](runtime-lifecycle.md); стартовое сообщение с правилами инструментов — [context-delivery.md](context-delivery.md).

## Код

- `tools/codex-app-server-mcp/server.py` — `create_server()` (FastMCP), `LocalFacade` (инструменты), `TurnWatchdog`, `server_name()`, `is_sensitive()`, `sniff_image_mime()`, `PREEXECUTION_RETRY_RULE`, `STDIN_CLOSED_MESSAGE`.
- `tools/codex-app-server-mcp/app_server_client.py` — `AppServerClient` (JSON-RPC по stdio, `FORBIDDEN_METHODS = {"turn/start"}`), `discover_codex_binary()`.
- `tools/codex-app-server-mcp/windows_desktop.py` (`WindowsDesktop`, Win32-наблюдение), `windows_notify.ps1`, `codex-tools.lock.json`, `requirements.txt` (`mcp==1.28.1`; только Windows `pillow==11.3.0`, `psutil==7.2.2`).
- `src/mcp-runtime.mjs` — `LocalMcpClient`, `validateEndpoint`, `RuntimeError`.
- `src/mac-runtime-switch.mjs` — `EXECUTOR_TOOL_RULES`, `runtimeLabel()`, `CODEX_NOT_FOUND_MESSAGE`, `WINDOWS_CODEX_NOT_FOUND_MESSAGE`.
- `scripts/check-codex-tools.mjs` (`npm run check:codex-tools`), `scripts/check-mac-screen-capture.mjs`.

## Поведение

### Роль и границы

- Модель работает в ChatGPT Web и сама принимает решения; App Server — только исполнитель и источник формы инструментов. Клиент отклоняет `turn/start` (`Forbidden App Server model method`); thread, `mcpServer/tool/call`, `node_repl`/`@oai/sky`, Computer Use, Responses API, `codex exec`, второй агент не используются.
- Решение пользователя: модели даются родные инструменты Codex, а не собственные; Codex не собирается и не копируется, потому что получился бы форк. Поиск — `rg` в `exec_command`, остальное — командами.
- Local-only: наружу — только то, что требует доступа к компьютеру. Web search, публичные документы, облачные возможности ChatGPT, `codex_apps`, downstream MCP Codex не публикуются: «видно Codex» ≠ «разрешено в ChatGPT».
- Обычные команды выполняются с правами пользователя (`dangerFullAccess`), ограничения одной папкой нет. Явный `read_only:true` включает проверенную файловую ReadOnly sandbox с сетью, без fallback к writable; после подготовки подходит для сервера предпросмотра. Проверка deny-write выполняется на поколение App Server. Lifecycle, UNKNOWN и безопасная интеграция — [command-activity](command-activity.md).
- Контекст проекта MCP не доставляет: пакет приходит вложениями стартового сообщения ([context-delivery.md](context-delivery.md)).

### Сервер MCP

- Имя `Codex App Server Local Mac` / `Codex App Server Local Windows` (`server_name()` по ОС). Streamable HTTP только на `127.0.0.1`; порт `--port` / `WEB_PILOT_CODEX_EXECUTOR_PORT` (17852), состояние `--state-dir` / `WEB_PILOT_CODEX_EXECUTOR_STATE_DIR`, Codex `--codex-bin` / `CODEX_APP_SERVER_BIN`. Запускает `control.py`.
- `stateless_http=True`, потому что Web Pilot перезапускает сервер при каждом старте, а ChatGPT и Claude (через VPS) держат прежний `Mcp-Session-Id`: stateful-сервер отвечал 404 «Session not found» без переподключения. Состояния MCP-сессии и in-session уведомлений нет.
- Instructions (текст закреплён тестом, константа `SERVER_INSTRUCTIONS`): только локальные инструменты, публичное — средствами ChatGPT; без модельного хода; «No UI control … Observation only» с тремя `computer_*`; поиск `rg` через `exec_command`, правка `apply_patch` без перечитывания; `LONG_COMMAND_RULE` — долгую команду не уводить в фон через `&`/`nohup`, запускать обычным `exec_command` и при session ID опрашивать сессию `write_stdin` с пустым вводом, не запуская повторно (то же в описании `exec_command`); предел длины instructions в тесте — 850 символов; `PREEXECUTION_RETRY_RULE` — заблокированный OpenAI до выполнения вызов повторить один раз без изменений, менять или дробить только после второй блокировки.
- Те же правила (три строки `EXECUTOR_TOOL_RULES`) идут в стартовое сообщение через `runtime.startupRules` на обеих ОС.
- Каталог состояния — 0700. При старте сервер удаляет пустую папку `trash` (непустую не трогает) и оставшийся `active-workspace.json`.

### Каталог — ровно 9 инструментов на обеих ОС

| Инструмент | Параметры (по умолчанию, пределы) | Назначение |
|---|---|---|
| `exec_command` | `cmd`, `workdir` (обязателен), `shell=""`, `login=true`, `tty=false`, `yield_time_ms=10000` (250–30000), `max_output_tokens=8000` (1–8000) | команда; вывод или session ID |
| `write_stdin` | `session_id`, `chars=""`, `yield_time_ms=250` (запись 250–30000, пустой опрос 5000–60000), `max_output_tokens=8000` | ввод или опрос сессии |
| `apply_patch` | `patch`, `workdir` | родной `apply_patch` Codex |
| `view_image` | `path` | локальное изображение |
| `bridge_status` | `repository=""` | статус и совместимость с Codex |
| `turn_watchdog` | `action` (`start`/`checkpoint`/`complete`), `summary`, `turn_token`, `timeout_seconds=150` (60–600), `notify_checkpoint=false` | уведомление о вероятно прерванном ответе |
| `computer_list_windows` | `title_contains=""`, `max_results=200` (1–500) | видимые окна |
| `computer_capture_screen` | `x`,`y`,`width`,`height` (область — только все четыре), `max_dimension=1600`, `include_cursor=true` | PNG экрана или области |
| `computer_capture_window` | `window_id`, `max_dimension=1600`, `include_cursor` (игнорируется) | PNG окна |

- Имена, параметры и описания — внешний контракт: менять только отдельной задачей и со сверкой `npm run check:codex-tools`. Описания есть у всех инструментов и параметров; целые и логические параметры `exec_command`/`write_stdin` строгие (строка вместо числа отклоняется).
- Клиенты кэшируют каталог: после изменения — ⌘Q, Refresh у подключения в ChatGPT (и в Claude), новая сессия; старые чаты могут вызывать прежние имена.

### `exec_command` и `write_stdin`

- Прямые `command/exec`, `command/exec/write`, `command/exec/terminate`, без thread и turn. Незавершённые сессии живут в памяти сервера и теряются при его перезапуске; таймаута у долгого процесса нет, App Server буферизует до 4 МБ вывода. Когда команда возвращается, App Server завершает её процессы: фоновое задание оболочки (`&`, `nohup`) исчезает сразу с пустым журналом (проверено на исполнителе), поэтому долгая команда идёт через сессию.
- `workdir` обязателен (`workdir is required`), потому что у MCP нет папки разговора. Полей sandbox, justification, environment_id нет.
- Оболочка: macOS — `shell`/`$SHELL`/`/bin/zsh`; Windows — PowerShell 7/Windows PowerShell по порядку Codex. POSIX: `-lc`/`-c`; PowerShell: `-Command`/`-NoProfile -Command` и UTF-8; cmd: `/c`.
- stdin открыт только при `tty=true` (`stdin_open: tty` в Codex); иначе команды без явного ввода не зависают. Non-TTY `write_stdin` допускает пустой опрос и Ctrl-C (`\x03`), иной ввод отклоняется как `stdin is closed for this session`; сессия остаётся живой.
- Вывод ограничен `max_output_tokens × 4` байт (максимум 8000 токенов ≈ 32000 байт). При обрезке остаются начало и конец с маркером `... N bytes omitted ...` и оценкой `Original token count`. Текстовый ответ содержит `Chunk ID`, `Wall time`, `Process running with session ID <id>` либо `Process exited with code <n>` и `Output`; без увеличения предела ради двойной обрезки в ChatGPT.
- Процесс, завершившийся между проверкой и записью, отдаёт финальный вывод и код; дальше — `Unknown or finished command session`. Пустой опрос ограничен 60 с, чтобы вызов через туннель не висел.

### `apply_patch`

Exec/apply_patch создают marker v2; terminal event App Server пишет exit и снимает active без write_stdin. Read-only сервер допускает merge, но защищает удаление. Writer после source блокирует merge, не безопасную диагностику. Остановку точной session разрешает пользователь через её executor; потерянный исход — UNKNOWN, без очистки по PID/возрасту. Детали: [команды](command-activity.md), [финал](parallel-execution.md). Девять инструментов, без модельных запросов.

- Формат Codex (`*** Begin Patch` … `*** End Patch`, Add/Delete/Update File, `*** Move to`); отклоняются пустой, не начинающийся с `*** Begin Patch` и больший 1 000 000 байт. `git apply` не используется.
- macOS: псевдоним `apply_patch` из PATH команд App Server через `command/exec`, патч в stdin с `closeStdin`, ожидание ≤120 с. Windows: тот же `codex.exe` под именем `apply_patch`, патч в stdin, потому что `apply_patch.bat` берёт патч аргументом, а многострочный патч до 1 МБ в командную строку не помещается.
- Удаление — `*** Delete File` или `rm`; откат — git; корзины нет.

### `view_image`

- Файл ≤ 20 000 000 байт (относительный путь — от домашней папки); тип по первым байтам: PNG, JPEG, GIF, WebP, TIFF, HEIC/HEIF/AVIF, BMP, ICO, PSD, ICNS, SVG, иначе `File is not an image`.
- macOS: временная копия в каталоге состояния, `sips -Z 1600`, копия удаляется, исходник не меняется. Windows: Pillow; ≤1600 по длинной стороне — байт в байт, больше — уменьшение в том же формате (кроме PNG/JPEG/GIF/WebP/BMP/TIFF — в PNG); без Pillow — понятная ошибка.
- Результат: текстовый JSON (`source`, `bytes`) + блок изображения. Описания `view_image` и `computer_capture_*` объясняют путь `content_items → image()` в скриптах ChatGPT.

### Чувствительные пути

`is_sensitive()` отклоняет `.env`, `.env.*`, `.npmrc`, `.pypirc`, `.netrc`, `credentials`, `credentials.json`, `id_rsa`, `id_ed25519`, `bridge_config.json`, `tunnel-key.dpapi`, `*.pem/.key/.pfx/.p12`, каталоги `.ssh`, `.gnupg`, `keychains`, `credentials`, `wallets`, профили браузеров, `Library/Accounts`, `CodexLocalMac/private`, `WebPilotCodexExecutor/private`. Проверка действует только в `view_image`: `workdir` и `repository` разрешаются без неё, а команды и патч работают с полными правами пользователя — это не граница безопасности.

### `bridge_status` и `turn_watchdog`

- `bridge_status`: `executor` (путь и версия Codex, `generation`, `pid`, `running`), `filesystem_scope`, `repository_mode: per-call`, `state_root`, `local_only: true`, `model_turns: "forbidden"`, `codex_tools` (`pinned_version`, `pinned_tag`, `installed_version`, `version_matches`, `apply_patch_available`, `lock_error`); с `repository` — `git status --short --branch`.
- `turn_watchdog`: `start` выдаёт `turn_token`; `checkpoint` перезапускает таймер (с `notify_checkpoint` — «работа продолжается»); `complete` снимает таймер и уведомляет «ответ готов»; срабатывание — «возможно, ответ прерван». macOS — `osascript display notification`, Windows — скрытый PowerShell с `windows_notify.ps1`. Отказ уведомления инструмент не ломает.

### Наблюдение экрана

- Решение пользователя: веб-модель не управляет мышью, клавиатурой и окнами — ни инструментами, ни командами (osascript, System Events, cliclick), потому что через туннель это медленно и редко нужно; живой интерфейс проверяет пользователь. Запрет для команд только текстовый (instructions и строка стартового сообщения в `src/context-session.mjs`), команды не фильтруются.
- macOS: список — `/usr/bin/osascript -l JavaScript` + `CGWindowListCopyWindowInfo(1|16)`, окна слоя 0, без CLT, Automation и Sky; поля `window_id`, `title`, `application`, `pid`, `rect`; `title_contains` ищет в заголовке и имени приложения; если все заголовки скрыты (нет «Записи экрана»), добавляется `note`. Снимки — `/usr/sbin/screencapture -x -t png` (`-C`, `-R x,y,w,h`), окно — `-o -l <window_id>`, в том числе перекрытое; свёрнутое снять нельзя. `max_dimension` 0 — без уменьшения, иначе 100–5000 (`sips -Z`). Временный файл читается через `fs/readFile` App Server и удаляется. `window_id` — только положительное целое, проверка до запуска команды; несуществующее окно → `could not create image from window`.
- Windows (`windows_desktop.py`, без ввода и активации окон): видимые окна с заголовком, те же поля; окно — `PrintWindow`, при отказе — область экрана; свёрнутое окно → ошибка.
- «Запись экрана» macOS нужна для заголовков и снимков. TCC относит запрос к Project Web Pilot (`com.oleynik.ProjectWebPilot`); Python и `server.py` отдельного разрешения не получают. Разрешение переживает обновления, пока постоянны подпись и designated requirement ([release.md](release.md)). Права подключения в ChatGPT — отдельный уровень. Агент не нажимает consent-диалоги, не правит TCC.db и не сбрасывает разрешения.

### Codex: поиск и клиент App Server

- Нужен установленный Codex (macOS — CLI или приложение ChatGPT, Windows — Codex CLI); без него `control.py` отвечает `CODEX_NOT_FOUND` до установки и запуска, тексты — `CODEX_NOT_FOUND_MESSAGE` / `WINDOWS_CODEX_NOT_FOUND_MESSAGE`.
- Поиск детерминирован, молча между установками не переключается: один раз при старте сервера берётся первый исполняемый файл, ответивший на `--version` за 5 с; путь и версия — в `bridge_status`.
  - macOS: `CODEX_APP_SERVER_BIN` → `~/.npm-global/bin/codex` → `~/.local/bin/codex` → PATH → `/Applications/ChatGPT.app/Contents/Resources/codex`.
  - Windows: `CODEX_APP_SERVER_BIN` → `codex.exe` из PATH → родной `codex.exe` пакета `@openai/codex-win32-*` глобального npm (`codex.cmd` лишь запускает Node) → `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` (официальный установщик) → WinGet Links → пути приложения ChatGPT.
- `AppServerClient`: один процесс `codex app-server --stdio` в своей группе, cwd — домашняя папка, старт при первом запросе; `initialize` (`experimentalApi`) + `initialized` один раз на поколение; после неожиданного выхода — новый процесс и поколение. `close()` останавливает только свой App Server с потомками (macOS — сигнал группе, Windows — `taskkill /T /F`). App Server — экспериментальный интерфейс Codex: совместимость видна в `bridge_status` и тестах `executor-channel`.

### Закрепление формы Codex

- `codex-tools.lock.json`: openai/codex 0.162.1, rust-v0.162.1, SHA-256 shell_spec.rs/view_image_spec.rs/apply_patch.lark. Проверка установленного CLI и исходников тега подтвердила: относительно 0.162.0 все три файла побайтно совпадают; формы и тайминги инструментов сохранены.
- `npm run check:codex-tools` находит Codex порядком macOS (Windows-путей не знает) и сверяет три файла тега `rust-v<установленная версия>` на GitHub с lock: 0 — совпало; 1 — отличаются файлы или версия, lock повреждён или Codex не найден; 2 — сеть или тег недоступны («не проверено»).

### Связь с приложением

`LocalMcpClient` только узнаёт свой сервер — инструменты принадлежат модели. Методы — `initialize`, `notifications/initialized`, `tools/list` (иначе `MCP_READ_ONLY`); адрес — только `http://127.0.0.1:<порт>/mcp` (`MCP_URL_INVALID`); `expectedServerName` обязателен, без значения по умолчанию, равен `runtimeLabel()` своей ОС (`MCP_SERVER_MISMATCH`); нужен лишь `bridge_status` (`MCP_TOOLS_MISSING`). Прочее: `MCP_UNAVAILABLE`, `MCP_HTTP_ERROR`, `MCP_RPC_ERROR`, `MCP_EMPTY_RESPONSE`, `MCP_RESPONSE_MISSING`, `MCP_ID_MISMATCH`, `MCP_TOOLS_INVALID`, `MCP_RESPONSE_TOO_LARGE` (> 2 МиБ); таймаут 10 с; `Mcp-Session-Id` — только если сервер его выдал.

## Решения и запреты

- Латентность вызова из ChatGPT (≈1,6–1,7 с при ≈7 мс локального выполнения) определяют round-trip коннектора через туннель (`initialize` + `initialized` + `tools/call` на каждый вызов), поэтому исполнитель ради скорости не переписывается без посегментного замера.
- Замеры: заданный метод не подменять shell или скриптом; имя коннектора не доказывает backend и маршрут. Трассировка туннеля/MCP — только opt-in: числа, методы, статусы; без tunnel ID, ключа, адресов, credentials, cookies, содержимого ChatGPT и файлов.
- Ключ туннеля и адрес коннектора не попадают в журналы, ответы инструментов и чат.

### Не возвращать

- Корзину (`delete_path`, `list_trash`, `restore_trash`, `/usr/bin/trash`) — решение пользователя: копила записи всех проектов, `rm` и `*** Delete File` её обходят, откат даёт git, у Codex корзины нет.
- Управление интерфейсом (`computer_click`, `_move_mouse`, `_scroll`, `_type_text`, `_key_press`, `_hotkey`, `_actions`, `_activate_window`, `_release_inputs`, `_status`), Sky, `node_repl`, Computer Use, thread с `danger-full-access`; передачу проверки интерфейса локальному агенту и универсальный Computer Use MCP не готовить.
- Собственные файловые, поисковые, process- и Git-инструменты и фасады (`run_command`, `start_process`, `stop_process`), overlay `bridge_mcp.py`.
- Доставку контекста через MCP (`workflow_context_recover`, `session-rules.md`, `active-workspace.json`) — [context-delivery.md](context-delivery.md); stateful MCP-сессии.
- Второй backend и переключатель backend — [runtime-lifecycle.md](runtime-lifecycle.md).

## Проверки

Автоматические (`.harness/workflow.json`):
- `executor-channel` — `node --test tests/codex-app-server-mcp.test.mjs`: каталог из 9, описания и instructions, команды, патч и изображения на настоящем App Server, stale `Mcp-Session-Id`, наблюдение экрана, ветки Windows с подменой платформы. Части с настоящим Codex пропускаются без macOS, Codex и venv исполнителя.
- `codex-tools-live` — `npm run check:codex-tools`.
- `unit-all` — `npm test`: на Windows `tests/mcp-runtime.test.mjs`, `tests/check-codex-tools.test.mjs`, `tests/windows-runtime-switch.test.mjs`; на macOS дополнительно `tests-macos/mac-runtime-switch.test.mjs` с проверкой правил стартового сообщения. macOS-набор не запускается на Windows.

Ручные и живые:
1. Пользователь, серия вызовов в новом проекте: `rg`/`cat`/`grep` без пути при `tty=false` завершаются сразу; ввод в non-TTY → `stdin is closed…`; Ctrl-C завершает non-TTY; ввод в завершившуюся сессию → финал и код, затем `Unknown or finished command session`; `seq 1 60000` → один маркер обрезки и `Original token count`; `max_output_tokens` > 8000 → 8000; строка в `yield_time_ms` отклоняется; изображения через `content_items`; блокировка OpenAI до выполнения → один неизменённый повтор.
2. Предсборочная проверка на изолированном состоянии: временный каталог и порты (`WEB_PILOT_CODEX_EXECUTOR_PORT`, `…_TUNNEL_PORT`), `launchctl` подменён записью вызовов, сигналы процессам запрещены; настоящие `control.py`, uv, Codex. Ожидается: подготовка доходит до шага туннеля; MCP отвечает своим именем и каталогом; без туннеля полный запуск не проходит (`TUNNEL_NOT_CONFIGURED`); три `computer_*` работают, несуществующий `window_id` → `could not create image from window`, временных файлов нет.
3. Захват экрана после обновления, смены подписи или перезагрузки: `node scripts/check-mac-screen-capture.mjs` (`--preflight` — только предпроверка). Требует одну корневую копию app, MCP на 17852 — записанный процесс, app и MCP запущены после подписи (иначе `MAC_CAPTURE_RESTART_REQUIRED`), `CGPreflightScreenCaptureAccess` (иначе `MAC_CAPTURE_PERMISSION_REQUIRED`); оба отказа — до захвата. Затем `computer_capture_screen` через MCP, проверка PNG и TCC attribution на `com.oleynik.ProjectWebPilot`. Consent и службы не автоматизирует.
4. После изменения каталога: ⌘Q, Refresh, новая сессия; каталог, снимки экрана и окна, в том числе перекрытого.

## Открыто

- Windows-часть до приёмки пользователем на настоящей Windows не проверена: Win32-наблюдение, уведомления, PowerShell, `apply_patch` через `codex.exe`, Pillow, поиск Codex (пути приложения ChatGPT — предположение).
- Расхождение: описания `view_image` обещают блок `image/png`, код отдаёт MIME исходного типа (`image/jpeg`, `image/heic`, `image/svg+xml`, `image/vnd.adobe.photoshop` …; `sips -Z` формат сохраняет). Показ в ChatGPT форматов кроме PNG/JPEG/GIF/WebP не проверен.
- TCC attribution не проверена для MCP, поднятого LaunchAgent при входе до открытия Web Pilot.
- Латентность после `stateless_http` и через канал VPS не замерялась.

Опциональный Review запускает Claude CLI командой Kit через обычные exec_command/write_stdin. Это не модельный ход Codex App Server и не новый MCP-инструмент; правила — [plan-review](plan-review.md).
