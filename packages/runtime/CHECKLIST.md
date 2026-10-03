# @aif/runtime — Checklist

Run through this list whenever you touch anything under `packages/runtime/`.

## Adapter parity is mandatory

Every feature or fix in the runtime layer must cover **every** adapter, not just the one that prompted the change.

- [ ] If you changed a runtime adapter (`adapters/claude`, `adapters/codex`, `adapters/openrouter`, `adapters/opencode`), audit the other adapters and apply the equivalent change. A fix that only lands in one adapter is incomplete.
- [ ] If you added a new capability, field, hook, or option to `RuntimeAdapter` / `types.ts`, implement it in **all** adapters. Do not ship a capability that only one adapter honours unless it is explicitly gated behind `capabilities`.
- [ ] If you changed the `run()` / `stream()` / `validate()` / `listModels()` contract, verify every adapter still conforms — including error classification in each adapter's `errors.ts`.
- [ ] If you changed session/resume semantics, verify parity across adapters that expose session reuse.

## Docs & registration sync

- [ ] Update `docs/providers.md` — the "Supported Runtimes" table must reflect new/changed capabilities, transports, and light models.
- [ ] Update `packages/runtime/src/adapters/TEMPLATE.ts` if conventions changed, so new adapters start from the current shape.
- [ ] Update `packages/runtime/src/bootstrap.ts` when registering a new built-in adapter.
- [ ] Update `.docker/Dockerfile` if an adapter needs a new system-level dependency (CLI binary, package, etc.).

## Tests

- [ ] Native supervision persists host/child identities before creation/resume; target output cannot forge control receipts. Test detached descendants, a full stdin pipe, lost parent/helper processes, reused PID rejection and live-orphan recovery. Unsupported OS mechanisms fail closed without a version allowlist.
- [ ] A native job-empty receipt proves only that containment unit. Do not claim adapter coverage or release device authority until all launch paths and external services for that transport are covered.
- [ ] A macOS capability probe must use only its nonce-scoped launchd service and temporary fixture binary, verify kernel rejection of a stale PID generation, observe an orphan and zero native membership, and confirm cleanup. Probe success never enables production execution or substitutes for a persisted stop receipt.
- [ ] Treat coalition counters as cumulative task accounting. Confirm a stable root-only baseline before allowing forks, then require exact started/exited deltas without rebasing; matching active counts alone must not hide extra completed tasks.
- [ ] Mac supervision verifies suspended creation before resume, separates target I/O from the private control socket, and independently checks that the coalition including the host is empty. Recovery requires the original UID/boot/process incarnation; enumeration, a stopped frame, a timeout or a launchctl error is not empty-group evidence. Bound finalization even if a durable callback is still pending after channel loss.
- [ ] Bind a Unix control connection to its kernel peer audit token before sending target arguments/environment. A hello claiming a real helper PID is not sufficient; reject a different peer without creating a target or persisting its launch identity.
- [ ] Preserve the launch caller's async context across accepted-socket callbacks. Test two concurrent task scopes and input from an unrelated context; restoring context must not bypass the data layer's run/grant fencing checks.
- [ ] Model Node's pause side effect when a control socket is inherited as child stdio for peer inspection. Restore prior flowing state only after the query exits successfully and credentials validate; keep deliberately paused streams paused and reject unverified peers.
- [ ] Bound binary stdin independently from argv/environment text. Account for Base64 expansion, retain decoded-chunk and queue limits, and verify an exact maximum-size round trip before EOF. Surface native stage/code in errors without branching on their message text.

- [ ] CLI fallback tests explicitly stub and restore `CODEX_CLI_PATH`; do not assume the developer's shell has no override. Keep real override cases covered.
- [ ] Add or update unit tests in `packages/runtime/src/__tests__/` for every adapter you touched.
- [ ] If the change spans multiple adapters, add a parity test or table-driven test that exercises each adapter.
- [ ] If Codex App Server protocol artifacts are touched or adapter protocol shapes change, run `npm run codex:app-server:protocol:check --workspace=@aif/runtime` and regenerate with `npm run codex:app-server:protocol:generate --workspace=@aif/runtime` if needed.
- [ ] Run `npm test -- --filter @aif/runtime` and keep coverage ≥70%.

## Final sweep

- [ ] `npm run lint`
- [ ] `npm test`
- [ ] Manually re-read the diff with the question: "did I leave one adapter behind?"
