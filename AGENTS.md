# AGENTS.md

> Project map for AI agents. Keep this file up-to-date as the project evolves.

## Project Overview

Autonomous task management system with Kanban board and AI subagents. Tasks flow through stages automatically (Backlog → Planning → Plan Ready → Implementing → Review → Done), each handled by runtime-resolved workflows (Claude adapter first). Skills-mode tasks (`useSubagents=false`) can optionally insert Improve after Planning and Verify before Review.

## Tech Stack

- **Language:** TypeScript (ES2022, ESNext modules)
- **Monorepo:** Turborepo (npm workspaces)
- **API:** Hono + WebSocket
- **Runtime Abstraction:** `@aif/runtime` workspace (runtime/provider contracts + registry)
- **Database:** SQLite (better-sqlite3 + drizzle-orm)
- **Frontend:** React 19 + Vite + TailwindCSS 4
- **Runtime:** Pluggable adapter system (`@aif/runtime`) — built-in Claude (Agent SDK) + Codex (SDK/CLI/API) + OpenRouter (API) adapters
- **Agent:** Runtime-neutral coordinator + node-cron
- **Testing:** Vitest

## Project Structure

```
packages/
├── shared/              # @aif/shared — contracts, schema, state machine, env, constants, logger
│   └── src/
│       ├── schema.ts        # Drizzle ORM schema (SQLite)
│       ├── types.ts         # Shared TypeScript types + RuntimeTransport enum
│       ├── stateMachine.ts  # Task stage transitions
│       ├── constants.ts     # App constants
│       ├── env.ts           # Environment validation
│       ├── logger.ts        # Pino logger setup
│       ├── index.ts         # Node exports
│       └── browser.ts       # Browser-safe exports
├── runtime/             # @aif/runtime — runtime/provider contracts, registry, validation/discovery services, adapters
│   └── src/
│       ├── index.ts         # Public API exports
│       ├── types.ts         # RuntimeAdapter interface, capabilities, execution intent
│       ├── registry.ts      # RuntimeRegistry — adapter registration and lookup
│       ├── bootstrap.ts     # Factory: create registry with built-in adapters
│       ├── resolution.ts    # Profile resolution (task → project → system → env fallback)
│       ├── readiness.ts     # Health check across all registered runtimes
│       ├── capabilities.ts  # Capability assertion before workflow execution
│       ├── promptPolicy.ts  # Agent definition vs slash-command fallback
│       ├── workflowSpec.ts  # Workflow kind, session reuse, required capabilities
│       ├── modelDiscovery.ts # Model listing + connection validation with cache
│       ├── cache.ts         # Generic in-memory TTL cache
│       ├── trust.ts         # Opaque Symbol-based trust token for permission bypass
│       ├── errors.ts        # Runtime error hierarchy
│       ├── module.ts        # Dynamic module loader for external adapters
│       └── adapters/
│           ├── TEMPLATE.ts      # Adapter development guide + skeleton
│           ├── claude/          # Claude adapter (Agent SDK transport)
│           ├── codex/           # Codex adapter (CLI + API transports)
│           └── openrouter/      # OpenRouter adapter (API transport)
├── data/                # @aif/data — centralized data-access layer
│   └── src/
│       ├── participants.ts  # Participant lifecycle and admin invariants
│       ├── authSessions.ts  # Password/session/CSRF persistence
│       ├── taskOwnership.ts # Atomic handoff, assignments, executor history
│       ├── taskTransitions.ts # Actor-aware atomic task transitions
│       ├── audit.ts         # Immutable audit persistence
│       ├── personalMode.ts  # Persisted personal execution/publication restrictions
│       ├── devices.ts       # Local device identity and API process ownership
│       ├── projectBindings.ts # Explicit local checkout registration
│       ├── participantBindings.ts # Logical attribution vs local account bindings
│       ├── syncJournal.ts   # Transactional causal registers, inbox/outbox and ACK
│       ├── syncCheckpoints.ts # Immutable checkpoint staging and atomic bootstrap
│       └── index.ts         # Public repository API
├── api/                 # @aif/api — Hono REST + WebSocket server (port 3009)
│   └── src/
│       ├── index.ts         # Server entry point
│       ├── routes/          # tasks/projects/chat/runtime profiles plus auth/participants
│       ├── services/        # runtime.ts, codexIndex.ts, fastFix.ts, roadmapGeneration.ts
│       │                    # github.ts provides the GitHub REST client
│       ├── middleware/      # logger.ts, rateLimit.ts, zodValidator.ts
│       ├── schemas.ts       # Zod request validation
│       └── ws.ts            # WebSocket handler
├── web/                 # @aif/web — React Kanban UI (port 5180)
│   └── src/
│       ├── App.tsx          # Root component
│       ├── components/
│       │   ├── auth/        # LoginPage
│       │   ├── participants/ # Participant menu and administration dialog
│       │   ├── kanban/      # Board, Column, TaskCard, AddTaskForm
│       │   ├── task/        # Detail, ownership/handoff, executor timeline
│       │   ├── layout/      # Header, CommandPalette
│       │   ├── project/     # ProjectSelector, ProjectRuntimeSettings
│       │   ├── settings/    # RuntimeProfileForm
│       │   └── ui/          # Reusable UI primitives (badge, button, dialog, etc.)
│       ├── hooks/           # useTasks, useProjects, useWebSocket, useTheme, useRuntimeProfiles
│       └── lib/             # api.ts, notifications.ts, utils.ts
└── agent/               # @aif/agent — Coordinator + runtime-driven subagent orchestration
    └── src/
        ├── index.ts         # Agent entry point
        ├── coordinator.ts   # Polling coordinator (node-cron)
        ├── autoQueueCommit.ts # Awaited Git commit gate before auto-queue terminal states
        ├── subagentQuery.ts # Universal runtime-backed query execution
        ├── reviewGate.ts    # Auto-review gate using adapter lightModel
        ├── hooks.ts         # Activity logging, project root
        ├── stderrCollector.ts # Generic stderr ring-buffer
        ├── notifier.ts      # Notification system
        ├── githubWorkflow.ts # GitHub sync, branch push, and PR publication
        ├── codex/           # Codex login broker (OAuth-in-Docker bridge)
        └── subagents/       # planner.ts, implementer.ts, reviewer.ts

.claude/agents/          # Agent definitions (loaded by runtimes that support them)
.docker/                 # Dockerfile, entrypoint, Angie configs
data/                    # SQLite database files (gitignored)
.ai-factory/             # AI Factory context and references
```

