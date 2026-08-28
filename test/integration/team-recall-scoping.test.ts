/**
 * Team Edition scoping for the recall pipeline.
 *
 * Recall is where an isolation bug would actually leak: the dense arm can
 * surface a stranger's Vectorize hit, and every hydration step after it must
 * refuse to turn that id into content. Whether a scope clause excludes another
 * workspace's rows is a property of real SQLite, so these scenarios run the
 * full recallEntries path against the sqlite-d1 facade — d1-mock branches on
 * query strings and ignores bindings, which is exactly what scoping lives in.
 *
 * The dense arm is forced down (VECTORIZE.query rejects) so the keyword arm's
 * SQL is the whole candidate source, and the facade's `issued` array pins the
 * byte-for-byte contract: absent an Identity, every statement is exactly what
 * it was before v3.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recallEntries } from "../../src/recall/search";
import type { RecallInternalOptions } from "../../src/recall/types";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import type { Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";

const memberOf = (personal: string): Identity => ({
  userId: "u1",
  role: "member",
  personalWorkspaceId: personal,
  companyWorkspaceIds: ["ws-co"],
  defaultShare: "" as const,
});

function makeCtx() {
  const pending: Promise<any>[] = [];
  return { ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext };
}

/** Dense arm always fails: the keyword arm's SQL becomes the entire candidate source. */
function recallEnv(sqlite: SqliteD1, vectorizeOverrides: Partial<VectorizeIndex> = {}): Env {
  return makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockRejectedValue(new Error("index unavailable")),
      ...vectorizeOverrides,
    }),
  });
}

/** Seed through the normal insert, then relocate — the unit under test IS that column. */
function seedIn(sqlite: SqliteD1, id: string, workspaceId: string, content: string) {
  sqlite.seed({ id, content, createdAt: 1000 });
  sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(workspaceId, id).run();
}

/** One entry per workspace that matches the same query word — isolation's minimal triangle. */
function seedTriangle(sqlite: SqliteD1) {
  seedIn(sqlite, "own", "ws-a", "alpha roadmap for my team");
  seedIn(sqlite, "co", "ws-co", "alpha offsite notes");
  seedIn(sqlite, "foreign", "ws-b", "alpha private diary");
}

