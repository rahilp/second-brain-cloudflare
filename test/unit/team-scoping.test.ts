/**
 * Team Edition scoping for the graph, tag vocabulary and nightly compression.
 *
 * These are the SQL-subject tests the d1-mock cannot carry: whether a scope clause
 * actually excludes another workspace's rows is a property of real SQLite, so every
 * scenario here runs against the sqlite-d1 facade and the shipped schema. The d1-mock
 * branches that stand in for these queries ignore workspace bindings entirely, which
 * is exactly why a green mock test proves nothing about isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { expandGraph, buildGraph } from "../../src/graph/traverse";
import { getTagVocabulary } from "../../src/tags/vocabulary";
import { compressTag } from "../../src/compression/digest";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import type { Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";

const DAY = 86400000;
const NOW = 400 * DAY;

const identity = (personal: string): Identity => ({
  userId: "u1",
  role: "member",
  personalWorkspaceId: personal,
  companyWorkspaceIds: ["ws-co"],
  defaultShare: "" as const,
});

/** Insert an edge row directly, workspace_id included — the unit under test IS that column. */
function seedEdge(sqlite: SqliteD1, sourceId: string, targetId: string, workspaceId: string) {
  sqlite.db
    .prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES (?, ?, ?, 'relates_to', 0.9, 'explicit', '{}', 1, 1, ?)`,
    )
    .bind(`${sourceId}-${targetId}`, sourceId, targetId, workspaceId)
    .run();
}

function seedEntry(sqlite: SqliteD1, id: string, workspaceId: string, tags: string[] = [], content = `content of ${id}`) {
  // Base-schema columns only: updated_at/staleness_checked_at arrive by runtime ALTER
  // and this facade does not run initializeDatabase for us.
  sqlite.db
    .prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, recall_count, importance_score, workspace_id)
       VALUES (?, ?, ?, 'api', ?, '[]', 0, 0, ?)`,
    )
    .bind(id, content, JSON.stringify(tags), NOW - DAY, workspaceId)
    .run();
}

describe("expandGraph with an Identity", () => {
  let sqlite: SqliteD1;

  beforeEach(() => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    // The seed lives in the caller's personal workspace; one neighbour is shared via
    // the company workspace (legitimate — must stay reachable), one belongs to a
    // stranger's personal workspace (must never be returned).
    seedEntry(sqlite, "seed", "ws-me");
    seedEntry(sqlite, "shared", "ws-co");
    seedEntry(sqlite, "foreign", "ws-other");
    seedEdge(sqlite, "seed", "shared", "ws-co");
    seedEdge(sqlite, "seed", "foreign", "ws-other");
  });

  afterEach(() => sqlite.close());

  it("keeps neighbours in the readable pair and drops strangers' nodes", async () => {
    const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"] });
    const out = await expandGraph(["seed"], { hops: 1 }, env, undefined, identity("ws-me"));
    expect(out.map(n => n.id).sort()).toEqual(["shared"]);
  });

  it("without an Identity returns every neighbour — pre-tenancy behaviour byte-for-byte", async () => {
    const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"] });
    const out = await expandGraph(["seed"], { hops: 1 }, env);
    expect(out.map(n => n.id).sort()).toEqual(["foreign", "shared"]);
  });

  it("reaches a readable neighbour through the other readable workspace, not just its own", async () => {
    // A scoped seed may legitimately walk personal → company; the IN-form handles
    // that, an equality on personalWorkspaceId would not.
    seedEntry(sqlite, "bridge", "ws-co");
    seedEdge(sqlite, "shared", "bridge", "ws-co");
    const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"] });
    const out = await expandGraph(["seed"], { hops: 2 }, env, undefined, identity("ws-me"));
    expect(out.map(n => n.id).sort()).toEqual(["bridge", "shared"]);
  });
});

describe("buildGraph with an Identity", () => {
  let sqlite: SqliteD1;

  beforeEach(() => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
  });

  afterEach(() => sqlite.close());

  it("selects no seeded nodes from edges outside the readable pair", async () => {
    seedEntry(sqlite, "mine", "ws-me");
    seedEntry(sqlite, "theirs", "ws-other");
    seedEdge(sqlite, "mine", "mine2", "ws-me");
    seedEntry(sqlite, "mine2", "ws-me");
    seedEdge(sqlite, "theirs", "theirs2", "ws-other");
    seedEntry(sqlite, "theirs2", "ws-other");

    const env = makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"] });
    const view = await buildGraph({}, env, undefined, identity("ws-me"));
    expect(view.nodes.map(n => n.id).sort()).toEqual(["mine", "mine2"]);
    expect(view.edges.every(e => e.source.startsWith("mine") && e.target.startsWith("mine"))).toBe(true);
  });
});