## Key Entry Points

Personal LAN M1 adds `packages/shared/src/sync/` (strict portable contracts/causality),
data `syncJournal.ts`, `syncCheckpoints.ts`, `syncMutations.ts`, `syncDomain.ts`,
`syncConflicts.ts`, `peers.ts` and `peerSync.ts`. The API owns pinned TLS transport in
`services/peerIdentity.ts`, `peerTransport.ts`, `peerProtocol.ts`, `peerSync.ts` and local
administration in `routes/peers.ts` / `routes/personal.ts`. Personal execution stays
disabled: do not remove execution guards before the M2 grant/fencing gate. See
`docs/local-device-sync.md` for recovery, mutation inventory and native acceptance.

M2 work in progress adds shared `taskCheckout.ts` / `taskCommit.ts` and data
`taskWorkspaces.ts`: exact detached checkouts, saved pre-execution scopes, and
prepared checkpoint intents in local migration v34. Registered task roots are
enforced at stage/API/chat boundaries; their commits use host-controlled snapshot
plumbing. Restore the original scope after restart; never recapture dirty files.
Shared `handoff/` and data `codeSnapshots.ts` add immutable code/context packages,
explicit portable-file manifests and verified blobs. Local migration v35 journals
checkpoint continuation into a new checkout before atomic root/scope activation.
Existing context is never overwritten and registered roots skip implicit AIF init.
P12 adds shared `handoff/gitSnapshot.ts` / `transferContracts.ts`, data
`snapshotTransfers.ts` and API `gitSnapshotTransfer.ts`: explicit pinned-TLS pulls,
durable chunks in migration v36, quarantined Git verification and separate readiness.
Peer requests only read published manifests/chunks; destination bindings/paths are
chosen locally. No transfer, checkout preparation or board sync grants execution.
Workspace registration is internal pending M2 onboarding/grants. Keep M1 personal
execution guards until the grant and stop/fencing gates are complete.

