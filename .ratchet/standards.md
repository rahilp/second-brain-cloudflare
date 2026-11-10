> DRAFT — inferred by ratchet-app-scout; review and edit.

# Standards for second-brain-cloudflare

1. Respect the layer import rules in `src/ARCHITECTURE.md`: pure (`memory/`, `text/`) imports only `constants.ts`; infra (`lib/`, `db/`) never imports domain or edge; domain never imports `routes/` or `mcp/`. Example: `src/db/init.ts` imports nothing from `src/routes/`.
2. Schema and migration logic lives in `src/db/` (e.g. `src/db/init.ts`), never inline in a route or MCP handler.
3. Every query that reads entries is workspace-scoped; `npm run check:scope -- --inventory` must exit 0, and any new exception carries a written justification in the inventory. Example: `scripts/check-scope.mjs`, `src/routes/admin.ts`.
4. Reads of a single entry go through `getReadableEntry` / `assertCanEditContent` in `src/lib/entry-access.ts`, not a raw `SELECT` in the route. Example: `src/routes/capture.ts`.
5. Routes authenticate with `requireAuth` / identity helpers from `src/lib/http.ts` and `src/lib/identity.ts` before touching data.
6. D1 statement limits are respected: no compound SELECT, `IN (...)` list or batch that can grow with brain size past D1's documented limits; chunk instead. Example: the probe fix in `src/db/init.ts` (PR #386).
7. Cron and nightly passes stay within the Worker subrequest budget; any new D1/KV/AI call on a cron path is counted in `test/unit/cron-subrequest-budget.test.ts`.
8. In-line comments are short and to the point (repo AGENTS.md rule). Long rationale goes in the commit message or `src/ARCHITECTURE.md`, not a paragraph above a line.
9. No em dashes in new code comments, test names, commit messages or docs written for this work.
10. Tests are named as behaviours ("does not match a shadow table's own protection error"), not as function names. Example: `test/unit/fts-repair.test.ts`.
11. Tests whose subject is the SQL itself use real SQLite via `test/helpers/sqlite-d1.ts` (against `db/schema.sql`), not `test/helpers/d1-mock.ts` string matching. Mocks are fine for non-SQL plumbing. Example: `test/unit/fts-backfill.test.ts`.
12. Every fix ships with a test that fails on the pre-fix code.
13. Tests never use Cloudflare credentials, remote bindings or the live brain: local SQLite, local workerd/miniflare and recorded fixtures only. Example: `test/helpers/make-env.ts`.
14. New tests live under `test/unit/` (or `test/integration/`, `test/eval/` where the kind fits) as `*.test.ts`, using vitest globals.
15. `npx tsc --noEmit` stays clean; no `any` or `@ts-ignore` added to silence a type error.
16. Shared constants (limits, thresholds, model names) live in `src/constants.ts`, not as magic numbers in modules.
17. Never bypass a git hook (`--no-verify` or equivalent); fix what the hook names.
18. No AI or agent attribution in commits, PR bodies or code.
19. `docs/` is local-only and never committed (only `docs/dashboard-architecture.md` is tracked).
20. User-visible copy (errors, MCP tool text) is honest and matches actual behaviour.
