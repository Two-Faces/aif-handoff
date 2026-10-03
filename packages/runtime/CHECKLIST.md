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

- [ ] CLI fallback tests explicitly stub and restore `CODEX_CLI_PATH`; do not assume the developer's shell has no override. Keep real override cases covered.
- [ ] Add or update unit tests in `packages/runtime/src/__tests__/` for every adapter you touched.
- [ ] If the change spans multiple adapters, add a parity test or table-driven test that exercises each adapter.
- [ ] If Codex App Server protocol artifacts are touched or adapter protocol shapes change, run `npm run codex:app-server:protocol:check --workspace=@aif/runtime` and regenerate with `npm run codex:app-server:protocol:generate --workspace=@aif/runtime` if needed.
- [ ] Run `npm test -- --filter @aif/runtime` and keep coverage ≥70%.

## Final sweep

- [ ] `npm run lint`
- [ ] `npm test`
- [ ] Manually re-read the diff with the question: "did I leave one adapter behind?"