P13 adds shared/data `deviceExecution.ts` and migration v37. Device
grants are separate from board workflow and TTL claims; `withTaskDeviceExecution`
reserves a durable run and fences result writes by grant/epoch/run/root/input.
Coordinator/stage/API/chat lifecycles create the host scope for an internally
enrolled, locally owned standalone task. Runtime promises, callbacks, timeouts,
claims and finalization retain that run; failures remain uncertain until P14
proves process-tree stop. Managed tasks stay excluded from legacy TTL recovery.
Migration v38/data `deviceSessions.ts` binds native/chat sessions to the local
task, grant, checkout and runtime identity; project warmups are not reused.
Personal AI remains disabled. Do not expose enrollment/release/accept as REST/MCP
actions or enable personal AI before P14 and native M2 acceptance are complete.

P14 foundation adds `handoff/deviceHandoff.ts`, data `deviceHandoff.ts` /
`deviceHandoffScope.ts` and local migration v39. Manual handoff freezes checkpoint
intent/context before acknowledgement, atomically relinquishes authority, stages
pinned-peer offers, and accepts a verified local snapshot in a fresh checkout.
The new grant-head `accepted` state is deliberately non-executable (including to
older runners); only a future explicit P15 continuation may promote it to `owned`.
Manual confirmation requires a local admin, human ownership and no managed run
history for the current grant. It cannot substitute for runtime process-tree stop.
Runtime-backed checkpoint/release remains open in P14; there are no browser/MCP handoff
actions or automatic delivery/acceptance/runtime launches in this increment.

P14 native supervision adds runtime `supervision/` with a Windows Job Object
host and data `deviceProcesses.ts` / migration v40 for local launch/stop receipts.
Persist host identity before creating the child, and its suspended identity before
resuming. API `deviceProcessSupervisor.ts` is an internal bridge, with no routes.
Empty-job evidence does not release a run/grant or establish adapter-wide coverage.
Complete Claude/Codex/OpenRouter/OpenCode transport coverage remains open. The targeted
native Mac runtime/API suite passed on 2026-10-03 (54 + 2 tests, user-supplied logs).
Unsupported platforms must reject; never substitute PID/group signals or
elapsed time for native stop proof. Existing personal AI guards remain enabled.

The standalone runtime `probe:macos-supervision` command
(`scripts/macos-supervision-probe.mjs` plus its fixed native C fixture). It checks
an isolated launchd resource coalition, double-fork/setsid orphan accounting and
audit-token signaling. It never reads the task DB or enables Mac execution.
The user's native arm64/Darwin 27.0.0 report passed on 2026-10-03: stable root-only
baseline 2/1/1, running 4/2/2, orphan 4/3/1, stale-token ESRCH, coalition reaped
after service removal and verified cleanup. Keep baseline-relative exact deltas.
This accepts the diagnostic fixture only. The internal Mac backend now lives in
`macosSupervisor.ts` / `macosSystem.ts` / `macosNativeSource.ts`: a one-shot launchd
host with a private socket, suspended posix_spawn, durable host/child callbacks,
audit-token stop and independently verified empty coalition. Mac receipts add
UID/boot/unique-ID bindings to the existing v40 JSON journal; no migration is
rewritten. Recovery compiles a fresh trusted helper and rejects a different boot
or user. It records stop only, never releases task authority. All nine native Mac
process cases and both API journal/recovery cases passed after the fixes in
`2f62264`. Adapter integration, runtime-backed release and full M2 acceptance remain
open; personal AI stays disabled.

