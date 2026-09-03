# Changelog

All notable changes to Second Brain are documented here. Version numbers match `SB_VERSION` in `src/env.ts` and the desktop app release.

## [3.0.0] — Team Edition

### Shipped in v3.0.0

**Team Edition (single shared team per brain)**

- Personal and Shared (`company`) memory layers on one Worker — no separate team deployment.
- Member management, invite tokens, capture defaults, sharing, author lock, and admin audit trail.
- Dashboard team panel: members, roster, activity, rename team, share/unshare from the UI.
- MCP and REST tools accept optional `workspace`: `personal` | `company` on reads and writes.
- MCP `list_teams` and `GET /team/workspaces` list the teams a caller belongs to (v3.0.0 returns one team per brain).

**Security and tenancy**

- Identity-scoped reads and writes; digest and config admin boundaries; MCP audit events.
- Multi-team write ambiguity resolved: optional `team` workspace id on capture, share, recall, list, graph, and digest.

**Recall in any language (#326)**

- Desktop app: a **Multilingual** reading (`@cf/baai/bge-m3`) in the embedding picker, on its own search index. The storage warning now costs a move between same-size models correctly.

**Upgrade**

- Existing v2 memories become the owner's personal workspace. Nothing is exposed to the team automatically.

### Internal plumbing (not user-facing in v3.0.0)

The codebase supports multiple company workspaces per member (many-to-many memberships, `team` query/body parameter, scoped recall). **v3.0.0 does not expose multi-team in the dashboard, admin UI, or provisioning flows** — each brain still has one shared team. Backlog: [GitHub issues labeled `multi-team`](https://github.com/rahilp/second-brain-cloudflare/issues?q=label%3Amulti-team).

AI clients: on v3.0.0 team brains, `list_teams` returns one entry; omit `team` unless more than one team is returned.

### Migration notes

- Re-run `./scripts/connect-ai-clients.sh` after upgrade to refresh `AI_Instructions/*.md` and the Cursor rule.
- OAuth replaces query-string tokens for MCP (v3).
- Vectorize index must exist for semantic recall; keyword recall continues without it.
