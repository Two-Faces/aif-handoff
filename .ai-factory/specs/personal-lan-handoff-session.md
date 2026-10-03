# Запуск сессии разработки персонального Handoff

> [ТЗ](personal-lan-handoff.md) · [План](../plans/personal-lan-handoff.md) · [Проекты](personal-lan-handoff-projects.json)

Этот текст предназначен для уже созданной пользователем сессии в проекте `E:\Projects\aif-handoff`. Создание/отправка сообщения в другую сессию этим документом не выполняется.

## Промпт

```text
Работаем над моим форком https://github.com/Two-Faces/aif-handoff.
Прочитай AGENTS.md, CHECKLIST.md, .ai-factory/RULES.md и:
- .ai-factory/specs/personal-lan-handoff.md
- .ai-factory/plans/personal-lan-handoff.md
- .ai-factory/specs/personal-lan-handoff-projects.json

Мне нужны автономные доски и продолжение разработки между Windows и Mac.
Оба устройства работают отдельно и синхронизируются, когда встречаются в LAN.
Одна задача имеет одного владельца исполнения; разные задачи могут выполняться
на разных компьютерах. Для Electron/macOS и iOS Simulator нужны связанные
задачи сборки/QA на подходящем устройстве и проверка конкретного коммита.

Это доработка существующего Handoff: Codex adapter, доска и локальный MCP уже есть.
Сначала сверяй план с актуальной ревизией. M1 (P01–P09) принят после нативной
проверки Windows/Mac 02.10.2026 и опубликован пользователем до b523143.
Продолжай M2 в codex/personal-lan-handoff-m2 в E:\Projects\aif-handoff:
по просьбе пользователя эта ветка теперь открыта в основном checkout/IDEA.
Вспомогательный managed worktree оставлен detached на c51f3fc; не продолжай
там старую копию. Слияние M2 в codex/personal-lan-handoff — после готовности M2.
Нативные M1-серверы и их данные сохраняй; quality gate запускай отдельно.
В shared добавлены taskCheckout.ts/taskCommit.ts: exact detached checkout,
scope до начала записи, checkpoint через temporary index и namespaced ref.
Local migration v34/taskWorkspaces.ts сохраняет scope до записи и commit intent
до Git publication. Registered roots подключены к stage/API/chat guards,
а API/auto-queue checkpoints восстанавливаются по исходному журналу.
Local v35 продолжает sealed workspace в новом checkout из immutable code/context
snapshot: reservation до materialization, atomic root/scope activation после неё.
P11 descriptor/manifest/blobs реализованы; смотри актуальные проверки в плане.
Пользователь подтвердил native Mac tests локальных helpers: shared 40 passed
(taskCheckout + contextSnapshot), data 11 passed (taskWorkspaces), 02.10.2026.
P10 остаётся открытой для onboarding/run gates; полный межмашинный handoff,
network code/blob transfer и stop/fencing этими тестами ещё не проверены.
Не восстанавливай принадлежность dirty files новым scope после restart и
не подменяй grants/fencing журналом: он не останавливает уже запущенный процесс.
P12 добавляет explicit Git/context transfer через pinned TLS, durable chunks v36
и Git quarantine. Итоговый Windows ai:validate прошёл: 3296 passed, coverage ≥70%,
build/Chromium/k6/protocol зелёные. Двухпроцессные TLS/crash tests прошли.
Пользователь подтвердил native Mac smoke P12 02.10.2026: shared 6 passed,
data 4 passed, API 12 passed (включая два процесса и loopback TLS), всего 22.
Реальный Win↔Mac code transfer и полный handoff ещё открыты.
P13 v37 grants/run fencing foundation прошла 54 native Mac tests 03.10.2026.
Реализованный блок 29e718d подключает scopes к полному lifecycle coordinator/API/chat,
runtime promises/callbacks, timeout/abort и finalization. v38/deviceSessions.ts
сохраняет provenance native/chat sessions по task/grant/root/runtime, без sync.
Не используй project warmup или произвольный native session в managed checkout.
Uncertain run нельзя очистить по TTL; personal AI по-прежнему запрещён.
Windows ai:validate lifecycle прошёл: 3358 passed / 1 existing skip, coverage ≥70%.
03.10.2026 пользователь подтвердил native Mac smoke: shared 30, data 41,
API 16, agent 19 — всего 106 passed. P13 закрыт в объёме grants/fencing/lifecycle;
полный Mac ai:validate и физический handoff этими тестами не подтверждены.
P14 начат: v39/deviceHandoff.ts добавляет durable journal, ручную остановку
для human tasks без managed run history, frozen code/context и atomic release.
Pinned offers/receipts и explicit acceptance сохраняют root/scope/epoch после crash;
grant head accepted не исполняется до отдельного явного продолжения P15.
Windows ai:validate первого блока прошёл: 3386 passed / 1 existing skip,
coverage всех пакетов ≥70%, build 7/7, Chromium 8/8, k6 3/3.
03.10.2026 пользователь сообщил об успешном прохождении всех тестов на Mac:
целевой smoke журнала для 7ec806c принят (61 shared + 50 data + 9 API = 120).
Evidence получено от пользователя; полный Mac ai:validate и физический handoff
этим не подтверждены.
Второй подблок P14 реализует Windows Job Object supervisor и v40 journal
task_device_processes: host identity до CreateProcess, suspended child receipt
до ResumeThread, native empty-job proof и recovery по PID+birth/job identity.
Внутренний API bridge связывает их с durable run, но не снимает grant/claim.
Успешный JS return при незавершённом process journal оставляет run uncertain.
Windows ai:validate второго блока прошёл на финальном коде: 3410 passed / 1 existing
skip, coverage всех пакетов ≥70%, build 7/7, Chromium 8/8, k6 3/3; лог
.codex/m2/logs/supervision-final-validate.log. Общий Mac smoke v40 принят
03.10.2026 по сообщению пользователя о прохождении тестов: целевой набор
для d63cd8b — 25 shared + 36 data = 61; команды в docs/local-device-sync.md.
Это не подтверждение полного Mac ai:validate, native Mac stop или физического handoff.
Полный P14 ещё открыт: transport integration всех четырёх adapters,
autonomous checkpoint/release и native Win/Mac handoff.
Personal AI не включать; manual confirmation не заменяет native proof.
Подготовлен Mac capability probe: `npm run probe:macos-supervision --workspace @aif/runtime`.
Он компилирует фиксированный C fixture в private temp, использует отдельный nonce
launchd service, проверяет resource-coalition counters, orphan после double-fork/setsid,
kernel stale-token rejection и cleanup. Это не production backend и не execution grant.
Первый JSON report Mac (arm64, kernel 27.0.0) подтвердил C compilation, оба symbols,
отдельную coalition и cleanup. Probe остановился до forks: начальные накопительные
счётчики 2/1/1 вместо ошибочно ожидавшихся 1/0/1. Диагностика исправлена на стабильный
root-only baseline и точные последующие deltas.
Повторный полный JSON report пользователя принят 03.10.2026: probe_passed,
blockers=[], cleanupVerified=true, grantsExecution=false. Baseline 2/1/1 совпал
с initialConfirmed; running 4/2/2, orphan 4/3/1. Child после setsid/double-fork
остался в той же coalition с ppid=1; stale audit token отвергнут ядром (ESRCH=3),
после остановки и снятия service coalition отсутствует (ESRCH=3).
Это native diagnostic fixture, не готовый production supervisor или stop receipt.
Mac launch/recovery backend реализован в runtime macosSupervisor.ts /
macosSystem.ts / macosNativeSource.ts. Целевой native runtime/API набор принят
03.10.2026 по выводу пользователя после обновления для `2f62264`:
**54 runtime + 2 API = 56 passed**, без failures и неисполненных cases.
Runtime: 20 OS-boundary + 25 protocol + все 9 native process tests, 19:22:21,
16.30s. API: оба native journal/recovery tests, 19:22:39, 3.94s (Europe/Moscow).
Среда, зафиксированная при приёмке: macOS 27.0.1, arm64, Node 22.22.2.
Evidence получено от пользователя; Mac удалённо не запускался. В этом отчёте
нет отдельных shared/data результатов или полного Mac ai:validate.

Одноразовый launchd host, закрытый Unix socket, posix_spawn START_SUSPENDED,
durable host/child callbacks и независимая проверка пустой coalition после exit.
Mac receipts хранят UID/boot UUID/unique IDs в существующем JSON journal v40;
старые migrations не менялись. Recovery сохраняет stop, не снимая run/grant.
Проверены stdin/EOF и 64 KiB binary round trip, detached grandchildren,
отказ persistence до записи, helper death, caller death до/после resume.
Kernel peer audit token проверяется до передачи target args. Принятые исправления:
SDK-safe names, boolean JSON для stopped, AsyncResource context для callbacks,
восстановление чтения Socket после inherited-stdio query и отдельный Base64 stdin
limit. История неуспешных прогонов сохранена в плане и docs/local-device-sync.md;
не повторять прежние указания о неподтверждённом native backend как текущий статус.

Предыдущий Windows gate исходников `2f62264`: ai:validate exit 0,
3495 passed / 10 skipped (9 native Mac-only + 1 прежний), coverage всех пакетов
≥70% (runtime минимум 74.82%), build 7/7, Chromium 8/8, k6 3/3,
protocol CLI 0.145.0; .codex/m2/logs/macos-stdin-limit-final-validate.log.
Полный дополнительный targeted
набор включает 13 shared + 7 data + 54 runtime + 2 API = 76; не приписывать
пользовательскому отчёту 56 tests прохождение всех 76.

Первый adapter increment P14 реализован: nativeProcessScope.ts связывает один
native stdio launch с host-owned capability/exact root, bounds input/output и
ожиданием durable native stop перед результатом. Codex app-server использует
async launcher, без start-timeout retry. Registry пропускает process-spawning
model discovery при таком scope. Windows native env добавляет OS essentials
libuv без ambient credentials/NODE_OPTIONS; допускается literal exe без shell.
API runTaskDeviceAppServer — внутренний bridge для уже enrolled standalone task
в active run и новом session; task/project/root, resume/fork и personal policy
проверяются до запуска. Worker/chat/routes пока не вызывают этот helper.
Все четыре adapters проверены: остальные transports явно отклоняют native scope.
Целевые Windows tests: 37 runtime (16 scope/parity + 21 app-server), 5 API с
реальным supervisor/SQLite и offline JSON-RPC fixture. Mac отчёт пользователя
03.10.2026 в textClipping 08-19-06 подтверждает 16 scope/parity + все 5 native API
tests (21 passed). Первоначально ещё 21 app-server test не выбран из-за пути
appServer/tests вместо appServer/__tests__. После исправления selector пользователь
прислал 21/21 run.test.ts (20:21:26, 1.02s). Целевой Mac smoke для 0195064 принят:
16 scope/parity + 21 app-server + 5 native API = 42 passed. Это не полный Mac
ai:validate, платный provider smoke или приёмка полного P14/M2. Повторять эти
команды без новых изменений не нужно. Personal AI и public admission ещё закрыты.
Финальный Windows ai:validate нового блока прошёл 03.10.2026: exit 0,
3515 passed / 10 skipped, coverage всех пакетов ≥70% (runtime min 74.91%,
API min 70.67%), build 7/7, Chromium 8/8, k6 3/3, protocol CLI 0.145.0.
Лог .codex/m2/logs/native-adapter-final-validate.log; sources во время прогона
не менялись. Root/runtime/API checklists и все четыре adapters проверены.

Следующий внутренний increment уже добавляет Codex CLI: runTaskDeviceCli делит
gate/journal с app-server, допускает только новую сессию и generated JSONL argv.
Custom argv, resume/fork, unknown fallback, глобальные session-limit scans и retry
запрещены. Explicit cli распознаётся корректно. Collector ждёт native proof и
drained stdio, сохраняет UTF-8/final line, ограничивает combined output 16 MiB,
требует zero exit + turn.completed и отвергает abort/protocol/callback failures.
SupervisedStdioProcess.waitForExit учитывает completion до установки listeners; stop не зависит
от consumer drain. Windows targeted: 106 runtime + 9 API. Финальный ai:validate
CLI блока прошёл 03.10.2026: exit 0, 3534 passed / 10 skipped, coverage всех пакетов
≥70% (runtime минимум 75.09%, API 70.72%), build 7/7, Chromium 8/8, k6 3/3,
protocol CLI 0.145.0. Лог .codex/m2/logs/native-cli-final-validate.log; восемь
package source/test hashes не изменились. Root/runtime/API checklists проверены.
Целевой Mac smoke CLI принят 03.10.2026 по textClipping пользователя 08-54-15:
85 runtime + 9 API = 94 passed для блока ba3347e. Runtime 20:52:22 / 1.04s,
API 20:52:26 / 15.06s; все три native CLI случая success/abort/timeout прошли.
Это offline protocol fixture с реальным supervisor, не полный Mac ai:validate,
платный provider smoke или включение обычного исполнения/personal AI.
Повтор этих команд без новых изменений не нужен; детали в docs/local-device-sync.md.

Новый SDK increment: runTaskDeviceSdk запускает реальный SDK 0.145.0 в фиксированном
Node worker под native supervisor; private CLI spawn SDK наследует ту же unit.
Host-resolved module URL, payload ≤1 MiB через stdin без secrets в argv, validated
SDK events и fenced host callbacks. Общий nativeBatch.ts используется CLI/SDK:
bounded output, UTF-8/drain, native stop/journal, без retries. Новая text-only
session; custom config/argv, execution hooks/env, outputSchema, resume/fork и
глобальные session scans запрещены. SDK schema cleanup/внутренний stderr buffer
не считать покрытыми. Windows targeted 109 runtime + 15 API, включая настоящий SDK
с offline CLI fixture, parent PID, abort/timeout и crash recovery. Финальный Windows
ai:validate прошёл: exit 0, 3572 passed / 10 skipped, coverage всех пакетов ≥70%
(runtime минимум 75.30%, API 70.65%), build 7/7, Chromium 8/8, k6 3/3, protocol
CLI 0.145.0. Лог .codex/m2/logs/native-sdk-final-validate.log; все 12 package
source/test hashes совпали до/после gate. 03.10.2026 пользователь подтвердил
«Тесты зеленые» в ответ на SDK smoke-команды для 068b777: запрошенный набор
109 runtime + 15 API = 124 tests. Целевая Mac приёмка принята по подтверждению;
подробные logs/длительности/счётчики в этом сообщении не приложены. Повтор без
изменений не нужен. Это не полный Mac gate или live provider run.
Public/normal/personal execution ещё не включать.

Следующий increment Claude SDK: runTaskDeviceClaudeSdk запускает реальный Agent
SDK 0.3.220 и CLI в фиксированном Node worker внутри native unit. Host callbacks
fenced; success требует matching init/result, worker completion, zero exit и
durable stop. Factory PATH discovery теперь lazy; explicit version probe внутри
worker, bundled version читается из manifest. Native .js/.mjs overrides допустимы,
.cjs не поддерживается pinned SDK. Settings sources/external MCP/persistence
отключены; hooks/env/schema/agent, bypass и resume/fork запрещены. Новые ordinary
runner/routes не включены. Windows targeted 54 runtime + 23 API = 77 passed,
actual SDK topology/hooks, old version/nonzero exit, abort и crash recovery.
Полный Windows ai:validate прошёл: exit 0, 3607 passed / 10 skipped, coverage всех
пакетов ≥70% (runtime минимум 75.59%, API 70.55%), build 7/7, Chromium 8/8,
k6 3/3, protocol CLI 0.145.0. Лог .codex/m2/logs/native-claude-final-validate.log;
все 15 package source/test hashes совпали. Native Mac smoke Claude SDK принят
03.10.2026 по сообщению пользователя «Тесты зеленые» для e1cc45b: запрошенный набор
54 runtime + 23 API = 77 tests. Пользователь отдельно подтвердил API-набор за
38 секунд; подробного stdout и отдельных счётчиков нет. Повтор без изменений
не нужен, команды сохранены в docs/local-device-sync.md. Это пользовательское
подтверждение целевого subset, не полный Mac ai:validate или live provider run.
Обычные capabilities не менялись; personal AI и полный P14/M2 пока не включать.

Новый increment — Claude CLI/API: внутренние runTaskDeviceClaudeCli/Api сохраняют
task/run/root/personal gate. API в этом форке уже работает через Agent SDK и
использует прежний worker; CLI делает прямой literal spawn внутри native worker
без SDK handshake/fallback. Version probe внутри unit, argv генерируется, prompt
через stdin. Raw CLI stdout/stderr ≤16 MiB даже для отфильтрованных metadata;
поддержаны UTF-8/final JSON без newline, сохранён default CLI timeout 300 секунд.
Fenced callbacks и результат требуют durable native stop. Custom argv/settings,
external MCP, persistence, resume/fork по-прежнему запрещены. Windows targeted:
114 runtime + 16 новых API-сценариев прошли. Финальный Windows ai:validate принят:
exit 0, 3655 passed / 10 skipped, в том числе все 39 native API/journal cases;
coverage всех пакетов ≥70% (runtime минимум 75.59%, API 70.40%), build 7/7,
Chromium 8/8, k6 3/3, protocol CLI 0.145.0. Лог
.codex/m2/logs/native-claude-cli-final-validate.log; 14 source/test hashes совпали.
Mac subset Claude CLI/API принят 03.10.2026 по сообщению пользователя «Тесты зеленые»
для 9fa29e1: запрошенный набор 114 runtime + 39 API = 153 tests. Пользователь
отдельно подтвердил API-набор за 60 секунд; подробного stdout и отдельных
счётчиков нет. Повтор без изменений не нужен; команды сохранены в device-sync doc.
Это целевой subset по подтверждению пользователя, не полный Mac ai:validate,
live provider run или приёмка P14/M2. Исходники после Windows gate не менялись.

Новый HTTP increment: text-only Codex API/OpenRouter идут через runTaskDeviceHttp
и фиксированный native worker; существующие request/auth builders сохранены.
Payload ≤1 MiB по stdin, response ≤16 MiB до разбора, proxy/NO_PROXY, без retry и
redirect. Strict JSON/SSE требует consistent ID, stop, usage, [DONE] для streaming,
worker completion и durable native proof. OpenRouter accounting chunk с повтором
finish учтён отдельно от OpenAI empty choices. Raw provider errors не выводятся;
HTTP status/limits сохраняются. Codex stream:false теперь учитывается с onEvent.
Windows итоговый ai:validate прошёл: 3730 passed / 10 skipped, coverage ≥70%
(runtime min 76.08%, API min 70.39%), build 7/7, Chromium 8/8, k6 3/3,
protocol CLI 0.145.0. Лог .codex/m2/logs/native-http-final-validate.log;
22 package source/test hashes совпали до/после gate. Все 65 native/journal
API cases прошли, включая новый HTTP и прежние CLI/SDK/app-server сценарии.
App-server proxy env casing и discovery tests учитывают Windows; HTTP fixtures
обходят browser bad ports и Windows reserved ranges без ослабления assertions.
Mac subset 188 runtime + 67 API пока ожидает пользователя.
OpenCode выполняет работу на отдельном сервере: остановка клиента его не
останавливает. nativeAdmission.ts закрывает run/resume/createSession до HTTP
с кодом native_external_executor_unowned; нужен owned server launch/recovery.
Local HTTP stop не считать доказательством remote inference/billing/сервера.

OpenCode обязателен для M2 по ответу пользователя 03.10.2026: на Mac нужны
задачи с локальными LLM. Пользователь установил OpenCode 1.18.34 на Mac;
command -v: /Users/aries/.local/state/fnm_multishells/1241_1791042421446/bin/opencode.
Это путь текущей fnm-сессии, перед native launch нужно определить реальный binary.
LM Studio сейчас установлен, но не нравится пользователю; другой inference backend
пока не выбран. Не исключать OpenCode из M2 и не подменять stop сервера
закрытием HTTP-клиента.
Далее P14 — owned OpenCode server,
normal runner admission/external-service coverage, runtime-backed checkpoint/release и
физическая передача Win→Mac→Win. Native stop receipt сам по себе не освобождает
grant/run и не подтверждает остановку внешних/делегированных services.
Personal AI и публичные launch/recovery/handoff actions пока не включать.
Детали и текущие проверки — в плане и docs/local-device-sync.md.
P15: onboarding, local session existence и continuation UI.
M3/M4 не отмечай готовыми после M2.
После завершения P01–P21 и приёмки M1–M4 запланирована P22: текущее действие AI,
прогресс по пунктам плана, живая лента событий/команд/проверок, файлы и diff,
состояние запуска и offline/stale-индикация между устройствами. Подробные требования
и приёмка — в конце списка задач плана. Это отложенный блок; текущий приоритет
P14/P15 и gates M1–M4 из-за него не менять.
Сохраняй прогресс в указанном плане, не заменяя другие планы.

Существующие проекты подключай только attach_existing: без init/install,
смены веток, переписывания контекста и захвата чужих изменений.
Для исполнения на двух устройствах обязателен execution grant/fencing;
TTL и потеря heartbeat не дают права забрать чужую задачу.
Code/context readiness отображается отдельно от синхронизации доски.

Делай scoped локальные коммиты после проверок. Push и PR не выполняй:
я проверяю результат и публикую вручную. Сохраняй paused/manual и серверный
запрет всех runtime-запусков personal-проектов через Handoff: coordinator,
QA/fix/commit/roadmap и chat/run/resume, включая ручные и taskless вызовы.
Проверяй до подготовки Git/filesystem. Unpause, auto-queue, restart и sync
не обходят запрет; новые задачи тоже защищены. Снять его можно только после
P13/P14 и gates исполнения M2, заменив обязательным grant/fencing.
Сохраняй общую идентичность участников и явное сопоставление с локальными
accounts. Разные participant UUID не должны ломать авторство,
назначения и ownership. Не переносить credentials/роли и не связывать
аккаунты по имени; неизвестные ссылки сохранять без выдачи локальных прав.
Эти M1 проверки уже пройдены на двух устройствах; сохраняй регрессии.
Mac пользователь запускает сам, SSH не требуется. Его Handoff checkout:
/Users/aries/Projects/aif-handoff; fixture: /Users/aries/Projects/handoff-lan-test.
Текущая macOS по сообщению пользователя — 27.0.1. Версия нужна для диагностики;
supervisor проверяет реальные возможности ОС, без привязки разрешения к номеру версии.
03.10.2026 пользователь подтвердил `xcrun --find clang`:
/Library/Developer/CommandLineTools/usr/bin/clang. Компилятор для следующего
native Mac probe уже доступен; это ещё не проверка механизма остановки.
M1 native acceptance не означает приёмку новых M2 Git/stop/fencing сценариев.
Остальные Mac project paths и toolchains пока неизвестны: не выдумывай их.
Для quality gate используй отдельную БД и свободные порты. Учитывай не только
PORT/WEB_PORT и AIF_API_URL/AIF_WEB_URL, но и API_BASE_URL для worker WebSocket.
```

## Данные, которые уточняются при настройке

- Реальные каталоги checkout на Mac и сопоставление `projectId`; Windows/WSL igorlink identity — отдельное подтверждение.
- Доступные нативные toolchains, OS/architecture, Xcode/simulators/signing для выбранных задач.
- Способ локального запуска и права firewall для защищённого peer listener. Начать с ручного адреса; discovery — последующее улучшение.

Эти данные не мешают подготовить ADR, migrations, attach API и двухузловой test harness. Мобильный стек и команды сборки брать из конкретного проекта; примеры пользователя не доказывают, что iOS-приложение уже существует.

## See Also

- [P01–P21 и gates milestones](../plans/personal-lan-handoff.md)
- [Отложенная P22: отображение выполнения после текущего плана](../plans/personal-lan-handoff.md#после-текущего-плана-наблюдение-за-выполнением-задач)
- [AC-01–AC-16](personal-lan-handoff.md#13-приёмка)