The first P14 adapter increment adds runtime `nativeProcessScope.ts`: an opaque
host capability for one exact-root launch, bounded stdio and awaited native stop
including journal acknowledgement. Codex app-server uses its async launcher;
native start timeout never retries. Unintegrated built-in transports reject this
scope before work, and the registry skips process-spawning model discovery.
API `runTaskDeviceAppServer` is an internal new-session bridge for an already
enrolled standalone task; it rejects resume/fork, other runtimes and scope
substitution. No routes/coordinator/chat call it yet. Windows needs a literal
`.exe`, not `.cmd`; native environment restores only libuv's OS essentials.
External service/config coverage, remaining transports, normal admission and
runtime-backed checkpoint/release remain open. Stop of this unit grants no
handoff authority. The separate adapter Mac smoke passed on 2026-10-03 from user
logs: 16 scope/parity + 21 app-server + 5 native API = 42 tests. The native API uses
an offline protocol fixture; this is not a live provider run or complete P14/M2.
See the current plan and device-sync instructions.

P14's second adapter increment connects the default Codex JSONL CLI through
`runTaskDeviceCli` and the same internal host/journal gates. It accepts only new
sessions and generated argv (no custom argv, shell or unknown-transport fallback).
Batch completion joins native proof and drained stdio, including already-finished
children. It decodes split UTF-8, bounds total output, requires `turn.completed`
and zero exit, and rejects abort/protocol/callback errors without retry. Global
session-limit scans are skipped in this scope; stream usage remains PARTIAL.
The Windows native fixture covers success, cancellation and timeout with a
detached writer and large stdin. The targeted Mac CLI smoke passed on 2026-10-03
from user logs: 85 runtime + 9 API = 94 tests, including native success/abort/timeout.
This uses an offline provider fixture, not a live model or full P14/M2 acceptance.
Claude, Codex SDK/API, OpenRouter and OpenCode still reject native scope.
Personal AI, normal runner admission and runtime-backed release remain closed.

P14's SDK increment uses `runTaskDeviceSdk` and a fixed Node worker under the
native supervisor. Managed SDK execution occurs inside that worker; its private
CLI spawn inherits the same native unit. `nativeBatch.ts`
shares bounded collection/stop handling with CLI; `nativeSdkProtocol.ts` validates
projected events before host callbacks. Secrets travel through bounded stdin,
not argv, and worker failures are opaque. New text-only sessions are admitted;
custom config/argv, hooks/env, output schema and resume/fork remain denied.
No global session scans or native retries occur. Windows tests cover actual SDK
topology, success/abort/timeout, malformed output and coordinator-death recovery.
Targeted Mac SDK acceptance was recorded on 2026-10-03 from the user's passing
confirmation for the requested 109 runtime + 15 API set; detailed logs were not
supplied in that report. Claude, Codex API, OpenRouter and OpenCode
still rejected native scope at that increment; normal/personal execution and full P14/M2 remain open.

P14's Claude SDK increment adds `adapters/claude/native.ts`, `nativeWorker.ts` and
`nativeProtocol.ts`, plus internal `runTaskDeviceClaudeSdk`. The fixed native
worker runs the real Agent SDK and its CLI; callbacks stay in the fenced host.
Success requires a matching result, worker completion, zero exit and durable stop.
Legacy executable discovery is lazy; explicit version probes run inside the same
native unit. Settings sources, external MCP config and session persistence are
disabled. Resume/fork, custom hooks/environment/schema/agent definitions and
permission bypass remain denied. No retries or host quota/session scans occur.
Offline actual-SDK tests verify version/CLI parent PID, tool/subagent callbacks,
stop on failure/cancellation and coordinator-death recovery without release.
Claude CLI/API, Codex API, OpenRouter and OpenCode remain closed to native scope.
The Claude increment's Mac smoke was accepted on 2026-10-03 from the user's
confirmation for the requested 54 runtime + 23 API set; API duration was reported
as 38 seconds. No detailed console log or individual counts were supplied.
See `docs/local-device-sync.md`; this is not full Mac/P14/M2 acceptance.
No normal/personal runner or handoff admission is enabled by this internal helper.

