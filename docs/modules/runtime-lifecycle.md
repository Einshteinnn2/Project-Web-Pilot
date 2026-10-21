# Жизненный цикл служб исполнителя

Службы исполнителя — MCP-сервер, tunnel-client (Secure MCP Tunnel) и SSH-проброс VPS — живут вне окна Web Pilot, стартуют при входе пользователя и перенастраиваются приложением при каждом его запуске. Здесь — `control.py`, состояние и порты, identity процессов, автозапуск, канал ChatGPT, компоненты Windows, очистка прежних runtime. Инструменты — [codex-app-server-executor.md](codex-app-server-executor.md), мастер — [first-run-onboarding.md](first-run-onboarding.md), упаковка — [release.md](release.md).

## Код

Жизненный цикл страниц — [SessionRuntimes](session-runtime.md), закрытие окна не завершает службы. [Lifecycle команд](command-activity.md) фиксирует terminal event независимо от polling; защищённый read-only сервер допускает интеграцию, но не удаление проекта. UNKNOWN не очищается по возрасту, завершение плана сервер не останавливает. Новой фоновой службы для parallel нет.

- `tools/codex-app-server-mcp/control.py` — CLI служб (`managed_process`, `stop_one`, `operation_lock`, `configure_tunnel`, `adopt_legacy_tunnel`, `vps_*`); `tunnel_prompt.py` — окна ввода туннеля.
- `src/mac-runtime-switch.mjs` — `CodexAppServerRuntime` (вызовы `control.py`), `MacSelectedRuntime` (MCP + канал), `MacRuntimeSwitcher` (`activate`, LaunchAgent, `retireLegacyRuntime`); имена исторические, классы работают на обеих ОС.
- `src/vps-tunnel.mjs` (`VpsTunnel`, `WindowsVpsTunnel`), `src/windows-runtime.mjs` (`WindowsExecutorBootstrap`, `retireLegacyWindowsRuntime`), `src/zip-archive.mjs`, `src/tunnel-setup.mjs` (`runTunnelHelper`, `TUNNEL_ID_PATTERN`).
- `src/main.mjs` (`activateRuntime`, IPC `pilot:set-chatgpt-channel`, `pilot:copy-vps-connector-url`), `src/startup-readiness.mjs` (`PREPARATION_ERRORS`), `src/ui/settings-panel.mjs`; `resources/runtime-control/windows-control.py` — только для остановки прежнего сервера Windows.

## Поведение

### Состояние, порты, процессы

| | macOS | Windows |
|---|---|---|
| Каталог состояния | `~/Library/Application Support/WebPilotCodexExecutor` | `%LOCALAPPDATA%\WebPilotCodexExecutor` |
| Python для `control.py` | `/usr/bin/python3` (нужны Apple CLT) | `runtime\venv\Scripts\python.exe` |
| uv, tunnel-client, rg, Git | uv из пакета, `runtime/tunnel-client`, Git — CLT | `runtime\tools\…` из архива (`tools.json`); tunnel-client на месте, рядом `cloudflared.exe` |
| `setup_complete` | venv и tunnel-client есть | плюс `runtime\setup.json` с SHA-256 `requirements.txt` |
| Ключ туннеля | `private/tunnel-key`, 0600 | `private\tunnel-key.dpapi` (DPAPI CurrentUser), `private` закрыта `icacls` |
| Identity / остановка | `/bin/ps -o lstart= -o command=`; TERM группе → 5 с → KILL | psutil (время запуска, exe, cmdline); дерево |

- Общее: `source/` (копия исполнителя из пакета), `runtime/venv` (Python 3.13), `private/` 0700 (`selector.json`, `tunnel-profile/`, ключ), `<имя>.pid.json`, журналы 0600, `control.lock`. Каталог фиксирован, пользователь его не выбирает.
- Порты: предпочтительные MCP `17852` (`/mcp`) и health/UI tunnel-client `17853` (`/readyz`, `/ui`). Если порт занят другой программой, `start` её не трогает, а выбирает свободный порт рядом (`_choose_port`: предпочтительный, затем +2…+49, кроме порта соседней службы) и сохраняет его в `<state>/ports.json` (решение пользователя). После старта MCP selector и профиль туннеля переписываются на фактический адрес; VPS-проброс следует `status.mcp_url`; на VPS-сервере `127.0.0.1:17842` не меняется. Переменные `WEB_PILOT_CODEX_EXECUTOR_PORT`/`…_TUNNEL_PORT` задают предпочтительные порты изолированных проверок. Адрес берётся из `status.mcp_url` после старта, не кэшируется.
- Службы запускаются отсоединёнными; на Windows — без окна и с cwd в каталоге состояния, потому что Windows не даёт заменить рабочую папку процесса, а `source/` заменяется при обновлении.
- Identity — `<имя>.pid.json = {pid, identity}`; macOS вызывает `/bin/ps` с `LC_ALL=C LANG=C`, потому что `lstart` зависит от локали. `managed_process`: PID исчез или его номер теперь у другой программы (identity не совпала, например после перезагрузки) — запись молча удаляется под `operation_lock`, без сигнала процессу (решение пользователя), и служба запускается заново. `stop_one` перед сигналом перечитывает identity. Чужой процесс или порт сигнал не получает; `ready` — только у `owned`.
- Ожидание готовности: MCP ≤25 с (initialize с именем сервера), tunnel-client ≤45 с (`/readyz`).

