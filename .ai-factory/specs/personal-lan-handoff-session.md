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
реальным supervisor/SQLite и offline JSON-RPC fixture. Mac повтор нового блока
ещё требуется: build, затем эти две команды из docs/local-device-sync.md (42 tests).
Финальный Windows ai:validate нового блока прошёл 03.10.2026: exit 0,
3515 passed / 10 skipped, coverage всех пакетов ≥70% (runtime min 74.91%,
API min 70.67%), build 7/7, Chromium 8/8, k6 3/3, protocol CLI 0.145.0.
Лог .codex/m2/logs/native-adapter-final-validate.log; sources во время прогона
не менялись. Root/runtime/API checklists и все четыре adapters проверены.

Далее P14 — остальные adapter transports (Claude/Codex/OpenRouter/OpenCode),
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