describe("tag vocabulary scoping", () => {
  let sqlite: SqliteD1;

  beforeEach(() => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    seedEntry(sqlite, "a1", "ws-a", ["alpha-only", "common"]);
    seedEntry(sqlite, "b1", "ws-b", ["beta-only"]);
    seedEntry(sqlite, "c1", "ws-co", ["company", "common"]);
  });

  afterEach(() => sqlite.close());

  function env(): Env {
    return makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
    });
  }

  it("scoped scan sees only the caller's personal + company tags", async () => {
    // No ctx: nothing cached, so the scan runs inline rather than behind waitUntil.
    const tags = await getTagVocabulary(env(), undefined, identity("ws-a"));
    expect(tags).toEqual(["alpha-only", "common", "company"]);
    expect(tags).not.toContain("beta-only");
  });

  it("unscoped scan still sees everything", async () => {
    const tags = await getTagVocabulary(env());
    expect(tags).toEqual(["alpha-only", "beta-only", "common", "company"]);
  });
});

describe("digest rollup partitioning", () => {
  let sqlite: SqliteD1;

  /** Ten old, low-importance entries per workspace, same tag, marker word per side. */
  function seedTagPerWorkspace(tag: string) {
    for (let i = 0; i < 10; i++) {
      seedEntry(sqlite, `w1-${i}`, "ws-1", [tag], `ALPHA progress note ${i} about the ${tag} plan`);
      seedEntry(sqlite, `w2-${i}`, "ws-2", [tag], `BETA progress note ${i} about the ${tag} plan`);
    }
  }

  beforeEach(() => {
    resetDatabaseInit();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    sqlite = makeSqliteD1();
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
  });

  /** Streams a digest response and records each prompt so inputs can be audited. */
  function makeDigestAI() {
    const prompts: string[] = [];
    const run = vi.fn().mockImplementation(async (_model: string, opts: any) => {
      if (_model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      if (opts?.stream) {
        prompts.push(opts.messages[0].content as string);
        const body = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: {"response":"A digest paragraph."}\n\n`));
            c.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
            c.close();
          },
        });
        return body;
      }
      return { response: "3" };
    });
    return { ai: { run } as unknown as Ai, prompts };
  }

  function makeCtx() {
    const pending: Promise<any>[] = [];
    return {
      ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as unknown as ExecutionContext,
      drain: () => Promise.allSettled(pending),
    };
  }

  it("never pools two workspaces' rows into one rollup", async () => {
    seedTagPerWorkspace("proj");
    const { ai, prompts } = makeDigestAI();
    const env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      AI: ai,
      OAUTH_KV: makeMemoryKV(),
      VECTORIZE: makeTestEnv().VECTORIZE,
    });
    // captureEntry INSERTs runtime-ALTER columns (updated_at), so the schema the
    // nightly cron normally guarantees must actually exist here.
    await initializeDatabase(env);
    const { ctx, drain } = makeCtx();

    await compressTag("proj", env, ctx);
    await drain();

    // Every prompt the model saw drew from exactly one side's rows — no mixed rollup.
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) {
      const hasAlpha = p.includes("ALPHA");
      const hasBeta = p.includes("BETA");
      // The classify calls that ride along on captureEntry also stream, and their
      // prompt carries neither marker — the invariant is "never both sides at once".
      expect(hasAlpha && hasBeta).toBe(false);
    }

    // Each digest entry inherited the workspace of the rows it was built from.
    const digests = await env.DB.prepare(
      `SELECT id, content, workspace_id FROM entries WHERE tags LIKE '%"synthesized"%'`,
    ).all() as { results: { id: string; content: string; workspace_id: string }[] };
    expect(digests.results.length).toBeGreaterThan(0);
    console.log("DIGESTS>>>", JSON.stringify(digests.results));
    for (const d of digests.results) {
      expect(d.content).toContain(`entries tagged "proj"`);
      expect(["ws-1", "ws-2"]).toContain(d.workspace_id);
      if (d.workspace_id === "ws-1") expect(d.content.length).toBeGreaterThan(0);
    }
  });
});
