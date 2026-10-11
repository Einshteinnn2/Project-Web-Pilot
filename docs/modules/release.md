# Выпуск

Парная сборка macOS arm64 и Windows x64 на Mac-хосте, подпись, установка постоянного macOS-приложения с сохранением identity, поставка ZIP и публикация GitHub Release по поручению пользователя. Не входят: мастер первого запуска ([first-run-onboarding.md](first-run-onboarding.md)), службы ([runtime-lifecycle.md](runtime-lifecycle.md)), исполнитель ([codex-app-server-executor.md](codex-app-server-executor.md)), порядок задач плана и push-hook ([контракт Kit](../../packages/workflow-kit/docs/modules/workflow-kit-package.md)).

## Код

- `package.json` — версия и скрипты: `build` → `scripts/release-all.mjs`; `build:mac` = `check:mac-signing` → `prepare:mac` → `build:mac:package` → `sign:mac` → `release:mac`; `build:win` = `prepare:win` → `build:win:package` → `verify:win`; хуки `pre*` запускают `stage:workflow-kit` и `stage:page-observer`.
- `scripts/`: `release-all.mjs` (`releaseAll`, `sourceSnapshot`, `verifyPackagedSources`, `PACKAGED_ROOTS`, `releaseAssetNames`), `release-mac.mjs` (`publishMacRelease`, `installMacBundle`, `backupSlot`), `sign-mac-bundle.mjs`, `check-mac-signature.mjs`, `prepare-{mac,windows}-toolchain.mjs`, `verify-windows-package.mjs`, `check-{installed-release,github-release,mac-screen-capture}.mjs`, `stage-*.mjs`.
- `src/platform.mjs` `BUNDLED_NODE_VERSION`; `src/windows-runtime.mjs` `WINDOWS_RUNTIME_ARCHIVE`/`_SHA256`; `resources/mac-permissions.plist`; `BUILD_WINDOWS.cmd` — узкий `build:win` на Windows-хосте, не выпуск.

## Результат выпуска

- **Постоянное приложение** `<repo>/Project Web Pilot.app` (основной Mac: `/Users/oleksandroliinyk/VSCODE/Project Web Pilot/Project Web Pilot.app`): имя и путь не зависят от версии, пользователь один раз делает на него Finder-алиас. Вторая цель — `/Applications/Project Web Pilot.app`. Обе обновляются каждым выпуском с сохранением device/inode `.app`; другие копии выпуск не трогает.
- **Каталог выпуска** `.harness/runtime/releases/<v>/`, **поставка** `~/Downloads/WebPilot-<v>/`. Шесть файлов релиза (`releaseAssetNames`): `Project-Web-Pilot-<v>-macOS-arm64.zip`, `Project-Web-Pilot-<v>-Windows-x64.zip`, `Windows-Codex-Local-2026-09-10.zip`, `SHA256SUMS.txt`, `INSTALL.txt`, `release-manifest.json`. `…-macOS-arm64.zip.sha256` от `release:mac` лежит в поставке, но не asset.
- `SHA256SUMS.txt` — `<sha256>  <file>` для двух ZIP и архива компонентов. `INSTALL.txt` генерируется (`Project Web Pilot <v>` первой строкой; для Windows — распаковать всю папку, нужен Codex CLI, «Codex App Server Local Windows», свой туннель, ARM64 через эмуляцию x64).
- `release-manifest.json`: `version, sourceCommit, sourceFiles, packagedSourceMatches, workflowKit, identity{device,inode,volumeUUID}` корневого app, `macCodeSignature`, `artifacts[]` (платформа, файл, размер, SHA ZIP и ASAR, число файлов исполнителя), `windowsRuntimeArchive`, `nativeWindowsTested:false`, `cleanVmTested:false`. Хеши и sourceCommit выпуска в документы не пишутся.
- Готовность — только при успешных сборке обеих платформ, установке и упаковке.

## Процедура выпуска

Полный выпуск: код → версия → DOCS → сборка → установка → GitHub. Исследовательские проекты без релизов исключены; явное поручение полного выпуска позволяет публикацию без нового вопроса. Последний опубликованный выпуск — **0.6.113** (Kit 1.7.2): AutoPlan ON до плана и после Recovery другого основного чата. **Текущий план готовит 0.6.114** с настраиваемой ротацией Chat (N=1–10): T008 — версия и preflight `release-source` (тип `test`, до DOCS), DOCS — актуализация документов, **T009** — единственная парная сборка, **T010** — установка готового Mac, **T011** — публикация GitHub. Delivery — отдельные задачи `package/installed`.