P14's Claude CLI/API increment adds internal `runTaskDeviceClaudeCli` and
`runTaskDeviceClaudeApi`. API retains the fork's Agent SDK implementation; direct
CLI runs via `nativeCliWorker.ts` inside the same native worker, without an SDK
handshake or fallback. CLI argv is generated, with literal executable selection,
stdin prompt and an in-unit version probe. Raw CLI stdout/stderr (including
discarded metadata) is bounded; full-stdin abort, final JSON without newline,
missing result, nonzero exit and coordinator-death recovery are tested. Native
SDK/API/CLI share host callback fencing and durable stop; ordinary capabilities
and the new-session/config/external-service restrictions remain unchanged.
Claude CLI/API Mac smoke was accepted on 2026-10-03 from the user's confirmation
for the requested 114 runtime + 39 API set; API duration was reported as 60 seconds.
No detailed console log or individual counts were supplied. See
`docs/local-device-sync.md` for the acceptance scope. Codex API,
OpenRouter and OpenCode remain closed, as do normal/personal runner admission,
runtime-backed release and full P14/M2 acceptance.

P14's HTTP increment adds `adapters/chatCompletion/` and internal
`runTaskDeviceHttp` for text-only Codex API/OpenRouter. Existing request builders
feed a fixed native HTTP worker with bounded input/response, proxy support and
no retries/redirects. Strict JSON/SSE completion, usage and durable native stop
are mandatory; callbacks remain fenced. OpenAI empty-choice usage and OpenRouter
repeated-finish accounting frames have separate validation. Local HTTP client
stop never proves remote inference/billing or another server stopped. OpenCode
remains denied by `opencode/nativeAdmission.ts`, including direct session creation,
until an owned server launch/recovery path is implemented. The user requires
OpenCode in M2 for local LLM tasks on Mac; do not defer it beyond M2. Mac HTTP smoke was
accepted from user evidence on 2026-10-03: 173 runtime + a separately confirmed
15 app-server process tests, plus 67 API tests (255 total). Windows ai:validate passed with 3730 tests,
10 skips, coverage ≥70%, build 7/7, Chromium 8/8 and k6 3/3; normal/personal
admission and full P14/M2 remain open. See `docs/local-device-sync.md` for current evidence and commands.

P14's owned OpenCode increment adds `opencode/native.ts`, `nativeWorker.ts` and
`nativeProtocol.ts`, plus internal `runTaskDeviceOpenCode`. A fixed worker launches
and versions a fresh 1.18.34 server inside the same native unit; it uses private
HOME/XDG/temp/auth and a locally announced endpoint. Existing server URLs, resume,
direct session creation, project/managed config and external MCP remain denied.
The model endpoint is `modelBaseUrl`, separate from the server address. Its own
inference process is not stopped by an OpenCode receipt. Strict new-session
completion and native stop/journal acknowledgement precede success. The optional
`nativeBatch.afterStopped` removes owned artifacts only after verified stop;
crashes/uncertain stop retain them. `deviceOpenCode.test.ts` covers lifecycle,
a detached writer and recovery, and uses `OPENCODE_NATIVE_TEST_PATH` for a real
installed CLI plus a local model/tool fixture. That variable participates in
Turbo test/coverage hashes. The final Windows ai:validate passed on 2026-10-04:
3784 tests, 10 existing skips, coverage ≥70%, build 7/7, Chromium 8/8 and k6 3/3.
The new Mac subset (241 runtime + 14 API) and complete P14/M2 remain open;
normal/personal runner admission is still disabled.

| File                                    | Purpose                               |
| --------------------------------------- | ------------------------------------- |
| `packages/api/src/index.ts`             | API server entry (Hono, port 3009)    |
| `packages/web/src/main.tsx`             | Web app entry (React, port 5180)      |
| `packages/agent/src/index.ts`           | Agent coordinator entry               |
| `packages/agent/src/autoQueueCommit.ts` | Auto-queue completion commit gate     |
| `packages/agent/src/subagentQuery.ts`   | Runtime-aware subagent execution path |
| `packages/runtime/src/index.ts`         | Shared runtime/provider contracts     |
| `packages/data/src/index.ts`            | Centralized data-access API           |
| `packages/shared/src/schema.ts`         | Database schema (drizzle-orm)         |
| `packages/shared/src/stateMachine.ts`   | Task state transitions                |
| `turbo.json`                            | Turborepo task definitions            |

