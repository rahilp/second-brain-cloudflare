/**
 * The insight review queue: listing it, and ruling on it.
 *
 * Run against real SQLite rather than the SQL-matching mock. The queue is
 * defined by a WHERE clause — an insight that is not deprecated — and a
 * mock that recognises queries by substring cannot tell a correct predicate
 * from a broken one. That is exactly how the dashboard's own pattern panel came
 * to render empty on any brain with more than a page of dismissals.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { setDbReady } from "../../src/runtime/state";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as any;

let sq: SqliteD1 | null = null;
afterEach(() => { sq?.close(); sq = null; setDbReady(false); });

function dbOf(s: SqliteD1) {
  return {
    prepare: (sql: string) => s.db.prepare(sql),
    exec: (sql: string) => s.db.exec(sql),
    async batch(stmts: { run(): Promise<any> }[]) {
      const out: any[] = [];
      for (const st of stmts) out.push(await st.run());
      // Collapsed to one entry in the issued log, because that is what D1 does:
      // a batch is a single subrequest however many statements it carries. The
      // per-statement rows would make a correctly batched write look like N.
      s.issued.splice(s.issued.length - stmts.length, stmts.length, `BATCH(${stmts.length})`);
      // Each statement's rows are kept, not discarded: a batch carries reads as
      // well as writes now — identity resolution pairs its SELECT with the
      // throttled last_used_at stamp so the pair costs one subrequest — and D1
      // returns a result per statement. `changes: 1` is preserved for the write
      // paths that read it.
      return out.map((r: any) => ({ ...r, meta: { changes: 1, ...r?.meta } }));
    },
  };
}

async function migrated(): Promise<SqliteD1> {
  const s = makeSqliteD1();
  resetDatabaseInit();
  await initializeDatabase({ DB: dbOf(s) } as unknown as Env);
  setDbReady(true);
  return s;
}

const envOf = (s: SqliteD1, overrides: Record<string, unknown> = {}): Env =>
  makeTestEnv(dbOf(s) as any, overrides as any);

function seedPattern(s: SqliteD1, id: string, content: string, extraTags: string[] = []) {
  s.seed({ id, content, createdAt: 1000, tags: ["auto-insight", ...extraTags], source: "system", vectorIds: [id] });
}

function seedEdge(s: SqliteD1, sourceId: string, targetId: string, type: string) {
  s.db.prepare(
    `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), sourceId, targetId, type, 1, "system", "{}", 1000, 1000).run();
}

const rowOf = (s: SqliteD1, id: string) => s.rows().find(r => r.id === id) as Record<string, any>;
const tagsOf = (s: SqliteD1, id: string) => JSON.parse(rowOf(s, id).tags ?? "[]") as string[];
const vectorsOf = (s: SqliteD1, id: string) => JSON.parse(rowOf(s, id).vector_ids ?? "[]") as string[];

describe("GET /patterns", () => {
  it("requires auth", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("GET", "/patterns", { token: null }), envOf(sq), ctx);
    expect(res.status).toBe(401);
  });

  it("returns only the patterns still waiting on a decision", async () => {
    sq = await migrated();
    seedPattern(sq, "pending-1", "You tend to ship on Fridays");
    seedPattern(sq, "dismissed", "Not a real pattern", ["status:deprecated"]);
    sq.seed({ id: "normal", content: "Just a memory", createdAt: 1000, tags: ["work"] });

    const data = await (await worker.fetch(req("GET", "/patterns"), envOf(sq), ctx)).json() as any;
    expect(data.patterns.map((p: any) => p.id)).toEqual(["pending-1"]);
    expect(data.total).toBe(1);
  });

  it("counts the whole queue, not the page", async () => {
    // The number the user is told is waiting has to be the real one, or paging
    // through a backlog gives no sense of how much is left.
    sq = await migrated();
    for (let i = 0; i < 30; i++) {
      sq.seed({ id: `p${i}`, content: `Pattern ${i}`, createdAt: 1000 + i, tags: ["auto-insight"], source: "system" });
    }

    const data = await (await worker.fetch(req("GET", "/patterns?limit=10"), envOf(sq), ctx)).json() as any;
    expect(data.patterns).toHaveLength(10);
    expect(data.total).toBe(30);
  });

  it("pages without repeating or skipping", async () => {
    sq = await migrated();
    for (let i = 0; i < 25; i++) {
      sq.seed({ id: `p${i}`, content: `Pattern ${i}`, createdAt: 1000 + i, tags: ["auto-insight"], source: "system" });
    }

    const first = await (await worker.fetch(req("GET", "/patterns?limit=10&offset=0"), envOf(sq), ctx)).json() as any;
    const second = await (await worker.fetch(req("GET", "/patterns?limit=10&offset=10"), envOf(sq), ctx)).json() as any;
    const third = await (await worker.fetch(req("GET", "/patterns?limit=10&offset=20"), envOf(sq), ctx)).json() as any;

    const seen = [...first.patterns, ...second.patterns, ...third.patterns].map((p: any) => p.id);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it("rejects a malformed limit rather than falling back to everything", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("GET", "/patterns?limit=all"), envOf(sq), ctx);
    expect(res.status).toBe(400);
  });

  it("answers cleanly on a brain with no patterns", async () => {
    sq = await migrated();
    const data = await (await worker.fetch(req("GET", "/patterns"), envOf(sq), ctx)).json() as any;
    expect(data).toMatchObject({ ok: true, patterns: [], total: 0 });
  });

  it("carries the memories each insight was drawn from", async () => {
    sq = await migrated();
    sq.seed({ id: "m1", content: "The first source memory", createdAt: 1000, tags: ["work"] });
    sq.seed({ id: "m2", content: "The second source memory", createdAt: 2000, tags: ["work"] });
    seedPattern(sq, "i1", "An insight about both");
    seedEdge(sq, "i1", "m1", "drawn_from");
    seedEdge(sq, "i1", "m2", "drawn_from");

    const data = await (await worker.fetch(req("GET", "/patterns"), envOf(sq), ctx)).json() as any;

    expect(data.patterns[0].sources.map((s: any) => s.content).sort())
      .toEqual(["The first source memory", "The second source memory"]);
  });

  it("reports a forgotten source instead of dropping it", async () => {
    sq = await migrated();
    sq.seed({ id: "m1", content: "The surviving source", createdAt: 1000, tags: ["work"] });
    seedPattern(sq, "i1", "An insight about both");
    seedEdge(sq, "i1", "m1", "drawn_from");
    seedEdge(sq, "i1", "gone", "drawn_from");

    const data = await (await worker.fetch(req("GET", "/patterns"), envOf(sq), ctx)).json() as any;

    expect(data.patterns[0].sources).toHaveLength(2);
    expect(data.patterns[0].sources.filter((s: any) => s.missing)).toHaveLength(1);
  });

  it("gives an insight with no recorded sources an empty list, not undefined", async () => {
    // Every insight written before this shipped. The client must not have to
    // distinguish "none" from "not loaded".
    sq = await migrated();
    seedPattern(sq, "old", "An insight from before provenance existed");

    const data = await (await worker.fetch(req("GET", "/patterns"), envOf(sq), ctx)).json() as any;

    expect(data.patterns[0].sources).toEqual([]);
  });
});

describe("POST /patterns/resolve — one at a time", () => {
  it("requires auth", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/patterns/resolve", { body: { id: "p1", action: "confirm" }, token: null }), envOf(sq), ctx);
    expect(res.status).toBe(401);
  });

  it("404s for an unknown id", async () => {
    sq = await migrated();
    const res = await worker.fetch(req("POST", "/patterns/resolve", { body: { id: "ghost", action: "confirm" } }), envOf(sq), ctx);
    expect(res.status).toBe(404);
  });

  it("400s for an entry that is not a derived insight", async () => {
    sq = await migrated();
    sq.seed({ id: "normal", content: "Just a memory", createdAt: 1000, tags: ["work"] });

    const res = await worker.fetch(req("POST", "/patterns/resolve", { body: { id: "normal", action: "confirm" } }), envOf(sq), ctx);
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toContain("not a derived insight");
  });

  it("400s for an invalid action", async () => {
    sq = await migrated();
    seedPattern(sq, "p1", "You tend to test things");
    const res = await worker.fetch(req("POST", "/patterns/resolve", { body: { id: "p1", action: "promote" } }), envOf(sq), ctx);
    expect(res.status).toBe(400);
  });

  it("confirm strips auto-insight, adds kind:semantic + status:canonical, and the entry becomes recallable", async () => {
    sq = await migrated();
    seedPattern(sq, "p1", "You tend to write tests before shipping");
    const env = envOf(sq, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "p1", score: 0.9, metadata: { parentId: "p1", isUpdate: false } }],
        }),
      }),
    });

    // Before confirmation the pattern is excluded from recall at D1 hydration.
    let recallData = await (await worker.fetch(req("GET", "/recall?query=tests"), env, ctx)).json() as any;
    expect(recallData.results ?? []).toHaveLength(0);

    const res = await worker.fetch(req("POST", "/patterns/resolve", { body: { id: "p1", action: "confirm" } }), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: "p1", action: "confirm" });

    const tags = tagsOf(sq, "p1");
    expect(tags).not.toContain("auto-insight");
    expect(tags).toContain("kind:semantic");
    expect(tags).toContain("status:canonical");

    // After confirmation the same query returns it.
    recallData = await (await worker.fetch(req("GET", "/recall?query=tests"), env, ctx)).json() as any;
    expect(recallData.results).toHaveLength(1);
    expect(recallData.results[0].id).toBe("p1");
  });

  it("dismiss deprecates: vectors deleted, status:deprecated applied, row kept", async () => {
    sq = await migrated();
    seedPattern(sq, "p1", "You tend to dismiss patterns");
    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "m" });

    const res = await worker.fetch(
      req("POST", "/patterns/resolve", { body: { id: "p1", action: "dismiss" } }),
      envOf(sq, { VECTORIZE: makeVectorizeMock({ deleteByIds }) }), ctx,
    );
    expect(res.status).toBe(200);

    expect(rowOf(sq, "p1")).toBeDefined(); // audit row kept
    expect(tagsOf(sq, "p1")).toContain("status:deprecated");
    expect(vectorsOf(sq, "p1")).toEqual([]);
    expect(deleteByIds).toHaveBeenCalledWith(["p1"]);
  });
});

describe("POST /patterns/resolve — in bulk", () => {
  it("dismisses many in one request", async () => {
    // The complaint this answers: ruling on a backlog two at a time.
    sq = await migrated();
    for (let i = 0; i < 12; i++) seedPattern(sq, `p${i}`, `Pattern ${i}`);
    const deleteByIds = vi.fn().mockResolvedValue({ mutationId: "m" });

    const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const data = await (await worker.fetch(
      req("POST", "/patterns/resolve", { body: { ids, action: "dismiss" } }),
      envOf(sq, { VECTORIZE: makeVectorizeMock({ deleteByIds }) }), ctx,
    )).json() as any;

    expect(data).toMatchObject({ ok: true, action: "dismiss", resolved: 12, skipped: 0 });
    for (const id of ids) {
      expect(tagsOf(sq, id)).toContain("status:deprecated");
      expect(vectorsOf(sq, id)).toEqual([]);
    }
    // One Vectorize call carrying every id, not one call per pattern.
    expect(deleteByIds).toHaveBeenCalledTimes(1);
    expect(deleteByIds.mock.calls[0][0].sort()).toEqual(ids.sort());
  });

  it("confirms many in one request", async () => {
    sq = await migrated();
    for (let i = 0; i < 5; i++) seedPattern(sq, `p${i}`, `Pattern ${i}`);

    const ids = Array.from({ length: 5 }, (_, i) => `p${i}`);
    const data = await (await worker.fetch(
      req("POST", "/patterns/resolve", { body: { ids, action: "confirm" } }), envOf(sq), ctx,
    )).json() as any;

    expect(data.resolved).toBe(5);
    for (const id of ids) {
      expect(tagsOf(sq, id)).not.toContain("auto-insight");
      expect(tagsOf(sq, id)).toContain("status:canonical");
      // Confirming must not touch the vectors — the entry is becoming
      // recallable, so it needs the ones it has.
      expect(vectorsOf(sq, id)).toEqual([id]);
    }
  });

  it("costs a fixed number of round trips however many patterns are in it", async () => {
    // The reason bulk exists at all: a free-plan invocation gets roughly 50 D1
    // queries, so a per-id loop would put a ceiling on the batch size.
    sq = await migrated();
    for (let i = 0; i < 40; i++) seedPattern(sq, `p${i}`, `Pattern ${i}`);
    sq.issued.length = 0;

    await worker.fetch(
      req("POST", "/patterns/resolve", { body: { ids: Array.from({ length: 40 }, (_, i) => `p${i}`), action: "dismiss" } }),
      envOf(sq), ctx,
    );

    // Six round trips, flat in the 40 ids, which is what this measures.
    //
    // Assert the TOTAL rather than only the unbatched statements. Both numbers
    // are pinned below, but the total is the one that means something: a batch
    // is a single subrequest however many statements it carries, so the split
    // between the two moves whenever a read is paired with a write, without the
    // cost changing at all. That is exactly what happened when identity
    // resolution began carrying the throttled users.last_used_at stamp in the
    // same batch as its read — unbatched went 4 -> 3, total stayed 6.
    expect(sq.issued).toHaveLength(6);
    // The route's own SELECT, plus v3's fixed identity cost on this first
    // request against a fresh database: the token→identity batch and the
    // one-time tenant bootstrap (two lookups + a batch; memoised afterwards).
    expect(sq.issued.filter(s => !s.startsWith("BATCH"))).toHaveLength(3);
  });

  it("skips what someone else already ruled on rather than failing the batch", async () => {
    // A list the user was looking at can race the nightly pass or a second tab.
    sq = await migrated();
    seedPattern(sq, "still-pending", "Pattern A");
    seedPattern(sq, "already-dismissed", "Pattern B", ["status:deprecated"]);
    sq.seed({ id: "not-a-pattern", content: "Just a memory", createdAt: 1000, tags: ["work"] });

    const data = await (await worker.fetch(
      req("POST", "/patterns/resolve", { body: { ids: ["still-pending", "already-dismissed", "not-a-pattern", "ghost"], action: "dismiss" } }),
      envOf(sq), ctx,
    )).json() as any;

    expect(data.resolved).toBe(1);
    expect(data.ids).toEqual(["still-pending"]);
    expect(data.skipped).toBe(3);
    // The already-dismissed one keeps its original tags; nothing was re-written.
    expect(tagsOf(sq, "not-a-pattern")).toEqual(["work"]);
  });

  it("refuses a batch larger than D1 can bind, rather than truncating it", async () => {
    // Silent truncation would report "resolved" for patterns still waiting.
    //
    // The cap is D1's 100 bound parameters MINUS the caller's workspace scope,
    // which the SELECT binds alongside the ids — three for an admin (personal,
    // company, and the '' legacy space), so 97 here. Asserted as the number the
    // route reports rather than a literal, because the point is that the reply
    // names the real limit: a client that trusted a hardcoded 100 would send a
    // batch D1 rejects outright.
    sq = await migrated();
    const res = await worker.fetch(
      req("POST", "/patterns/resolve", { body: { ids: Array.from({ length: 101 }, (_, i) => `p${i}`), action: "dismiss" } }),
      envOf(sq), ctx,
    );
    expect(res.status).toBe(400);
    const limit = Number((await res.json() as any).error.match(/exceed (\d+) per request/)![1]);
    expect(limit).toBeLessThanOrEqual(100);
    expect(limit).toBe(100 - 3);
  });

  it("rejects a malformed ids list", async () => {
    sq = await migrated();
    for (const ids of [[1, 2], "p1", []]) {
      const res = await worker.fetch(
        req("POST", "/patterns/resolve", { body: { ids, action: "dismiss" } }), envOf(sq), ctx,
      );
      expect(res.status, JSON.stringify(ids)).toBe(400);
    }
  });

  it("counts a repeated id once", async () => {
    sq = await migrated();
    seedPattern(sq, "p1", "Pattern");
    const data = await (await worker.fetch(
      req("POST", "/patterns/resolve", { body: { ids: ["p1", "p1", "p1"], action: "dismiss" } }), envOf(sq), ctx,
    )).json() as any;
    expect(data).toMatchObject({ resolved: 1, skipped: 0 });
  });
});

/**
 * The queue's rows, and who the product says wrote them.
 *
 * Two keys join `sources` here: `workspace`, because the client holds no
 * workspace ids and the one thing it could infer a layer from (`sources`) is
 * about the INPUTS, not the insight; and `actor_name`, which comes from the
 * same `resolveActorLabel` every other read surface calls. The label is the
 * reach case below: one constant in one function, four surfaces following.
 */