1. **Работа.** Кодовые задачи, включая версию в `package.json` и `package-lock.json` (строго `X.Y.Z`, новая на каждый выпуск; packager берёт её из `package.json`, `--app-version` не передаётся). Версия Kit — отдельно (`packages/workflow-kit/package.json` + `VERSION` в `src/lib/common.mjs`). Evidence-строки delivery-проверок в `.harness/workflow.json` называют номер версии — обновлять через `config:apply` полной конфигурацией. До DOCS проходят `unit-all`, `electron-smoke`, `codex-tools-live`; при правке Kit — `kit-check`.
2. **DOCS.** Все документы, включая README и контракты ротации, фиксируются после T008 и до сборки. Если после DOCS добавляется код, требуется новая DOCS-итерация. `release-manifest.sourceCommit` = HEAD после DOCS перед сборкой, Git-тег указывает на тот же исходный коммит.
3. **Перед сборкой**: файлы снимка (`src`, `resources`, `tools/codex-app-server-mcp`, `package*.json`, `LICENSE`) закоммичены — иначе `release-all` отказывает («Packaged sources have uncommitted changes»), потому что `sourceCommit = HEAD`. Preflight `.harness/runtime/release-<v>-preflight.json` (`{path, device, inode, volumeUUID, bootSessionUUID}` корневой копии и `/Applications`) записывает сам `release-all` при первом запуске версии (`recordReleasePreflight`). Подпись: `npm run check:mac-signing`.
4. **Сборка**: `paired-release` вызывает `npm run build` **только в T009**, один раз после `release-source` и DOCS. Не запускать вручную: повтор после manifest отклоняется.
5. **Установка** (`installed`, проверка `release-installed`): `/Applications` обновляется из готового staging `.harness/runtime/build/Project Web Pilot-darwin-arm64/Project Web Pilot.app` вызовом `installMacBundle({source, target:'/Applications/Project Web Pilot.app', backupRoot:'.harness/runtime/release-backups.noindex', version})` из корня репозитория, без пересборки; npm-команды нет.
6. **Публикация** (`package`, проверка `github-release`) — только по поручению пользователя (в scope или отдельным сообщением); без него выпуск остаётся локальным. Push `main` и тега `v<v>` на sourceCommit, Release из `~/Downloads/WebPilot-<v>/`, проверка; коммит задачи тоже уходит в `main`; задача завершена, когда проверка прошла после финального push. Push до завершения DOCS отклоняет hook Kit (`DOCS_BEFORE_PUSH`); `--no-verify` запрещён.

Правка кода после завершённой сборки — следующей версией. Упал `paired-release` до manifest — версию не повышать, разобрать `paired-release.lock` и `releases/<v>/`. Дефектную сборку, не ставившуюся в `/Applications` и не опубликованную, можно пересобрать из того же дерева после удаления её `releases/<v>/` и поставки — только с согласия пользователя. Поставку и выбор подписи не трогать до конца выпуска: их читают `release-installed` и `github-release`.

## Сборка