## Documentation

| Document        | Path                    | Description                               |
| --------------- | ----------------------- | ----------------------------------------- |
| README          | README.md               | Project landing page                      |
| Getting Started | docs/getting-started.md | Installation, setup, first steps          |
| Architecture    | docs/architecture.md    | Agent pipeline, state machine, data flow  |
| API Reference   | docs/api.md             | REST endpoints, WebSocket events          |
| Configuration   | docs/configuration.md   | Environment variables, logging, auth      |
| Providers       | docs/providers.md       | Runtime profiles and adapter capabilities |
| MCP Sync        | docs/mcp-sync.md        | MCP tools, transports, and authentication |

## AI Context Files

| File                        | Purpose                               |
| --------------------------- | ------------------------------------- |
| CLAUDE.md                   | Project instructions for Claude Code  |
| AGENTS.md                   | This file — project structure map     |
| .ai-factory/DESCRIPTION.md  | Project specification and tech stack  |
| .ai-factory/ARCHITECTURE.md | Architecture decisions and guidelines |
| .ai-factory/RULES.md        | Project rules and conventions         |
| .ai-factory/references/     | AI provider SDK reference docs        |

## Agent Rules

- Never combine shell commands with `&&`, `||`, or `;` — execute each command as a separate Bash tool call. This applies even when a skill, plan, or instruction provides a combined command — always decompose it into individual calls.
  - Wrong: `git checkout main && git pull`
  - Right: Two separate Bash tool calls — first `git checkout main`, then `git pull`

- DB boundary is mandatory: `api`, `agent`, and `runtime` access database only through `@aif/data`. Direct imports of DB helpers from `@aif/shared/server` and direct SQL construction imports are blocked by ESLint.

## Package Checklist Rule

**CRITICAL:** Check the `CHECKLIST.md` file and ensure all items are completed.

## UI Component Rules

- **Reuse existing components first.** Before creating a new UI component, check `packages/web/src/components/ui/` for an existing primitive that fits the need. Compose existing primitives (e.g. `Dialog` + `Button`) instead of writing new wrappers.
- **Pencil sync required for new components.** If a new UI component is genuinely needed, its design must be synced with the Pencil design system (`.pen` files) using the `pencil` MCP tools (`batch_design`, `get_guidelines`). Never add a visual component to the codebase without a corresponding Pencil representation.
- **UI primitives live in `packages/web/src/components/ui/`.** Domain-specific compositions belong in their feature folder (e.g. `components/task/`, `components/kanban/`).
- **No expensive CSS properties.** Never use `box-shadow`, `backdrop-filter`, `filter: blur()`, `text-shadow`, or other GPU/paint-heavy CSS in components. These trigger costly compositing and repaint cycles, especially on low-end devices and during scroll/animation. Use `border`, `outline`, `opacity`, or solid `background-color` as lightweight alternatives.
- **Theme color pairing → see [`docs/ui-theme-colors.md`](docs/ui-theme-colors.md).** Pairing rules between semantic tokens and fixed-color backgrounds, the verification checklist (light + dark), and known cases live there. Read it before touching color classes on any UI.
- **If you fix a theme-readability bug, append to `docs/ui-theme-colors.md` → "Learnings".** Whenever a change adjusts colors to fix contrast/legibility in a theme (light or dark), add a one- or two-line dated entry with the symptom, cause, and fix. This keeps the doc the single living memory of theme-pairing pitfalls so the same class of bug does not recur.

## Docker Sync Rule

- **Docker config must stay in sync with packages.** When adding a new package under `packages/` or introducing new inter-package dependencies, update the Docker configuration accordingly:
  - `.docker/Dockerfile` — add build stages, `COPY` directives, and build steps for the new package.
  - `docker-compose.yml` / `docker-compose.production.yml` — add or update services, volumes, and dependency links as needed.
  - Verify the Docker build still succeeds after changes: `docker compose build`.

