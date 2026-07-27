import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureEntry } from "../../src/capture/entry";
import { makeTestDb, makeTestEnv, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

// Collects waitUntil promises so we can await the fire-and-forget auto-link.
function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

// AI mock: embeds queries, and streams a fixed verdict for the contradiction/merge LLM call.
function makeAI(verdict: string) {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(verdict)}}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as unknown as Ai;
}

function match(id: string, score: number) {
  return { id, score, metadata: { parentId: id, isUpdate: false } };
}

function seedExisting(db: D1Mock, tags: string[] = []) {
  db.entries.push({ id: "existing", content: "Existing memory", tags: JSON.stringify(tags), source: "api", created_at: 1, vector_ids: "[]" });
}

describe("auto-link on write (issue #16)", () => {
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
  });

  it("links a newly-stored entry to a similar existing one (relates_to, inferred)", async () => {
    seedExisting(db);
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [match("existing", 0.8)] }) }),
      AI: makeAI('{"contradicts": false}'),
    });
    const { ctx, drain } = makeCtx();

    const result = await captureEntry("A related new memory", [], "api", env, ctx);
    await drain();

    expect(result.status).toBe("stored");
    if (result.status !== "stored") throw new Error("expected stored");
    expect(db.edges).toHaveLength(1);
    const e = db.edges[0];
    expect(e.type).toBe("relates_to");
    expect(e.provenance).toBe("inferred");
    expect([e.source_id, e.target_id]).toContain("existing");
    expect([e.source_id, e.target_id]).toContain(result.id);
  });

  it("does NOT link when the capture is blocked as a duplicate", async () => {
    seedExisting(db);
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [match("existing", 0.97)] }) }),
      AI: makeAI('{"contradicts": false}'),
    });
    const { ctx, drain } = makeCtx();

    const result = await captureEntry("Near-identical memory", [], "api", env, ctx);
    await drain();

    expect(result.status).toBe("blocked");
    expect(db.edges).toHaveLength(0);
  });

  it("does NOT link when the capture is merged/replaced into an existing entry", async () => {
    seedExisting(db);
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [match("existing", 0.9)] }) }),
      AI: makeAI('{"action":"replace","target_id":"existing"}'),
    });
    const { ctx, drain } = makeCtx();

    const result = await captureEntry("Updated version", [], "api", env, ctx);
    await drain();

    expect(result.status).toBe("replaced");
    expect(db.edges).toHaveLength(0);
  });

  it("does NOT link a contradiction-protected draft (the new entry lost to a canonical)", async () => {
    seedExisting(db, ["status:canonical"]);
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [match("existing", 0.9)] }) }),
      AI: makeAI('{"action":"contradiction","conflicting_id":"existing","reason":"conflict"}'),
    });
    const { ctx, drain } = makeCtx();

    const result = await captureEntry("Conflicting claim", [], "api", env, ctx);
    await drain();

    expect(result.status).toBe("contradiction_protected");
    expect(db.edges).toHaveLength(0);
  });

  it("projects a supersedes edge (not a redundant relates_to) when a new entry wins a contradiction", async () => {
    seedExisting(db); // non-canonical incumbent
    const env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ query: vi.fn().mockResolvedValue({ matches: [match("existing", 0.9)] }) }),
      AI: makeAI('{"action":"contradiction","conflicting_id":"existing","reason":"conflict"}'),
    });
    const { ctx, drain } = makeCtx();

    const result = await captureEntry("The corrected fact", [], "api", env, ctx);
    await drain();

    expect(result.status).toBe("contradiction");
    if (result.status !== "contradiction") throw new Error("expected contradiction");
    expect(db.edges).toHaveLength(1);
    const e = db.edges[0];
    expect(e.type).toBe("supersedes"); // new supersedes the deprecated incumbent
    expect(e.provenance).toBe("system");
    expect(e.source_id).toBe(result.id);
    expect(e.target_id).toBe("existing");
  });
});