describe("GET /patterns — the layer and the author of each row", () => {
  async function teamFixture() {
    const s = await migrated();
    const env = envOf(s);
    const roots = await ensureTenantBootstrap(env);
    const alice = await createMember(env, { name: "Alice" });
    return {
      s, env,
      companyWorkspaceId: roots.companyWorkspaceId,
      personalWorkspaceId: alice.member.personalWorkspaceId,
      token: alice.token,
    };
  }

  /** An insight exactly as runWeeklyInsights writes one: source system, actor_id "". */
  async function seedInsightIn(s: SqliteD1, id: string, workspaceId: string, content: string) {
    seedPattern(s, id, content);
    await s.db.prepare(`UPDATE entries SET workspace_id = ?, actor_id = '' WHERE id = ?`)
      .bind(workspaceId, id).run();
  }

  const get = (env: Env, path: string, token: string) =>
    worker.fetch(req("GET", path, { token }), env, ctx);

  it("reports a company-workspace insight as the company layer, authored by Second Brain", async () => {
    const fx = await teamFixture();
    sq = fx.s;
    await seedInsightIn(sq, "i-co", fx.companyWorkspaceId, "The team ships behind flags on Fridays");

    const data = await (await get(fx.env, "/patterns", fx.token)).json() as any;

    expect(data.patterns).toHaveLength(1);
    expect(data.patterns[0]).toMatchObject({ workspace: "company", actor_name: "Second Brain" });
  });

  it("reports a personal-workspace insight as the personal layer, with the same author", async () => {
    const fx = await teamFixture();
    sq = fx.s;
    await seedInsightIn(sq, "i-me", fx.personalWorkspaceId, "You tend to ship on Fridays");

    const data = await (await get(fx.env, "/patterns", fx.token)).json() as any;

    expect(data.patterns[0]).toMatchObject({ workspace: "personal", actor_name: "Second Brain" });
  });

  it("adds the two keys and renames or drops nothing", async () => {
    // Exhaustive rather than a subset check, so test/ui/pattern-queue.test.ts
    // cannot be surprised by a key appearing or a name changing under it.
    const fx = await teamFixture();
    sq = fx.s;
    await seedInsightIn(sq, "i-co", fx.companyWorkspaceId, "The team ships behind flags on Fridays");
    seedEdge(sq, "i-co", "gone", "drawn_from");

    const data = await (await get(fx.env, "/patterns", fx.token)).json() as any;

    const row = data.patterns[0];
    expect(Object.keys(row).sort())
      .toEqual(["actor_name", "content", "created_at", "id", "sources", "workspace"]);
    expect(row.id).toBe("i-co");
    expect(row.content).toBe("The team ships behind flags on Fridays");
    expect(row.created_at).toBe(1000);
    expect(row.sources).toEqual([{ id: "gone", missing: true }]);
  });

  it("issues the same number of statements whether or not the page has a company row", async () => {
    // The layer is computed from a column already in the projection, and
    // lookupActorLabels issues NO statement for an empty id list — which this
    // queue's always is, because every auto-insight row is written with
    // actor_id "". The call is made anyway rather than skipped: "every row
    // here is system-authored" is an invariant of a different file, and the
    // cost of not relying on it is zero. This is what proves that.
    const personalOnly = await teamFixture();
    sq = personalOnly.s;
    await seedInsightIn(sq, "i-me", personalOnly.personalWorkspaceId, "You tend to ship on Fridays");
    const beforeP = sq.issued.length;
    await get(personalOnly.env, "/patterns?limit=50", personalOnly.token);
    const personalCost = sq.issued.length - beforeP;
    sq.close();

    const withCompany = await teamFixture();
    sq = withCompany.s;
    await seedInsightIn(sq, "i-me", withCompany.personalWorkspaceId, "You tend to ship on Fridays");
    await seedInsightIn(sq, "i-co", withCompany.companyWorkspaceId, "The team ships behind flags on Fridays");
    const beforeC = sq.issued.length;
    await get(withCompany.env, "/patterns?limit=50", withCompany.token);
    const companyCost = sq.issued.length - beforeC;

    expect(companyCost).toBe(personalCost);
    // Pinned: identity, the page, the count and the source hydration. Unchanged
    // by this task — the projection widened, no statement was added.
    expect(companyCost).toBe(4);
  });

  it("names the same author on /patterns, /list and /entry from one fixture", async () => {
    // THE REACH CASE. `resolveActorLabel` is one function with four callers, so
    // renaming its system branch had to move every surface at once. Three of
    // them are asserted here off a single row; the fourth (/graph node labels)
    // is asserted in test/integration/graph-team-aware.test.ts. If any of these
    // could disagree, the label was special-cased somewhere it should not have
    // been.
    const fx = await teamFixture();
    sq = fx.s;
    await seedInsightIn(sq, "i-co", fx.companyWorkspaceId, "The team ships behind flags on Fridays");

    const patterns = await (await get(fx.env, "/patterns", fx.token)).json() as any;
    const list = await (await get(fx.env, "/list?n=50", fx.token)).json() as any;
    const entry = await (await get(fx.env, "/entry?id=i-co", fx.token)).json() as any;

    expect(patterns.patterns[0].actor_name).toBe("Second Brain");
    expect(list.find((r: any) => r.id === "i-co").actor_name).toBe("Second Brain");
    expect(entry.entry.actor_name).toBe("Second Brain");
  });
});
