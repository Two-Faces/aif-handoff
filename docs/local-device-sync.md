# Personal LAN board synchronization (M1)

M1 shares project metadata, tasks, plans, comments, assignment identities and executor
history between independent local Handoff installations. Each installation keeps its
own SQLite database and works offline. This milestone **does not execute personal
tasks or transfer code, context files or attachment bytes**. Grants, process fencing,
code snapshots and native build/QA belong to M2/M3.

## Start two independent installations

Use Node 22 and separate checkouts/databases on Windows and macOS. Run `npm ci` and
`npm run build` inside Handoff. Do not initialize or install anything inside projects
you want to attach. Set these variables in each API process's environment:

```text
AIF_PERSONAL_MODE=true
AIF_PEER_ENABLED=true
AIF_PEER_PORT=3010
DATABASE_URL=<absolute local path to this device's SQLite database>
```

Start the API with `npm run dev --workspace=@aif/api`. In another terminal start
`npm run dev --workspace=@aif/web`. Direct workspace commands read environment
variables; the root `npm run dev` additionally loads root `.env`/`.env.local` and
starts the existing coordinator/MCP stack. Personal execution remains blocked even
if that coordinator is running. Use the same absolute `DATABASE_URL` for API/MCP.

The personal browser API listens on `127.0.0.1:3009`. The separate peer listener
uses TLS on port 3010 (IPv4 LAN interfaces). Allow that port only on the private LAN
in the host firewall. This implementation does not change firewall rules itself.
Do not expose the development UI or browser API to the Internet.

Device installation identity is outside the database in `~/.aif-handoff/installation-id`.
The local TLS key/certificate is `~/.aif-handoff/peer-identity.json` (override its
directory with `AIF_PEER_IDENTITY_DIR`). Keep that directory private to the OS user.
Keys, passwords, auth sessions, CSRF tokens and runtime credentials never enter the
shared journal. A copied database on another installation fails closed. Only one
API process may own the same device database; MCP writers use separate journal
incarnations while sharing that database.

## Attach and pair

1. In the project picker choose **Create Project → Attach existing checkout ·
   personal board**. Registration inspects Git read-only and preserves HEAD, index,
   dirty files and AI context. Projects receive stable UUIDs; matching names or Git
   remotes do not merge identities.
2. Open **Global settings → Personal LAN sync** on both devices. Compare the full
   certificate fingerprints using the two local screens.
3. On the source, enter the other device's fingerprint, select the boards to share
   and create an invitation. It expires in five minutes and is restricted to that
   client certificate and the selected project IDs.
4. On the receiver, enter `https://<source-LAN-address>:3010`, paste the invitation,
   review its project IDs/fingerprint and accept it. Both devices persist a peer
   certificate pin. A lost pairing reply may be retried with the identical invitation;
   changing the device/project request or reusing it after revocation is rejected.
5. For bidirectional automatic reconnect, save the receiver's address on the source
   as well. Either device's **Sync now** exchanges both directions. Known addresses
   retry every three seconds when healthy, with exponential backoff capped at one
   minute after failure. Manual addresses are the first supported slice; mDNS
   discovery is a later improvement, as specified in the session prompt.
6. Select the received project and open **PROJECT → Personal project**. Attach the
   actual local checkout to that UUID. A received board has no local root until this
   explicit action. Multiple bindings are retained; M1 does not choose an execution
   root or claim code readiness.
7. In **Participant mapping**, explicitly map each shared identity to a local active
   participant account. Until then, names/history remain visible but assignments do
   not grant local permissions. Accounts with the same display name are never linked
   automatically. Roles and credentials stay local. Administration requires a local
   admin when participants mode is enabled.

Participant login accounts are local to each installation. Bootstrap an administrator
against that device's own `DATABASE_URL`, then restart its API with
`PARTICIPANTS_MODE_ENABLED=true` (see [Getting Started](getting-started.md)). Matching
usernames or display names do not share passwords or permissions. Confirming a mapping
recognizes task attribution and assignments while preserving the selected local role.

No real projects from the inventory are automatically attached. A portable manifest
can be written only through the separate confirmed manifest endpoint.

## Editing, conflicts and readiness

The journal captures shared mutations in the same SQL transaction as the domain
write. Receiving data is SQL-only: it never invokes task actions, Git, filesystem
writers, runtimes, push/PR or auto-queue. Imported tasks default to paused/manual;
server guards also block execution after unpause, restart or explicit helper calls.

Independent field edits merge. Concurrent versions of the same field remain in
**Personal project → Conflicts**. Choose a retained version or merge text. A
resolution carries the exact parent dots; if another version arrives, refresh and
review it. Dates do not choose winners. Task positions use a stable ID tie-break.
Deletes retain durable tombstones, so an old bootstrap cannot resurrect a task.

The board plan editor saves to SQLite, retains its starting revision while editing
and preserves a rejected draft. Personal REST/MCP plan and workflow writes require
`expectedSyncRevisions` from the task response. Conflicted values require the explicit
resolution endpoint rather than an ordinary save. Other shared fields accept optional
revision checks. Local runtime state and usage accounting remain outside the journal.

Only attachment descriptors (name, MIME type, size) travel in M1. Paths and content
are excluded. A received descriptor is not a downloadable file or a verified blob.
Local uploads can remain in the source database; their bytes are not copied into a
project by the personal routes. The UI always separates board availability from
execution/code readiness.

## Interruption, recovery and revocation

- Checkpoints use a consistent SQLite snapshot of the portable fields, bounded chunks,
  a SHA-256 digest and per-stream watermarks. Staged chunks persist across restart;
  only the final verified transaction changes the live board. Concurrent local edits
  are merged during installation. Deltas, dedup IDs and contiguous ACKs are durable.
- Cancel stops the current transfer; committed edits and staged chunks remain. A
  future automatic retry may resume it. Disable `AIF_PEER_ENABLED` and restart the
  API to stop all peer exchange while preserving the board.
- Revoke a peer to deny subsequent requests immediately. Revocation does not erase
  either board. To pair it again, create a new explicit invitation. Never bypass a
  fingerprint mismatch by silently replacing a stored pin.
- Use SQLite-consistent backups (stop processes, or the SQLite backup API), preserving
  the journal. Restore the same identity only as replacement of a stopped installation.
  After rollback, explicitly request a fresh two-way bootstrap with
  `POST /peers/:id/resync`; it retains board data, journal and tombstones. A new writer
  incarnation prevents sequence reuse. Do not copy a running installation to create a
  second device. A new installation needs a fresh database/identity and pairing.
- Protocol/schema mismatches stop exchange with a structured error. M1 retains all
  operations and checkpoint history; there is no automatic compaction/GC. Disk-full
  or failed SQL commits do not produce a success ACK. Free space and retry.
- There is no relay or multi-hop delta forwarding. Pair authors directly for each
  board. No peer is a central authority, and no connection failure grants execution.

## Mutation coverage and evidence

| Shared mutation family | Entry points / boundary                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| Projects               | `createProject`, `updateProject`, organization changes, attach, delete                        |
| Tasks                  | create/update/delete, `setTaskFields` whitelist, plan persistence, scheduling                 |
| Workflow               | `transitionTaskStatus`, `applyTaskAction`, `handoffTaskExecution`; actor guards and revisions |
| Ordering               | position-only updates and backlog normalization, independent of `updatedAt`                   |
| Discussion             | comment create/update and portable attachment descriptors                                     |
| Attribution            | logical participants/assignments, source identity dependencies, immutable history             |
| Integrations           | MCP push-plan/status, GitHub issue import/update                                              |
| Local only             | runtime profiles/options, claims/heartbeat, usage, QA state, paths, local account lifecycle   |
| Denied for personal    | coordinator claims/advance/watchdog/runtime-gate writes and all runtime launch helpers        |
| Remote                 | `materializeSharedEntity` / checkpoint installation; no source writers or side effects        |