### `control.py`

- Команды: `setup`, `status`, `start [--mcp-only|--tunnel-only]`, `stop [--tunnel-only]`, `selector-start`, `configure-selector`, `configure-channel --channel secure-tunnel|vps`, `configure-tunnel [--tunnel-id] [--key-stdin]`; только Windows — `autostart --state on|off|status`, `vps-apply --port`, `vps-status`, `vps-stop`, `vps-supervise`.
- stdout — только JSON `{ok: true, …}` или `{ok: false, error, code?}` (выход 1); вывод установщиков — в stderr. Всё, кроме долгоживущей `vps-supervise`, — под `operation_lock` (занят → `Another Codex executor lifecycle operation is still running`).
- `CodexAppServerRuntime` запускает его без shell, аргументами-массивом, из `<state>/source`: `setup|status|start|stop|selector-start` и отдельные методы `configure-*`, `autostart`, `vps-*`; прочее — `RUNTIME_ACTION_DENIED`. Таймауты: setup 10 мин, start 90 с, прочее 20–30 с. На Windows перед каждой командой — `WindowsExecutorBootstrap.ensure()`.
- `status`: `mcp`/`tunnel` (`running`, `owned`, `pid`, `ready`, `configured`), `mcp_url`, `tunnel_ui`, `tunnel_target`, `selector`, пути, `setup_complete`; без ключа и tunnel ID.
- `setup`: сначала `require_codex()` → `CODEX_NOT_FOUND` до любых загрузок. macOS: venv на Python 3.13 закреплённым uv 0.9.13 (`WEB_PILOT_UV`; системный 3.9 не тянет `mcp`), пакеты; tunnel-client — своя рабочая копия, рабочий из `WEB_PILOT_CODEX_TUNNEL_CLIENT`/PATH или последний релиз `openai/tunnel-client` с проверкой `SHA256SUMS.txt`. Windows: `uv venv --clear --managed-python --python 3.13 --no-config`, пакеты, tunnel-client только из компонентов, `setup.json`. Первый setup требует интернет; пока `setup_complete` ложно, приложение повторяет setup.
- `start`: `--tunnel-only` — только tunnel-client. Иначе MCP: устаревшая запись PID уже удалена `managed_process`; чужой listener на сохранённом порту → выбор свободного порта; `require_codex()`; `server.py --port --state-dir`. При `--mcp-only`, ненастроенном туннеле или канале `vps` на этом всё; иначе профиль направляется на свой `mcp_url` и стартует `tunnel-client run --profile codex-executor` (занятый порт tunnel-client — так же свободный порт, профиль `health.listen_addr` переписывается). `stop` — tunnel, затем MCP.

### Secure MCP Tunnel

- `configure-tunnel`: ID `^tunnel_[A-Za-z0-9_-]{16,100}$` (шаблон JS и Python сверяет `tests/tunnel-id-runtime.test.mjs`), ключ ≥16 без пробелов; работающий свой tunnel-client сначала останавливается (`stop_one`), потому что при отозванном ключе или удалённом туннеле он работает, но не становится готовым, а пользователь вводит туннель заново в мастере. Профиль ссылается на ключ через `env:WEB_PILOT_CODEX_EXECUTOR_TUNNEL_API_KEY`, health `127.0.0.1:17853`, один `server_urls` на локальный MCP; запись атомарная, 0600.
- Ввод из приложения — только `tunnel_prompt.py` через `runTunnelHelper` (секреты — через stdin воркера, ошибки — коды `MAC_|WINDOWS_TUNNEL_*`); окна и шаги — [first-run-onboarding.md](first-run-onboarding.md).
- Один ChatGPT-коннектор на туннель компьютера: `configure-selector` направляет единственный профиль на проверенный `mcp_url`. Туннели Mac и Windows раздельны.
- Без туннеля службы не сломаны: MCP работает, `tunnel.configured = false`, полный запуск в канале Secure — `TUNNEL_NOT_CONFIGURED`. Готовность — `ready && owned` нужных служб.

