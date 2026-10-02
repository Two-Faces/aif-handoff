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
Продолжай M2 в codex/personal-lan-handoff-m2; подходящий managed worktree
уже создан, сначала найди и используй его вместо создания ещё одной копии.
Работающий M1 checkout E:\Projects\aif-handoff и его серверы сохраняй.
В shared добавлены taskCheckout.ts/taskCommit.ts: exact detached checkout,
scope до начала записи, checkpoint через temporary index и namespaced ref.
Это primitives, ещё не подключённые к runners. P10 остаётся открытой:
нужны общий root/scope lifecycle для implementation/fix/QA/commit,
замена прежнего runtime commit prompt и durable provenance/recovery.
Не восстанавливай принадлежность dirty files новым scope после restart.
Далее следуй зависимостям P11–P15. M3/M4 не отмечай готовыми после M2.
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
- [AC-01–AC-16](personal-lan-handoff.md#13-приёмка)
