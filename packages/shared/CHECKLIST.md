# @aif/shared — Checklist

Run through this list whenever you touch anything under `packages/shared/`.

- [ ] If you changed `schema.ts`, generate/apply the drizzle migration and update `@aif/data` repository functions that touch the affected tables.
- [ ] If you changed `types.ts`, check all consumers (`api`, `agent`, `runtime`, `web`) still compile — shared types fan out everywhere.
- [ ] If you changed `stateMachine.ts`, verify every subagent and API route that drives stage transitions still honours the new rules.
- [ ] Keep `browser.ts` free of Node-only imports — the web package depends on it.
- [ ] Task checkpoint changes preserve source/task HEAD, branches, index and unrelated files in native Git fixtures. Begin scopes before writes; reject overlapping pre-existing edits and stale checkpoint refs. Snapshot plumbing must not execute repository hooks or external filters.
- [ ] Context packages verify descriptor/manifest bindings and every blob. Portable paths are explicit, bounded and collision-free; edited existing context, local credentials/settings and unsafe role configuration must not be silently copied or overwritten.
- [ ] Git transfer verifies bundle refs/object format, prerequisites, quarantined objects and target path compatibility before publishing readiness. Full fallback does not move user refs/index; retries never fill deleted context in a previously completed checkout.
- [ ] Adopting an incoming task checkpoint uses its private ref, expected predecessor and verified ancestry. Symbolic refs, divergence and locked refs fail closed; a repeated publication preserves user branches/index/files. Migration upgrades retain existing grant ownership, active runs and native bindings.
- [ ] Native Git fixture files run serially on Windows; retain explicit concurrent-process tests and strict timeouts/assertions.
- [ ] `npm run lint`
- [ ] `npm test`