### Selector и канал ChatGPT

- `private/selector.json = {schema_version: 1, mode: "app-server", mcp_url, chatgpt_channel}`; `mode: "local"` прежних версий читается как `app-server`, блок `local` и чужая цель при перезаписи отбрасываются.
- Канал `secure-tunnel` (по умолчанию, решение пользователя) или `vps` хранится в `settings.json` (`chatgptChannel`) и в selector, чтобы автозапуск соблюдал его без окна.
- Settings → «Подключение ChatGPT»: кнопка VPS неактивна, пока проброс не готов; причина — строкой («Свой сервер не настроен.», конфликт `RemoteForward`, другой порт, последняя ошибка ssh). На VPS: готовность (иначе `VPS_NOT_READY`) → `configure-channel vps` → `stop --tunnel-only`; на Secure — всегда: `configure-channel` → `start --tunnel-only`; MCP не перезапускается. Подсказка — какой плагин ChatGPT включить и какой отключить; переключает их пользователь. Ошибки `CHATGPT_CHANNEL_INVALID|CONFIG_FAILED`.
- В канале VPS поле `tunnel` статуса — проброс VPS, поэтому готовность одна для старта, сайдбара и настроек; доставка контекста требует готового проброса (`RUNTIME_NOT_READY`). Сбой VPS не ломает канал Secure.

### Проброс VPS

- Договор с vps-server: он создаёт `Host vps-mcp-tunnel` в `~/.ssh/config`, ключ, пользователя и адрес коннектора `~/.config/vps-server/mcp-url`; Web Pilot только держит проброс. `/v1`, `wpstunnel`, `com.oleynik.wps-tunnel` не трогать.
- «Настроен» — `ssh -G -T vps-mcp-tunnel` даёт hostname, отличный от псевдонима; `RemoteForward` там — конфликт, проброс не ставится. Публичный адрес с компьютера не проверяется: сервер пускает только Anthropic и OpenAI.
- Проброс работает при любом канале, потому что через него подключается Claude, и следует за портом MCP: `ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R 127.0.0.1:17842:127.0.0.1:<порт MCP> vps-mcp-tunnel`. Готов = настроен, без конфликта, ssh жив, порт совпадает.
- macOS: LaunchAgent `com.oleynik.vps-mcp-tunnel` (RunAtLoad, KeepAlive, ThrottleInterval 15, журнал `~/Library/Logs/vps-mcp-tunnel.log`); plist переписывается только при смене порта, затем `bootout` + `bootstrap` (до 4 попыток).
- Windows: наблюдатель `control.py vps-supervise` с `%SystemRoot%\System32\OpenSSH\ssh.exe` (нет — не настроен). `vps-apply` пишет `vps.json {forward_port, control_sha256}` и запускает наблюдатель (ssh не чаще раза в 15 с, журнал `vps-tunnel.log` ≤1 МБ); смена порта или `control.py` его перезапускает; при входе его поднимает `selector-start`. Сервер убран из `~/.ssh/config` → `vps-stop`.
- Адрес коннектора показывается маской `https://<сервер>/mcp/…/mcp`; полный (https, путь `/mcp/<≥20 символов>/mcp`) читается только для «Скопировать» прямо в буфер — не логируется, не хранится, не уходит в renderer, диагностику и чат.

### Автозапуск и независимость от окна

- Закрытие Web Pilot завершает только UI (все его окна уничтожаются); MCP, tunnel-client и VPS работают до выключения компьютера. Автозапуск — при входе пользователя, не системная служба.
- macOS: `~/Library/LaunchAgents/com.oleynik.WebPilotCodexExecutor.plist` (0600): `/usr/bin/python3 -B <state>/source/control.py selector-start`, Aqua, RunAtLoad, Umask 077, журналы `autostart.{out,err}.log`. Запускает копию в состоянии, поэтому не зависит от пути app и workspace.
- Windows: HKCU `…\CurrentVersion\Run` `ProjectWebPilotCodexExecutor` = `pythonw.exe -B <state>\private\autostart.pyw` (`selector-start`, журнал `autostart.log`); без секретов и прав администратора, идемпотентно; `autostart --state status` — `enabled` и `current`.
- `selector-start`: `start --mcp-only` → selector с фактическим `mcp_url`; `vps` — свой tunnel-client остановить; `secure-tunnel` с туннелем — запустить; Windows — затем `vps_apply`, если есть `vps.json`.

