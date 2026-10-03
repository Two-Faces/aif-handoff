# @aif/api — Checklist

Run through this list whenever you touch anything under `packages/api/`.

- [ ] New or changed REST endpoints → update `docs/api.md` and the Zod schemas in `schemas.ts`.
- [ ] New or changed WebSocket events → update `docs/api.md` and the web client (`packages/web/src/hooks/useWebSocket.ts`).
- [ ] All DB access goes through `@aif/data`. Never import drizzle helpers or construct SQL directly here.
- [ ] Runtime execution goes through `@aif/runtime` — no direct provider SDK calls from routes or services.
- [ ] Validate every new request body/query with Zod via the `zodValidator` middleware.
- [ ] Add integration tests for new routes (happy path + one error path minimum).
- [ ] Filesystem fixtures use `mkdtemp` under the OS temporary directory and clean up afterwards. Tests that assume default paths explicitly stub and restore environment settings; include absolute-path coverage for spawned MCP configuration.
- [ ] Bare-router tests explicitly set and restore `PARTICIPANTS_MODE_ENABLED`. Permission-sensitive scenarios cover an authenticated session separately so a developer's enabled login cannot mask revision/validation assertions with a 403.
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] Peer traffic uses the dedicated pinned TLS listener and project allowlists. Browser/MCP credentials never authenticate peers; personal runtime guards run before Git/filesystem preparation.
- [ ] Code transfer is an explicit local-admin action, uses local checkout bindings, and rechecks peer revocation across awaits. Interrupted/cancelled transfers retain verified chunks; process-death tests cover filesystem preparation before durable completion. Readiness never grants execution.
- [ ] Managed helpers/background QA/chat reserve one host run through all result writes. Late output after cancellation is fenced; session import/resume validates task/grant/root provenance. Personal and taskless execution denials remain enforced before checkout effects.
- [ ] Peer handoff messages carry immutable grants/receipts only. Peers cannot choose paths, confirm local stop or accept/launch a task. Delivery rechecks revocation across network waits; lost ACK never restores a released source.
- [ ] Native process recovery loads identity only from the local data journal. Test actual helper/coordinator death with a separate SQLite fixture; record proof without releasing task authority. No public process-launch/recovery routes exist before the complete execution gate.
- [ ] Internal native adapter bridges require the current task run, exact registered root and matching task/project attribution; reject unbound resume/fork and unsupported transports before launch. Test real native process/journal integration with an offline protocol fixture, and preserve personal execution denial and uncertain-run fencing on abort.
- [ ] SDK worker fixtures use the actual SDK with a local CLI fixture and assert parent/child topology. Isolate inherited SDK originator overrides in tests; prove stop and retained authority after coordinator death rather than treating SDK return as stop evidence.

- [ ] Loopback HTTP fixtures avoid fetch-restricted ports and Windows reserved ranges. Select and bind an available port before requests; do not add retries to runtime attempts or relax authorization/stop assertions to hide fixture setup failures.

- [ ] Owned-server native tests cover detached writers and coordinator recovery without releasing the grant. Keep installed-CLI tests explicit, include their executable selection in test cache hashes, and do not treat a skipped real-binary case as native acceptance.