## Runtime Adapter Sync Rule

- **Docs must stay in sync when adding or modifying runtime adapters.** When a new adapter is added to `packages/runtime/src/adapters/` or an existing adapter's capabilities change:
  - `docs/providers.md` — update the "Supported Runtimes" table (including the `Usage Reporting` column).
  - `packages/runtime/src/adapters/TEMPLATE.ts` — verify the template still reflects current conventions.
  - `packages/runtime/src/bootstrap.ts` — register the new built-in adapter.
  - `.docker/Dockerfile` — add any new system-level dependencies.
  - **Usage reporting contract** — declare `capabilities.usageReporting` (`FULL` / `PARTIAL` / `NONE`) and return `RuntimeRunResult.usage` as `RuntimeUsage` or explicit `null`. The discovery test in `bootstrap.test.ts` fails the build if the field is missing.
- **Cross-adapter consistency on shared changes.** When modifying shared runtime infrastructure (`errors.ts`, `types.ts`, `timeouts.ts`, `capabilities.ts`) or refactoring a pattern that exists across multiple adapters — enumerate ALL adapter directories under `packages/runtime/src/adapters/` and verify each is updated. Do not rely on the issue description or plan to list affected adapters — scan the directory.

## Migration Version Rule

- **Migration versions are append-only — never renumber or edit a merged migration.** In `packages/shared/src/db.ts` `MIGRATIONS` array, never change the `version` number or `sql` body of a migration that has already landed on `main`. If a feature branch collides on a version with `main` during merge, append the new migration at the next free slot — do NOT reuse or reorder existing version numbers.
  - **Why:** user databases store progress via `PRAGMA user_version`. If version N is already applied and the SQL behind N is later swapped for different content, `runMigrations` filters `m.version > currentVersion` and silently skips the new content on those DBs. Result: schema drift between code and DB — missing columns, crashes at query time (see v13 runtime_limit snapshot incident).
  - **When resolving merge conflicts in `MIGRATIONS`:** keep the first-merged entry at its original version; move the conflicting second entry to a new trailing version. Do not "reconcile" by editing either slot.
  - **Writing a recovery migration:** `ALTER TABLE ADD COLUMN` statements are idempotent via `isIgnorableMigrationError` (duplicate column → swallowed). Safe to re-issue the same DDL in a later version to backfill DBs that skipped it.

## Nullable Cast Rule

- **Never use `as T` to strip a nullable return.** Helpers like `asRecord(x)`, `JSON.parse` wrappers, and other `unknown → T | null` narrowing functions can legitimately return `null`. Writing `const r = asRecord(x) as T` silently drops `| null` from the type, the TypeScript checker goes quiet, and subsequent `r.foo` access crashes at runtime on real-world nullable inputs.
  - **Always declare the union explicitly:** `as T | null` (or skip the cast entirely).
  - **Always guard before access:** `if (!r) return null` immediately after the cast.
  - **Applies to all adapter parsers** that walk untrusted payloads (Codex session JSONL, Claude stream events, OpenRouter responses) — a missing/null field is normal, not exceptional.

## Structured Error Classification Rule

- **Never use string/pattern matching on error messages to branch logic.** All error classification must go through structured fields: `category` (enum from `RuntimeErrorCategory`), `adapterCode`, or `httpStatus`. Message text is for logging and diagnostics only — never use `.includes()`, regex, or substring checks on `error.message` to make control-flow decisions.
  - Classifiers (`classifyBy*` in `packages/runtime/src/errors.ts`) are the single entry point for mapping raw errors to structured categories.
  - Each adapter's `errors.ts` must preserve structured context (HTTP status, adapter code) on the error object so consumers can branch on it without re-parsing the message.
  - When adding a new error condition, extend the `RuntimeErrorCategory` enum or add a new `adapterCode` — do not add a new message pattern check.

## Project Rules

- Every package must maintain at least 70% test coverage (measured by @vitest/coverage-v8)
- Write code following SOLID and DRY principles
- Always run after implementation: `npm run ai:validate`
