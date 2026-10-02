# Personal LAN synchronization, protocol 1

Status: accepted for implementation, 2026-10-02. Scope: M1, P01–P09 of
`.ai-factory/plans/personal-lan-handoff.md`. This document specifies the contract;
it does not claim that the implementation or native acceptance is complete.

## Boundary and compatibility

Each device owns an independent local SQLite database. Existing standalone
projects keep their behavior. Personal projects persist their mode and
`publicationPolicy=local_only`; restarting or disabling LAN synchronization does
not remove these restrictions. A personal project's board may exist without a
checkout. A local binding, never a received path, resolves filesystem access.

M1 refuses every Handoff runtime launch for a personal project, including manual
QA, fix, commit, roadmap, warmup and task-bound/taskless chat. Gate before claims,
Git preparation, attachment writes associated with launches, or runtime setup.
The data claim boundary and the execution boundary provide defense in depth.
Pause, auto-mode and scheduling flags cannot enable execution. M2 may replace
this prohibition only with tested grant/fencing and stop semantics. External
editor sessions are outside Handoff's process control.

`attach_existing` reads an existing Git checkout with argument-array Git calls
and optional locks disabled. It accepts ordinary repositories and worktrees,
records metadata, and does not initialize, fetch, switch, install, create a
manifest or rewrite context. Portable manifests are a separate explicit action.

## Identity and local state

- Project and entity IDs are stable UUIDs. Remote URL/name similarity never
  merges projects. Multiple local bindings can name one confirmed project.
- Device UUID and incarnation UUID identify a writer. A stream key is the tuple
  `(projectId, deviceId, incarnation)`, encoded unambiguously. Sequence numbers
  start at 1 and increase within that stream, not globally across projects.
- Device secrets, local roots, process claims, sessions, runtime profiles and
  credentials stay local. Restoring a backup to a second host requires a new
  identity and bootstrap; it cannot reuse sequence numbers or execution grants.
- A logical participant identity is independent of `participants.id`. Local
  account bindings are explicit and unique; names do not imply identity.
  Portable attribution includes logical ID and display-name snapshot only.
  Local roles, passwords, sessions and active-state are never replicated.
- Unknown logical authors and assignments remain visible as unresolved data.
  They do not create login accounts, populate FKs with foreign local UUIDs or
  confer permissions. Binding to an active local account enables existing local
  authorization checks. Historical name snapshots remain unchanged.

## Operations and causality

API, MCP and worker writers can share the same local database. Each writer
process allocates a fresh operation incarnation; persisted journal rows retain
old incarnations for retransmission. A restarted writer cannot reuse an old
stream sequence after restoring a backup. Peer authentication binds the device
key, not an ephemeral writer incarnation. This is separate from the local
installation identity and API-process lock.

An operation contains protocol/schema versions (both 1), operation UUID, stream
identity, positive safe-integer sequence, project/entity IDs, typed intent,
causal context and a bounded payload. Reject unknown fields/intents and invalid
values rather than applying a generic row patch. Local paths, session handles,
credentials, claims and publication/execution switches are absent from payloads.
Timestamps are diagnostic metadata and never determine conflict winners.

The causal context is a version vector of applied contiguous stream sequences
within the project. A field revision is the operation's `(stream, sequence)`
dot. An incoming write dominates a previous field version only if its context
covers that dot. Retain concurrent versions as a multi-value register. Independent
fields merge. A resolution must explicitly name all observed conflicting parent
dots and cover them in its context; unseen concurrent edits remain conflicts.
Reject a resolution against a changed parent set and require a refreshed choice.

For stable display while conflicted, sort variants by stream then sequence then
operation UUID. This selects a displayed variant, not an authoritative winner.
Plan/status/ownership conflicts block actions that depend on those fields. Task
ordering uses the same stable tie-break after position. Tombstones dominate old
edits, are preserved in bootstrap, and have no implicit resurrection operation.
Comments and immutable history are unions by stable ID with explicit edit/delete
intents; repeated delivery cannot append another history entry or usage charge.

Status and human/AI ownership changes retain existing actor-aware validation at
the local command boundary, with expected revision/CAS. Remote materialization
records the validated domain operation and causal conflict without rerunning
workflow transitions or their side effects. It must not turn received status or
actor metadata into runtime eligibility or local account privileges.