**Инструменты.** `prepare:mac`: uv 0.9.13 (первый кандидат с закреплёнными SHA-256 и версией: `WEB_PILOT_UV`, `mac-tools/uv`, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`) и Node 24.21.0 darwin-arm64 с nodejs.org по закреплённому SHA (архив проверяется до распаковки) → `.harness/runtime/mac-tools/`. `prepare:win`: архив компонентов (`WINDOWS_RUNTIME_SHA256`) из кеша `.harness/runtime/windows-payload/` → `WEB_PILOT_WINDOWS_RUNTIME_ARCHIVE` → `windows-app/resources/windows-payload/` → `releases/latest/download/<архив>`, только при совпадении SHA; `node-v24.21.0-win-x64.zip` по закреплённому SHA → `.harness/runtime/windows-node`. Electron 44.5.1/Node 24.21.0 зашиты и в `check-installed-release.mjs`: при смене стека менять там же, в `package.json`, `BUNDLED_NODE_VERSION`, SHA в `prepare-*` и путь Node в `BUILD_WINDOWS.cmd`.

**Упаковка.** electron-packager `--asar` → `.harness/runtime/build/`, extra-resource `resources` и `tools/codex-app-server-mcp`, плюс `.harness/runtime/mac-tools` (macOS: `--arch=arm64 --app-bundle-id=com.oleynik.ProjectWebPilot --extend-info=resources/mac-permissions.plist` — микрофон, геолокация) или `.harness/runtime/windows-payload` и `windows-node` (Windows `--arch=x64`). `--ignore` — allowlist: в `app.asar` только `PACKAGED_ROOTS` = `src`, `node_modules`, `package.json`, `LICENSE`, потому что denylist пропускает неотслеживаемые папки (например «Claude outputs» с видео пользователя). Исполнитель — физический extra-resource, в ASAR не дублируется. `resources/workflow-kit` (копия `packages/workflow-kit/src`) и `resources/chatgpt-page-observer-preload.cjs` генерируются stage-скриптами и не хранятся в Git; `.gitattributes` держит `resources/workflow-kit/**` в LF, иначе CRLF на Windows ломает сверку SHA Kit.

**`npm run build` (`releaseAll`)** — только macOS-хост, версия `X.Y.Z`:
1. Лок `mkdir .harness/runtime/paired-release.lock` (у `release:mac` — `mac-release.lock`); после убитого процесса остаётся — удалить вручную, убедившись, что сборка не идёт.
2. Есть `releases/<v>/release-manifest.json` → отказ. Kit stage-ится и сверяется с `packages/workflow-kit/src` (набор файлов и SHA).
3. Снимок: `package.json`, `package-lock.json`, `src/**`, `resources/**`, `tools/codex-app-server-mcp/**` без `__pycache__`/`.pyc` и `.DS_Store`; `sourceCommit = git rev-parse HEAD`.
4. `build:mac`, затем `build:win`; ошибка останавливает дальнейшее. Снимок сверяется заново (`Sources changed during build`).
5. `verifyPackagedSources` (mac staging, win staging, корневой app): `package.json` в ASAR = корневой без `private`/`scripts`/`devDependencies` (`Packaged runtime manifest mismatch`); файлы снимка побайтно (`Packaged source mismatch`); нет вложенного app (`Nested app in package`); верх ASAR только `PACKAGED_ROOTS` (`Unexpected files in package`).
6. ASAR корневого app = staging; версия в Info.plist; device/inode корневого app не изменились (`Installed app identity changed`); `mac-tools` = `.harness/runtime/mac-tools`; подпись = receipt `mac-release.json`.
7. Windows ZIP — `ditto -c -k --keepParent --norsrc`. Оба ZIP: `unzip -tq`, `app.asar` и файлы исполнителя внутри = staging/исходники. Архив компонентов — по закреплённому SHA. Копии в поставке сверяются по SHA-256; `SHA256SUMS.txt`, `INSTALL.txt`, manifest пишутся в `releases/<v>/` и в поставку.

`release:mac`: ZIP `ditto -c -k --sequesterRsrc --keepParent`, `unzip -tq`, сверка распакованной копии (версия, ASAR, Info.plist, подпись), установка корневого app, `releases/<v>/{zip, .zip.sha256, mac-release.json}`, ZIP с `.sha256` — в поставку. Сборка не трогает настройки, профиль, проекты, чаты и работающее приложение; оно остаётся старой версией до полного выхода (⌘Q).

## Подпись macOS

- Решение пользователя: постоянная подпись Apple Development с requirement без `cdhash`, потому что TCC привязывает Screen Recording к designated requirement, а ad hoc-подпись меняет CDHash каждой сборки и разрешение теряется (inode `.app` бережёт только алиас). Сертификат — существующий UkrHD (TeamID `LXY7H5ZUE9`); не менять, ключи не создавать и не экспортировать.
- Выбор явный: `WEBPILOT_MAC_SIGNING_IDENTITY` (SHA-1, 40 hex; приоритет) или `.harness/runtime/mac-signing.json` `{"identity":"<SHA-1>"}` (обычный файл, не symlink). SHA-1 должен соответствовать ровно одному имени в `security find-identity -v -p codesigning`, имя `Apple Development: …`. Коды `MAC_SIGNING_PLATFORM|IDENTITY_REQUIRED|CONFIG_INVALID|IDENTITY_UNKNOWN|IDENTITY_TYPE|BUNDLE_INVALID` (не `.app`, symlink, чужой bundle id, версия ≠ `package.json`) останавливают `build:mac`.
- `sign:mac`: `@electron/osx-sign` 2.7.0, `type: development`, `strictVerify`, `hardenedRuntime: false`, `timestamp: 'none'`; без provisioning profile, нотаризации, Developer ID. `Contents/Resources/mac-tools` исключён: Node и uv сохраняют свои подписи и SHA, ресурсы запечатаны подписью приложения.
- `verifyMacSignature`: `codesign --verify --deep --strict`, Identifier, не adhoc, Sealed Resources, привязанный Info.plist, requirement без `cdhash`, SHA-1 листового сертификата = выбранный, TeamIdentifier = OU → `macCodeSignature` в manifest.
- Смена подписи: пользователь полностью перезапускает Web Pilot и исполнитель и один раз выдаёт разрешение. Агент не нажимает consent, не правит TCC.db, не делает общий сброс, не меняет Full Disk Access; `tccutil reset ScreenCapture com.oleynik.ProjectWebPilot` — один раз и только при доказанном несовпадении requirement.

## Установка macOS (`installMacBundle`)

- Источник ≠ цель, цель — `*.app`; источник и существующая цель — настоящие каталоги (не symlink, только `Contents`), bundle id `com.oleynik.ProjectWebPilot`, версия ASAR = `CFBundleShortVersionString`; у источника она = ожидаемой и подпись валидна; иначе отказ без изменений.
- `ditto` во временный `.web-pilot-install-*` рядом с целью и сверка (version, asarSha256, plistSha256, signature); старый `Contents` → backup, новый — на место, повторная сверка. Каталог `.app` сохраняет device/inode (`App directory identity changed` → откат), потому что на identity держится Finder-алиас; при любой ошибке прежний `Contents` возвращается.
- Backup — `.harness/runtime/release-backups.noindex` (`.noindex` скрывает Helper-приложения от Spotlight): на цель один слот `mac-<родитель>-<sha256(путь)[0:12]>` с предыдущим `Contents`, без накопления (копии выпусков занимали десятки ГБ); первая установка копии не создаёт. Сбой замены слота → `backupError`, копия остаётся во временном `mac-*`, установка успешна.
- После установки: полный выход (⌘Q), запуск через прежний алиас; если менялся каталог MCP — Refresh коннектора в ChatGPT/Claude и новая сессия.

## Windows-пакет

- Собирается и проверяется на Mac без запуска: это доказывает лишь отсутствие ошибок упаковки.
- `verify:win`: `Project Web Pilot.exe` (PE, ≥1 MiB); `app.asar`; архив компонентов по SHA, в vendor-списке ровно по одному uv, tunnel-client, ripgrep, git; portable Node (архив по SHA, `node.exe` PE ≥10 MiB); Kit = `packages/workflow-kit/src`; `workspace-setup-worker.mjs`; 8 `WINDOWS_EXECUTOR_FILES`; есть `runtime-control/windows-control.py` (останавливает прежний Windows-мост при обновлении); нет `windows-first-run.py` и `Contents/Info.plist`; исходники совпадают.
- Архив компонентов (~82 MiB) не в Git (больше лимита снимка Kit 16 MiB, `FILE_TOO_LARGE`) и публикуется в каждом релизе, потому что чистый клон собирает Windows через `latest/download`. Из него берутся только uv, tunnel-client, ripgrep, MinGit; состав и SHA не менять.

## Публикация на GitHub

- Репозиторий `OleynikAleksandr/Project-Web-Pilot` (публичный); токен — `git credential fill`. Runtime, ключи, профиль, конфиг подписи и app bundle — в `.gitignore`.
- Push только fast-forward, старые теги не перемещаются. Release создаётся черновиком, после загрузки шести файлов серверные size и digest сверяются с поставкой, затем публикуется (ручные шаги, скрипта нет).
- Контракт `github-release`: `origin/main` = локальный HEAD; удалённый тег `v<v>` (peeled) = `sourceCommit`; Release не draft/prerelease; assets — ровно шесть имён `releaseAssetNames`, `size` и `digest = sha256:<hex>` = файлам поставки.

## Решения и запреты

- Решения пользователя: один постоянный путь для алиаса; app и ZIP — самостоятельные результаты; платформы — одним номером.
- `build:mac`/`build:win` — узкие операции; `release:mac` после парной сборки не запускать: он пересоздаст ZIP и переустановит корневой app, ZIP разойдётся с manifest.
- Корневой app исключён из Git и упаковок, иначе следующая сборка вложит предыдущую.
- Между сборкой, установкой и публикацией не пересобирать: `/Applications` и GitHub получают ровно проверенную сборку. Сборка — не приёмка: живой ChatGPT, чистую ОС и Windows проверяет пользователь.

Не возвращать: ad hoc-подпись, автовыбор или fallback сертификата; denylist `--ignore`; релиз без архива компонентов Windows; тег не на sourceCommit (на коммит delivery-задачи или на DOCS после сборки); `release-backups/` с накоплением; в пакетах `mac-runtime.zip`, `mac-control.py`, `mac-first-run.py`, `windows-first-run.py`.

## Проверки

Автоматические: `tests/release-all.test.mjs`, `tests/release-mac.test.mjs` (macOS), `tests/sign-mac-bundle.test.mjs`, `tests/mac-toolchain.test.mjs`, `tests/windows-runtime.test.mjs`, `tests/workflow-kit-source.test.mjs`. `.harness/workflow.json`: **до DOCS** — `unit-all`, `electron-smoke` (ротация N=1/N=4 и регрессии), `release-source` (обычный `test`), `codex-tools-live`, при изменении Kit — `kit-check`; **только delivery** — `paired-release`, `release-installed`, `github-release`. `release-installed` сверяет исходники, подпись, manifest и preflight volume UUID/inode, поставку, Electron/Node, Windows-payload, Kit CLI и observer/AutoPlan fixture без перезапуска пользовательского приложения. Дополнительно: `npm run verify:win`, `node scripts/check-workflow-kit-staging.mjs`.

Ручные/живые:
- **Подписи** — `node scripts/check-mac-signature.mjs`: staging, обе установки, ZIP поставки; identity по volume UUID + inode (device — в той же загрузке) → `.harness/runtime/mac-signature-check.json`.
- **Захват экрана** после смены подписи/обновления — `node scripts/check-mac-screen-capture.mjs` (`--preflight` — без захвата): одна запущенная корневая копия (основная — по решению пользователя) и MCP по адресу из selector запущены после подписи (иначе `MAC_CAPTURE_RESTART_REQUIRED`), разрешение выдано вручную (иначе `MAC_CAPTURE_PERMISSION_REQUIRED`); нужен PNG и TCC attribution на текущий Web Pilot без «Failed to match existing code requirement». Службы не перезапускает; отрицательный тест подписи — только на временной копии.
- **Поставка**: `shasum -c SHA256SUMS.txt`; `unzip -tq`; `unzip -l` без «Claude outputs», `.mp4`, `mac-runtime.zip`, `mac-control.py`, `mac-first-run.py`; `plutil -lint resources/mac-permissions.plist`; в Info.plist три ключа разрешений и верный `CFBundleIdentifier`.
- **Независимая проверка** агентом ChatGPT (только чтение, `control.py status`): версия `/Applications`, MCP «Codex App Server Local Mac» с 9 инструментами и `bridge_status`, службы ([runtime-lifecycle.md](runtime-lifecycle.md)), SHA `app.asar` = manifest.
- **Приёмка пользователем (macOS)**: после полного выхода проверить Recovery новых Chat/Work без повторного Send; **0.6.114 — Settings N=1 и N=4, AutoPlan ON, Git DONE → новый Chat → Recovery → одно Continue, старый Chat молчит; OFF не ротирует, Work/parallel не ротируются, ошибка явно останавливает цепочку**. Также [Review](plan-review.md#проверки-и-пользовательская-приёмка), архив, тема, Доктор, туннели, чистая установка. Native Windows и чистая macOS — отдельная живая проверка; фикстуры их не заменяют.
- **Восстановление чата**: при работающем Review длительное ожидание не открывает блок связи. При реально обнаруженной ошибке «Перезагрузить страницу чата» объясняет причину, сохраняет текущий чат, не повторяет сообщение; черновик, UNKNOWN и пауза ограничения запросов защищены. Fixture-проверки этого пути не подтверждают живой ChatGPT.

## Открыто

- Опубликованная **0.6.113** содержит AutoPlan ON до подтверждённого нового scope и перенос после Recovery другого основного чата. Исходники **0.6.114** добавляют ротацию Chat по подтверждённым DONE (1–10), без потери задач и с защитой от повторной отправки. Проверены Node и Electron TEST FIXTURE, **не** живой ChatGPT/native Windows. Выпуск 0.6.114: только T009/T010/T011 **после DOCS**, без принудительного перезапуска работающего app/MCP.

- **Риск uv.** `mac-tools/uv`, перезаписанный на месте, macOS может убить SIGKILL при `uv --version` (лечится свежей копией с тем же SHA); `prepare-mac-toolchain.mjs` копирует поверх существующего файла.
- **Native Windows не принята** на исполнителе Codex App Server: окна/снимки Win32, DPAPI, `icacls`, реестр, uv/Python, PowerShell, OpenSSH/VPS, `taskkill`, антивирус, переход с прежней версии, автозапуск, 9 инструментов, стартовое сообщение, автопродолжение; пути поиска Codex на Windows — предположение. До приёмки рабочая Windows-версия — 0.6.95; откат на Windows — её установка.
- **Не проверялись**: первый запуск на чистой macOS (с Codex и без), автозапуск после перезагрузки, откат. Процедура отката (слот `release-backups.noindex` или прошлый GitHub Release) не описана.
