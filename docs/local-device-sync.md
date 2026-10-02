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

## Device execution authority foundation (P13, in progress)

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

This is the **foundation, not completion of P13**. Production coordinator/API/chat
lifecycles still need their positive host-scope integration around the complete
run, streamed callbacks, timeout/abort and result finalization. Until then, managed
tasks are excluded from legacy scheduling, claims, watchdog and QA recovery, and
direct stage/helper/chat execution is denied. Taskless execution is also denied
for projects with managed tasks. Personal projects retain the stronger M1 ban.
No autonomous cross-device execution has been enabled or accepted.

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
The targeted P13 fixture commands above comprise 53 tests; native Mac results
for this increment are still pending. Package checklists were reviewed: no new
request bodies/events, dependencies/packages, UI components or adapter capability
changes; Docker/Pencil/adapter synchronization does not apply to this increment.

## Implementation references

- [ADR](decisions/personal-lan-sync.md)
- [Node 22 TLS API](https://nodejs.org/docs/latest-v22.x/api/tls.html)
- [Ed25519 X.509 identifiers, RFC 8410](https://www.rfc-editor.org/rfc/rfc8410.html)
