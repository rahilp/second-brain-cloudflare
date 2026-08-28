import { COMPRESSION_IMPORTANCE_THRESHOLD, COMPRESSION_MIN_RECALL, isTopicTag } from "../../src/compression/eligibility";

/**
 * Decode a `%"tag"%` bind parameter back to the tag, undoing tagLikePattern's escaping.
 *
 * Production escapes % and _ in the tag and pairs the clause with ESCAPE '\\', so a tag
 * `q3_planning` arrives here as `%"q3\\_planning"%`. Without this the double would look for
 * a tag spelled with a backslash and silently match nothing.
 */
const tagFromLikePattern = (pattern: string) =>
  pattern.replace(/%"/g, "").replace(/"%/g, "").replace(/\\([%_\\])/g, "$1");

/**
 * Does this tag array satisfy `tags LIKE '%"<tag>"%'`?
 *
 * MODELS: ASCII case-insensitivity. SQLite's LIKE matches `Work` for `%"work"%`, and
 * comparing case-sensitively here would make the double disagree with production on exactly
 * the inputs behind #278's rollup bug, where the candidate `Kind:Semantic` selected — and
 * rolled up — every entry carrying `kind:semantic`. test/unit/d1-mock-fidelity.test.ts pins
 * this; do not "simplify" it back to Array.includes.
 *
 * DOES NOT MODEL, so a green test here is NOT coverage of any of these:
 *   - LIKE wildcards in the tag. Real `%"q3_planning"%` also matches `q3-planning`, and
 *     `%"%"%` matches every row; this matches exactly one tag either way. That is why P1's
 *     escaping bug is covered against real SQLite in test/integration/, not here.
 *   - JSON escaping. A tag containing a quote is stored as \\" so real LIKE misses it;
 *     this compares the decoded strings and matches.
 *   - Unicode case folding. SQLite's LIKE is ASCII-only; toLowerCase is not, so this
 *     matches `Σ`/`σ` where real LIKE does not.
 * Anything whose subject is the pattern rather than the tag belongs in a real-SQLite test.
 */
const tagMatchesLike = (tags: string[], tag: string) =>
  tags.some(t => t.toLowerCase() === tag.toLowerCase());

/** What src/db/init.ts's probe sees on a migrated brain — see the handler in all(). */
const SCHEMA_PROBE_RESULTS = [
  ...["entries", "edges", "insight_candidates", "workspaces", "users", "memberships",
    "entry_events", "admin_events", "maintenance_cursor"].map(name => ({ kind: "table", name })),
  ...["idx_entries_created_at", "idx_entries_source", "idx_entries_workspace_created",
    "idx_edges_source", "idx_edges_target", "idx_edges_weight", "idx_insight_candidates_queue",
    "idx_workspaces_kind", "idx_users_token_hash", "idx_entry_events_entry", "idx_admin_events_created"]
    .map(name => ({ kind: "index", name })),
  ...["id", "content", "tags", "source", "created_at", "vector_ids", "recall_count",
    "importance_score", "contradiction_wins", "contradiction_losses", "updated_at",
    "staleness_checked_at"].map(name => ({ kind: "column", name })),
  ...["workspace_id", "actor_id"].map(name => ({ kind: "column", name })),
  // edges.workspace_id arrives by ALTER on upgraded brains and lives in the base
  // CREATE on fresh ones — either way a migrated brain reports it.
  { kind: "edge_column", name: "workspace_id" },
  { kind: "user_column", name: "default_share" },
  { kind: "user_column", name: "removed_at" },
];

export class D1Mock {
  entries: any[] = [];
  edges: any[] = [];
  // Tenancy rows, populated by the real ensureTenantBootstrap when a route's
  // requireIdentity runs against this double. The statements it issues are
  // modelled just faithfully enough for the owner identity to resolve; member
  // provisioning is covered against real SQLite in test/integration/.
  users: any[] = [];
  workspaces: any[] = [];
  memberships: any[] = [];

  prepare(sql: string) {
    let s = sql.replace(/\s+/g, " ").trim();

    // Team-edition workspace scoping. Production appends `AND workspace_id IN (?, ?)`
    // (or a bare `WHERE` form) whenever an Identity is in play. Every integration test
    // in this file runs as the owner whose bootstrap backfill has already moved all
    // seeded rows into the readable set, so filtering would change nothing — the honest
    // move is to strip the clause AND its bound values so the legacy shape handlers
    // keep matching. Workspace isolation itself is NOT modelled by this double; it is
    // covered against real SQLite in test/integration/team-recall-scoping.test.ts and
    // test/unit/team-scoping.test.ts.
    const scopeDrop = new Set<number>();
    if (/workspace_id IN \(/.test(s)) {
      const clauseRe = /(?:AND |WHERE )workspace_id IN \(((?:\?(?:, )?)+)\)/g;
      for (const m of s.matchAll(clauseRe)) {
        const offset = (s.slice(0, m.index!).match(/\?/g) ?? []).length;
        const n = (m[1].match(/\?/g) ?? []).length;
        for (let i = 0; i < n; i++) scopeDrop.add(offset + i);
      }
      s = s.replace(clauseRe, " ")
        .replace(/\s{2,}/g, " ").trim()
        // A clause that was the only condition leaves a dangling connector.
        .replace(/^WHERE\s+(?=ORDER\b|LIMIT\b|GROUP\b|$)/i, "")
        .replace(/\bAND\s+\)/g, ")")
        .replace(/WHERE\s*\)/gi, ")");
    }

