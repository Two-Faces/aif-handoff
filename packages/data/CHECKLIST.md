# @aif/data — Checklist

Run through this list whenever you touch anything under `packages/data/`.

- [ ] `@aif/data` is the only legal DB boundary for `api`, `agent`, and `runtime`. Do not re-export raw drizzle helpers or leak SQL construction.
- [ ] If you added a new repository function, keep it cohesive with the existing repository-style API (one function = one intent).
- [ ] If `@aif/shared/schema.ts` changed, update the affected repository functions here in the same PR.
- [ ] Add unit tests covering new query paths and edge cases (empty result, conflict, update of missing row).
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] Shared personal-board mutations journal the whitelist delta in the same transaction; remote apply never calls source writers or emits an outbox echo. Plans/workflow require field revisions.
- [ ] Execution workspace scopes persist before writes; prepared checkpoint intents persist before Git ref publication. Process-restart tests cover Git publication without SQLite acknowledgement. Scope/intent records stay local and never bypass personal execution guards.
- [ ] Continuing a checkpoint reserves the successor before filesystem preparation and activates its root/scope atomically. Restart uses the immutable saved package, clears native session reuse, and never adopts unclaimed target edits or recaptures source context.
- [ ] Snapshot chunk reads/writes enforce current peer/project scope and manifest membership, including cached digests. Persist verified chunks before progress and completion atomically; quotas and cleanup must not delete Git/user files.
- [ ] Device grants stay outside board sync and TTL recovery. Fenced result checks and writes share a transaction; nested timeouts, late callbacks, changed inputs and process restart cannot clear an uncertain run. A received successor remains pending until verified stop/readiness acceptance.
- [ ] Native/chat session provenance stays local and survives UI deletion. Resume requires the same task, grant, snapshot root and runtime identity; old/unbound IDs cannot be adopted by changing cwd or importing a virtual session.
- [ ] Handoff relinquish and successor issuance commit together; lost ACK/restart never restore source authority. Manual confirmation cannot acknowledge an unverified runtime tree. Acceptance reserves its local checkout before Git publication and leaves a non-executable `accepted` head until explicit continuation.
- [ ] Native Git fixture files run serially on Windows; retain explicit concurrent-process tests and strict timeouts/assertions.
- [ ] Native process receipts are local and bound to the originating run/device. Unresolved receipts prevent settlement; recovery records stop only and never clears claims, grants or run reservations. Pre-supervision runs cannot acquire proof retroactively.
- [ ] Runtime-backed handoff checks pre-launch admission for every run in the grant, plus complete bound stop receipts. Freeze code/context with stop acknowledgement; retain active reservations until atomic release. Restart and old callbacks must not replace the frozen proof or reacquire authority.