### Активация при запуске Web Pilot

- При запуске (окно создано, сайдбар ещё не загружен) службы поднимаются, только если уже установлены (`prepared()`) и на macOS есть CLT; иначе их готовит мастер или первое использование, потому что запуск приложения не должен зависеть от служб (иначе чистый Mac не доходил до мастера, а окно без сайдбара выглядело зависшим).
- `activateRuntime` — одна общая попытка на запуск (старт, мастер, первое использование, Доктор — [project-doctor.md](project-doctor.md)); неудачная забывается и повторяется при следующем обращении, ошибка — в сайдбаре. `status` ничего не готовит.
- `MacRuntimeSwitcher.activate`: (1) macOS — записать plist LaunchAgent и `launchctl disable` на время перенастройки; (2) разовая очистка прежнего runtime, сбой не мешает; (3) `stop` → копия исходника в `<state>/source` (staging + rename) → `configure-selector` → `configure-channel`; (4) MCP: `status` → `setup` при необходимости → `start --mcp-only` → `LocalMcpClient.initialize`; (5) проброс VPS на фактический `mcp_url` (ошибка — только в статусе); (6) Secure и туннель настроен → `start --tunnel-only`, не готов → `RUNTIME_NOT_READY`; в канале VPS tunnel-client остаётся остановленным; (7) Windows — `autostart on` только после успешного старта и здесь не выключается; (8) macOS — `launchctl enable` при любом исходе, потому что неудачный старт (нет Codex, туннель офлайн) не должен отменять запуск при входе.
- После успеха сохраняется отметка очистки, на Windows `WorkspaceSetup` получает окружение MinGit, кэш контекста очищается.

### Компоненты Windows

- На Windows нет системного Python, поэтому `WindowsExecutorBootstrap` сверяет архив `Windows-Codex-Local-2026-09-10.zip` с `WINDOWS_RUNTIME_SHA256`, распаковывает только `vendor` (uv, tunnel-client, ripgrep, git; SHA-256 каждого по `manifest.json`) разборщиком `src/zip-archive.mjs` (CRC-32, без выхода за папку) в `runtime\tools` через staging (`tools.json` — последним) и создаёт Python: `uv venv --clear --managed-python --python 3.13`. Состав и SHA архива не меняются ([release.md](release.md)).
- `control.py` принимает исполняемые файлы только внутри `runtime\tools`; PATH служб — venv, MinGit, ripgrep, uv, `%APPDATA%\npm` (Codex CLI); loopback-проверки — мимо системного прокси. Git для Workflow Kit — только MinGit пакета (`WORKFLOW_GIT_BIN`). Коды `WINDOWS_RUNTIME_*`, `WINDOWS_GIT_*`.

### Разовая очистка прежних runtime

- Отметка `legacyMacRuntimeRetired` / `legacyWindowsRuntimeRetired`; до неё — `legacyRuntimeRoots` (≤8 путей из прежних настроек). Сбой не блокирует запуск и повторяется; отметка пишется только после полностью успешной активации.
- macOS: TERM группе только процессам, чья командная строка точно называет файлы прежнего корня (`.venv/bin/python` + `mcp/bridge_mcp.py` или `tools/tunnel-client … --profile mac-local`), при двух совпавших чтениях `/bin/ps` (переиспользованный PID дважды не совпадёт); `bootout` и удаление plist `com.oleynik.CodexLocalMac`, удаление `<userData>/runtime/Codex-Local-Mac` со служебными файлами.
- Windows: для корней с `.venv\Scripts\python.exe` (копия в userData, корни из настроек и `CodexLocalWindows\*.pid.json`) — `windows-control.py stop` (только записанные им процессы); удаление HKCU Run `ProjectWebPilotMCP` и копии в userData.
- Папки пользователя не трогаются: `~/VSCODE/Codex Local Mac`, `~/Library/Application Support/CodexLocalMac`, `%LOCALAPPDATA%\CodexLocalWindows`, выбранная папка прежнего сервера — их удаляет пользователь, не агент.
- Туннель переносится один раз (`adopt_legacy_tunnel` в `configure-selector`), если своих профиля и ключа нет, через обычный `configure_tunnel`; повреждённая настройка не переносится, ключ не печатается, прежние файлы не меняются.
- `macRuntimeMode: "app-server"` пишется, но не читается: откат на версию с переключателем backend останется на том же backend. Откат Windows на версию до исполнителя — сначала отключить автозапуск `ProjectWebPilotCodexExecutor`, иначе два сервера делят один туннель.