    // Production pairs every tag LIKE clause with `ESCAPE '\\'` (see tagLikePattern). The
    // escape clause never changes which query a statement IS, so branches that identify a
    // query by its exact text compare against this form rather than each growing a suffix.
    const sBare = s.replace(/ ESCAPE '\\'/g, "");
    const db = this;

    const makeStmt = (allArgs: any[]) => {
      // Drop the bindings that belonged to the stripped scope clauses, positionally.
      const args = scopeDrop.size ? allArgs.filter((_, i) => !scopeDrop.has(i)) : allArgs;
      return {
      async run() {
        if (s.startsWith("INSERT INTO workspaces")) {
          db.workspaces.push({ id: args[0], kind: args[1], name: args[2], created_at: args[3] });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO users")) {
          const [id, name, email, role, token_hash, suspended, created_at] = args;
          db.users.push({ id, name, email, role, token_hash, suspended, created_at });
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("INSERT INTO memberships")) {
          // INSERT ... SELECT ?, ?, ? WHERE NOT EXISTS (... user_id = ? AND workspace_id = ?):
          // the id pair is bound twice, first to write, then to guard.
          const [userId, wsId] = args;
          if (!db.memberships.some((m: any) => m.user_id === userId && m.workspace_id === wsId)) {
            db.memberships.push({ user_id: userId, workspace_id: wsId, created_at: args[2] });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (s.startsWith("INSERT INTO maintenance_cursor")) {
          return { meta: {} };
        }
        // ensureTenantBootstrap's one-time legacy backfill. Modelled for real so
        // rows pushed by tests without a workspace_id still land in the owner's
        // personal workspace before any scoped read sees them.
        if (s.startsWith("UPDATE entries SET workspace_id = ? WHERE workspace_id = ''")) {
          let n = 0;
          for (const e of db.entries) {
            if (!e.workspace_id) { e.workspace_id = args[0]; n++; }
          }
          return { meta: { changes: n } };
        }
        if (s.startsWith("UPDATE edges SET workspace_id = ? WHERE workspace_id = ''")) {
          let n = 0;
          for (const e of db.edges) {
            if (!e.workspace_id) { e.workspace_id = args[0]; n++; }
          }
          return { meta: { changes: n } };
        }
        if (s.startsWith("INSERT INTO entries")) {
          const colMatch = s.match(/INSERT INTO entries \(([^)]+)\)/i);
          if (!colMatch) throw new Error("INSERT INTO entries missing column list");
          const cols = colMatch[1].split(",").map(c => c.trim());
          if (cols.length !== args.length) {
            throw new Error(`INSERT INTO entries column/bind mismatch: ${cols.length} vs ${args.length}`);
          }
          const row: Record<string, any> = {
            recall_count: 0,
            importance_score: 0,
            contradiction_wins: 0,
            contradiction_losses: 0,
          };
          cols.forEach((col, i) => { row[col] = args[i]; });
          if (row.updated_at === undefined) row.updated_at = row.created_at ?? Date.now();
          db.entries.push(row);
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, vector_ids = ?, tags = ?, updated_at = ?, workspace_id = ? WHERE id")) {
          const [content, vector_ids, tags, updated_at, workspace_id, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.vector_ids = vector_ids; row.tags = tags; row.updated_at = updated_at; row.workspace_id = workspace_id; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, vector_ids = ?, tags = ?, updated_at = ? WHERE id")) {
          const [content, vector_ids, tags, updated_at, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.vector_ids = vector_ids; row.tags = tags; row.updated_at = updated_at; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, vector_ids = ? WHERE id")) {
          const [content, vector_ids, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.vector_ids = vector_ids; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = ?, vector_ids")) {
          const [tags, vector_ids, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.tags = tags; row.vector_ids = vector_ids; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET vector_ids = ?, workspace_id")) {
          const [vector_ids, workspace_id, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.vector_ids = vector_ids; row.workspace_id = workspace_id; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET vector_ids")) {
          const [vector_ids, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.vector_ids = vector_ids;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = ? WHERE id = ? AND tags = ?")) {
          const [tags, id, expectedTags] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row && row.tags === expectedTags) {
            row.tags = tags;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = ?, staleness_checked_at = ? WHERE id = ? AND tags = ? AND content = ?")) {
          // Staleness CAS: guards content as well as tags, because the verdict being
          // written is derived from content and the tag mutation is often a no-op.
          const [tags, staleness_checked_at, id, expectedTags, expectedContent] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row && row.tags === expectedTags && row.content === expectedContent) {
            row.tags = tags;
            row.staleness_checked_at = staleness_checked_at;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (s.startsWith("UPDATE entries SET staleness_checked_at = ? WHERE id = ?")) {
          const [staleness_checked_at, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.staleness_checked_at = staleness_checked_at;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = ? WHERE id")) {
          const [tags, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.tags = tags;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags = ?, updated_at = ?, workspace_id = ? WHERE id")) {
          const [content, tags, updated_at, workspace_id, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.tags = tags; row.updated_at = updated_at; row.workspace_id = workspace_id; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags = ?, updated_at = ? WHERE id")) {
          const [content, tags, updated_at, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.tags = tags; row.updated_at = updated_at; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, updated_at = ? WHERE id")) {
          const [content, updated_at, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.updated_at = updated_at; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ?, tags")) {
          const [content, tags, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) { row.content = content; row.tags = tags; }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET content = ? WHERE id")) {
          const [content, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.content = content;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = json_insert(tags, '$[#]', 'rolled-up'), content = content ||")) {
          const [addition, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            const tags: string[] = JSON.parse(row.tags ?? "[]");
            if (!tags.includes("rolled-up")) tags.push("rolled-up");
            row.tags = JSON.stringify(tags);
            row.content = row.content + addition;
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET tags = json_insert(tags, '$[#]'")) {
          const [tag, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) {
            const tags: string[] = JSON.parse(row.tags ?? "[]");
            if (!tags.includes(tag)) tags.push(tag);
            row.tags = JSON.stringify(tags);
          }
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET contradiction_wins = contradiction_wins + 1")) {
          const [id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.contradiction_wins = (row.contradiction_wins ?? 0) + 1;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET contradiction_losses = contradiction_losses + 1")) {
          const [id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.contradiction_losses = (row.contradiction_losses ?? 0) + 1;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET recall_count")) {
          const [id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.recall_count = (row.recall_count ?? 0) + 1;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE entries SET importance_score")) {
          const [score, id] = args;
          const row = db.entries.find((e: any) => e.id === id);
          if (row) row.importance_score = score;
          return { meta: { changes: row ? 1 : 0 } };
        }
        if (s.startsWith("DELETE FROM entries WHERE id")) {
          const [id] = args;
          const before = db.entries.length;
          db.entries = db.entries.filter((e: any) => e.id !== id);
          return { meta: { changes: before - db.entries.length } };
        }
        if (s.startsWith("INSERT INTO edges")) {
          const placeholderCount = (s.match(/\?/g) ?? []).length;
          if (placeholderCount !== args.length) {
            throw new Error(`INSERT INTO edges placeholder/bind mismatch: ${placeholderCount} vs ${args.length}`);
          }
          const [id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at] = args;
          const existing = db.edges.find((e: any) => e.source_id === source_id && e.target_id === target_id && e.type === type);
          if (existing) {
            existing.weight = Math.max(existing.weight, weight); // ON CONFLICT ... max(weight)
            existing.updated_at = updated_at;
          } else {
            db.edges.push({ id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at });
          }
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("DELETE FROM edges WHERE ((source_id")) {
          // deleteEdge: order-agnostic pair delete, optional trailing type filter.
          const [a, b, c, d, type] = args;
          const before = db.edges.length;
          db.edges = db.edges.filter((e: any) => {
            const pairMatch = (e.source_id === a && e.target_id === b) || (e.source_id === c && e.target_id === d);
            if (!pairMatch) return true;
            if (type && e.type !== type) return true;
            return false;
          });
          return { meta: { changes: before - db.edges.length } };
        }
        if (s.startsWith("DELETE FROM edges WHERE source_id")) {
          // Cascade delete on forget: source_id = ? OR target_id = ? (both bound to the same id).
          const [sid, tid] = args;
          const before = db.edges.length;
          db.edges = db.edges.filter((e: any) => e.source_id !== sid && e.target_id !== tid);
          return { meta: { changes: before - db.edges.length } };
        }
        if (s.startsWith("DELETE FROM edges WHERE provenance")) {
          // runGraphPass prune: inferred edges below a weight, older than a cutoff.
          const [weight, age] = args;
          const before = db.edges.length;
          db.edges = db.edges.filter((e: any) => !(e.provenance === "inferred" && e.weight < weight && e.updated_at < age));
          return { meta: { changes: before - db.edges.length } };
        }
        return { meta: {} };
      },
      async first() {
        // ── ensureTenantBootstrap / resolveIdentity (tenancy) ──
        if (s.startsWith("SELECT id FROM workspaces WHERE kind")) {
          const kind = s.match(/kind = '(\w+)'/)?.[1];
          const row = db.workspaces
            .filter((w: any) => w.kind === kind)
            .sort((a: any, b: any) => a.created_at - b.created_at)[0];
          return row ? { id: row.id } : null;
        }
        if (s.includes("u.role = 'admin'")) {
          // findOwner: oldest admin plus their personal workspace.
          const admin = db.users
            .filter((u: any) => u.role === "admin")
            .sort((a: any, b: any) => a.created_at - b.created_at)[0];
          if (!admin) return null;
          const pm = db.memberships.find((m: any) =>
            m.user_id === admin.id &&
            db.workspaces.some((w: any) => w.id === m.workspace_id && w.kind === "personal"));
          return pm ? { userId: admin.id, personalWorkspaceId: pm.workspace_id } : null;
        }
        if (s.startsWith("SELECT 1 AS ok FROM memberships")) {
          // ownerHasPersonalWorkspace.
          const ok = db.memberships.some((m: any) =>
            m.user_id === args[0] &&
            db.workspaces.some((w: any) => w.id === m.workspace_id && w.kind === "personal"));
          return ok ? { ok: 1 } : null;
        }
        if (s.includes("u.token_hash = ?")) {
          // resolveIdentity's IDENTITY_SQL: token hash to user + both workspaces.
          const user = db.users.find((u: any) => u.token_hash === args[0] && !u.suspended);
          if (!user) return null;
          const wsAll = (kind: string) => db.memberships
            .filter((mm: any) => mm.user_id === user.id)
            .map((mm: any) => db.workspaces.find((w: any) => w.id === mm.workspace_id && w.kind === kind))
            .filter(Boolean);
          const personalWorkspaceId = wsAll("personal")[0]?.id ?? null;
          // The real query aggregates every company membership into one packed
          // `id@created_at` list, because a user may belong to more than one team
          // (memberships is many-to-many). Returning a single id here would have
          // let a mock-backed identity read as a member of one arbitrary team
          // while the real one reads all of them — and the scope bindings that
          // fall out of that list size the D1 batches, so the difference shows up
          // as a subrequest count, not as a wrong row.
          const companyWorkspaces = wsAll("company")
            .map((w: any) => `${w.id}@${w.created_at ?? 0}`)
            .join(",");
          // Personal membership is what authenticates; a team is not required.
          if (!personalWorkspaceId) return null;
          return {
            userId: user.id,
            role: user.role,
            personalWorkspaceId,
            companyWorkspaces: companyWorkspaces || null,
          };
        }
        // GET /entry. Models the COALESCE alias: a row written before the
        // updated_at column exists carries no value, and the route must see
        // created_at rather than undefined.
        if (s.includes("COALESCE(updated_at, created_at) AS last_updated") && s.includes("FROM entries WHERE id = ?")) {
          const row = db.entries.find((e: any) => e.id === args[0]);
          return row ? { ...row, last_updated: row.updated_at ?? row.created_at } : null;
        }
        if (s.includes("SELECT vector_ids FROM entries WHERE id")) {
          const row = db.entries.find((e: any) => e.id === args[0]);
          return row ? { vector_ids: row.vector_ids } : null;
        }
        // These branches match `as count` in lower case only. src/migration/embedding.ts
        // writes `AS count`, so three of its queries fall through here and return null
        // rather than a row — pre-existing, and those paths are covered against real SQLite
        // in test/integration/embedding-migration.test.ts. Worth knowing before adding a
        // fourth caller and trusting the double.
        // GET /stats's summary. Matched on the two aggregate names that are stable
        // across its scoped and unscoped halves: `count`/`avg_importance` carry a
        // `CASE WHEN workspace_id IN (…)` so the admin's content totals agree with
        // /count, while unvectorized/unclassified stay corpus-wide for the repair
        // panel. This double ignores bindings, so it cannot see that scoping at all
        // — the assertion that it works lives in test/integration/team-isolation.ts
        // against real SQLite. Here the brain is single-user, where both halves
        // agree, so counting every entry is the faithful answer.
        if (s.includes("as unvectorized") && s.includes("as unclassified") && s.includes("AVG(")) {
          const count = db.entries.length;
          const scored = db.entries.filter((e: any) => typeof e.importance_score === "number");
          const avg_importance = scored.length > 0
            ? scored.reduce((sum: number, e: any) => sum + e.importance_score, 0) / scored.length
            : null;
          // The grace cutoff is the only numeric bind in this statement; the scope
          // bindings around it are workspace-id strings.
          const numeric = args.filter((a: any) => typeof a === "number");
          const cutoff = numeric.length > 0 ? Number(numeric[numeric.length - 1]) : undefined;
          const unvectorized = cutoff !== undefined
            ? db.entries.filter((e: any) => e.vector_ids === '[]' && e.created_at < cutoff).length
            : 0;
          const unclassified = db.entries.filter((e: any) => !String(e.tags).includes('"status:') && !String(e.tags).includes('"kind:')).length;
          return { count, avg_importance, unvectorized, unclassified };
        }
        if (s.includes("COUNT(*) as count") && s.includes("vector_ids = '[]'") && s.includes("created_at <")) {
          const cutoff = Number(args[0]);
          const count = db.entries.filter((e: any) => e.vector_ids === '[]' && e.created_at < cutoff).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count") && s.includes(`tags NOT LIKE '%"status:%'`) && s.includes(`tags NOT LIKE '%"kind:%'`)) {
          const count = db.entries.filter((e: any) => !String(e.tags).includes('"status:') && !String(e.tags).includes('"kind:')).length;
          return { count };
        }
        if (s.includes("COUNT(*) as count")) {
          return { count: db.entries.length };
        }
        if (s.includes("WHERE id") && !s.includes("json_each")) {
          return db.entries.find((e: any) => e.id === args[0]) ?? null;
        }
        if (s.includes("WHERE tags LIKE") && s.includes("created_at >")) {
          // Cooldown check: find entries matching arg LIKE patterns + any hardcoded tags in SQL
          const likePatterns: string[] = args.slice(0, -1).map((a: any) => String(a));
          const cutoff = args[args.length - 1] as number;
          // Extract hardcoded tags from SQL (e.g. '%"synthesized"%')
          const hardcoded = [...s.matchAll(/'%"(\w+)"%'/g)].map(m => m[1]);
          const match = db.entries.find((e: any) => {
            if (e.created_at <= cutoff) return false;
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (!hardcoded.every(t => tags.includes(t))) return false;
            return likePatterns.every((p: string) => {
              const tag = tagFromLikePattern(p);
              return tagMatchesLike(tags, tag);
            });
          });
          return match ? { id: match.id } : null;
        }
        return null;
      },
      async all() {
        if (s.startsWith("SELECT type AS kind, name FROM sqlite_master")) {
          // src/db/init.ts's schema probe. This mock stands in for a deployed brain, and
          // a deployed brain is migrated — its rows carry every ALTER column below — so
          // the honest answer is "all present", which is also what makes the mock report
          // the real cold-start cost of a cold isolate rather than a fresh install's.
          // The names are spelled out rather than imported from init.ts on purpose: a
          // mock that derives its answer from the code under test can only ever agree
          // with it. Fresh and partially-migrated brains are covered against real SQLite
          // in test/unit/db-init.test.ts.
          return { results: SCHEMA_PROBE_RESULTS };
        }
        if (s === "SELECT id FROM entries") {
          return { results: db.entries.map((e: any) => ({ id: e.id })) };
        }
        if (s === "SELECT source_id, target_id, type FROM edges") {
          return {
            results: db.edges.map((e: any) => ({
              source_id: e.source_id,
              target_id: e.target_id,
              type: e.type,
            })),
          };
        }
        if (
          sBare === "SELECT id FROM entries WHERE tags LIKE ?" ||
          sBare === "SELECT id, vector_ids FROM entries WHERE tags LIKE ?" ||
          sBare === "SELECT id, vector_ids, content, tags, source, created_at FROM entries WHERE tags LIKE ?"
        ) {
          const pattern = String(args[0]);
          const tag = tagFromLikePattern(pattern);
          const results = db.entries
            .filter((e: any) => tagMatchesLike(JSON.parse(e.tags ?? "[]"), tag))
            .map((e: any) => ({ id: e.id, vector_ids: e.vector_ids ?? "[]", content: e.content, tags: e.tags, source: e.source, created_at: e.created_at }));
          return { results };
        }
        if (s.includes("WHERE content LIKE") && s.includes("ORDER BY created_at DESC LIMIT")) {
          // Keyword (hybrid recall) query: content LIKE ? OR content LIKE ? ... LIMIT ?
          const limit = Number(args[args.length - 1]);
          const patterns = args.slice(0, -1).map((a: any) => String(a).replace(/^%/, "").replace(/%$/, "").toLowerCase());
          const rows = [...db.entries]
            .filter((e: any) => patterns.some((p: string) => String(e.content).toLowerCase().includes(p)))
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at }));
          return { results: rows };
        }
        if (s.includes("FROM entries") && s.includes("id NOT IN (SELECT source_id FROM edges)")) {
          // runGraphPass backfill: entries not referenced by any edge, newest first.
          const linked = new Set(db.edges.flatMap((e: any) => [e.source_id, e.target_id]));
          const limitMatch = s.match(/LIMIT (\d+)/);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
          const rows = [...db.entries]
            .filter((e: any) => {
              if (linked.has(e.id)) return false;
              if (s.includes('"status:deprecated"') && (JSON.parse(e.tags ?? "[]") as string[]).includes("status:deprecated")) return false;
              return true;
            })
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content }));
          return { results: rows };
        }
        if (s.includes("SELECT id FROM entries WHERE id IN")) {
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id }));
          return { results };
        }
        if (s.includes("SELECT source_id, target_id, type FROM edges WHERE source_id IN") && s.includes("OR target_id IN")) {
          const ids = new Set(args.map((a: any) => String(a)));
          const results = db.edges
            .filter((e: any) => ids.has(e.source_id) || ids.has(e.target_id))
            .map((e: any) => ({ source_id: e.source_id, target_id: e.target_id, type: e.type }));
          return { results };
        }
        if (s.includes("FROM edges WHERE source_id IN") && s.includes("OR target_id IN")) {
          // expandGraph BFS / graph edge fetch: every edge touching the frontier, strongest
          // first. Args are the frontier id list bound twice (source_id IN …, target_id IN …).
          const ids = new Set(args.map((a: any) => String(a)));
          const results = db.edges
            .filter((e: any) => ids.has(e.source_id) || ids.has(e.target_id))
            .sort((a: any, b: any) => b.weight - a.weight)
            .map((e: any) => ({ source_id: e.source_id, target_id: e.target_id, type: e.type, weight: e.weight, provenance: e.provenance, created_at: e.created_at }));
          return { results };
        }
        if (s.includes("SELECT source_id, target_id FROM edges ORDER BY weight DESC")) {
          // buildGraph default mode: strongest edges first (to derive the node set).
          const limitMatch = s.match(/LIMIT (\d+)/);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : db.edges.length;
          const results = [...db.edges]
            .sort((a: any, b: any) => b.weight - a.weight)
            .slice(0, limit)
            .map((e: any) => ({ source_id: e.source_id, target_id: e.target_id }));
          return { results };
        }
        if (s.includes("SELECT id, content, tags, importance_score, created_at FROM entries WHERE id IN")) {
          // buildGraph node hydration.
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, importance_score: e.importance_score ?? 0, created_at: e.created_at }));
          return { results };
        }
        if (s.includes("SELECT id, tags FROM entries WHERE id IN")) {
          // expandGraph deprecation check.
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, tags: e.tags }));
          return { results };
        }
        if (s.includes("SELECT id, content, tags, source, created_at FROM entries WHERE id IN") && !s.includes("tags NOT LIKE")) {
          // Graph node hydration (/connections, /graph). The `tags NOT LIKE` guard
          // keeps this from shadowing recall's hydration query (same columns, but it
          // applies the auto-pattern/deprecated/kind filters itself further down).
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at }));
          return { results };
        }
        if (s.includes("recall_count, importance_score") && s.includes("WHERE id IN")) {
          const includesContent = s.startsWith("SELECT id, content,");
          const includesHydrationFields = s.startsWith("SELECT id, content, source, created_at, COALESCE(updated_at, created_at) AS last_updated,");
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({
              id: e.id,
              ...(includesContent ? { content: e.content } : {}),
              ...(includesHydrationFields ? {
                source: e.source,
                created_at: e.created_at,
                last_updated: e.updated_at ?? e.created_at,
              } : {}),
              recall_count: e.recall_count ?? 0,
              importance_score: e.importance_score ?? 0,
              contradiction_wins: e.contradiction_wins ?? 0,
              contradiction_losses: e.contradiction_losses ?? 0,
              tags: e.tags ?? "[]",
            }));
          return { results };
        }
        if (s.includes("SELECT tags FROM entries WHERE id = ?")) {
          const row = db.entries.find((e: any) => e.id === args[0]);
          return { results: row ? [{ tags: row.tags }] : [] };
        }
        if (s.startsWith("SELECT id, tags, content FROM entries WHERE id IN")) {
          // Staleness retry re-read: fresh tags and content for every row whose CAS lost,
          // in one statement. Rows deleted mid-pass simply do not come back.
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, tags: e.tags, content: e.content }));
          return { results };
        }
        if (s.includes("COALESCE(updated_at, created_at) < ?") && s.includes("SELECT id, content, tags FROM entries")) {
          const cutoff = Number(args[0]);
          const limitMatch = s.match(/LIMIT (\d+)/);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
          // This handler, and the other `tags.includes("auto-pattern"/"auto-insight")`
          // checks below (the recall hydration branches and the digest-candidate
          // branch), enforce the exclusion UNCONDITIONALLY — in JS, on every row,
          // regardless of what the matched SQL string actually says. Unlike
          // `tagMatchesLike` above, which at least reads the bind parameter, these
          // never look at whether the real query has a `tags NOT LIKE
          // '%"auto-pattern"%'`-shaped clause at all. A production query that lost
          // that clause entirely would still be filtered here and the test would
          // stay green. Anything whose subject IS one of those exclusion clauses —
          // asserting it exists, asserting its exact shape — is untestable against
          // this mock and belongs in a `sqlite-d1`-backed test instead.
          const results = [...db.entries]
            .filter((e: any) => {
              const tags: string[] = JSON.parse(e.tags ?? "[]");
              if (tags.includes("status:deprecated")) return false;
              if (tags.includes("auto-pattern")) return false;
              if (tags.includes("auto-insight")) return false;
              if (tags.includes("synthesized")) return false;
              if (tags.includes("rolled-up")) return false;
              const touched = e.updated_at ?? e.created_at;
              return touched < cutoff;
            })
            .sort((a: any, b: any) => (a.staleness_checked_at ?? 0) - (b.staleness_checked_at ?? 0))
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags }));
          return { results };
        }
        if (s.includes("SELECT id, content, tags, source, created_at, updated_at FROM entries WHERE id IN") || s.includes("SELECT id, content, tags, source, created_at, updated_at, workspace_id FROM entries WHERE id IN")) {
          const inMatch = s.match(/WHERE id IN \(([^)]*)\)/);
          const idCount = inMatch ? inMatch[1].split(",").length : 0;
          const ids = args.slice(0, idCount);
          const rest = args.slice(idCount);
          let argIdx = 0;
          const kindMatch = s.match(/tags LIKE '%"(kind:(?:episodic|semantic))"%'/);
          const explicitTag = s.includes("tags LIKE ?")
            ? tagFromLikePattern(String(rest[argIdx++]))
            : null;
          // Unconditional exclusion, not derived from `s` — see the note above the
          // first such check in this file.
          let rows = db.entries.filter((e: any) => {
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (!ids.includes(e.id)) return false;
            if (tags.includes("auto-pattern")) return false;
            if (tags.includes("auto-insight")) return false;
            if (s.includes('"status:deprecated"') && tags.includes("status:deprecated")) return false;
            if (explicitTag !== null && !tagMatchesLike(tags, explicitTag)) return false;
            if (kindMatch && !tags.includes(kindMatch[1])) return false;
            return true;
          });
          if (s.includes("created_at >= ?")) {
            const after = Number(rest[argIdx++]);
            rows = rows.filter((e: any) => e.created_at >= after);
          }
          if (s.includes("created_at <= ?")) {
            const before = Number(rest[argIdx++]);
            rows = rows.filter((e: any) => e.created_at <= before);
          }
          const results = rows.map((e: any) => ({
            id: e.id,
            content: e.content,
            tags: e.tags,
            source: e.source,
            created_at: e.created_at,
            updated_at: e.updated_at ?? e.created_at,
          }));
          return { results };
        }
        if (s.includes("FROM entries WHERE id IN") && s.includes("tags NOT LIKE")) {
          // recallEntries D1 hydration — filter by IDs, exclude auto-pattern/auto-insight entries, apply after/before
          const inMatch = s.match(/WHERE id IN \(([^)]*)\)/);
          const idCount = inMatch ? inMatch[1].split(",").length : 0;
          const ids = args.slice(0, idCount);
          const rest = args.slice(idCount);
          let argIdx = 0;
          const kindMatch = s.match(/tags LIKE '%"(kind:(?:episodic|semantic))"%'/);
          // Unconditional exclusion, not derived from `s` — see the note above the
          // first such check in this file.
          let rows = db.entries.filter((e: any) => {
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (!ids.includes(e.id)) return false;
            if (tags.includes("auto-pattern")) return false;
            if (tags.includes("auto-insight")) return false;
            if (s.includes('"status:deprecated"') && tags.includes("status:deprecated")) return false;
            if (kindMatch && !tags.includes(kindMatch[1])) return false;
            return true;
          });
          if (s.includes("created_at >= ?")) {
            const after = Number(rest[argIdx++]);
            rows = rows.filter((e: any) => e.created_at >= after);
          }
          if (s.includes("created_at <= ?")) {
            const before = Number(rest[argIdx++]);
            rows = rows.filter((e: any) => e.created_at <= before);
          }
          const results = rows.map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at }));
          return { results };
        }
        if (s.includes("SELECT id, content FROM entries") && s.includes("WHERE tags LIKE") && s.includes("ORDER BY created_at DESC")) {
          // compressTag raw entries query — tag match, system-tag exclusion, and the
          // recall/age/contradiction eligibility predicate (cutoff is the 2nd bind param).
          const tagPattern = args[0] as string;
          const tag = tagFromLikePattern(tagPattern);
          const cutoff = Number(args[1]);
          // The synthesized/auto-pattern/auto-insight/rolled-up exclusion below is
          // unconditional, not derived from `s` — see the note above the first such
          // check in this file.
          const results = [...db.entries]
            .filter((e: any) => {
              const tags: string[] = JSON.parse(e.tags ?? "[]");
              if (!tagMatchesLike(tags, tag)) return false;
              if (tags.includes("synthesized") || tags.includes("auto-pattern") || tags.includes("auto-insight") || tags.includes("rolled-up")) return false;
              if (!(e.importance_score == null || e.importance_score < COMPRESSION_IMPORTANCE_THRESHOLD)) return false;
              const rc = e.recall_count; // NULL/undefined → recall clause is falsy → protected (matches SQL)
              if (!(rc === 0 || (rc < COMPRESSION_MIN_RECALL && e.created_at < cutoff))) return false;
              if (!(e.contradiction_wins == null || e.contradiction_wins === 0)) return false;
              return true;
            })
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, 50)
            .map((e: any) => ({ id: e.id, content: e.content }));
          return { results };
        }
        if (s.includes("SELECT id, content FROM entries WHERE id IN")) {
          const results = db.entries
            .filter((e: any) => args.includes(e.id))
            .map((e: any) => ({ id: e.id, content: e.content }));
          return { results };
        }
        if (s.includes("json_each(entries.tags)") && s.includes("HAVING count > 10")) {
          // Digest-candidate query (nightly compression + /stats): per-tag count of
          // entries that pass the compression eligibility predicate. Cutoff is args[0].
          const cutoff = Number(args[0]);
          const counts = new Map<string, number>();
          // Unconditional exclusion, not derived from `s` — see the note above the
          // first such check in this file.
          for (const e of db.entries as any[]) {
            const tags: string[] = JSON.parse(e.tags ?? "[]");
            if (tags.includes("rolled-up") || tags.includes("synthesized") || tags.includes("auto-pattern") || tags.includes("auto-insight")) continue;
            if (!(e.importance_score == null || e.importance_score < COMPRESSION_IMPORTANCE_THRESHOLD)) continue;
            const rc = e.recall_count; // NULL/undefined → recall clause is falsy → protected (matches SQL)
            if (!(rc === 0 || (rc < COMPRESSION_MIN_RECALL && e.created_at < cutoff))) continue;
            if (!(e.contradiction_wins == null || e.contradiction_wins === 0)) continue;
            for (const t of tags) {
              // The same predicate isTopicTagSql() is generated from, rather than a second
              // copy of the rule: a double that filters differently from production hides
              // exactly the bugs it is supposed to catch.
              if (!isTopicTag(t)) continue;
              counts.set(t, (counts.get(t) ?? 0) + 1);
            }
          }
          const results = [...counts.entries()]
            .filter(([, c]) => c > 10)
            .sort((a, b) => b[1] - a[1])
            .map(([tag, count]) => ({ tag, count }));
          return { results };
        }
        if (s.includes("json_each(entries.tags)") && s.includes("GROUP BY value")) {
          // Top tags by frequency — for /stats
          const freq = new Map<string, number>();
          db.entries.forEach((e: any) => {
            (JSON.parse(e.tags ?? "[]") as string[]).forEach(t => freq.set(t, (freq.get(t) ?? 0) + 1));
          });
          const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
          return { results: sorted.map(([value, n]) => ({ value, n })) };
        }
        if (s.includes("json_each(entries.tags)")) {
          // Distinct sorted tags — for /tags
          const tags = new Set<string>();
          db.entries.forEach((e: any) => {
            (JSON.parse(e.tags ?? "[]") as string[]).forEach(t => tags.add(t));
          });
          return { results: [...tags].sort().map(t => ({ value: t })) };
        }
        if (s.includes(`tags NOT LIKE '%"status:%'`) && s.includes(`tags NOT LIKE '%"kind:%'`) && s.includes("ORDER BY created_at ASC LIMIT")) {
          const limitMatch = s.match(/LIMIT\s+(\d+)/i);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
          const rows = [...db.entries]
            .filter((e: any) => !String(e.tags).includes('"status:') && !String(e.tags).includes('"kind:'))
            .sort((a: any, b: any) => a.created_at - b.created_at)
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags }));
          return { results: rows };
        }
        if (s.includes("vector_ids = '[]' AND created_at <") && s.includes("ORDER BY created_at DESC LIMIT")) {
          const cutoff = Number(args[0]);
          const limitMatch = s.match(/LIMIT\s+(\d+)/i);
          const limit = limitMatch ? parseInt(limitMatch[1], 10) : 25;
          const rows = [...db.entries]
            .filter((e: any) => e.vector_ids === '[]' && e.created_at < cutoff)
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .slice(0, limit)
            .map((e: any) => ({ id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at }));
          return { results: rows };
        }
        if (s.startsWith("SELECT id, content, tags, source, created_at, COALESCE(updated_at, created_at) AS last_updated, recall_count, importance_score, contradiction_wins, contradiction_losses FROM entries") && s.includes("ORDER BY created_at DESC") && !s.includes("WHERE id = ?")) {
          // GET /export: the caller's readable set, newest first, no LIMIT. The
          // route appends `WHERE workspace_id IN (?, ?)` (bound to args), so
          // rows outside those workspaces are withheld here too. `last_updated`
          // models the COALESCE, so a row that never had updated_at written
          // exports its created_at.
          const workspaces: string[] = args.map((a: any) => String(a));
          const results = [...db.entries]
            .filter((e: any) => !workspaces.length || workspaces.includes(e.workspace_id ?? ""))
            .sort((a: any, b: any) => b.created_at - a.created_at)
            .map((e: any) => ({
              id: e.id, content: e.content, tags: e.tags, source: e.source, created_at: e.created_at,
              last_updated: e.updated_at ?? e.created_at,
              recall_count: e.recall_count ?? 0, importance_score: e.importance_score ?? 0,
              contradiction_wins: e.contradiction_wins ?? 0, contradiction_losses: e.contradiction_losses ?? 0,
            }));
          return { results };
        }
        if (
          s.startsWith("SELECT source_id, target_id, type, weight, provenance, created_at FROM edges") &&
          !s.includes("WHERE source_id IN")
        ) {
          // GET /export: the readable set's edges. The scope clause (if any) has been
          // stripped above along with its bindings; owner-scoped tests see the whole
          // edge set either way, and isolation is covered against real SQLite.
          const results = db.edges
            .map((e: any) => ({
              source_id: e.source_id, target_id: e.target_id, type: e.type,
              weight: e.weight, provenance: e.provenance, created_at: e.created_at,
            }));
          return { results };
        }
        if (s.includes("ORDER BY created_at DESC LIMIT")) {
          const limit = Number(args[args.length - 1]);
          const filterArgs = args.slice(0, -1);
          let argIdx = 0;
          let rows = [...db.entries];
          if (s.includes("tags LIKE ?")) {
            const pattern = String(filterArgs[argIdx++]);
            const tag = tagFromLikePattern(pattern);
            rows = rows.filter((e: any) => tagMatchesLike(JSON.parse(e.tags ?? "[]"), tag));
          }
          if (s.includes("created_at >= ?")) {
            const after = Number(filterArgs[argIdx++]);
            rows = rows.filter((e: any) => e.created_at >= after);
          }
          if (s.includes("created_at <= ?")) {
            const before = Number(filterArgs[argIdx++]);
            rows = rows.filter((e: any) => e.created_at <= before);
          }
          rows.sort((a: any, b: any) => b.created_at - a.created_at);
          return { results: rows.slice(0, limit) };
        }
        return { results: [] };
      }
      };
    };

    return {
      bind(...args: any[]) { return makeStmt(args); },
      ...makeStmt([]),
    };
  }

  async exec(_sql: string) { }
  async batch(stmts: any[]) { return Promise.all(stmts.map((s: any) => s.run())); }
  reset() {
    this.entries = [];
    this.edges = [];
    this.users = [];
    this.workspaces = [];
    this.memberships = [];
  }
}