## Atomic journal and receive contract

All shared writers in `@aif/data` use the same transaction boundary. A successful
local command updates its domain rows, field revisions, stream counter and
durable outgoing operation together. A failure rolls all of them back. Capture
explicit whitelisted changed fields in that transaction, never an `updatedAt`
scan. REST, MCP and worker entry points do not write a second journal themselves.

The receiver validates authentication, allowlist, versions, sizes and operation
identity before accepting a batch. The `(stream, sequence)` and operation UUID
are unique. Identical duplicates succeed without effects; reuse with different
content is a structured protocol error. Gaps and unmet causal dependencies may
be durably buffered, but the applied cursor advances only through contiguous,
successfully applied operations. Domain projection, conflict versions, inbox and
cursor commit atomically. Send ACK only after commit. Failure/partial receive
never advances ACK past an unapplied operation.

ACKs are per stream and per peer, monotonic and bounded by the sequence sent.
Filtering one project cannot create a gap in another project's stream. Remote
application never creates a new outgoing operation, runs Git, changes local
bindings or invokes AI. UI broadcasts occur after commit; reconnect refetches
state, so a lost WebSocket message does not lose a domain change.

## Bootstrap and retention

Bootstrap captures a consistent project checkpoint with field versions,
tombstones, logical attribution, immutable records and applied watermarks in one
read transaction. It excludes local state. Transfer bounded chunks into staging,
verify the manifest/digest and completeness, then install atomically with the
checkpoint watermarks. Apply subsequent deltas from those watermarks. Concurrent
local edits are retained and merged, never replaced by a snapshot row overwrite.

A partial checkpoint is not synchronization success. Its cursor is independent
of the applied cursor and survives reconnect. Retain operations after the
checkpoint until the peer has acknowledged them. M1 does not compact away
unacknowledged history; compaction is permitted only with a committed checkpoint
and agreed watermarks for all active peers. An obsolete/revoked peer requires a
fresh bootstrap, preserving deletion history. Disk failure preserves the last
committed state and produces no success ACK.

## Peer authentication and transport

Use a separate TLS listener with pinned peer certificate fingerprints and local
private keys. The browser API stays loopback in personal mode. Manual addressing
is sufficient for initial pairing; discovery never establishes trust. Pairing
requires an expiring single-use random invitation and explicit fingerprint
confirmation on both hosts. Do not reuse browser sessions or MCP bearer tokens.

Subsequent requests authenticate the paired device, enforce its project allowlist
and negotiate protocol/schema 1 before data exchange. Reject unknown/revoked
peers, changed fingerprints and version downgrade. Bound bytes, batch length,
timeouts and retries. Cancellation stops transfer without acknowledging partial
work. Reconnect resumes from durable cursors with capped exponential backoff.
Diagnostics expose counts and structured codes, never private keys/tokens.

## Mutation inventory and verification

P05 must enumerate and test these writer families, including indirect calls:

| Domain       | Entry points to cover                                                      |
| ------------ | -------------------------------------------------------------------------- |
| Projects     | create/attach, name/group/order changes, delete                            |
| Tasks        | create/edit, plan persistence, status actions, scheduling, reorder, delete |
| Ownership    | human/AI handoff, assignments, immutable executor/audit history            |
| Discussion   | comments, comment edits, attachment descriptors                            |
| Integrations | MCP push-plan/sync-status and worker status/plan writers                   |

Runtime-only bookkeeping stays local. Blob bytes and code/context transfer are
M2; M1 displays unavailable payloads separately from board synchronization.

The integration harness uses separate Node child processes and database files;
it never switches the singleton DB concurrently. Exercise both delivery orders,
duplicates, gaps, ACK loss, crash before/after transaction/ACK, restart, concurrent
bootstrap edits, clock skew, independent project allowlists, and stale deletes.
Use authenticated transport between processes, not only mocked transport.

AC-01–06 and AC-14 board/auth map to attach/identity, journal, merge and transport
tests. AC-15 also requires existing regression suites, the M1 launch denial
matrix, and two independent participant UUIDs before/after explicit binding.
AC-07–13, AC-14 code/blob and AC-16 remain M2–M4 acceptance. Real Windows/Mac
smoke, Mac roots/toolchains and native round trips are separate open prerequisites;
two processes on Windows do not count as Mac acceptance.