### Ошибки и инварианты

- Мастер показывает фиксированный текст `PREPARATION_ERRORS` с кодом, иначе общий; сырые stderr и аргументы — никогда. `APP_SERVER_RUNTIME_COMMAND_FAILED` — любой отказ `setup|status|start|stop|selector-start`; `RUNTIME_STATUS_INVALID` — не JSON или неполный статус; `RUNTIME_FOREIGN_PROCESS` — в статусе служба `running && !owned` («Перезагрузите компьютер…»); `APP_SERVER_SELECTOR_CONFIG_FAILED`, `APP_SERVER_AUTOSTART_FAILED`, `VPS_TUNNEL_COMMAND_FAILED` — отказ своей команды.
- Ключ туннеля: stdin/скрытый ввод → файл 0600 / DPAPI → окружение tunnel-client; не в argv, stdout, status, renderer (только булевы признаки), диагностике, recovery, Git, реестре, пусковых файлах и чате. Проверки не перезаписывают туннель живого подключения пользователя: у них свой каталог состояния и порты.

## Решения и запреты

### Не возвращать

- Второй backend — решение пользователя: Codex Local Mac (`mac-control.py`, `mac-first-run.py`, `MacRuntimeBootstrap`, `mac-runtime.zip`, `McpRuntime`) и прежний сервер Codex Local Windows (`WindowsRuntimeBootstrap`, `windows-first-run.py`), потому что macOS и Windows должны быть идентичны.
- Переключатель backend (режим `local`, `setMacRuntimeMode`, IPC `pilot:set-mac-runtime-mode`, `pilot:choose-runtime`, выбор папки runtime).

## Проверки

Автоматические (`.harness/workflow.json`):
- `unit-all` (`npm test`): тесты из `tests/*.test.mjs` на Windows и Linux; на macOS дополнительно `tests-macos/*.test.mjs` (включая `mac-runtime-switch`). Все файлы выполняются последовательно. Windows-проверки: `windows-runtime-switch`, `vps-tunnel`, `settings-chatgpt-channel`, `windows-runtime`, `windows-autostart`, `tunnel-prompt`, `tunnel-id-prompt`, `tunnel-id-runtime`, `startup-readiness`.
- `executor-channel` (`tests/codex-app-server-mcp.test.mjs`): состояние и порты, перенос туннеля без вывода ключа, `CODEX_NOT_FOUND` до установки, selector и канал при входе, identity в C-локали, службы Windows с подменой платформы.
- Electron smoke службы не запускает, `src/main.mjs` модульно не покрыт: после изменений — `node --check` и первый запуск установленной версии.

Ручные (пользователь):
1. Закрыть главное окно — MCP и туннель продолжают отвечать.
2. Перезагрузка — службы поднимаются при входе, канал соблюдён.
3. Переключение каналов в обе стороны; `../vps-server/setup/check-mcp.sh`; вызов из ChatGPT и Claude.
4. Установленная версия (только чтение): `control.py status` — MCP `running/owned/ready`, selector без `local`; LaunchAgent включён, `source/` = пакет, отметка очистки есть, `com.oleynik.CodexLocalMac` и `bridge_mcp.py` не запущены, папки пользователя на месте.

## Открыто

- Windows вживую не проверена: автозапуск после перезагрузки, DPAPI, `icacls`, реестр, `msvcrt`, uv и загрузка Python, OpenSSH/VPS, `taskkill`, антивирус, переход с прежней версии. Риски: при неудачной остановке прежнего сервера два tunnel-client временно делят один туннель; ssh наблюдателя, убитого не через `control.py`, держит удалённый порт и мешает новому пробросу; скрипта настройки сервера для Windows в vps-server может не быть.
- macOS: если сервер убран из `~/.ssh/config`, LaunchAgent VPS не выгружается и перезапускает ssh каждые 15 с (на Windows наблюдатель останавливается).
- Коннектор Claude к VPS не создан и не проверен (локальный CLI для [Review](plan-review.md) от него не зависит); OAuth для коннекторов отложен; запуск служб до входа в ОС не реализован.
- Отложено: `Condition` вместо опроса вывода Python; `AbortController` для первой навигации.
