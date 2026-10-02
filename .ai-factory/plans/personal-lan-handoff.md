# План: персональный Handoff между Windows и Mac

> [ТЗ](../specs/personal-lan-handoff.md) · [Запуск сессии](../specs/personal-lan-handoff-session.md) · [Проекты](../specs/personal-lan-handoff-projects.json)

Статус: код M1 P01–P09 реализован; локальный quality gate закрыт полным `ai:validate`, включая k6. Нативный Windows ↔ Mac pilot подтвердил pairing, автоматический обмен, offline/restart, сохранение конфликтующих правок и отображение результата resolution на обоих устройствах. Пользователь подтвердил Mac checkout binding и чистое дерево после attach. Общий gate M1 и checkbox P09 остаются открытыми до остальных native checks, включая participant mapping; ограничения доказательств Mac Git-сверки указаны ниже. M2–M4 не реализовывались. Исследованная база: `Two-Faces/aif-handoff`, `main@3d982ef344aaa2fb72f99d5603a1fea0051206ea`, 02.10.2026. Ветка: `codex/personal-lan-handoff` от `51df656`. Рабочие пользовательские checkout не менялись и не регистрировались; отдельно создан тестовый `E:\Projects\handoff-lan-test`.

Новые пути модулей ниже — предложение; существующие точки расширения проверены по исходной ревизии. Не создавать отдельный пакет только ради transport: начать с модулей в текущих workspaces. Если пакет окажется необходимым, выполнить Docker Sync Rule.

## Original Request

