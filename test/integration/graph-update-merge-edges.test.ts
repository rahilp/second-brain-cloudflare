/**
 * B3 — the two writes that changed an entry's meaning and drew nothing.
 *
 * Capture infers edges; editing and merging did not. An entry whose content was
 * rewritten kept the graph position of the text it no longer contains, and a
 * merge — which is the one write that combines two memories — left the survivor
 * connected to whatever the older half happened to match.
 *
 * Both are fixed without spending anything new, which is the whole constraint:
 *
 *   - the update path re-embeds through `storeEntry` anyway, so it now returns
 *     the vector it just computed and the neighbour query reuses it. No second
 *     embed call.
 *   - the merge path already asked Vectorize for neighbours during duplicate
 *     detection. It reuses that answer. No second query.
 *
 * The counts asserted here are the point. Getting the edges by paying for
 * another embed or another query would pass a "does it draw an edge" test and
 * fail the reason the work was worth doing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { updateEntryContent } from "../../src/capture/store";
import { captureEntry } from "../../src/capture/entry";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;

describe("edges from the update and merge paths", () => {
  let sqlite: SqliteD1;
  let embeds: number;
  let queries: number;

  beforeEach(async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    embeds = 0;
    queries = 0;
    await initializeDatabase(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"] }));
  });

  afterEach(() => sqlite.close());

  /** Counts embeds; answers any streamed call with `verdict`. */
  function ai(verdict: string) {
    return {
      run: vi.fn().mockImplementation(async (model: string) => {
        if (model.startsWith("@cf/baai/bge")) {
          embeds++;
          return { data: [new Array(384).fill(0.1)] };
        }
        return new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(verdict)}}\n\n`));
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        });
      }),
    } as any;
  }

  function vectorize(matches: { id: string; score: number }[]) {
    return {
      query: vi.fn().mockImplementation(async () => {
        queries++;
        return { matches: matches.map(m => ({ ...m, metadata: { parentId: m.id } })) };
      }),
      insert: async () => ({}), upsert: async () => ({}), deleteByIds: async () => ({}), getByIds: async () => [],
    } as any;
  }

  function envWith(matches: { id: string; score: number }[], verdict: string): Env {
    return makeTestEnv(undefined, {
      DB: sqlite.db as unknown as Env["DB"],
      OAUTH_KV: makeMemoryKV(),
      AI: ai(verdict),
      VECTORIZE: vectorize(matches),
    });
  }

  async function edges(): Promise<{ source_id: string; target_id: string; type: string }[]> {
    const r = await sqlite.db.prepare(`SELECT source_id, target_id, type FROM edges`).all() as any;
    return r.results;
  }

  describe("editing an entry's content", () => {
    it("links the rewritten entry to its new neighbours", async () => {
      sqlite.seed({ id: "edited", content: "the original text", createdAt: 1000 });
      sqlite.seed({ id: "friend", content: "a related memory", createdAt: 900 });
      const env = envWith([{ id: "friend", score: 0.85 }], "3");

      const result = await updateEntryContent(env, "edited", "an entirely different subject");
      expect(result.status).toBe("updated");

      expect((await edges()).flatMap(e => [e.source_id, e.target_id])).toContain("friend");
    });

    it("spends no extra embed call doing it", async () => {
      sqlite.seed({ id: "edited", content: "the original text", createdAt: 1000 });
      sqlite.seed({ id: "friend", content: "a related memory", createdAt: 900 });
      const env = envWith([{ id: "friend", score: 0.85 }], "3");

      await updateEntryContent(env, "edited", "an entirely different subject");

      // One: the re-embed the update already owed. The neighbour query reuses
      // that vector rather than embedding the same text a second time.
      expect(embeds).toBe(1);
    });
  });

  describe("merging a near-duplicate into its target", () => {
    /** 0.9 sits between the flag and block thresholds, where merge is decided. */
    const MATCHES = [{ id: "target", score: 0.9 }, { id: "friend", score: 0.82 }];
    const MERGE = '{"action":"merge","target_id":"target","merged_content":"the combined memory"}';

    let pending: Promise<any>[];
    let mergeCtx: ExecutionContext;

    beforeEach(() => {
      sqlite.seed({ id: "target", content: "the memory being merged into", createdAt: 1000 });
      sqlite.seed({ id: "friend", content: "a related memory", createdAt: 900 });
      pending = [];
      mergeCtx = { waitUntil: (p: Promise<any>) => pending.push(p) } as unknown as ExecutionContext;
    });

    it("links the surviving entry to its neighbours", async () => {
      const env = envWith(MATCHES, MERGE);

      const result = await captureEntry("the memory being merged in", [], "api", env, mergeCtx);
      expect(result.status).toBe("merged");
      await Promise.all(pending);

      expect((await edges()).flatMap(e => [e.source_id, e.target_id])).toContain("friend");
    });

    it("asks Vectorize nothing it did not already ask during duplicate detection", async () => {
      const env = envWith(MATCHES, MERGE);

      await captureEntry("the memory being merged in", [], "api", env, mergeCtx);
      await Promise.all(pending);

      // One: the duplicate check. Its neighbours are reused for inference.
      expect(queries).toBe(1);
    });

    it("never links the survivor to itself", async () => {
      const env = envWith(MATCHES, MERGE);

      await captureEntry("the memory being merged in", [], "api", env, mergeCtx);
      await Promise.all(pending);

      expect(await edges()).not.toContainEqual(
        expect.objectContaining({ source_id: "target", target_id: "target" }),
      );
    });
  });

  /**
   * The merge target is chosen by the model, not by score. When it picks the
   * SECOND-best match, the best one is still sitting in `neighbors` — and it is
   * a near-duplicate of the very content just merged in. Linking to it is
   * exactly the junk edge B1 exists to suppress, arriving by a different door.
   */
  describe("merging into a target that is not the top match", () => {
    it("still refuses to link the survivor to the duplicate match", async () => {
      sqlite.seed({ id: "top-match", content: "the closest near-duplicate", createdAt: 1100 });
      sqlite.seed({ id: "second", content: "the memory being merged into", createdAt: 1000 });
      const pending: Promise<any>[] = [];
      const mergeCtx = { waitUntil: (p: Promise<any>) => pending.push(p) } as unknown as ExecutionContext;

      // top-match scores highest, so it is dup.matchId; the model merges into `second`.
      const env = envWith(
        [{ id: "top-match", score: 0.93 }, { id: "second", score: 0.9 }],
        '{"action":"merge","target_id":"second","merged_content":"the combined memory"}',
      );

      const result = await captureEntry("the memory being merged in", [], "api", env, mergeCtx);
      expect(result.status).toBe("merged");
      await Promise.all(pending);

      expect((await edges()).flatMap(e => [e.source_id, e.target_id])).not.toContain("top-match");
    });
  });
});