describe("recallEntries with an Identity", () => {
  let sqlite: SqliteD1;
  let env: Env;
  beforeEach(async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    env = recallEnv(sqlite);
    // The final hydration reads updated_at, a runtime-ALTER column: the schema
    // the nightly cron normally guarantees must actually exist here.
    await initializeDatabase(env);
    // Init's DDL pollutes `issued`; assertions below filter to entries reads.
    sqlite.issued.length = 0;
  });
  afterEach(() => sqlite.close());

  it("returns the caller's own and company rows, never another member's private rows", async () => {
    seedTriangle(sqlite);
    const { ctx } = makeCtx();
    const internal: RecallInternalOptions = { identity: memberOf("ws-a") };

    const res = await recallEntries({ query: "alpha", topK: 10, synthesize: false }, env, ctx, undefined, internal);

    const ids = res.matches.map(m => m.id);
    expect(ids).toContain("own");
    expect(ids).toContain("co"); // personal ∪ company: the shared row stays readable
    expect(ids).not.toContain("foreign");
  });

  it("scopes every entries read, and leaves the unscoped SQL byte-for-byte alone", async () => {
    seedTriangle(sqlite);
    const { ctx } = makeCtx();
    const keywordSql = () => sqlite.issued.find(s => s.includes("ORDER BY created_at DESC LIMIT"));

    // Absent identity: the pre-tenancy string, verbatim. (The hydration
    // projection now carries workspace_id so matches can report their layer —
    // what must never appear unscoped is the workspace_id *clause*.)
    await recallEntries({ query: "alpha", topK: 10, synthesize: false }, env, ctx);
    expect(keywordSql()).toBe(
      `SELECT id, content, tags, source, created_at FROM entries WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?`,
    );
    expect(sqlite.issued.some(s => s.includes("FROM entries") && s.includes("workspace_id IN"))).toBe(false);

    // With identity: the same statement plus the AND'd clause, nothing else moved.
    sqlite.issued.length = 0;
    await recallEntries({ query: "alpha", topK: 10, synthesize: false }, env, ctx, undefined,
      { identity: memberOf("ws-a") });
    expect(keywordSql()).toBe(
      `SELECT id, content, tags, source, created_at FROM entries WHERE content LIKE ? AND workspace_id IN (?, ?) ORDER BY created_at DESC LIMIT ?`,
    );
    // Both hydration steps carry the clause too — the candidate-signal read is
    // the leak-catcher for unscoped vectorize hits until namespaces land (P3).
    const hydrations = sqlite.issued.filter(s => s.includes("FROM entries WHERE id IN"));
    expect(hydrations.length).toBeGreaterThan(0);
    for (const sql of hydrations) expect(sql).toContain("AND workspace_id IN (?, ?)");
    // The recall_count bump stays by-id: those ids came from already-scoped rows.
    expect(sqlite.issued.some(s => s.includes("UPDATE entries SET recall_count") && s.includes("workspace_id")))
      .toBe(false);
  });

  it("scopes the ?tag= scan too", async () => {
    // Non-empty vector_ids keep the tag branch past its no-vectors early return,
    // and getByIds must hand back real vectors: unlike the main path, a ?tag=
    // recall never touches VECTORIZE.query, so without them fusion has no dense
    // arm and keyword-only rows are not admissible. parentId metadata is what
    // lets hydration resolve the vector hits back to entry rows.
    const vectorFor = (entryId: string) => ({
      id: `v-${entryId}`, values: new Array(384).fill(0.2), metadata: { parentId: entryId },
    });
    for (const [id, ws] of [["t-own", "ws-a"], ["t-co", "ws-co"], ["t-foreign", "ws-b"]] as const) {
      sqlite.seed({ id, content: `alpha tagged ${id}`, createdAt: 1000, tags: ["proj"], vectorIds: [`v-${id}`] });
      sqlite.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(ws, id).run();
    }
    const { ctx } = makeCtx();

    const res = await recallEntries(
      { query: "alpha", topK: 10, tag: "proj", synthesize: false },
      recallEnv(sqlite, { getByIds: vi.fn().mockResolvedValue([vectorFor("t-own"), vectorFor("t-co")]) }),
      ctx, undefined, { identity: memberOf("ws-a") },
    );

    expect(sqlite.issued.some(s =>
      s.includes("FROM entries WHERE tags LIKE ?") && s.includes("AND workspace_id IN (?, ?)"),
    )).toBe(true);
    const ids = res.matches.map(m => m.id);
    expect(ids).toContain("t-own");
    expect(ids).toContain("t-co");
    expect(ids).not.toContain("t-foreign");
  });

  it("computes DF over the caller's readable corpus only", async () => {
    // "zeta" is rare inside ws-a but floods ws-b. Corpus-wide, 11/15 rows say
    // zeta — past the saturation cut, so distill drops it from the query.
    // Scoped, 1/5 clears the cut and the term survives into queryUsed.
    seedIn(sqlite, "zeta-hit", "ws-a", "zeta alpha discovery");
    for (let i = 0; i < 3; i++) seedIn(sqlite, `filler-${i}`, "ws-a", `alpha filler ${i}`);
    for (let i = 0; i < 10; i++) seedIn(sqlite, `flood-${i}`, "ws-b", `zeta private log ${i}`);
    const { ctx } = makeCtx();

    const unscoped = await recallEntries({ query: "alpha zeta", topK: 5, synthesize: false }, env, ctx);
    expect(unscoped.queryUsed).not.toContain("zeta");

    sqlite.issued.length = 0;
    const scoped = await recallEntries({ query: "alpha zeta", topK: 5, synthesize: false }, env, ctx,
      undefined, { identity: memberOf("ws-a") });
    expect(scoped.queryUsed).toContain("zeta");
    // And the aggregate itself was scoped — visible on the issued SQL directly.
    // No time bounds parsed from the query, so the scope clause IS the WHERE.
    const aggregate = sqlite.issued.find(s => s.includes("AS total") && s.includes("SUM(CASE WHEN content LIKE"));
    expect(aggregate).toBeDefined();
    expect(aggregate!).toContain("FROM entries WHERE workspace_id IN (?, ?)");
    expect(aggregate!).not.toContain("created_at");
  });
});
