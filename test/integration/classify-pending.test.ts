import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function unclassifiedEntry(id: string, tags: string[] = ["work"]) {
  return {
    id,
    content: `Content for ${id}`,
    tags: JSON.stringify(tags),
    source: "api",
    created_at: Date.now() - 600000,
    vector_ids: '["v"]',
    recall_count: 0,
    importance_score: 0,
  };
}

// The shared default AI mock (makeAIMock in make-env.ts) returns a bare "3" with
// no parseable canonical/kind, so classifyEntry yields no signal and no tag gets
// written. That's realistic (ambiguous content stays untagged and gets retried —
// see the "still unclassified" test below) but most of these tests want a
// classifier that actually resolves, so they supply one explicitly.
function makeClassifyingAIMock(result: { importance: number; canonical: boolean; kind: "episodic" | "semantic" }) {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(JSON.stringify(result))}}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as any;
}

describe("POST /classify-pending", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns 401 without auth", async () => {
    const res = await worker.fetch(req("POST", "/classify-pending", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns { processed: 0, failed: 0, remaining: 0 } when nothing is unclassified", async () => {
    const res = await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
    expect(data.failed).toBe(0);
    expect(data.remaining).toBe(0);
  });

  it("processes unclassified entries, writes tags, and drains remaining to 0", async () => {
    env = makeTestEnv(db, { AI: makeClassifyingAIMock({ importance: 4, canonical: true, kind: "semantic" }) });
    db.entries.push(unclassifiedEntry("e1"), unclassifiedEntry("e2"));
    const res = await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(2);
    expect(data.failed).toBe(0);
    expect(data.remaining).toBe(0);
    for (const id of ["e1", "e2"]) {
      const tags: string[] = JSON.parse(db.entries.find((e: any) => e.id === id).tags);
      expect(tags).toContain("kind:semantic");
      expect(tags).toContain("status:canonical");
    }
  });

  it("skips entries that already have a status: or kind: tag", async () => {
    env = makeTestEnv(db, { AI: makeClassifyingAIMock({ importance: 4, canonical: true, kind: "semantic" }) });
    db.entries.push(
      unclassifiedEntry("has-status", ["work", "status:draft"]),
      unclassifiedEntry("has-kind", ["work", "kind:episodic"]),
    );
    const res = await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(0);
    expect(data.remaining).toBe(0);
    // untouched — still exactly the tags they started with
    expect(JSON.parse(db.entries.find((e: any) => e.id === "has-status").tags)).toEqual(["work", "status:draft"]);
    expect(JSON.parse(db.entries.find((e: any) => e.id === "has-kind").tags)).toEqual(["work", "kind:episodic"]);
  });

  it("is resumable: re-running after a full drain is a no-op", async () => {
    env = makeTestEnv(db, { AI: makeClassifyingAIMock({ importance: 4, canonical: true, kind: "semantic" }) });
    db.entries.push(unclassifiedEntry("only-one"));
    await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const res2 = await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const data2 = await res2.json() as any;
    expect(data2.processed).toBe(0);
    expect(data2.remaining).toBe(0);
  });

  it("leaves an entry untagged and still 'remaining' when classification is inconclusive", async () => {
    // Known, spec-accepted edge case: idempotency is defined by tag *presence*, not
    // a separate "attempted" marker. If classifyEntry can't resolve a kind/canonical
    // signal (default mock here returns neither), the row gets no tag and is
    // reselected on the next call — this documents that behavior rather than hiding it.
    db.entries.push(unclassifiedEntry("ambiguous"));
    const res = await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(1);
    expect(data.remaining).toBe(1);
    expect(JSON.parse(db.entries.find((e: any) => e.id === "ambiguous").tags)).toEqual(["work"]);
  });

  it("promotes canonical status and writes kind for a fully unclassified entry", async () => {
    env = makeTestEnv(db, { AI: makeClassifyingAIMock({ importance: 5, canonical: true, kind: "episodic" }) });
    // An entry that already carries kind: (but no status:) is excluded by the WHERE
    // clause entirely — the "skips" test above covers that. This one has neither
    // reserved tag, so it's selected and should get both written.
    db.entries.push(unclassifiedEntry("neither", ["work"]));
    await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const neither = JSON.parse(db.entries.find((e: any) => e.id === "neither").tags);
    expect(neither).toContain("status:canonical");
    expect(neither).toContain("kind:episodic");
  });

  it("does not touch importance_score (tags-only backfill)", async () => {
    env = makeTestEnv(db, { AI: makeClassifyingAIMock({ importance: 5, canonical: true, kind: "semantic" }) });
    db.entries.push(unclassifiedEntry("importance-check"));
    await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const updated = db.entries.find((e: any) => e.id === "importance-check");
    expect(updated.importance_score).toBe(0);
  });

  it("counts failed and continues when a row can't be updated (e.g. corrupt tags JSON)", async () => {
    // classifyEntry swallows AI-level errors internally (returns a neutral,
    // untagged result), so to exercise this endpoint's own try/catch we force a
    // failure downstream of that call instead: malformed tags JSON blows up
    // JSON.parse inside the handler.
    env = makeTestEnv(db, { AI: makeClassifyingAIMock({ importance: 4, canonical: true, kind: "semantic" }) });
    db.entries.push(
      { ...unclassifiedEntry("bad"), tags: "not-json" },
      unclassifiedEntry("good"),
    );
    const res = await worker.fetch(req("POST", "/classify-pending"), env, ctx);
    const data = await res.json() as any;
    expect(data.processed).toBe(1);
    expect(data.failed).toBe(1);
    // "bad" is still malformed/untagged so it's still selected next time; "good"
    // got tagged successfully and drops out of the unclassified set.
    expect(data.remaining).toBe(1);
  });
});
