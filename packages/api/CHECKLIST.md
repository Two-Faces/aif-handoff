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
