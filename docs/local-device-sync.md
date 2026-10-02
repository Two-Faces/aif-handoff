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

## Implementation references

- [ADR](decisions/personal-lan-sync.md)
- [Node 22 TLS API](https://nodejs.org/docs/latest-v22.x/api/tls.html)
- [Ed25519 X.509 identifiers, RFC 8410](https://www.rfc-editor.org/rfc/rfc8410.html)
