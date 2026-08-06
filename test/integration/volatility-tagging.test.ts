import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../../src/index";
import { captureEntry } from "../../src/capture/entry";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";
import { tagsAfterAppend, tagsAfterWrite, STALE_AS_OF } from "../../src/memory/stale";
import { getVolatility } from "../../src/memory/volatility";
import { runStalenessPass, STALENESS_AGE_MS } from "../../src/staleness/pass";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function makeCtx() {
  const pending: Promise<any>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext,
    drain: () => Promise.allSettled(pending),
  };
}

function makeContradictionAI(response: string) {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as any;
}

const tagsOf = (db: D1Mock, id: string): string[] =>
  JSON.parse(db.entries.find((e: any) => e.id === id)!.tags ?? "[]");

const seed = (db: D1Mock, id: string, tags: string[], content = "Original note") => {
  db.entries.push({
    id, content, tags: JSON.stringify(tags), source: "api",
    created_at: 1, updated_at: 1, vector_ids: "[]",
  });
};

// Just over CHUNK_MAX_CHARS (1600), which routes appendToEntry down its full re-embed
// branch instead of the incremental one. Both branches write tags, so both are exercised.
const LONG = "a".repeat(1601);

describe("volatility supplied by the calling model", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  describe("tag helpers", () => {
    it("tagsAfterAppend clears the as-of qualifier but keeps the verdict", () => {
      const out = tagsAfterAppend(["work", "volatility:durable", STALE_AS_OF]);
      expect(out).toContain("volatility:durable");
      expect(out).not.toContain(STALE_AS_OF);
      expect(out).toContain("work");
    });

    it("tagsAfterWrite still clears both — a replacement discards the verdict", () => {
      const out = tagsAfterWrite(["work", "volatility:durable", STALE_AS_OF]);
      expect(out).not.toContain("volatility:durable");
      expect(out).not.toContain(STALE_AS_OF);
      expect(out).toContain("work");
    });
  });

  describe("POST /capture", () => {
    it("stores the supplied verdict as a volatility tag", async () => {
      const res = await worker.fetch(
        req("POST", "/capture", { body: { content: "Rahil is head of product at Acme", volatility: "state" } }),
        env, ctx,
      );
      expect(res.status).toBe(200);
      const id = (await res.json() as any).id;
      expect(getVolatility(tagsOf(db, id))).toBe("state");
    });

    it("stores no verdict when the field is omitted — omission is the abstain", async () => {
      const res = await worker.fetch(
        req("POST", "/capture", { body: { content: "Some note" } }), env, ctx,
      );
      const id = (await res.json() as any).id;
      expect(getVolatility(tagsOf(db, id))).toBeNull();
    });

    it("keeps the caller's own tags alongside the verdict", async () => {
      const res = await worker.fetch(
        req("POST", "/capture", { body: { content: "A note", tags: ["work", "acme"], volatility: "volatile" } }),
        env, ctx,
      );
      const tags = tagsOf(db, (await res.json() as any).id);
      expect(tags).toEqual(expect.arrayContaining(["work", "acme", "volatility:volatile"]));
    });

    it("rejects an unknown value with 400 and writes nothing", async () => {
      const res = await worker.fetch(
        req("POST", "/capture", { body: { content: "A note", volatility: "temporary" } }), env, ctx,
      );
      expect(res.status).toBe(400);
      expect(db.entries).toHaveLength(0);
    });

    it("rejects a value that differs only by case — the tag namespace is exact", async () => {
      const res = await worker.fetch(
        req("POST", "/capture", { body: { content: "A note", volatility: "Volatile" } }), env, ctx,
      );
      expect(res.status).toBe(400);
    });

    // captureEntry lowercases tags after withVolatility has already filtered the
    // namespace, so a case-sensitive filter let a caller's own tag through to become a
    // second verdict — and getVolatility returns the first match, so the unvalidated
    // one won over the enum. That made `tags[]` an override for a validated field.
    it("a differently-cased volatility tag cannot smuggle in a second verdict", async () => {
      const res = await worker.fetch(
        req("POST", "/capture", { body: { content: "A note", tags: ["Volatility:durable"], volatility: "volatile" } }),
        env, ctx,
      );
      const tags = tagsOf(db, (await res.json() as any).id);
      expect(tags.filter(t => t.toLowerCase().startsWith("volatility:"))).toEqual(["volatility:volatile"]);
      expect(getVolatility(tags)).toBe("volatile");
    });

    it("an invalid cased tag cannot shadow the validated verdict", async () => {
      const res = await worker.fetch(
        req("POST", "/capture", { body: { content: "A note", tags: ["Volatility:sometimes"], volatility: "durable" } }),
        env, ctx,
      );
      // Previously getVolatility found the junk tag first, failed its enum check and
      // returned null — which also let the nightly pass overwrite the caller's verdict.
      expect(getVolatility(tagsOf(db, (await res.json() as any).id))).toBe("durable");
    });

    // Nothing stops a caller writing raw tags in the reserved namespace without using the
    // enum at all, so withVolatility never runs and both tags reach the row. Reading has
    // to tolerate that: a junk verdict ahead of a real one used to report the entry as
    // unclassified, which lowered its recall floor and invited the pass to overwrite it.
    it("an invalid verdict written directly into tags cannot shadow a valid one", async () => {
      const res = await worker.fetch(
        req("POST", "/capture", { body: { content: "A note", tags: ["volatility:sometimes", "volatility:durable"] } }),
        env, ctx,
      );
      expect(getVolatility(tagsOf(db, (await res.json() as any).id))).toBe("durable");
    });

    it("cannot produce two verdicts when tags already carry one", async () => {
      const res = await worker.fetch(
        req("POST", "/capture", { body: { content: "A note", tags: ["volatility:durable"], volatility: "volatile" } }),
        env, ctx,
      );
      const tags = tagsOf(db, (await res.json() as any).id);
      expect(tags.filter(t => t.startsWith("volatility:"))).toEqual(["volatility:volatile"]);
    });
  });

  describe("POST /append", () => {
    it("preserves an existing verdict when none is supplied", async () => {
      seed(db, "e1", ["work", "volatility:durable"]);
      const res = await worker.fetch(
        req("POST", "/append", { body: { id: "e1", addition: "One more detail" } }), env, ctx,
      );
      expect(res.status).toBe(200);
      expect(getVolatility(tagsOf(db, "e1"))).toBe("durable");
    });

    it("preserves the verdict on the long-content re-embed branch too", async () => {
      seed(db, "e1", ["volatility:durable"], LONG);
      await worker.fetch(req("POST", "/append", { body: { id: "e1", addition: "More" } }), env, ctx);
      expect(getVolatility(tagsOf(db, "e1"))).toBe("durable");
    });

    it("overrides the existing verdict when one is supplied", async () => {
      seed(db, "e1", ["volatility:durable"]);
      await worker.fetch(
        req("POST", "/append", { body: { id: "e1", addition: "Now it moves", volatility: "state" } }), env, ctx,
      );
      expect(getVolatility(tagsOf(db, "e1"))).toBe("state");
    });

    it("clears the as-of qualifier, because updated_at has moved", async () => {
      seed(db, "e1", ["volatility:state", STALE_AS_OF]);
      await worker.fetch(req("POST", "/append", { body: { id: "e1", addition: "Fresh info" } }), env, ctx);
      const tags = tagsOf(db, "e1");
      expect(tags).not.toContain(STALE_AS_OF);
      expect(getVolatility(tags)).toBe("state");
    });

    it("rejects an unknown value with 400 and leaves the entry untouched", async () => {
      seed(db, "e1", ["volatility:durable"], "Untouched");
      const res = await worker.fetch(
        req("POST", "/append", { body: { id: "e1", addition: "x", volatility: "sometimes" } }), env, ctx,
      );
      expect(res.status).toBe(400);
      expect(db.entries.find((e: any) => e.id === "e1")!.content).toBe("Untouched");
    });
  });

  describe("POST /update", () => {
    it("discards the old verdict when none is supplied — the content it described is gone", async () => {
      seed(db, "e1", ["work", "volatility:durable", STALE_AS_OF]);
      const res = await worker.fetch(
        req("POST", "/update", { body: { id: "e1", content: "Completely different fact" } }), env, ctx,
      );
      expect(res.status).toBe(200);
      const tags = tagsOf(db, "e1");
      expect(getVolatility(tags)).toBeNull();
      expect(tags).not.toContain(STALE_AS_OF);
      expect(tags).toContain("work");
    });

    it("applies a supplied verdict, which must survive the strip", async () => {
      seed(db, "e1", ["volatility:durable", STALE_AS_OF]);
      await worker.fetch(
        req("POST", "/update", { body: { id: "e1", content: "New fact", volatility: "volatile" } }), env, ctx,
      );
      const tags = tagsOf(db, "e1");
      expect(getVolatility(tags)).toBe("volatile");
      expect(tags).not.toContain(STALE_AS_OF);
    });

    it("rejects an unknown value with 400 and leaves the entry untouched", async () => {
      seed(db, "e1", [], "Untouched");
      const res = await worker.fetch(
        req("POST", "/update", { body: { id: "e1", content: "New", volatility: "" } }), env, ctx,
      );
      expect(res.status).toBe(400);
      expect(db.entries.find((e: any) => e.id === "e1")!.content).toBe("Untouched");
    });
  });

  // The dedup path rewrites the TARGET entry and discards the incoming tag list. That
  // predates this feature and is left alone — except for the verdict, which the tool
  // schema promises wins permanently. Dropping it returned "merged" (a success) on a
  // write that threw the judgment away, and the merge bumps updated_at, so the nightly
  // pass would not revisit the entry for 90 days to re-derive anything.
  describe("duplicate merge and replace paths", () => {
    const mergingEnv = (db: D1Mock, action: string) => makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({
        query: vi.fn().mockResolvedValue({
          matches: [{ id: "target", score: 0.88, metadata: { parentId: "target" } }],
        }),
      }),
      AI: makeContradictionAI(action),
    });

    const seedTarget = (db: D1Mock, tags: string) => db.entries.push({
      id: "target", content: "I prefer dark mode", tags, source: "api",
      created_at: Date.now(), vector_ids: '["target"]', recall_count: 0, importance_score: 2,
    });

    it("carries the caller's verdict onto a merged entry", async () => {
      seedTarget(db, '["work"]');
      const { ctx: c } = makeCtx();
      const result = await captureEntry(
        "I like dark mode at night", ["volatility:durable"], "api",
        mergingEnv(db, '{"action":"merge","target_id":"target","merged_content":"Dark mode, especially at night"}'), c,
      );
      expect(result.status).toBe("merged");
      expect(getVolatility(tagsOf(db, "target"))).toBe("durable");
    });

    it("carries the caller's verdict onto a replaced entry", async () => {
      seedTarget(db, '["work"]');
      const { ctx: c } = makeCtx();
      await captureEntry(
        "I switched to light mode", ["volatility:state"], "api",
        mergingEnv(db, '{"action":"replace","target_id":"target"}'), c,
      );
      expect(getVolatility(tagsOf(db, "target"))).toBe("state");
    });

    it("does not strip a verdict the caller is actively supplying", async () => {
      // The net-loss case: the target already held this verdict and the caller sent the
      // same one, yet the row came back carrying none at all.
      seedTarget(db, '["work","volatility:durable"]');
      const { ctx: c } = makeCtx();
      await captureEntry(
        "I like dark mode at night", ["volatility:durable"], "api",
        mergingEnv(db, '{"action":"merge","target_id":"target","merged_content":"Dark mode at night"}'), c,
      );
      expect(getVolatility(tagsOf(db, "target"))).toBe("durable");
    });
  });

  describe("precedence over the regex classifier", () => {
    it("the nightly pass does not overwrite a verdict the model supplied", async () => {
      const old = Date.now() - STALENESS_AGE_MS - 86400000;
      // Wording the regex classifier reads as `state` ("works at"), tagged `durable` by the
      // caller. The caller's verdict has to win, or the model's judgment is decorative.
      db.entries.push({
        id: "job", content: "Alice works at Acme Corp", tags: JSON.stringify(["volatility:durable"]),
        source: "api", created_at: old, updated_at: old, vector_ids: "[]",
      });

      await runStalenessPass(makeTestEnv(db), {} as ExecutionContext);

      const tags = tagsOf(db, "job");
      expect(getVolatility(tags)).toBe("durable");
      // durable is not stale-flagged, so the pass must also not have added the qualifier.
      expect(tags).not.toContain(STALE_AS_OF);
    });

    it("still classifies entries the model left unjudged", async () => {
      const old = Date.now() - STALENESS_AGE_MS - 86400000;
      db.entries.push({
        id: "job", content: "Alice works at Acme Corp", tags: "[]",
        source: "api", created_at: old, updated_at: old, vector_ids: "[]",
      });

      await runStalenessPass(makeTestEnv(db), {} as ExecutionContext);

      expect(getVolatility(tagsOf(db, "job"))).toBe("state");
    });
  });
});