> Я хочу интегрировать handoff под все проекты и сделать инструмент синхронизации по сети локальной с моим маком. Но так как ты уже имеет контекст про проекты, то можешь составить ТЗ для другой сессии именно по этому проекту [https://github.com/Two-Faces/aif-handoff.](https://github.com/Two-Faces/aif-handoff.) Я уже создал проект и сессию и жду только составление плана. Есть идеи, как можно сделать так, чтобы по проектам была интегрирована доски задач и при этом на винде/маке они синхронизировались, если я работаю между ними. Допустим я пишу приложение на электроне, но билд на мак можно сделать только там и фишки разрабатывать только там. Так же как пример - я делаю мобильную версию на проекте и хочу отдельные таски делать на маке, чтобы там через эмулятор прогонять, потому что на винде нельзя такое провернуть

Уточнения пользователя: «Возьми на заметку - я сделал форку handoff и он будет как база, потому что я хочу его под себя доработать». Ответ на вопрос о disconnected mode: «Оба компьютера работают автономно; при встрече в локальной сети синхронизируют изменения». Push пользователь выполняет вручную после локальных коммитов и проверки.

## Requirements Reconciliation

Обязательные решения и приоритет источников приведены в [ТЗ](../specs/personal-lan-handoff.md#requirements-reconciliation). Старые MCP sync, human/AI handoff и timestamp resolver сохраняют свой локальный смысл; они не обеспечивают обмен двух offline-узлов. Процесс пользователя имеет приоритет над старой настройкой автоматической GitHub-публикации. Поддержка Codex уже есть: повторно создавать adapter или массово переинициализировать проекты не требуется.

## Зависимости и границы

```text
P01 → P02 → P03 → P04 → P05 → P06 → P07 → P08 → P09    [M1]
                    P03 → P10 → P11 → P12
       P02 + P06 + P10 → P13 → P14 → P15               [M2]
       P03 + P06 + P15 → P16 → P17 → P18 → P19        [M3]
             P09 + P15 + P19 → P20 → P21             [M4]
```

В этих строках стрелка обозначает зависимость, а не требование запускать независимые работы параллельно. Подробные зависимости указаны у каждой задачи. В M1 все runtime-запуски personal-проектов через Handoff запрещены сервером уже в P02, включая ручные и taskless helpers; `paused/manual` само по себе не считается защитой. После P13/P14 и gates исполнения M2 запрет заменяется обязательным execution grant/fencing; автономные workers остаются opt-in M3. P09 не включает исполнение ни локальным действием, ни получением данных.

## M1. Две автономные доски

- [x] **P01. Зафиксировать контракт и базовые проверки.**
  - Зависимости: нет.
  - Прочитать root/package `AGENTS.md`, `CHECKLIST.md`, `.ai-factory/{RULES,ARCHITECTURE,DESCRIPTION}.md`; сверить исследованную ревизию с текущим кодом.
  - Создать `docs/decisions/personal-lan-sync.md`: offline semantics, per-field causality, journal/checkpoint/ACK, один владелец задачи, local-only publication и protocol compatibility. Утвердить точный контракт bootstrap + delta до transport.
  - Зафиксировать серверный запрет исполнения M1 и полный перечень точек запуска. Определить общую идентичность участников отдельно от локальных auth accounts, явное mapping, поведение неизвестного автора/исполнителя и миграцию существующих ссылок без переноса credentials/ролей.
  - Зафиксировать baseline существующих проверок и доступность второй машины. Спроектировать изолированный двухпроцессный test harness; не переключать singleton DB конкурентно.
  - Проверка: требования AC-01–16 сопоставлены с тестами/ручной приёмкой; неизвестные Mac paths/toolchain остаются явными prerequisites, не придуманными значениями.

- [x] **P02. Ввести personal mode и безопасное подключение проекта.**
  - Зависимости: P01.
  - Файлы: `packages/api/src/repositories/projects.ts`, `packages/shared/src/projectInit.ts`, `packages/runtime/src/projectInit.ts`, `packages/shared/src/env.ts`, `packages/agent/src/{coordinator,githubWorkflow}.ts`, API `routes/{tasks,chat}.ts`, `services/{runtime,fastFix,qaRunner,qaCheckRunner,commitGeneration,roadmapGeneration}.ts`, data claim APIs и соответствующие request contracts.
  - Разделить `attach_existing` и init/install; определять Git checkout через Git, включая `.git`-файл. Регистрация только читает filesystem и пишет Handoff metadata.
  - Добавить `publicationPolicy=local_only`, execution paused/manual при personal onboarding. Guard запрещает push/PR независимо от прежнего YAML-флага; обычный режим сохраняет совместимость.
  - Ввести обязательный серверный запрет всех runtime-запусков personal-проектов до готовности P13/P14 и gates исполнения M2. Охватить coordinator/auto-queue, API QA/fix/commit/roadmap, `runApiRuntimeOneShot` и прямые chat/run/resume, включая taskless вызовы. Проверять до подготовки Git/filesystem; новые, импортированные и восстановленные задачи защищены одинаково. Unpause, auto-mode/auto-queue, restart и remote apply не отключают запрет; UI лишь объясняет его.
  - Проверка: Git fixtures с dirty tracked/untracked/index и worktree; ноль init/npm/npx/network/checkout вызовов при attach, точная сохранность состояния. Все personal-mode публикационные пути заблокированы, standalone-mode regressions зелёные.
  - Проверка запрета M1: отрицательные тесты каждой точки запуска, включая ручные/taskless вызовы, unpause/auto-queue и restart; ноль runtime-вызовов и подготовительных изменений checkout. Полный grant/fencing остаётся задачей P13, но запрет нельзя отложить до неё.

- [x] **P03. Добавить device/project/participant identity, локальные bindings и миграции.**
  - Зависимости: P02.
  - Файлы: `packages/shared/src/schema.ts`, `db.ts`, `types.ts`; новые `packages/data/src/devices.ts`, `projectBindings.ts`, публичные exports.
  - Стабильный logical project ID и per-device checkout bindings. `.ai-factory` portable manifest создаётся отдельным действием; импорт inventory — read-only preview → явное сопоставление → registration.
  - Общая идентичность участника и явная локальная привязка к `participants.id`; data API привязок и append-only backfill авторов, назначений и ownership history. Не переносить password hashes/sessions/роли/active-state и не объединять аккаунты по имени. Неизвестное авторство/назначение хранится без FK на чужой локальный UUID и без потери данных; локальные права требуют подтверждённого mapping и активной учётной записи.
  - Device incarnation/identity хранится локально; предусмотреть запрет двух экземпляров и backup cloning. Не менять смысл `executionOwner`/`ownershipRevision`.
  - Append-only migrations после актуального последнего version, согласованный fresh-init schema и backfill старых rootPath без потери данных.
  - Проверка: миграция заполненной старой БД и новая БД; одна доска/разные пути; Windows+WSL bindings; неоднозначный remote match не объединяет проекты сам.
  - Проверка identity: два локальных UUID одного владельца, явное сопоставление, одинаковые имена разных аккаунтов, неизвестный автор/исполнитель и неактивный local account. Credentials не входят в общий DTO; backfill сохраняет авторство, назначения и локальную авторизацию.

- [x] **P04. Реализовать journal/outbox/inbox в data layer.**
  - Зависимости: P03.
  - Предлагаемые модули: `packages/shared/src/sync/contracts.ts`, `packages/data/src/syncJournal.ts`, `syncApply.ts`.
  - Типизированные operation intents, stable operationId, causal context, per-field revision, contiguous ACK и dedup. Sequence/ACK scope — stream `(projectId, originDeviceId, deviceIncarnation)`: allowlist другого проекта не создаёт gaps. Доменные mutations и outbox в одной транзакции; apply/inbox/cursor тоже атомарно.
  - Локальные ephemeral поля исключены из DTO. Remote apply без outgoing echo, filesystem/runtime effects. Добавить tombstones и безопасный checkpoint bootstrap; compaction только с согласованными watermarks.
  - Проверка: crash до/после commit/ACK, duplicates, sequence gaps, replay, два проекта с разным allowlist, fresh peer bootstrap с параллельными правками; ни потерь, ни повторных событий.

- [x] **P05. Провести все общие записывающие пути через доменные операции.**
  - Зависимости: P04.
  - Файлы: `packages/data/src/index.ts`, `taskTransitions.ts`, `taskOwnership.ts`; REST task/project repositories; MCP `tools/pushPlan.ts`, `tools/syncStatus.ts`, `sync/conflictResolver.ts`.
  - Перечислить mutations: task create/edit/plan/status/reorder/delete, comments/attachments/history, shared project metadata. Все public writers используют transactional intents. Сохранить actor-aware переходы и совместимость локальных MCP tools.
  - Авторов комментариев, assignees и actor metadata сериализовать через общую идентичность P03. Remote apply сохраняет несопоставленные ссылки без создания login accounts, потери истории или выдачи локальных прав; локальные действия используют подтверждённый mapping.
  - Version/CAS для планов и workflow; не строить journal из `updatedAt` и не реплицировать generic `setTaskFields` без whitelist.
  - Проверка: mutation coverage matrix с REST/MCP/worker путями; reorder синхронизируется даже без изменения updatedAt, remote transition не обходит human ownership и terminal guards.
  - Проверка: bootstrap/delta комментариев, назначений и human/AI ownership между двумя БД с разными participant UUID; до mapping данные видимы, но права исполнителя не выдаются, после mapping действуют обычные локальные проверки доступа.

- [x] **P06. Реализовать детерминированные merge и явные конфликты.**
  - Зависимости: P05.
  - Предлагаемые модули: `packages/data/src/syncConflicts.ts`, pure causal/ordering helpers в `packages/shared/src/sync/`.
  - Независимые поля merge; concurrent same-field variants сохраняются; resolution ссылается на оба parents. Status/grant не LWW; comments/run union stable IDs; tombstones; порядок карточек с детерминированным tie-break.
  - Проверка: перестановки доставки дают одинаковую проекцию; часы ±24 часа не выбирают победителя; conflict+resolution, delete/edit, reorder/reorder и старый bootstrap не приводят к silent overwrite.

- [x] **P07. Добавить защищённый peer listener и pairing.**
  - Зависимости: P04, P06.
  - Предлагаемые модули: `packages/api/src/services/peerIdentity.ts`, `peerTransport.ts`, `routes/peers.ts`, peer schemas; конфигурация env/local data.
  - Одноразовое pairing с fingerprints, mTLS/pinning либо эквивалентный проверяемый канал, device keys локально, project allowlist и revoke. Browser API остаётся loopback.
  - Negotiate protocol/schema, quotas/batches, structured error codes и downgrade protection; auth sessions/MCP bearer не выдавать как peer identity.
  - Проверка: неизвестный/revoked peer, неверный fingerprint, истёкший pairing, неподдерживаемый protocol и foreign project не читают/пишут данные.

- [x] **P08. Реализовать двусторонний bootstrap/delta/reconnect.**
  - Зависимости: P07.
  - Предлагаемые модули: `packages/api/src/services/peerSync.ts`, data checkpoint/cursor API и integration harness.
  - Ручной peer address first; bounded push/pull batches, persisted progress/ACK, streaming bootstrap, retries/backoff, cancellation. Затем discovery paired peers и reconnect в LAN. Никаких sync command side effects.
  - Сохранность outbox при restart/no disk; смена identity и старый peer требуют resync. Хранить диагностические счётчики без вывода секретов.
  - Проверка: две реальные независимые БД/processes через transport; offline edits, packet loss/reordering/disconnect/restart, ACK-loss и достаточный объём данных; eventual convergence.

- [ ] **P09. Добавить UI устройств, сопоставления проектов и конфликтов.**
  - Зависимости: P02, P03, P06, P08.
  - Файлы: `packages/web/src/components/{project,settings,task,kanban}/`, `hooks/useWebSocket.ts`, API client/hooks. Новые domain compositions через существующие UI primitives.
  - Local device/peers, binding selection, last contact, pending operations, «Синхронизировать», conflict resolution. Получение board data не означает code ready и не включает worker.
  - Явное сопоставление общего владельца с local participant, отображение несопоставленного авторства/назначений и причины запрета запусков M1; кнопки запуска не могут обходить серверный запрет P02.
  - Проверка: reconnect/React Query invalidation, offline edits, conflict UX light/dark; UI rules/theme docs/Pencil representation при необходимости нового visual component.
  - **Gate M1:** AC-01–06, AC-14 (board/auth часть), AC-15. Оба устройства имеют автономные доски; все runtime-запуски personal-проектов блокируются сервером. Авторство/назначения синхронизируются при разных локальных participant UUID без переноса credentials и обхода прав.

## M2. Снимки кода и продолжение задачи

- [ ] **P10. Сделать commits scoped и task checkouts воспроизводимыми.**
  - Зависимости: P02, P03.
  - Файлы: `packages/shared/src/commitWorkflow.ts`, `gitIsolation.ts`, `packages/agent/src/autoQueueCommit.ts`, `subagents/planner.ts`, остальные mutating stage root resolution.
  - Детерминированный ownership/whitelist diff helper; убрать требование prompt `git add -A`; сохранить index/unrelated files. Exact-snapshot root для implementation/fix/QA/commit, а не только условного planner worktree.
  - Context overlay не переписывает mutable reused worktree. Local-only guard протестировать на worker, API helper и GitHub workflow.
  - Проверка: чужие staged hunks/untracked/dirty files, чужая ветка, одинаковое имя ветки с другим HEAD, глобально грязный root, один commit или корректная последовательность task commits. Failure сохраняет исходное состояние.

- [ ] **P11. Добавить immutable code/context snapshot contract.**
  - Зависимости: P10, P04.
  - Предлагаемые модули: `packages/shared/src/handoff/contracts.ts`, `packages/data/src/codeSnapshots.ts`, `packages/api/src/services/contextSnapshot.ts`.
  - Snapshot commit/object format, digest, portable allowlist manifest; goal/plan/next steps/test outcomes. Поддержать ignored portable context без копирования machine configs/session history/secrets.
  - Учесть project `AGENTS.md`, `docs/agent-context`, `.ai-factory`, `.agents/skills`, `.codex/agents`; имеющийся AIF 2.19 readiness без повторного init.
  - Проверка: manifest привязан к commit, чужие local paths/auth config не переносится, изменённый контекст создаёт новый digest, неполный пакет не ready.

- [ ] **P12. Реализовать Git snapshot и blob transfer.**
  - Зависимости: P08, P11.
  - Предлагаемый модуль: `packages/api/src/services/gitSnapshotTransfer.ts`; data descriptors; `attachmentStorage.ts`/blob storage.
  - Проверка Git bundle/prerequisites, namespaced refs, full fallback, resumable content-addressed blobs. Source/target ветки и origin refs не меняются; создать exact-commit task checkout.
  - Проверять LFS/submodules, hash format, collision/path/junction guards; показать code/context/blob readiness независимо от board sync.
  - Проверка: transfer без GitHub/GitLab SSH, interrupted/missing base/tampered blob, dirty destination, mismatched object format; bootstrap не запускает hooks/runtime произвольно.

- [ ] **P13. Добавить устойчивое право исполнения и fencing во все runners.**
  - Зависимости: P02, P03, P06, P10.
  - Файлы: schema/data task ownership/transitions/claim APIs; `packages/agent/src/{coordinator,subagentQuery,taskWatchdog,autoQueueCommit}.ts`; API `fastFix`, `qaRunner`, `qaCheckRunner`, `commitGeneration`, `services/runtime.ts::runApiRuntimeOneShot`, `routes/chat.ts` и taskless roadmap/commit paths.
  - `ownerDeviceId + executionEpoch` отдельно от local claim/TTL и human/AI ownership. Все start/completion/status paths проверяют ожидаемый grant и runId; remote tasks исключены из watchdog/auto-queue.
  - Выбранная платформа — требование/desired device, не автоматическое присвоение. Нет TTL takeover; остановленный/restarted coordinator не возвращает relinquished право. Successor выдаёт только текущий owner, не более одного на epoch; обычный sync/status writer не выдаёт grant.
  - Task-bound chat/run/resume использует общий gate и task checkout. Taskless mutations получают отдельный scoped local execution либо запрещены; read-only обеспечивается permissions, не одним prompt.
  - Сохранить запрет P02 до готовности P14 и прохождения gates исполнения M2; затем заменить его обязательными проверками grant/fencing во всех ранее закрытых точках. Unpause/auto-queue не становятся обходом новых проверок.
  - Проверка: два coordinator, partition, stale heartbeat/claim, duplicated/forked assignment, delayed completion, chat/runtime/helper bypass и неправильный project root; одной task никогда не разрешены два активных устройства.

- [ ] **P14. Реализовать persisted handoff state machine и подтверждённую остановку.**
  - Зависимости: P11, P12, P13.
  - Предлагаемые модули: `packages/data/src/deviceHandoff.ts`, `packages/api/src/services/deviceHandoff.ts`; agent `stageAbort.ts`, shutdown/recovery; runtime process-tree lifecycle.
  - Requested → quiescing → checkpointed → durable released → received → accepted, idempotent transfer ID, epoch chain/issuer/single-successor validation, target readiness. После release потеря ACK не возобновляет источник.
  - Manual session flow: checkpoint + подтверждение прекращения записи; autonomous flow: фактический exit процесса/детей. Нельзя сразу освобождать grant после abort signal.
  - Проверка: failure/restart на каждой границе, orphan child, зависший runtime, target unavailable, невозможный scoped commit, lost ACK, повторный accept, revoked target. До release отмена безопасна; после — только обратный handoff.

- [ ] **P15. Добавить UI/CLI продолжения и пакет для новой сессии Codex.**
  - Зависимости: P09, P14.
  - Файлы: task details/actions, API/MCP public surface, context renderer. Переиспользовать существующие Codex transports; локальный resume только после local existence check.
  - Действия «Работать здесь», «Сохранить контекст», «Передать», «Принять и продолжить»; отображение процесса остановки, code readiness и конкретного blocker. Receiving sync сам не стартует AI.
  - Проверка: ручной Win→Mac→Win на точном snapshot с новой локальной сессией; пользователь понимает цель и следующий шаг; никакой автоматической cloud публикации.
  - **Gate M2:** AC-07–11 и code/blob части AC-14, regressions AC-15. Автономное исполнение разрешать только после native stop/fencing tests.

## M3. Платформенные задачи и QA

- [ ] **P16. Добавить device capabilities и локальные execution profiles.**
  - Зависимости: P03, P08, P15.
  - Предлагаемые модули: `packages/api/src/services/deviceCapabilities.ts`, `hostExecutionProfiles.ts`; data/profile DTO; project/device settings.
  - OS/arch/native|WSL|container, Git/Node/PHP/tool versions, Xcode/simulator/Android readiness, signing readiness без секретов, local resource limits. Не смешивать с provider RuntimeCapabilities.
  - Build/QA команды локально разрешены для проекта; проверка readiness перед запуском, advertisement only informational. Unknown/incompatible показывает waiting/blocker.
  - Проверка: macOS native vs Linux container, Android Windows compatibility, missing SDK/auth/roles и stale advertisement. Нативные Windows `.cmd` spawn и Mac process tree реально проверены.

- [ ] **P17. Добавить связанные implementation/build/QA-задачи.**
  - Зависимости: P06, P16.
  - Файлы: schema/db, data/task dependencies, state machine inputs, API/Zod, board/task UI.
  - Nullable parentTaskId/taskKind для старых tasks, dependency edges с cycle/self/same-project checks, verification requirements. Concurrent offline cycle после merge сохраняется как конфликт/quarantine и блокирует зависимые запуски до resolution. Legacy tags/roadmap alias не считать DAG.
  - Снимок результата implementation закрепляется как input зависимой build/QA task. Автоматическая готовность не выдаёт чужой grant; assignment проходит P14 либо задача заранее принадлежит target.
  - Проверка: локальный цикл и concurrent A→B/B→A в разных offline узлах, cascade/delete active task, failed dependency, disconnected Mac; родитель показывает ожидание проверки без потери результата реализации.

- [ ] **P18. Добавить immutable run/verification results и authoritative verified gate.**
  - Зависимости: P12, P13, P17.
  - Файлы: schema/db/data run APIs, `packages/shared/src/stateMachine.ts`, `packages/data/src/taskTransitions.ts`, API QA runners, artifact storage.
  - RunId/device/epoch/source snapshot/toolchain/command/outcome/artifacts. `approve_done → verified` фиксирует только current owner родительской task, с CAS owner/epoch/snapshot/requirements revision и успешными обязательными проверками. Non-owner отправляет approval intent; без владельца переход ожидает.
  - Результаты старых epoch/commits остаются историей; изменения кода инвалидируют прежние проверки. Повтор sync не удваивает runs/usage.
  - Проверка: A passed, B current → cannot verify; offline stale replica approval при B на владельце, stale concurrent approve, replay result, missing artifacts, failed required QA; existing human/AI gates сохранены.

- [ ] **P19. Пройти платформенный сценарий Electron и мобильного QA.**
  - Зависимости: P16, P18.
  - Создать documented sample profiles/templates, без предположения, что текущий проект уже имеет iOS app. Электронный Mac build/signing и iOS Simulator smoke — на реальном Mac с доступным fixture/toolchain.
  - Windows implementation A → Mac build/QA A → artifact/result → новая B → recheck. Android profile отдельно проверяется на поддерживаемой Windows среде, если доступен SDK/emulator.
  - Проверка: AC-12/13, logs/artifacts привязаны к A/B; отсутствие signing/iOS prerequisites обозначено как непройденная часть native acceptance, а не замоканный успех.
  - **Gate M3:** current-snapshot verification, dependency UX и обе нативные execution среды; auto workers включаются opt-in.

## M4. Внедрение во все проекты

- [ ] **P20. Подключить pilot, затем остальные checkout.**
  - Зависимости: P09, P15, P19.
  - Источник: `../specs/personal-lan-handoff-projects.json`. Сначала CRM backend + Nuxt; на Mac пользователь указывает реальные roots. Пройти round trip одной задачи и независимые задачи в disconnected mode.
  - Затем подключить остальные checkout через attach_existing; igorlink Windows/WSL сопоставить явно. Репозитории с неизвестной версией AIF не инициализировать без отдельной задачи.
  - Не менять existing feature/stage/master branches; не удалять Claude context; `.codex/config.toml` переносить только через отдельную локальную настройку MCP, не wholesale copy.
  - Проверка: AC-02/03/16, сохранность dirty files/index, существующие skills и контекст читаются; состояние подключения по каждому checkout документировано.

- [ ] **P21. Завершить эксплуатационные документы и quality gates.**
  - Зависимости: P20.
  - Документы: `docs/local-device-sync.md`, `docs/device-handoff.md`, `docs/platform-tasks.md`, getting-started/configuration/MCP/architecture, AGENTS project map и root/package CHECKLIST.
  - Native install/start/stop/update, Windows firewall/manual peer, Mac prerequisites, backup/restore/rekey, revoke, incompatible protocol, unsupported takeover, recovery without silent authority restoration. Чётко описать manual push.
  - Тесты: targeted unit/integration по изменённым пакетам, existing regression suites, root `npm run ai:validate`, coverage ≥70% каждого пакета; native Windows+Mac acceptance отдельно от Linux CI. Docker config/build синхронизировать при изменении packages/dependencies.
  - **Gate M4:** AC-01–16 с evidence matrix; failed/unavailable native checks остаются открытыми. Local commits по scope; push/PR вручную владельцем.

## Матрица проверок

| Критерии | Задачи | Основная проверка |
| --- | --- | --- |
| AC-01–03 | P02/P03/P08/P09/P20 | Два локальных процесса, registration fixtures, реальные device bindings; запрет всех runtime-запусков M1, unpause/auto-queue и restart |
| AC-04–06 | P04–P08 | Fault injection, permutations, conflicts, tombstone/bootstrap |
| AC-07–08 | P13/P14 | Два workers, partition, stale epoch, crash на каждой границе и process exit |
| AC-09–11 | P10–P15 | Git fixtures, bundle transfer, index preservation, новая локальная сессия |
| AC-12–13 | P16–P19 | Native Mac/Windows, exact-snapshot QA и CAS verified gate |
| AC-14 | P07/P08/P12/P14 | Auth/protocol/transfer interruption, hashes и ACK consistency |
| AC-15 | P02/P03/P05/P09/P13/P18/P21 | Старые MCP/ownership/workflows/Docker regressions; два participant UUID, явное mapping, авторство/назначения и сохранение локальных прав без credentials sync |
| AC-16 | P20/P21 | CRM pilot и manifest подключённых checkout |

В планировании проверки кода и native scenarios не выполнялись: функциональности пока нет. При реализации записывать точные команды, результаты и ограничения, а не только отметки checkbox. Ошибки baseline и недоступные среды отделять от регрессий; не ослаблять assertions ради зелёной проверки.

## Прогресс реализации — 02.10.2026

- P01: создан `docs/decisions/personal-lan-sync.md` с контрактом journal/causality/ACK/checkpoint, изоляцией local state, participant mapping, запретом исполнения M1 и проектом двухпроцессного harness. Node 22.22.3, npm 10.9.8; `npm ci` выполнен в Handoff, lockfile не изменён.
- Исходный `npm run ai:validate`: format/lint прошли, выполнение остановилось на runtime tests (6 failed, 895 passed, 1 skipped; 5 файлов). Проверки CLI fallback ожидали `codex`, окружение возвращало установленный Windows `codex.exe`. Полный baseline coverage/build/perf/load/protocol этим запуском не проверен. Лог: локальный `.git/personal-lan-baseline.log`.
- P02 в работе: append-only v30, persisted personal/local-only policy, read-only Git attach, default paused/manual и запреты data claims, API helpers/routes, direct stage runners, coordinator и publication. Новые targeted suites: shared + DB 20 passed, data + pause 19 passed, API 5 passed, agent 8 passed, upgrade/reopen migration 1 passed. `npm run build`: 7/7 packages passed. Existing API regression selection: 196 passed, 1 failed (`projects.test.ts`: Windows `E:\\tmp` vs `\\tmp` в GitHub fixture). Полные проверки и package checklists ещё выполняются.
- Проверки P02: `npm run lint` прошёл; `npm run build` прошёл во всех 7 пакетах. Полные coverage runs: shared 241 passed (минимальная метрика 72.66%), data 267 passed (77.81%), agent 399 passed (76.43%). API: 502 passed, 2 failed; coverage с `--coverage.reportOnFailure` — минимальная метрика 72.38%, тесты остаются красными. Ошибки API: POSIX mode password-файла в `bootstrapParticipantAdmin.test.ts` на Windows и сравнение `E:\\tmp` с `\\tmp` в GitHub fixture. Assertions не изменялись.
- Обязательный `npm run ai:validate` после P02 запущен: format/lint прошли, runtime tests остановили pipeline (те же 6 CLI-path ошибок baseline и дополнительный 5s timeout protocol-generator test под нагрузкой). Полный root gate не считается пройденным. Checklists shared/data/api/agent просмотрены; DB boundary и browser-safe exports соблюдены, публичные API/env изменения документированы, runtime adapters и Docker dependencies не менялись.
- Изолированный повтор runtime suite в дочернем процессе без унаследованного `CODEX_CLI_PATH` (остальное окружение сохранено): 901 passed, 1 skipped. Дополнительный timeout не воспроизвёлся; runtime-код/tests не менялись. P02 код и новые проверки готовы, checkbox оставлен открытым до разрешения общих quality gates; P03 может разрабатываться поверх готовых execution/attach boundaries.
- P03: append-only v31 с backfill старых roots, авторов и назначений; local device identity/installation check/process lock, checkout bindings, logical participants и явные local account mappings. Добавлены read-only inventory preview, explicit attach-to-project и отдельная запись переносимого manifest. Миграция сохраняет в том числе неоднозначные старые projects с одинаковым root; она не объединяет их.
- Проверки P03: shared coverage 242 passed (минимальная метрика 72.57%), data 275 passed (79.11%), API 506 passed / те же 2 Windows failures (coverage min 72.35%). Отдельные проверки новых registration endpoints и populated v30 migration прошли. `npm run lint` и итоговый `npm run build` прошли. Root `ai:validate` без унаследованного `CODEX_CLI_PATH` дошёл до tests и остановился на 5s timeout protocol-generator под общей нагрузкой (runtime: 900 passed, 1 failed, 1 skipped); изолированно runtime suite ранее прошёл. Общие gates остаются открытыми.
- P04 foundation: append-only v32, строгий portable operation contract, per-field causal registers, transactional inbox/outbox, dedup/collision checks, contiguous ACK с проверкой sent watermark, tombstones. Checkpoint копируется атомарно внутри SQLite, передаётся bounded chunks, проверяет digest и устанавливается атомарно с сохранением конкурентных локальных правок. Отдельные writer incarnations исключают повторное использование sequence после рестарта writer process. Подключение всех REST/MCP/worker writers к этому ядру — следующий P05; сетевой транспорт и process-crash harness ещё не реализованы.
- Проверки P04: shared coverage 245 passed (min 73.01%), data coverage 292 passed (min 79.62%); дополнительный SQLite backup/reopen test прошёл после coverage run. Перестановки, gaps, duplicate/collision, rollback до ACK, lost ACK, concurrent resolution, bootstrap tampering/partial install и replay старого checkpoint после delete проверены. Итоговый build и lint прошли. Обязательный root `ai:validate` запущен: data 293 passed, MCP 103 passed; остановка снова на известном 5s protocol-generator timeout под общей нагрузкой (runtime 900 passed, 1 failed, 1 skipped). M1 не объявлен готовым.
- Пользователь подтвердил, что Mac пока недоступен. Mac paths/toolchain, native acceptance и M1 gate на двух устройствах остаются открытыми; Windows child-process harness не заменяет эту приёмку. Реальные пользовательские checkout не регистрировались и не изменялись.

## Актуальный результат стабилизации M1 — 02.10.2026

- Код стабилизации сохранён локальным коммитом `77f30ed` (`fix: stabilize native Windows validation and peer identities`).
- Исправлена проверка защищённого bootstrap password-файла на Windows: проверяется настоящий ACL, включая унаследованный и write-only доступ, с чтением через тот же открытый handle. POSIX сохраняет owner-only проверку. Ошибки fail closed без вывода пароля; лимит 64 KiB. Native ACL tests проходят.
- GitHub/checkout fixtures используют абсолютные пути OS temp и очищаются после тестов. Установка MCP сохраняет абсолютные `DATABASE_URL` / `PROJECTS_DIR`, относительные пути разрешает от корня Handoff; оба случая покрыты тестами. Тесты явно задают свои переменные окружения.
- Root `npm test` запускает workspace suites последовательно, сохраняя внутреннюю параллельность Vitest и двухпроцессные сценарии. Assertions, таймауты и пороги не ослаблены. CLI fallback tests изолированы от пользовательского `CODEX_CLI_PATH`; root `ai:protocol` выбирает локальный npm PATH CLI и сохраняет строгую проверку версии SDK.
- Полный прогон выявил редкий дефект DER INTEGER в случайном serial сертификата: после очистки sign bit мог остаться избыточный нулевой префикс. Исправлено создание положительного serial без такого префикса. Детерминированная регрессия до исправления: 3 failed / 2 passed, после — 5 passed; реальный TLS и peer crash/restart также проходят. Существующие identities/pins автоматически не заменяются.
- Итоговый `npm run ai:validate` завершился с кодом 0: format, lint 10/10, tests 10/10, coverage 10/10, build 7/7, Chromium perf/e2e 7 passed, k6 3/3, protocol check (CLI 0.145.0), checklist. Всего unit/integration: **3213 passed / 1 existing skipped**. Лог: локальный `.git/m1-final-validation.log`.

| Пакет | Тесты passed | Минимальная метрика coverage |
| --- | ---: | ---: |
| shared | 245 | 72.57% |
| data | 298 | 75.00% |
| runtime | 902 (+1 skipped) | 73.25% |
| api | 531 | 70.86% |
| agent | 399 | 76.26% |
| mcp | 105 | 86.27% |
| web | 733 | 74.49% |

- Браузерные и k6 проверки выполнены на отдельной БД `.git/m1-validation/fixture.sqlite` со 100 synthetic paused/manual задачами. Пользовательский `CODEX_CLI_PATH` сохранён; `DATABASE_URL`, `PROJECTS_DIR` и адреса тестового сервера переданы только дочернему процессу. k6 v2.3.0 скачан из официального release, SHA-256 сверена; бинарник локален в `.git/tools/k6`, системная установка/PATH не менялись. Драйвер: `.git/m1-validation-run.mjs`; исходные logs/reports остаются локальными.
- k6: chat-sessions — 26 537 запросов, p95 9.17 ms; runtime-profiles — 107 336, p95 6.95 ms; tasks — 10 026, p95 46.54 ms. HTTP error rate 0 для всех трёх, исходные thresholds пройдены. Это проверка локальных API endpoints, а не измерение скорости LAN replication. Отчёты: `packages/api/perf/reports/`.
- CHECKLIST root/api/runtime проверены; повторяющиеся правила переносимости fixtures и env isolation добавлены в package checklists. REST-схемы и WS-контракты не менялись, DB boundary сохранена. Adapter capabilities/контракты и зависимости не менялись, поэтому parity/docs registration/Docker sync неприменимы. Временные dev servers завершены.
- Открыта только нативная часть M1: установка Mac, его checkout paths/toolchain/firewall, pairing и двусторонний сценарий на тестовом репозитории. Personal execution guards сохранены до M2. Push/PR не выполнялись; M2–M4 остаются следующими этапами.

## Начало нативной приёмки — 02.10.2026

- Пользователь запускает Mac самостоятельно, без SSH: `/Users/aries/Projects/aif-handoff`, ветка `codex/personal-lan-handoff` на `640e400`, Node v22.22.2. Пользователь подтвердил выполнение `npm ci` и `npm run build`; stdout этих команд не проверялся здесь.
- Windows: Node v22.22.3, LAN `192.168.1.35`, browser `http://localhost:5180`, API `127.0.0.1:3009`, pinned peer TLS `3010`. Отдельные БД/ключи в `.git/native-acceptance/`; launcher сохраняет PID + start time, stop проверяет оба. Для нативного запуска `PROJECTS_DIR`/`PROJECTS_MOUNT` очищены: host/container mapping здесь не нужен. Coordinator не запускается.
- Создан независимый Git fixture `E:\Projects\handoff-lan-test`, initial commit `d52fc06`, `npm test` passed. Через реальный API зарегистрирована personal board `d1c9902d-f366-4dcb-b733-ae857e7bb5b1`; задача `483a9322-eb21-47df-b62c-47eec4b6f5b4` создана paused/manual. Checkout сохранил исходный commit и чистое дерево.
- Живой запуск выявил пропуск `/peers` в Vite proxy: возвращался HTML вместо JSON. Маршрут добавлен, новый Playwright integration test проверяет GET и validation error POST через настоящий dev proxy без mocks. `ai:validate` после исправления exit 0: 3213 passed / 1 skipped, coverage ≥70% во всех пакетах, build 7/7, browser 8 passed, k6 3/3, protocol check passed. Лог `.git/native-acceptance/proxy-validation.log`. UI primitives/styles, REST/WS contracts и зависимости не менялись.
- Для уже скачанного Mac commit подготовлен запуск Vite через `createServer` с дополнительным `/peers` proxy в runtime-конфигурации; эта команда проверена на Windows через настоящий peer API. Она не меняет файлы Mac checkout. Исправление в исходниках пока сохранено локально, push не выполнялся.
- Mac запущен пользователем: `192.168.1.152:3010`, device `74870384-2979-43dc-bb16-299c7f7b3152`. Нативное TLS 1.3 соединение с Windows проверило присланный пользователем certificate fingerprint. Pairing выполнен из Mac UI с приглашением для одной тестовой доски; bootstrap завершён с обеих сторон. На Windows сохранён обратный адрес Mac; ошибки отсутствуют, pending operations = 0. Первоначально пользователю был ошибочно передан JSON вместо UI-кода Base64; исправленная инструкция и новый код проверены через настоящий UI, без изменения контракта приложения.
- Mac-задача `0be17612-999e-4d8b-9d2d-c89f5396e293` автоматически появилась на Windows; её title revision содержит Mac device ID. Windows-комментарий `bd2f83d9-0c11-4321-b09f-ac875d346a46` получил ACK. Ручной sync для проверки Mac-задачи не вызывался.
- Offline/restart: Windows API перезапущен с `AIF_PEER_ENABLED=false`, локальные API/UI остались доступны. На Windows изменено описание исходной задачи и создана `43828676-db61-44f5-a41f-c1edd4c55bdd` («Windows: офлайн»), 3 операции ожидали передачи. Пользователь независимо изменил описание на Mac. После второго restart с peer enabled обмен возобновился автоматически и очередь обнулилась.
- Конфликт description сохранил две версии с разными device origins: `Офлайн-версия Windows` и `оффлайн-версия mac`. Через реальный Windows UI (Playwright, без mocks) выполнены Merge text → Save merged version; обе строки сохранены, conflicts = 0, Mac ACK получен. Скриншоты до/после и causal parents сохранены локально в `.git/native-acceptance/`, состояние — `acceptance-state.json`. Пользователь подтвердил появление обеих строк и офлайн-задачи на Mac без обновления страницы. Windows fixture остался на `d52fc06`, рабочее дерево чистое.
- Пользователь создал Mac fixture `/Users/aries/Projects/handoff-lan-test` и подтвердил Attach to this project с `macOS native` в существующей доске. После attach сообщил HEAD `79f862d` и пустой `git status --short`. Хеш до attach в чат не передан: строгое сравнение Mac HEAD до/после этим свидетельством не доказано. Windows API продолжает возвращать только собственный binding `E:\Projects\handoff-lan-test` / `native_windows` с исходным HEAD; чужой путь не перенёсся. Последняя проверка: peer errors = null, pending operations = 0.
- На живом Windows API после restart проверены `run-qa`, `run-qa-check`, `sync-plan`: все вернули HTTP 403 / `personal_execution_disabled`; рабочее дерево тестового checkout осталось чистым.
- Participant mapping/локальная авторизация на двух нативных устройствах ещё **не проверены**; полный M1 gate не закрыт. Оба приложения оставлены запущенными с включённым обменом. Firewall не менялся. Автопроверка отклонила запуск дополнительного HTTP download server; он не запущен, Mac fixture создан локально пользователем.

## Предыдущий срез M1 — до стабилизации quality gate

- P07/P08: append-only v33; TLS 1.3 и взаимные certificate pins, одноразовое приглашение с ожидаемым fingerprint, allowlist/revoke, отдельный listener, проверка protocol/schema, quotas. Checkpoint/delta/reconnect, bounded ACK, persisted resume и явный resync после restore. Только manual peer addresses; mDNS discovery оставлен последующим улучшением согласно session prompt. Новых packages/dependencies нет.
- Двухпроцессный harness: реальные отдельные Node-процессы и SQLite-файлы, pinned TLS, 40 задач, многокусковой bootstrap, обрыв/kill/restart, потерянный reply после commit, офлайн независимые и конфликтующие планы, resolution/delete/revoke. Отдельно проверены отмена repair при shutdown, неизвестный peer, неправильный pin, expired invitation, foreign scope и отсутствие HTTP body до проверки pin.
- P09 UI реализован в существующих компонентах: attach_existing, устройства/pairing/адреса/прогресс/revoke/resync, local checkout/participant mappings, конфликты и editor plan CAS. Новых visual primitives нет; использованы существующие `.pen`-представленные controls. Select получил только `id`/`aria-label`. Chromium light/dark: 2 passed; полный perf/e2e на изолированной БД: 7 passed. Draft plan сохраняется при stale response; WS sync и reconnect инвалидируют React Query.
- Общие writers сверены AST-инвентаризацией. Закрыт дополнительный прямой runtime-gate status writer; все attachment paths/bytes исключены из wire contract. Local uploads personal routes сохраняются в БД без записи в checkout. Добавлены фактические MCP-tool CAS tests, а не только вызовы data helpers.
- Полные package runs: shared 245 passed (min coverage 72.57%); data 298 passed (74.51%); web 733 passed (74.49%); MCP 105 passed (86.27%); agent 399 passed (76.26%); runtime 901 passed / 1 skipped (73.22%, без унаследованного CODEX_CLI_PATH). Финальный API coverage run на закоммиченном коде: 519 passed / 2 baseline failures (min 71.01%), включая cancellation/repair, protocol downgrade и structured storage diagnostics. Все измеренные метрики выше 70%; API suite не зелёный.
- Итоговые `npm run build` 7/7 и `npm run lint` 10/10 прошли. `npm run ai:validate` был запущен: format/lint прошли, остановка на неизменённом runtime protocol-generator test (5s timeout под общей нагрузкой; isolated suite прошёл). Assertions/timeouts не ослаблялись. API baseline: Windows POSIX file-mode expectation и `E:\\tmp` vs `\\tmp` в GitHub fixture. `ai:protocol` прошёл с bundled CLI 0.145.0; унаследованный внешний CLI 0.159.2 несовместим с SDK 0.145.0. `ai:load` сообщил отсутствие k6 и пропустил шаг; это не успешная нагрузочная приёмка.
- Package CHECKLIST shared/data/api/agent/mcp/web просмотрены. DB boundary, browser-safe exports, миграции и их upgrade tests, shared consumers build, API/MCP/WS docs и UI theme checks выполнены. Runtime adapters/capabilities не менялись; Docker package/dependency sync неприменим. Документация: `docs/local-device-sync.md`, ADR, API/configuration/MCP и AGENTS map. Реальные Mac paths/toolchain/firewall и native Win↔Mac round trip остаются открытыми.
- M1 не объявлен принятым: нужен доступный Mac, устранение/согласование baseline quality failures и реальная нагрузочная проверка с k6. Runtime guards сохраняются. Push/PR не выполнялись, M2–M4 не отмечены готовыми.
- Дополнительный итоговый root run прошёл runtime (901 passed), но обнаружил пропущенный Turbo passthrough новых env-настроек; `turbo.json` и строгий env contract test исправлены. В этом же запуске новый `existingCheckout` Git-fixture превысил 5s под общей нагрузкой; это не помечено как baseline. Изолированные native fixtures проходят, assertions и timeout сохранены. Общий gate остаётся открытым до устойчивого полного запуска.
- Заключительный `ai:validate` после code commits (`89cb12a`): format/lint прошли, data 298 / MCP 105 passed, остановка снова на baseline runtime protocol-generator timeout (900 passed, 1 failed, 1 skipped). Лог `.git/personal-committed-validate.log`; отдельный API coverage `.git/personal-committed-api-coverage.log`. Финальные build 7/7, lint 10/10 и targeted peer/UI tests прошли. Изолированные Git/Turbo tests 5 passed после исправления passthrough. Все изменения сохранены локально, временные dev servers остановлены.

## See Also

- P05/P06: доменные writers для projects/tasks/plans/comments/handoff/history, GitHub import и reorder теперь записывают whitelist delta в общей SQL-транзакции; REST/MCP принимают field revisions. Remote materializer не вызывает Git/runtime/files и не создаёт echo. Явное participant binding обновляет локальные назначения; deactivation не удаляет общую идентичность. Добавлены conflict list/resolve API с parent-set CAS и детерминированный порядок карточек. Дополнительно закрыта Git-подготовка в personal task events до runtime gate.
- Проверки P05/P06: data sync suites 23 passed, API personal suites 10 passed, MCP full suite 103 passed; build 7/7, lint 10/10. Проверены две БД с разными participant UUID, отсутствие credentials/roots на wire, plan CAS rollback, независимые edits, concurrent plans/resolution, tombstones и maintenance exclusions. Полные quality gates и транспортные проверки ещё открыты.

- [Требования и архитектурные инварианты](../specs/personal-lan-handoff.md)
- [Готовый запуск следующей сессии](../specs/personal-lan-handoff-session.md)
- [Существующие package rules](../../AGENTS.md)