Tests include causal permutations, gaps, duplicates, collisions, rollback, stale ACKs,
tombstones, checkpoint integrity, explicit participant mappings across different UUIDs,
REST/MCP CAS and execution denial. `peerProcesses.test.ts` runs two real Node processes
with independent on-disk databases over pinned TLS, interrupting bootstrap and losing
a committed delta reply before killing/restarting the receiver. `personal-lan.spec.ts`
checks settings and conflict resolution in Chromium in both themes. Test fixtures are
synthetic; none of the inventoried working copies is modified.

M1 native acceptance completed on 2026-10-02 with Windows and macOS installations:
pinned pairing, automatic board exchange, offline edits across a Windows API restart,
conflict retention/resolution, and updates visible on the Mac without reloading.
The user's native Mac diagnostic confirmed its checkout's current HEAD and branch
match the values recorded at attach, and the working tree remains clean.

Separate local participant UUIDs and explicit mappings were exercised in both
directions. An unmapped Mac assignment granted no task participation on Windows;
mapping it to a local member enabled that assignment while admin routes continued
to return 403. Login account counts and local roles remained unchanged by peer sync.
Both devices returned 401 for anonymous board access. The Mac evidence was provided
by the user; Windows API/UI checks were run directly in the acceptance session.

The Comments tab currently displays existing discussion without a standalone comment
composer. Comment creation is available through REST; native attribution acceptance
used a human-owned task with an assigned participant. Code transfer and AI execution
remain outside M1 and disabled for personal projects until M2's execution gates pass.

Validation results and the acceptance evidence are recorded in the
[implementation plan](../.ai-factory/plans/personal-lan-handoff.md).

## M2 implementation in progress: local checkpoint primitives

`@aif/shared` now provides `prepareTaskCheckout`, `assertTaskCheckout`,
`beginTaskChangeScope` and `commitTaskChanges`, with separate prepare/publish and
host-only journal serialization helpers. `@aif/data/taskWorkspaces` records these
in the local `task_execution_workspaces` table (migration v34). These are internal
building blocks; registration has no public endpoint yet. This does not enable
code transfer or personal AI execution.

- A checkout is detached at a full immutable commit ID. Its registration binds
  the project, task, repository, path and base commit. Reuse checks this identity
  and HEAD; it never restores a branch or overwrites edited/deleted context.
  Preparation neither fetches nor pulls and does not copy mutable ignored context.
- The caller must open a change scope **before** task writes in the isolated
  checkout. Existing dirty, staged and untracked paths are excluded. Any later
  change to those files or their staged entries blocks the checkpoint, including
  overlaps within one file. A model-provided list of paths cannot create a scope.
- The helper builds and verifies a whitelisted tree using a temporary index.
  `commit-tree` creates a checkpoint object; compare-and-swap `update-ref` publishes
  only `refs/aif/tasks/<project-and-task-digest>/checkpoint`. Both source and task
  HEADs, branches, indexes and working files stay unchanged. Failure may leave
  unreachable Git objects, but never partially stages or resets user changes.
- These are local **snapshot commits**: project hooks and filesystem monitor
  commands do not run. They are not the existing interactive commit workflow.
  External filters, LFS attributes, working-tree encodings, submodules and symlinks
  currently produce readiness blockers. Built-in Git line-ending normalization
  is retained. No push, PR or runtime is invoked.
- Registration stores `preparing` before Git creation, then commits the original
  scope, `active` state and task root together before execution. A partially
  prepared checkout with new unclaimed edits is blocked instead of adopted.
- Checkpointing stores the immutable candidate commit and whitelist as
  `checkpoint_prepared` **before** advancing the Git ref. Only then does it record
  `checkpointed`. Recovery validates the original journal, parent/tree/diff, files
  and ref. If Git publication succeeded before a process died, the retry accepts
  that same commit; it does not create another one or infer ownership from the
  current dirty tree. Scope/intent JSON is trusted local storage, never API/peer
  input, and is not included in board replication.
- Coordinator, stage runners, fast-fix, QA, task-bound chat and runtime helpers
  resolve registered roots through the shared execution guard. A prepared/sealed
  workspace denies new runs. Plan persistence also checks the registration and
  honors the task root when optional plan metadata is loaded from the database.
  Registered API/auto-queue commits use the journal directly and GitHub automation
  declines publication. Legacy interactive commit now uses only user-staged files;
  its prompt no longer stages the entire checkout.
- `continueTaskExecutionWorkspace` now reserves one successor for a sealed
  workspace revision, prepares a fresh checkout from its code/context snapshot,
  and atomically activates the new root and original change scope. Retrying after
  a process restart uses that reservation; unclaimed target edits block adoption.
  Old checkout files/indexes remain intact. The task's old session ID is cleared,
  and an absolute plan path is converted to a bounded path in the new root.
  Onboarding and exclusive execution remain P13–P15 integration work. The local
  journal does not stop a process already running, issue a device grant, or replace
  stop/fencing checks. These helpers are not a filesystem sandbox; M1 execution
  denial remains until those gates pass.

The existing standalone worktree helper also stops replaying context on reuse,
preserves tracked context on creation, and rejects an unrelated repository that
merely has the same branch name.

Native Windows Git fixtures cover source/index preservation, overlapping staged
hunks, foreign untracked files, binary and UTF-8 paths, HEAD drift, ref contention,
linear checkpoint chains, hook/filter non-execution, and independent Node process
recovery after Git publication but before SQLite acknowledgement. On 2026-10-02,
the user supplied native macOS results: `taskCheckout.test.ts` 30 passed,
`contextSnapshot.test.ts` 10 passed, and `taskWorkspaces.test.ts` 11 passed.
This accepts the local primitives on macOS; full network handoff acceptance remains open.

## Immutable code/context packages (P11)

`captureTaskCodeSnapshot` seals context against the verified task checkpoint.
The descriptor includes full commit/base IDs, Git object format, project/task/device
identity, parent snapshot and a SHA-256 context digest. The manifest contains the
goal, acceptance criteria, completed work, next step, decisions, open questions,
plan revision and check outcomes with referenced context artifacts. Check commands
are data and are never executed during capture, validation or installation.

Tracked context comes from Git blobs at that exact commit, not dirty working files.
Ignored/untracked context requires explicit `portablePaths`. The bounded allowlist
includes `AGENTS.md`, `CLAUDE.md`, Markdown/text under `.ai-factory`, documents under
`docs/agent-context`, portable skills under `.agents/skills`, and role definitions
under `.codex/agents`. Machine settings, `.codex/config.toml`, auth/session files,
user-home context, hidden nested paths and credentials are excluded from this
context overlay. This does not remove files already committed as project code.
Codex TOML roles accept a conservative subset of textual role/model/instruction
fields and read-only/workspace-write sandbox settings; local MCP, commands and
permission escalation require local configuration. Unsupported role syntax blocks
the package instead of being silently rewritten.

Limits are 512 files, 1 MiB per file, 8 MiB total file bytes and 1 MiB manifest JSON.
Paths must be relative, portable across Windows/macOS, and free of case/Unicode or
file/directory collisions. Blob contents, lengths and hashes, plan revision, and
descriptor/manifest bindings are verified on both store and load. Missing blobs
never become ready by referencing another project's cached digest.

Migration v35 appends immutable metadata/blobs and a **local-only** continuation
journal; v34 scopes/intents retain their original values. Snapshot refs are pinned
under `refs/aif/snapshots/<id>` without changing user branches. Installation checks
all existing files before writing missing portable files; existing edited context,
symlink/junction paths and external Git filters block it. Identical retries are
accepted. Portable files remain outside task code commits and their explicit
selection carries forward to the next snapshot unless replaced by the caller.
Registered snapshot execution skips implicit AI Factory initialization, preserving
existing AIF 2.19 project context. Resuming uses a new local session.

Capture and execution-workspace registration remain internal host APIs. P12 adds
explicit REST publish/pull operations for already captured packages, described
below; the full handoff UI remains P15. Board replication does not carry file bytes.
Execution grants and confirmed process stop are P13/P14.
Process-restart tests cover interruption after filesystem materialization but
before activation, with later source-context changes, and passed on Windows and
native macOS. The Mac evidence is the user's targeted Vitest output, not a full
Mac validation run or a network code/grant handoff. To repeat these fixture-only
checks from the Handoff repository root, use filename filters:

```sh
npm test --workspace @aif/shared -- taskCheckout.test.ts contextSnapshot.test.ts
npm test --workspace @aif/data -- taskWorkspaces.test.ts
```

Require actual `Test Files` / `Tests` passed summaries. `No test files found` is
not acceptance, even if a workspace's `--passWithNoTests` setting returns exit 0.

## Explicit Git and context transfer (P12)

Local administration can publish an existing snapshot and pull it from a paired
peer over the pinned TLS listener. The source builds a full [Git bundle](https://git-scm.com/docs/git-bundle)
and, when supported by its history, a bundle with one verified base prerequisite.
The receiver selects the smaller incremental form only when the base commit is
available. Missing prerequisite objects trigger a full-bundle fallback. Neither
side needs GitHub/GitLab SSH or invokes fetch, pull, push, package installation,
hooks, custom filters, LFS download, submodule update or runtime execution.

Bundle headers must advertise exactly the expected immutable snapshot ref and
object format. Incoming packs are first unbundled in an isolated temporary bare
repository, checked with Git fsck, and inspected for portable paths, case/Unicode
collisions, symlinks, submodules and external filters. An incremental quarantine
may read the explicitly selected local repository's object database as an alternate;
the alternate is never taken from peer metadata. Only after these checks are objects
imported and `refs/aif/snapshots/<id>` pinned. User branches, `origin/*`, HEAD,
FETCH_HEAD, index and working files remain unchanged. Unsupported content or a
SHA-1/SHA-256 mismatch produces a blocker; it is not silently rewritten.

Each resource and 256 KiB chunk has a SHA-256 digest. Migration v36 persists outgoing
bytes, incoming manifests, verified chunks and local destination reservations.
Repeated chunks are idempotent; corruption/mismatched replies fail before staging.
Process restart uses the same manifest and continues at missing chunks. The durable
completion flag prevents a later retry from filling deleted context in an already
completed checkout. A crash after Git import/checkout creation but before completion
can safely finish the reserved checkout from frozen context bytes.

Limits: 64 MiB per Git bundle, up to a full and an incremental bundle plus the P11
8 MiB context limit per snapshot, 2 MiB transfer manifest, 512 MiB declared resource
bytes for each local outgoing/incoming store, 100 retained incoming transfers and
two active pulls per API process. SQLite/base64 overhead is additional. Withdraw
exports or remove inactive transfer records through local administration to free
transfer storage; those actions never delete repository objects or user checkout
files. Published bytes remain immutable until explicitly withdrawn; a receiver
rejects a changed manifest under the same pending reservation.

Readiness is separate from board synchronization. Local status reports code,
context, checkout and chunk progress; `executionReady` remains false. A native
local checkout binding and a fresh destination are mandatory. WSL/container or
another device's path is not used by the native host. The task stays paused/manual
with its prior execution root/session until the later grant/onboarding workflow.

Windows tests cover independent databases/processes over real pinned TLS, partial
downloads and process death, full fallback for incomplete base objects, altered
chunks, import into divergent dirty repositories, bidirectional re-export,
revocation and a process crash after checkout identity creation but before the
SQLite completion write. Native Windows↔Mac acceptance of this new transfer layer
remains pending, separately from the accepted local P10/P11 tests and M1 board sync.

On 2026-10-02 the user supplied passing native macOS results for the same P12
fixture checks: `gitSnapshot.test.ts` 6 tests (5.69 s), `snapshotTransfers.test.ts`
4 tests (797 ms), and API `gitSnapshotTransfer.test.ts` / `peerProcesses.test.ts`
12 tests across two files (9.57 s). All **22 tests passed**, including the real
loopback TLS/process-restart scenarios. This closes the targeted Mac smoke;
cross-device Windows↔Mac transfer and the full handoff acceptance remain open.

For a native fixture smoke of P12 after updating Handoff, run:

```sh
npm test --workspace @aif/shared -- gitSnapshot.test.ts
npm test --workspace @aif/data -- snapshotTransfers.test.ts
npm test --workspace @aif/api -- gitSnapshotTransfer.test.ts peerProcesses.test.ts
```

The API suite runs two local child processes with private databases and loopback
TLS ports; it exercises real transport but does not replace Windows↔Mac acceptance.

## Device execution authority and runner lifecycles (P13)

Migration v37 records device grants, their current heads and local runs separately
from board status, human/AI ownership and temporary coordinator locks. These tables
are never included in ordinary board synchronization or bootstrap, and survive
task deletion so an old authority chain cannot silently be recreated.

Host-only enrollment derives a replicated task's first owner from its single
creation dot. A receiving device cannot elect itself. Standalone enrollment is
limited to paused, never-started backlog tasks. Successors bind the predecessor,
next epoch, issuer, destination, transfer ID and immutable snapshot. The issuer
must own the predecessor; SQLite permits one successor per epoch/predecessor.
Issuance requires a durable release record that only the future P14 verified-stop
transaction will write. No abort/TTL/force shortcut or public proof writer exists.

The receiving host checks a directly authenticated, currently authorized issuer
and known ancestry. Identical deliveries are idempotent; a conflicting successor
quarantines the task. A received grant is **pending**, never execution-ready.
There are no release/accept/enrollment HTTP or MCP endpoints in this increment.

The internal `withTaskDeviceExecution` scope reserves a durable run before work.
It checks device/epoch/grant/run, exact registered checkout, human/AI ownership
revision and an execution-input digest. Result mutations validate and write in
the same SQLite transaction. Human board edits remain available and invalidate
an old run's inputs. Completed-run callbacks cannot overwrite a later run.
Nested unfinished or failed work leaves an **uncertain** reservation, as does an
exception; a new process cannot steal it after restart. Do not clear these rows
or use lock expiry as a recovery method: P14 must establish that writing stopped.

Coordinator, direct stages, API helpers, background QA and task-bound chat now
create one host scope for an internally enrolled standalone task with a local
owned grant and active registered checkout. Nested helpers share the reservation
through runtime promises, event callbacks, artifact writes and finalization.
The adapter promise itself remains pending across a caller timeout. Abort, stale
input and failed calls retain the reservation; watchdog retries are disabled for
managed runs. Only successful settlement clears the matching local claim, in the
same transaction. Legacy TTL/watchdog/QA recovery cannot clear managed runs.
Legacy backlog scheduling, auto-queue advancement and quota recovery stay excluded;
managed tasks enter this integration with an explicitly selected executable stage.
Taskless execution remains denied for projects with managed tasks, including
chat explore mode. Personal projects retain the stronger M1 execution ban.

Local migration v38 binds chat/native sessions to task, project, grant, snapshot
root and runtime/provider/profile/transport. Managed resume requires that saved
provenance; changing cwd or importing an unbound/virtual session is insufficient.
Bindings survive UI session deletion and are never synchronized. Project warmup
sessions are not forked into managed tasks. This establishes origin, not provider
session availability: P15 still owns the local existence check and continuation UI.
P14 must prove process-tree termination before release/accept. No autonomous
cross-device execution has been enabled or accepted.

Fixture checks (require actual passed test summaries):

```sh
npm test --workspace @aif/shared -- deviceExecution.test.ts
npm test --workspace @aif/data -- deviceExecution.test.ts
npm test --workspace @aif/api -- personalMode.test.ts
npm test --workspace @aif/agent -- personalMode.test.ts
```

These cover local DB/Git fixtures, process death/restart, late results, fork
quarantine and closed entry points. They do not establish native process-tree
stop or physical Windows-to-Mac grant handoff; those remain P14/M2 acceptance.

On 2026-10-02 the Windows `npm run ai:validate` gate passed for this increment
using the isolated M2 validation database and ports 3309/5480: 3336 tests passed
with one existing skip, all seven workspace builds passed, Chromium 8/8, k6 3/3,
and protocol artifacts matched CLI 0.145.0. Minimum coverage across the four
metrics per package: shared 75.03%, data 77.66%, API 70.15%, agent 76.31%, runtime
73.25%, web 74.49%, MCP 86.27%. Coverage thresholds/exclusions were unchanged.
The initial targeted P13 fixture commands above comprised 53 tests. The user
reported native Mac passes for shared 9/9, data 20/20 and agent 15/15. API passed
8/9: its bare-router revision test inherited `PARTICIPANTS_MODE_ENABLED=true`
and correctly received an anonymous-access 403 before revision validation.
The same failure was reproduced on Windows with that environment flag enabled.
The fixture now sets its access mode explicitly and tests the revision workflow
both with legacy access and a real admin session/CSRF token. Anonymous denial
and missing/stale revision checks remain strict. `start_ai` uses a backlog fixture
in both modes so its personal execution gate is not masked by a wrong-stage error.
The API fixture now has 10 tests (54 across the four commands); both inherited
login settings pass locally. On 2026-10-03 the user confirmed the corrected API
rerun passed on native Mac. Together with the earlier shared/data/agent results,
all 54 targeted fixture tests are accepted on Mac. This is user-reported native
evidence for the foundation; it does not cover the later lifecycle integration
or P14 native-stop gates.
After the fixture correction, the complete Windows `ai:validate` gate passed
again: 3337 tests, one existing skip, coverage above 70% in every package
(API minimum 70.18%), builds 7/7, Chromium 8/8, k6 3/3 and protocol check.
Only tests, the API checklist and acceptance documentation changed in that fix.
Package checklists were reviewed: no new
request bodies/events, dependencies/packages, UI components or adapter capability
changes; Docker/Pencil/adapter synchronization does not apply to this increment.

The subsequent lifecycle integration adds real SQLite/Git fixtures around a
controllable runtime adapter: coordinator stage completion, delayed stage timeout,
chat cancellation/resume, background QA, checkpoint and snapshot-scoped roadmap
input. No provider/model is called by these tests. The lifecycle Mac smoke commands are:

```sh
npm test --workspace @aif/shared -- db.test.ts deviceExecution.test.ts
npm test --workspace @aif/data -- deviceExecution.test.ts taskWorkspaces.test.ts
npm test --workspace @aif/api -- deviceExecutionLifecycle.test.ts personalMode.test.ts
npm test --workspace @aif/agent -- deviceExecutionLifecycle.test.ts personalMode.test.ts
```

Expected passed counts: shared 30, data 41, API 16, agent 19. Run these after pulling the
lifecycle commit and `npm ci` / `npm run build`; an empty test selection is not
acceptance. Native process-tree stop and physical Windows↔Mac handoff remain P14/M2.

On 2026-10-03 the user confirmed that all four commands passed on native Mac with
the expected counts: shared 30, data 41, API 16, agent 19, **106 passed** in total.
This accepts the P13 grant/fencing/lifecycle increment from `29e718d`. Evidence is
user-reported; the Mac was not accessed remotely. It does not establish a complete
Mac `ai:validate`, actual runtime process-tree termination or physical device handoff.
P14 and the M2 execution gate remain open; personal AI stays disabled.

Windows lifecycle validation on 2026-10-03 passed the isolated `ai:validate` gate:
3358 tests and one existing skip, seven builds, Chromium 8/8, k6 3/3 and protocol
check against CLI 0.145.0. Minimum package coverage metrics: shared 75.03%, data
77.31%, API 70.41%, agent 76.17%, runtime 73.25%, web 74.49%, MCP 86.27%.
Logs: `.codex/m2/logs/lifecycle-final-validate.log` and the final-file rerun
`lifecycle-release-validate.log`. Thresholds, exclusions and test timeouts were
not relaxed. Package checklists were reviewed; migration v38 is append-only and
tested from v37 with existing data. REST request schemas/WS events, packages,
dependencies, runtime capabilities and UI components did not change; Docker,
adapter and Pencil synchronization does not apply. No push or M2→M1 merge occurred.

## Durable manual handoff (P14 foundation; process supervision pending)

Migration v39 adds a local handoff journal and extends grant heads with `accepted`.
The head-table rebuild preserves all existing ownership, epoch, active-run and
release fields; migrations 1–38 are unchanged. Ordinary board sync never carries
this journal or local stop attestations.

The host path is `requested → quiescing → checkpointed → released → received → accepted`.
Request closes new runs and fences callbacks before quiescence. A manual stop
confirmation requires an active local admin, a human-owned task, no active claim
or native session, and no managed run history for that grant. Even a previously
settled adapter call is not proof that background children stopped. There is no
manual force-override for autonomous runs.

Confirmation saves the prepared Git intent and immutable context/blobs in one DB
transaction, before publishing refs or acknowledging the action. Later source
edits cannot become a new checkpoint after restart; portable context comes from
the frozen package. Relinquish, single successor issuance and the released offer
commit together. After release, cancellation is refused; a return requires a new
handoff and higher epoch. Revoked/offline destinations and lost ACK leave source
authority relinquished. Before release, a local manual cancellation is possible
only when the same manual-stop safety conditions hold.

Explicit local acceptance requires the exact verified P12 transfer and matching,
unconflicted board plan. It reserves the local checkout before adopting the task's
private Git ref by CAS. On a return trip, only that ref advances after verifying
ancestry; user branches, index, dirty roots and earlier task checkouts remain intact.
Root/scope activation, native-session reset and the new `accepted` head commit
together. A crash after ref publication can repeat the same acceptance. `accepted`
does not authorize a runner: P15 must provide a separate explicit continuation.
Using a head state distinct from `owned` also keeps older P13 runners from launching
an accepted task during a staggered upgrade.

The pinned peer protocol transfers offers/receipts only. Host delivery and receipt
refresh are explicit, with authorization rechecked after network waits. There are
no public browser/MCP actions, automatic acceptance, new runtime transports, or
changes to the personal execution ban.

Tests cover two local SQLite/Git replicas, a round trip with higher epochs, dirty
user roots, stale input/actors, revocation, a fork over real loopback TLS, and fresh
process recovery after confirmation, Git publication, release and target acceptance
without DB acknowledgement. These are fixtures, not physical Windows↔Mac or native
runtime stop acceptance.

Windows `ai:validate` completed with exit 0: **3386 passed / 1 existing skip**,
lint and tests/coverage 10/10, build 7/7, Chromium 8/8, k6 3/3, protocol check with
CLI 0.145.0 and checklist. Minimum coverage metrics: shared 75.46%, data 78.13%,
API 70.57%, agent 76.17%, runtime 73.25%, web 74.49%, MCP 86.27%.
The isolated driver used a fixture database and ports 3309/5480; evidence is in
`.codex/m2/logs/p14-validate.log`. Only documentation changed after the run.
Root/shared/data/API checklists were reviewed; shared consumers build and the
DB boundary remains enforced. No new packages/dependencies, adapter capabilities
or UI components require Docker/adapter/Pencil changes.

Native Mac fixture smoke was accepted on 2026-10-03 from the user's report that
all tests passed. The requested suite for `7ec806c` contains shared 61, data 50
and API 9 tests (120 total); the Mac was operated by the user, not remotely.
This does not establish full Mac `ai:validate`, native process-tree termination
or physical Windows↔Mac handoff. Reproduction commands:

```sh
npm test --workspace @aif/shared -- deviceHandoff.test.ts db.test.ts taskCheckout.test.ts
npm test --workspace @aif/data -- deviceHandoff.test.ts deviceExecution.test.ts taskWorkspaces.test.ts
npm test --workspace @aif/api -- deviceHandoff.test.ts peerHandoff.test.ts
```

Run after pulling and building the same revision.
Shared/data Git fixture files run serially on Windows to avoid process-startup
contention; all explicit concurrency scenarios, timeouts, assertions, coverage
thresholds and exclusions remain intact.

**P14 remains open:** this journal foundation did not itself implement native
supervision or runtime-backed release. The later native primitives below still
need complete transport integration and acceptance before authority can transfer.
`quiescing` requests cancellation; it never certifies exit. The adapter inventory
includes Claude, Codex, OpenRouter and OpenCode; their current cancellation paths
must not be treated as portable tree-stop proofs. Native supervision must account
for startup races, descendants, process identity reuse and host death before any
autonomous release path is enabled. Windows job objects and POSIX process groups
have different containment contracts; see the primary references below.
The user reported macOS 27.0.1 as the current test environment. Record versions for
diagnostics, but determine supervisor support by checking actual OS capabilities
and behavior at startup. An OS update must not require editing a version allowlist;
unavailable or unverified stop mechanisms must continue to block runtime release.
On 2026-10-03 the user also confirmed `xcrun --find clang` resolves to
`/Library/Developer/CommandLineTools/usr/bin/clang`. This establishes the compiler
prerequisite for a future native Mac probe, not supervision support.

## Windows native process supervision (P14, transport integration pending)

The host-only `launchSupervisedProcess` primitive uses an in-memory C# helper
under Windows PowerShell. It creates a dedicated non-inherited Job Object with
kill-on-close and no breakaway, then passes `PROC_THREAD_ATTRIBUTE_JOB_LIST` to
`CreateProcessW`. This avoids an uncontained child between creation and job
assignment. The child remains suspended until the local prepared receipt commits.
Native API availability is exercised at launch; no OS version allowlist is used.

Migration v40 adds local `task_device_processes` receipts:
`reserved → identified → prepared → stopped`. The data callbacks persist the
helper's PID/birth/job identity before child creation and the suspended child's
identity before resume. A run with unresolved receipts cannot settle on a mere
successful JS return. Upgrade preserves existing runs/grants; older runs do not
gain stop evidence. Receipts are never replicated or accepted from peers.
The internal bridge validates the registered task checkout before reservation,
creation and resume. The source project root cannot be substituted as the cwd.

The helper's control pipe is separate from target stdout/stderr/stdin. A target
printing a fake `stopped` message cannot certify itself; a full stdin pipe cannot
block cancellation. On root exit or cancellation the helper terminates remaining
job members and queries native accounting until membership is zero. Only then
does it emit evidence. Helper loss rejects the current call without fabricating
proof, even though kill-on-close starts terminating descendants.

Explicit internal recovery loads identity from the local journal, checks the
original host's birth time through an open process handle, stops that host, then
terminates/queries the original job. A reused/mismatched PID is never killed.
The saved Windows session ID must also match: `Local` job names in another
session's namespace cannot establish that the original job is absent.
Recovery may repeat after lost acknowledgement. Stop receipts survive board-task
deletion, but do not clear the active run, claim, grant or handoff phase.

Native fixtures cover detached descendants, continued writes, a root exiting
before its child, helper death, caller death before resume/during execution,
separate-process SQLite recovery, forged output and an unrelated live process.
The runtime primitive proves only its Job Object is empty. It does not establish
that work delegated to external services, remote MCP servers or broker-created
processes stopped. Transport-specific coverage must be established before a
runtime-backed handoff can consume this evidence.

**Still open:** Claude/Codex/OpenRouter/OpenCode adapter integration, native Mac
backend acceptance, autonomous checkpoint/release and physical Windows↔Mac acceptance.
The adapters still use their existing cancellation paths. Linux and unsupported
mechanisms reject; they never fall back to a PID or process-group signal.
Personal AI and public launch/recovery actions stay
disabled. This sub-block does not complete P14.

Windows `ai:validate` completed with exit 0 on the final sources: **3410 passed /
1 existing skip**, lint and tests/coverage 10/10, build 7/7, Chromium 8/8, k6 3/3,
protocol CLI 0.145.0 and checklist. Minimum coverage metrics: shared 75.56%,
data 78.57%, runtime 73.54%, API 70.57%, agent 76.17%, web 74.49%, MCP 86.27%.
Evidence is in `.codex/m2/logs/supervision-final-validate.log`; hashes of the 20
changed/new TS files matched before and after validation. The driver used its
private fixture database and ports 3309/5480. Root/shared/data/runtime/API
checklists were reviewed. No packages/dependencies, adapter capabilities,
REST/WS contracts or UI components changed, so Docker/adapter registration and
Pencil synchronization do not apply.

Common Mac regression for migration v40 and run journals was accepted on
2026-10-03 from the user's report that the requested tests passed. The target
suite for `d63cd8b` contains shared 25 and data 36 tests (**61 total**). The Mac
was operated by the user, not remotely. Reproduction commands:

```sh
npm run build
npm test --workspace @aif/shared -- processSupervision.test.ts db.test.ts
npm test --workspace @aif/data -- deviceProcesses.test.ts deviceExecution.test.ts
```

These checks exercise portable contracts, migration and fencing; they do not
certify full Mac `ai:validate`, native Mac process stop or physical handoff.
The Windows Job Object fixtures run only on Windows. The native journal bridge
fixtures also run on Mac once the Mac backend below is available.

## macOS supervision capability probe (native fixture accepted)

Before implementing the Mac backend, test the actual installed kernel interfaces
and launchd behavior with the fixed diagnostic fixture:

```sh
npm run probe:macos-supervision --workspace @aif/runtime
```

Run as the logged-in Mac user, without sudo. The command uses the existing clang
from `xcrun`, compiles a small helper inside a private temporary directory, and
registers one nonce-named job under that user's GUI launchd domain. It creates
only its own bounded fixture processes; it does not start an AI provider, read
the task database or change project checkouts or runtime profiles.

The probe requires a dedicated resource coalition with only the identified root
active before allowing the fixture to fork. Kernel task counters are cumulative,
so already completed startup tasks are retained in a frozen baseline. Two equal
accounting samples and unchanged live root identity must confirm this baseline
before the go gate. Thereafter the required started/exited deltas are exactly
`+2/+1` with two active tasks after forking, `+2/+2` with one orphan, and `+2/+3`
with none remaining. Extra completed tasks cannot be hidden by active counts
alone, and the probe never rebases during execution.
A double-fork/setsid child must remain accounted for after its
parent exits and must demonstrate continued writes. Signals use an audit token
and the kernel must reject a deliberately stale PID generation. The signaling
helper also verifies that the target runs this exact temporary fixture executable.
The final result requires the child to be gone, native accounting to be empty
(or the previously observed coalition to be reaped after service removal), an
unrelated control process to remain unchanged, and cleanup to complete.

The output is a JSON report with `status: probe_passed` or `blocked`, structured
blockers, observations and `grantsExecution: false`. Send the complete report,
including blockers on failure. Missing APIs, changed ABI sizes, a shared coalition
or denied signaling remain blockers; no OS version number admits a fallback.
The diagnostic process lifetime is bounded only to limit fixture leaks; a timeout
never establishes successful stop. Failed cleanup preserves the temporary folder
and returns its exact `--cleanup` command. Cleanup verifies the directory owner,
nonce service identity and the compiled binary hash before using that helper.
An explicit cleanup refuses to race a still-running probe driver. A changed
process incarnation, image or coalition is treated as unverified, not as exit.

The probe has portable protocol/negative tests and a passing user-supplied native
fixture report recorded below. A passed probe only establishes a candidate
mechanism. The subsequent Mac backend has its own accepted native runtime/API
report below; adapter transport integration and P14/M2 acceptance remain open.
Personal AI stays disabled.

Windows verification on 2026-10-03: final `ai:validate` exited 0 with 3432 tests
passed and one existing skip, including 22 probe protocol/negative tests. All
package coverage minima remained above 70%; build 7/7, Chromium 8/8 and k6 3/3
passed. The six changed/new runtime files had identical SHA-256 hashes before
and after validation. The CLI also passed ESLint and `node --check`. Evidence:
`.codex/m2/logs/macos-probe-final-validate.log`. Root/runtime checklists were
reviewed; adapter contracts, dependencies, migrations, UI and Docker are unchanged.
This evidence does not include compilation or execution of the C helper on Mac.

The user's first native report on 2026-10-03 (arm64, Darwin 27.0.0) subsequently
confirmed C compilation, both required symbols, a root coalition distinct from
the control, and verified cleanup. It stopped before forks with
`coalition_not_isolated` because the initial probe assumed counters `1/0/1`, while
the reported started/exited/active values were `2/1/1`. The exact source of the
completed startup task was not observed. The baseline fix above handles cumulative
accounting; it does not accept this partial report as orphan, stale-token or stop
proof. The subsequent successful repeat is recorded below.

The baseline correction passed Windows `ai:validate`: 3438 tests passed with one
existing skip (28 probe tests), all package coverage minima above 70%, build 7/7,
Chromium 8/8 and k6 3/3. The four changed runtime files were unchanged throughout
validation. Log: `.codex/m2/logs/macos-probe-baseline-validate.log`.

The user's repeat native report on 2026-10-03 (arm64, Darwin 27.0.0), following
the baseline fix, returned `probe_passed`, no blockers, `cleanupVerified: true`
and `grantsExecution: false`. It reported:

- Separate root/control coalitions; unchanged initial and confirmation counters
  of `2/1/1` (started/exited/active).
- `4/2/2` after the two forks; the detached child had `ppid=1`, a different process
  group and the same resource coalition as the root.
- Kernel rejection of the stale audit token (`audit_signal`, `errno=3`) and
  successful signaling of the actual root.
- `4/3/1` with the orphan still accounted for after the root stopped.
- The known coalition absent (`errno=3`) after child stop and service removal,
  followed by verified cleanup.

This accepts the native diagnostic fixture on that reported environment. The
report was supplied by the user; Codex did not run it remotely. It is not a full
Mac `ai:validate`, a production durable stop receipt or physical Win/Mac task
handoff acceptance. Mac launch/recovery supervision is implemented below but
awaits its own native tests, followed by adapter transport integration.
P14/M2 remain open and personal AI remains disabled.

## Codex CLI native integration (internal P14 increment; Mac acceptance pending)

`runTaskDeviceCli` shares the internal task/run/root/personal admission gate with
app-server. It is not called by ordinary routes, chat or the worker. Only a new
session with generated `exec --json` arguments is admitted; custom argv,
resume/fork and unknown-transport fallback are rejected before launch. Explicit
`cli` is now recognized as a known transport rather than an unknown fallback.
Literal executables and the Windows `.exe` requirement remain unchanged.

The collector waits for both the durable native stop promise and fully drained
stdout/stderr, even if completion happened before the consumer attached. UTF-8 is
decoded across chunk boundaries and a final JSONL line need not end with newline.
Combined stdout/stderr is limited to 16 MiB; overflow stops the unit and fails the
run. Success requires zero exit and `turn.completed`; malformed/incomplete JSONL,
`turn.failed`, `error`, callback failures, cancellation and timeouts reject. No
native retry or fallback occurs. Stop still grants no release or takeover rights.

Native CLI calls do not scan global session-limit files or use custom CLI argv.
Their environment drops ambient `NODE_OPTIONS`/`NODE_PATH` while retaining the
existing curated provider-auth policy and Windows OS essentials. Usage from JSONL
is still `PARTIAL`. External MCP/services and configuration admission, other
transports, bound continuation and runtime-backed checkpoint/release remain open.
Personal AI stays disabled; these internal helpers do not enable it.

Windows targeted regression covers **106 runtime + 9 API tests**. The new API
cases execute the actual CLI collector and native supervisor with an offline
Node fixture using default argv. They verify large UTF-8 stdin, trailing JSONL,
stderr, a detached writer, and durable success/abort/timeout semantics. Cancellation
and timeout retain the fenced run after native stop. There are no paid provider
calls, remote side effects or changes to real project checkouts in these fixtures.

Final Windows `ai:validate` passed on 2026-10-03 (exit 0): **3534 passed / 10
skipped**, coverage at least 70% in every package (runtime minimum 75.09%, API
70.72%), build 7/7, Chromium 8/8, k6 3/3 and protocol CLI 0.145.0. Evidence:
`.codex/m2/logs/native-cli-final-validate.log`. Eight package source/test hashes
matched the snapshot captured near the start of the gate; no sources changed
during it. Root/runtime/API checklists, all four adapter registrations/usage
contracts and native deny parity were reviewed. No dependencies/packages,
migrations, public REST/WS/MCP or UI changed, so their conditional Docker/Pencil/
route checks do not apply. The gate used private SQLite and ports 3309/5480.

After publication/pull, the required Mac subset is:

```bash
cd /Users/aries/Projects/aif-handoff
npm run build
npm test --workspace @aif/runtime -- codexCliNative.test.ts nativeProcessScope.test.ts codexCli.test.ts codexAdapter.test.ts --bail=1
npm test --workspace @aif/api -- deviceProcessSupervisor.test.ts --bail=1
```

Expected **85 runtime + 9 API = 94 passed** (15 native CLI protocol, 16 scope/parity,
33 legacy CLI and 21 adapter tests; 9 native API/journal cases). This increment
needs its own Mac acceptance; the previous 42-test app-server acceptance does not
cover it. Installed clang/macOS SDK is required. Full P14/M2 acceptance is separate.

## Codex app-server native integration (first internal P14 increment, accepted)

`runTaskDeviceAppServer` now connects the existing protocol adapter to the native
supervisor and durable process journal. It admits only an already enrolled,
locally owned standalone task inside its active run, using the exact registered
checkout and matching task/project attribution. It rejects resume/fork and other
transports before process reservation. There are no new routes; ordinary worker
and chat paths do not call it, and personal AI remains disabled.

The host creates an opaque `nativeProcessScope`, permits one launch and joins
native stop plus journal acknowledgement before returning an adapter result.
Cancellation fences the run even when stop succeeds. A start timeout cannot retry
another unit. Pending launches cannot outlive the scope if an adapter forgets to
await them; ignored/forged/reused scopes fail. The stdio bridge preserves binary
input with 64 KiB chunks and bounds unread output at 4 MiB per stream. Registry
model-effort checks retain static validation but skip dynamic discovery that
could spawn an uncontained process.

In this first increment Codex app-server consumed the native scope; Claude,
Codex SDK/CLI/API, OpenRouter and OpenCode rejected it before provider work. The
following CLI increment above now supports the default JSONL CLI path too.
This is not whole-adapter stop coverage: configured MCP/external services,
remaining transports, normal runner admission, local session provenance for
resume/fork and runtime-backed checkpoint/release are still P14/P15 work. No
stop receipt in this increment releases or transfers device authority.

Native launch accepts a literal executable, resolved from absolute PATH entries
without a shell. Windows `.cmd` wrappers require a separate audited integration;
the current path requires a real `.exe`. The curated app-server environment adds
only the Windows OS essentials normally supplied by libuv (including SYSTEMROOT
and TEMP); omitting them caused a real Node fixture to abort before JSON-RPC.
Provider credentials and `NODE_OPTIONS` are not restored from the ambient env.

Windows targeted checks on 2026-10-03 passed: **37 runtime + 5 API**. The portable
runtime set is 16 scope/parity tests plus 21 app-server run tests. The API suite
uses the actual adapter, native host and isolated SQLite journal with a local
JSON-RPC fixture. It verifies that a detached writer stops before a successful
result, cancellation keeps the fenced run, invalid task/root/session inputs do
not launch, and previous crash/recovery cases still work. It makes no paid model
requests or provider authentication calls. Targeted Mac acceptance for this
increment is complete and separate from the accepted 56-test backend suite below.

The user's 2026-10-03 textClipping report (08-19-06 filename) confirms **16 scope/
parity + 5 native API tests passed**, starting at 20:18:15 and 20:18:19 respectively.
All real native/journal cases passed, including the detached writer and abort
fencing. Transport errors logged within the deliberate abort case did not fail
its verified-stop assertions. The other 21 app-server cases were not selected:
the submitted command used `appServer/tests/run.test.ts`, missing the underscores.
The user then ran `npm test --workspace @aif/runtime -- run.test.ts --bail=1`
(the basename is unique in this workspace) and supplied **21 passed**, starting
at 20:21:26, duration 1.02s. This completes **42/42 requested tests** for `0195064`.
It does not establish a full Mac quality gate, a live paid-provider run or complete
P14/M2 acceptance. Application sources did not change during this acceptance.

The final Windows `ai:validate` passed on 2026-10-03 (exit 0): **3515 passed /
10 skipped**, all package coverage metrics at least 70%, build 7/7, Chromium 8/8,
k6 3/3 and protocol CLI 0.145.0. Runtime minimum coverage is 74.91%, API 70.67%.
Log: `.codex/m2/logs/native-adapter-final-validate.log`. Package sources stayed
unchanged during this run. Root/runtime/API checklists were reviewed, adapter
template/provider docs updated and all four registrations/usage contracts checked.
No package, dependency, migration, UI or public REST/WS/MCP change was introduced;
conditional Docker/Pencil/route checks do not apply. The gate used its private
SQLite fixture and ports 3309/5480, preserving the native M1 apps and user data.

Accepted regression commands, retained for future changes (no repeat needed now):

```bash
cd /Users/aries/Projects/aif-handoff
npm run build
npm test --workspace @aif/runtime -- nativeProcessScope.test.ts run.test.ts --bail=1
npm test --workspace @aif/api -- deviceProcessSupervisor.test.ts --bail=1
```

Accepted scope at `0195064`: **37 runtime + 5 API = 42 passed**. The subsequent
CLI increment expands the shared API file to 9 cases; use its current acceptance
commands above. The API cases require the installed
clang/macOS SDK and use private temporary checkouts/SQLite. Preserve full error
output on failure; do not replace native proof with longer sleeps or PID kills.

## macOS native supervisor (targeted native runtime/API suite accepted)

On 2026-10-03 the user supplied passing Mac results after updating the M2 branch
for the `2f62264` stdin fix: **54 runtime + 2 API tests passed**, with no failures
or unexecuted cases in those suites. Runtime started at 19:22:21 and completed in
16.30 seconds; API started at 19:22:39 and completed in 3.94 seconds (Europe/Moscow).
The runtime count comprises 20 simulated OS-boundary tests, 25 protocol tests and
all **9 real native process tests**. Both API cases use the native supervisor and
durable SQLite journal, including recovery from a separate process after a crash.
The environment recorded during validation is macOS 27.0.1, arm64, Node 22.22.2.

This accepts the targeted Mac launch/stop/recovery suite, including binary stdin
through EOF, detached descendants, failed persistence, helper death, and caller
death before/after resume. Evidence is the user's Vitest output, not remote
execution by the agent. The report does not contain the separate shared/data
commands or a full Mac `ai:validate`. The next P14 work is integration with all
four adapter transports and runtime-backed checkpoint/release; physical Windows
↔ Mac handoff and the overall M2 gate remain open. Personal AI stays disabled.

The failed attempts and their fixes below are historical evidence; the passing
runtime/API report above supersedes their pending-acceptance status.

The internal `launchSupervisedProcess` / `recoverSupervisedProcess` dispatch to
`macosSupervisor.ts` and `macosSystem.ts` on Darwin. The bundled Objective-C
helper in `macosNativeSource.ts` is compiled with the installed clang/macOS SDK
and Foundation. A logged-in user's GUI launchd domain is required; no sudo,
system daemon installation or OS version allowlist is used. The compiler and
SDK are required for both launch and recovery.

Each launch creates a UID-owned mode-0700 directory and a UUID-named, one-shot
launchd service. Its executable receives a clean environment via `env -i`.
Task arguments/environment remain data on a private Unix socket; they are not
embedded in native source, a shell command or the service plist. The target gets
only its own stdin/stdout/stderr, and cannot forge control frames through output.
Input and output queues are bounded; a full stdin pipe cannot block control.
Closing stdin is idempotent and subsequent writes are rejected on both platforms.

Before sending a launch request, a trusted query helper inspects the accepted
Unix socket's kernel `LOCAL_PEERTOKEN` through an inherited descriptor. Its UID,
PID generation and current process identity must match the host's hello; no
control data is read or written through that descriptor. The controller then
verifies the executable, user, boot-session UUID and stable root-only coalition counters,
then awaits the durable host-identity callback. The helper uses
`POSIX_SPAWN_START_SUSPENDED` with `POSIX_SPAWN_CLOEXEC_DEFAULT`; the child must be
observed suspended in the same coalition. Only the durable prepared callback
authorizes audit-token resume. Initial setuid/setgid executables are rejected.
These are internal host primitives, not browser/MCP launch actions.

On cancellation, parent-channel loss or root exit, the helper signals members of
its coalition using checked native unique IDs/PID generations and audit tokens.
Enumeration finds candidates; native accounting, not an empty PID list, proves
cessation. Its stopped frame alone is insufficient: the controller separately
waits for the host to exit and the entire coalition to become empty, removes the
service, checks again, then returns evidence. Callback/channel failures remain
uncertain; finalization is bounded even if a durable callback is still pending.
Timeouts never establish successful stop.

Mac receipts extend the existing v40 JSON journal with `macos_coalition_v1`,
UID, boot-session UUID, resource coalition, host unique ID/PID generation and
the prepared child identity. No schema migration is rewritten or needed for
these JSON variants. Host projection preserves every platform binding. Receipt
schemas, mismatched provenance and unresolved-run settlement are tested on the
portable data boundary; receipts stay local and never release a task grant.

Recovery compiles a fresh trusted query/stop helper and uses only identity from
the local journal. A different boot/user, changed host incarnation, inaccessible
member or unverifiable native mechanism blocks recovery; it never signals a
reused PID or infers takeover from a lease. A lost bootout acknowledgement is
accepted only when the exact same-boot coalition is already reaped and the host
is gone. Target launch requests are never persisted, the service has no automatic
restart, and the controller accepts only one connection. After verified removal,
cleanup deletes only the checked UUID/UID-owned directory. This proves cessation
of the native unit; delegated services, privilege-changing work and remote MCP
activity still require transport-specific accounting before P14 can release a run.

The first native backend run on the user's Mac on 2026-10-03 **failed during
helper compilation**: the private `decimal` function collided with the `decimal`
typedef imported by Foundation from the macOS SDK. The supplied runtime log has
38 simulated tests passed and 8 native tests failed; both API bridge tests failed
at the same compilation boundary. These failures precede the native scenarios.
The formatter and all its calls now use `aif_u64_string`; compiler warnings remain
errors and test assertions are unchanged.

The user's second log (2026-10-03, 07:30) gets past compilation and the native
capability query, but rejects the capability frame before registering a service:
38 simulated runtime tests passed, 8 native runtime and 2 API tests failed. The
log does not include the rejected frame. Source review found that the C expression
`@(i.bsd.pbi_status == 4)` boxes an integer, so its `stopped` field cannot satisfy
the required JSON boolean. It now explicitly uses `NSNumber numberWithBool`.
Validation still rejects numeric 0/1; errors at this barrier now include the
phase, identity/boot issue paths and UID/kind checks, without copying raw payloads.
Three additional simulated regressions cover numeric stopped values and an
invalid boot UUID, including cleanup before launchd registration. Native
acceptance was still pending at that revision.

The third native log (2026-10-03, 07:45) passes 41 simulated cases but times out
in all 8 native cases before preparation; the two API bridge cases report
`run_scope_required` inside `onIdentity`. A portable regression reproduced lost
AsyncLocalStorage across accepted-socket callbacks. Binding the frame handler to
the launch caller's async resource now preserves separate concurrent task scopes
and output callbacks, while the data layer still validates every run/grant write.

The user's standalone diagnostic reaches host persistence and then startup timeout;
explicit recovery verifies zero active processes. A subsequent native stack sample
shows the helper waiting in its poll loop. Node 22's child-process implementation
pauses streams inherited as stdio, including this socket passed to the peer query.
The controller now restores its previously flowing state only after query exit and
credential validation. Deliberately paused sockets stay paused; failed credentials
never resume reading. The OS-boundary mock now reproduces Node's pause side effect,
and its new regression failed before this fix and reads the next frame afterward.
The corrected backend still needed a Mac rerun at that revision; the earlier
timeout was not a passing native launch/stop scenario.

On the next Mac run (2026-10-03, 19:10), the first native case passed: suspended
barriers, literal arguments, separate output and verified completion. The second
case returned a native error; `--bail=1` left six cases unexecuted (45 passed,
1 failed across the 52-test runtime scope). Source inspection found that stdin's
Base64 payload incorrectly used the 32768-character argv/environment text guard.
A permitted 65536-byte chunk encodes to 87384 characters and was rejected before
decoding. The binary input path now checks that encoded bound separately while
retaining the 65536-byte decoded limit and 4 MiB queue limit. A new native round-trip
case hashes binary chunks of 24573, 24574 and 65536 bytes through EOF and rejects
65537 bytes at the caller boundary. Native error messages now include adapter code
and, when valid, stage/nativeCode, while preserving structured error fields. The
reported failure did not include its native stage; the bound violation is verified
from source and its correction was subsequently confirmed by the 19:22 native run.
The user separately confirmed both native API bridge tests passed on this Mac run.
This accepts the targeted journal/stop and separate-process crash-recovery cases
for the socket/context revision; it does not accept the incomplete runtime suite
or the subsequent stdin fix.
The passing capability probe above does not certify this helper or its lifecycle.
The complete regression command set remains available for future changes:

```sh
npm run build
npm test --workspace @aif/shared -- processSupervision.test.ts
npm test --workspace @aif/data -- deviceProcesses.test.ts
npm test --workspace @aif/runtime -- macosSupervisor.test.ts macosSupervisorProtocol.test.ts macosSystem.test.ts
npm test --workspace @aif/api -- deviceProcessSupervisor.test.ts
```

Scope at `2f62264`: 13 shared contract tests, 7 data journal tests, 25 simulated
protocol tests, 20 simulated OS-boundary tests, **9 real Mac process tests** and
**2 real native SQLite bridge tests** (76 total; the latest supplied report covers
the 56 runtime/API tests). Later adapter increments expand this API file; refer
to their separate acceptance records and current commands above rather than
attributing those added cases to the original backend report.
The native cases exercise
suspended preparation, literal argv/output, forged output, full stdin, detached
grandchildren, an unrelated live process, failed persistence, helper death and
caller death before/after resume. The bridge records stop without clearing a
crashed run's authority. Windows skips the nine Mac-only cases; this is not
native Mac acceptance. P14/M2 remain open and personal AI stays disabled.

Final Windows verification on 2026-10-03: `ai:validate` exited 0 with **3488
passed / 9 skipped** (the eight Mac-only process cases and one existing skip),
lint/tests/coverage 10/10, build 7/7, Chromium 8/8, k6 3/3 and protocol CLI 0.145.0.
Coverage minima: shared 75.75%, data 78.57%, runtime 74.72%, API 70.57%, agent
76.17%, web 74.49%, MCP 86.27%. SHA-256 hashes of all 15 changed/new package files
were identical before and after the final run. Evidence:
`.codex/m2/logs/macos-supervisor-final-validate.log`. Root/shared/data/runtime/API
checklists were reviewed; no adapter capability, migration, dependency, package,
UI or public route changed. These results do not compile or execute the new
Objective-C backend on Mac.

After the SDK symbol fix, Windows `ai:validate` again exited 0 on 2026-10-03:
3488 passed / 9 skipped, all package coverage metrics at least 70%, build 7/7,
Chromium 8/8, k6 3/3 and protocol CLI 0.145.0. Log:
`.codex/m2/logs/macos-symbol-fix-validate.log`. Root/runtime checklists reviewed;
adapter contracts, capabilities, dependencies, migrations and UI are unchanged,
so their conditional checks do not apply. The existing native tests retain the
compilation regression check; rerun the runtime/API commands on Mac for acceptance.

The boolean/diagnostic fix passed Windows `ai:validate` on 2026-10-03 (exit 0):
3491 passed / 9 skipped, coverage at least 70% in every package (runtime minimum
74.76%), build 7/7, Chromium 8/8, k6 3/3 and protocol CLI 0.145.0. Evidence:
`.codex/m2/logs/macos-boolean-fix-validate.log`. Root/runtime checklists reviewed;
adapter/public contracts, dependencies, migrations and UI are unchanged. This
Windows run does not accept native Mac execution. That revision's runtime/API
scope was 49 + 2 tests; subsequent socket fixes expand it to 52 + 2 as listed above.

Final Windows verification for both socket/context fixes on 2026-10-03:
`ai:validate` exited 0 with **3494 passed / 9 skipped**, coverage metrics at least
70% in every package (runtime minimum 74.77%), build 7/7, Chromium 8/8, k6 3/3,
and protocol CLI 0.145.0. Log:
`.codex/m2/logs/macos-socket-lifecycle-final-validate.log`. The four changed runtime
source/test files were unchanged during this final gate. The earlier
`macos-async-context-validate.log` predates the completed socket fix and is not
acceptance of the final source. Root/runtime checklists were reviewed and extended;
no adapter capability, dependency, migration, UI or public route changed. Native
Mac runtime/API acceptance remains open; use `--bail=1` on the rerun to stop at the
first failed case instead of repeating the same timeout across the suite.

The stdin-bound/error-diagnostic fix passed final Windows `ai:validate` on
2026-10-03 (exit 0): **3495 passed / 10 skipped** (nine Mac-only native cases and
one existing skip), all package coverage metrics at least 70% (runtime minimum
74.82%), lint/tests/coverage 10/10, build 7/7, Chromium 8/8, k6 3/3 and protocol
CLI 0.145.0. Log: `.codex/m2/logs/macos-stdin-limit-final-validate.log`. The four
changed runtime source/test files were unchanged during the gate. Root/runtime
checklists reviewed; no adapter capability, dependency, migration, UI or route
changed. The subsequent **54 runtime + 2 API** Mac rerun passed as recorded above.

## Implementation references

- [ADR](decisions/personal-lan-sync.md)
- [Clang: Objective-C boxed expressions and NSNumber boolean literals](https://clang.llvm.org/docs/ObjectiveCLiterals.html#boxed-expressions)
- [Node 22: inherited stdio streams are paused during spawn](https://github.com/nodejs/node/blob/v22.22.2/lib/internal/child_process.js#L410-L420)
- [Node: binding callbacks to their async context](https://nodejs.org/download/release/v22.18.0/docs/api/async_context.html#static-method-asyncresourcebindfn-type-thisarg)
- [Node 22 TLS API](https://nodejs.org/docs/latest-v22.x/api/tls.html)
- [Ed25519 X.509 identifiers, RFC 8410](https://www.rfc-editor.org/rfc/rfc8410.html)
- [Windows job objects and child-process membership](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Atomic process creation inside a Windows job](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812)
- [Windows session namespaces for named job objects](https://learn.microsoft.com/en-us/windows/win32/termserv/kernel-object-namespaces)
- [Apple setsid: new sessions/process groups](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setsid.2.html)
- [Apple XNU: deprecated NOTE_TRACK/NOTE_CHILD support](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/event.h)
- [Apple XNU: native process identity and audit-token signal implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/proc_info.c)
- [Apple XNU: libproc wrappers](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c)
- [Apple XNU: resource coalition accounting layout](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/coalition.h)
- [Apple XNU: cumulative coalition task counters and active membership](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/coalition.c)
- [Apple XNU: suspended process creation before user code](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_exec.c)
- [Apple XNU: spawn attributes, descriptor inheritance and working directory](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/spawn/posix_spawn.c)
- [Apple XNU: Unix socket peer audit tokens](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/uipc_usrreq.c)
- [Node 22: inheriting stream descriptors in child processes](https://github.com/nodejs/node/blob/v22.22.2/doc/api/child_process.md#optionsstdio)
