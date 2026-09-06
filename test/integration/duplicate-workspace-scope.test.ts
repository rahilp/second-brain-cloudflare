/**
 * Duplicate and contradiction candidates are hydrated by id, and those ids come
 * from a Vectorize query — not from an already-scoped read.
 *
 * That distinction is the whole of this file. `src/lib/scope.ts` licenses an
 * unscoped by-id lookup only when the ids came from a read that was itself
 * scoped; here they came from a vector query whose workspace filter is
 * best-effort by contract (`src/vectorize/scope.ts` degrades to an unfiltered
 * query on a filter-shaped rejection, and latches that per isolate). In the
 * degraded mode the candidate list can therefore hold another member's entry,
 * and the consequence is not a ranking imperfection: `captureEntry`'s merge path
 * takes a candidate as the merge TARGET, so a colleague's memory can enter the
 * merge prompt, land in `merged_content`, and overwrite their row.
 *
 * Real SQLite, not the string-matching D1 double: whether a predicate actually
 * excludes a row is a property of the SQL, and the double ignores workspace
 * bindings entirely, so a green mock would prove nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { resetVectorizeFilterState, vectorizeFilterState } from "../../src/vectorize/scope";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { captureEntry } from "../../src/capture/entry";
import { checkDuplicateAndContradiction } from "../../src/capture/duplicate";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

let sqlite: SqliteD1;
let env: Env;
let alice: { userId: string; personalWorkspaceId: string };
let bob: { userId: string; personalWorkspaceId: string };

/** A token that appears in Bob's row and nowhere else, so "did Bob's words
 * reach the model" is answerable from the prompt log alone — Alice's own
 * content also goes to the classifier on the same double. */
const BOB_MARKER = "psoriasis-consult";
const BOB_SECRET = `Bob private: the ${BOB_MARKER} counter-offer is 180 and he will take 165`;
const ALICE_NOTE = "Alice private: the counter-offer is 180 and I will take 165";

function seed(id: string, workspaceId: string, actorId: string, content: string) {
  sqlite.db
    .prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
       VALUES (?, ?, '[]', 'test', ?, ?, '[]', ?, ?)`,
    )
    .bind(id, content, Date.now() - 3600_000, Date.now() - 3600_000, workspaceId, actorId)
    .run();
}

/**
 * The AI double: embeddings for `embed`, and one scripted verdict for every
 * streamed call, with each prompt recorded. Asserting on the PROMPTS is what
 * makes these cases sharp — a merge built from a foreign row is a leak whether
 * or not the model's answer happens to quote it.
 */
function scriptedAI(verdict: string, prompts: string[]): Ai {
  return {
    run: vi.fn().mockImplementation(async (model: string, opts: any) => {
      if (model === "@cf/baai/bge-small-en-v1.5") return { data: [new Array(384).fill(0.1)] };
      prompts.push(String(opts?.messages?.[0]?.content ?? ""));
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

/**
 * A Vectorize index that REJECTS the workspace metadata filter — the documented
 * degraded mode — and answers every query with `matchId` at 0.9. That score sits
 * between DUPLICATE_FLAG_THRESHOLD and DUPLICATE_BLOCK_THRESHOLD, which is the
 * band where the merge model is consulted.
 */
function degradedVectorize(matchId: string) {
  return makeVectorizeMock({
    query: vi.fn().mockImplementation(async (_values: number[], opts: any) => {
      if (opts?.filter) throw new Error("VECTORIZE_QUERY_ERROR (code = 40006): unsupported metadata filter");
      return { matches: [{ id: matchId, score: 0.9, metadata: { parentId: matchId } }] };
    }),
  });
}

/** The same index with a working filter, for the same-workspace control cases. */
function filteringVectorize(matchId: string, matchWorkspaceId: string) {
  return makeVectorizeMock({
    query: vi.fn().mockImplementation(async (_values: number[], opts: any) => {
      const wanted: string[] | undefined = opts?.filter?.workspace_id?.$in;
      if (wanted && !wanted.includes(matchWorkspaceId)) return { matches: [] };
      return { matches: [{ id: matchId, score: 0.9, metadata: { parentId: matchId } }] };
    }),
  });
}

const contentOf = async (id: string) =>
  ((await sqlite.db.prepare(`SELECT content FROM entries WHERE id = ?`).bind(id).first()) as { content: string } | null)?.content;

beforeEach(async () => {
  resetDatabaseInit();
  // Module-scoped latch: a case that degrades it would otherwise leave every
  // later case in this file querying unfiltered.
  resetVectorizeFilterState();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
  });
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  const a = await createMember(env, { name: "Alice" });
  const b = await createMember(env, { name: "Bob" });
  alice = { userId: a.member.userId, personalWorkspaceId: a.member.personalWorkspaceId };
  bob = { userId: b.member.userId, personalWorkspaceId: b.member.personalWorkspaceId };
  void roots;
});

afterEach(() => sqlite?.close());

describe("a degraded vector filter cannot put a colleague's memory in a merge", () => {
  it("hydrates no candidate outside the writer's workspace", async () => {
    seed("b-secret", bob.personalWorkspaceId, bob.userId, BOB_SECRET);
    const prompts: string[] = [];
    env.VECTORIZE = degradedVectorize("b-secret");
    env.AI = scriptedAI('{"action":"merge","target_id":"b-secret","merged_content":"combined"}', prompts);

    const result = await checkDuplicateAndContradiction(
      ALICE_NOTE, env, undefined, alice.personalWorkspaceId,
    );

    // The degraded path was really taken — otherwise the case passes because the
    // filter worked, which is exactly what it is meant to rule out.
    expect(vectorizeFilterState().supported).toBe(false);
    // No prompt was built at all, because there was nothing readable to build
    // one from. Asserted on the model's INPUT: a merge assembled from a foreign
    // row is a leak whatever the model then says about it.
    expect(prompts).toEqual([]);
    expect(result.mergeAction).toBeNull();
    expect(result.contradiction.detected).toBe(false);
  });

  it("leaves the colleague's row untouched when the model asks to merge into it", async () => {
    // The assertion that matters most: the merge path REWRITES its target.
    seed("b-secret", bob.personalWorkspaceId, bob.userId, BOB_SECRET);
    const prompts: string[] = [];
    env.VECTORIZE = degradedVectorize("b-secret");
    env.AI = scriptedAI(
      '{"action":"merge","target_id":"b-secret","merged_content":"Merged: the counter-offer is 180 and the walk-away is 165"}',
      prompts,
    );

    const result = await captureEntry(ALICE_NOTE, [], "api", env, ctx, undefined, {
      workspaceId: alice.personalWorkspaceId,
      actorId: alice.userId,
    });

    expect(vectorizeFilterState().supported).toBe(false);
    // Alice's memory was stored as her own row, not merged into Bob's.
    expect(result.status).toBe("flagged");
    expect(await contentOf("b-secret")).toBe(BOB_SECRET);
    // And nothing anywhere carries the merged text.
    const { results: merged } = await sqlite.db
      .prepare(`SELECT id FROM entries WHERE content LIKE '%walk-away%'`).all();
    expect(merged).toEqual([]);
    // Bob's words never reached the model.
    expect(prompts.join("\n")).not.toContain(BOB_MARKER);
  });

  it("draws no contradiction from a colleague's memory either", async () => {
    // The same hydration feeds the contradiction prompt, which deprecates the
    // row it names and writes a supersedes edge against it.
    seed("b-secret", bob.personalWorkspaceId, bob.userId, BOB_SECRET);
    const prompts: string[] = [];
    env.VECTORIZE = makeVectorizeMock({
      query: vi.fn().mockImplementation(async (_values: number[], opts: any) => {
        if (opts?.filter) throw new Error("VECTORIZE_QUERY_ERROR (code = 40006): unsupported metadata filter");
        // Below DUPLICATE_FLAG_THRESHOLD, above CANDIDATE_SCORE_THRESHOLD: the
        // contradiction prompt's band rather than the merge one's.
        return { matches: [{ id: "b-secret", score: 0.6, metadata: { parentId: "b-secret" } }] };
      }),
    });
    env.AI = scriptedAI('{"contradicts": true, "conflicting_id": "b-secret", "reason": "reversed"}', prompts);

    const result = await captureEntry(ALICE_NOTE, [], "api", env, ctx, undefined, {
      workspaceId: alice.personalWorkspaceId,
      actorId: alice.userId,
    });

    expect(result.status).toBe("stored");
    // The classifier still sees Alice's own capture on this same double; what
    // must never appear is Bob's.
    expect(prompts.join("\n")).not.toContain(BOB_MARKER);
    const { results: tags } = await sqlite.db
      .prepare(`SELECT tags FROM entries WHERE id = 'b-secret'`).all() as { results: { tags: string }[] };
    expect(tags[0].tags).not.toContain("status:deprecated");
    const { results: edges } = await sqlite.db.prepare(`SELECT id FROM edges`).all();
    expect(edges).toEqual([]);
  });

  it("will not act on an id the prompt never offered, even one the vector query returned", async () => {
    // The second consumer of the candidate list: the model's answer is validated
    // against a list of ids, and the write it authorises (captureEntry's merge)
    // is a by-id rewrite. Here the prompt legitimately shows Alice her own row,
    // and the model names Bob's — an id the degraded vector query did return.
    // Validating against the raw Vectorize ids would let that through.
    seed("a-old", alice.personalWorkspaceId, alice.userId, "Alice: the counter-offer is 180");
    seed("b-secret", bob.personalWorkspaceId, bob.userId, BOB_SECRET);
    const prompts: string[] = [];
    env.VECTORIZE = makeVectorizeMock({
      query: vi.fn().mockImplementation(async (_values: number[], opts: any) => {
        if (opts?.filter) throw new Error("VECTORIZE_QUERY_ERROR (code = 40006): unsupported metadata filter");
        return {
          matches: [
            { id: "a-old", score: 0.9, metadata: { parentId: "a-old" } },
            { id: "b-secret", score: 0.88, metadata: { parentId: "b-secret" } },
          ],
        };
      }),
    });
    env.AI = scriptedAI(
      '{"action":"merge","target_id":"b-secret","merged_content":"Merged: the walk-away is 165"}',
      prompts,
    );

    const result = await captureEntry(ALICE_NOTE, [], "api", env, ctx, undefined, {
      workspaceId: alice.personalWorkspaceId,
      actorId: alice.userId,
    });

    expect(vectorizeFilterState().supported).toBe(false);
    // The prompt really was built — Alice's own candidate is in it — so this is
    // the id-validation path and not the empty-rows path already covered above.
    expect(prompts.join("\n")).toContain("Alice: the counter-offer is 180");
    expect(prompts.join("\n")).not.toContain(BOB_MARKER);
    // The named merge was refused, so the capture stored as its own flagged row.
    expect(result.status).toBe("flagged");
    expect(await contentOf("b-secret")).toBe(BOB_SECRET);
    expect(await contentOf("a-old")).toBe("Alice: the counter-offer is 180");
  });
});

describe("the writer's own duplicates are still found, and still merged", () => {
  it("merges a genuine same-workspace duplicate", async () => {
    // A fix that breaks dedupe is worse than the defect, so this is the case
    // that has to keep passing: same workspace, filter working, merge lands.
    seed("a-old", alice.personalWorkspaceId, alice.userId, "Alice: the counter-offer is 180");
    const prompts: string[] = [];
    env.VECTORIZE = filteringVectorize("a-old", alice.personalWorkspaceId);
    env.AI = scriptedAI(
      '{"action":"merge","target_id":"a-old","merged_content":"Alice: the counter-offer is 180 and the walk-away is 165"}',
      prompts,
    );

    const result = await captureEntry(ALICE_NOTE, [], "api", env, ctx, undefined, {
      workspaceId: alice.personalWorkspaceId,
      actorId: alice.userId,
    });

    expect(result).toEqual({ status: "merged", id: "a-old" });
    expect(await contentOf("a-old")).toBe("Alice: the counter-offer is 180 and the walk-away is 165");
    expect(prompts.join("\n")).toContain("Alice: the counter-offer is 180");
  });

  it("merges a duplicate on the company layer the writer shares", async () => {
    // The write target is the workspace that matters, not the member: a capture
    // shared to the company layer dedupes against the company layer.
    const company = (await sqlite.db
      .prepare(`SELECT id FROM workspaces WHERE kind = 'company'`).first()) as { id: string };
    seed("co-old", company.id, bob.userId, "Company: the release freeze starts Monday");
    const prompts: string[] = [];
    env.VECTORIZE = filteringVectorize("co-old", company.id);
    env.AI = scriptedAI(
      '{"action":"merge","target_id":"co-old","merged_content":"Company: the release freeze starts Monday and lifts Friday"}',
      prompts,
    );

    const result = await captureEntry(
      "Company: the release freeze starts Monday", [], "api", env, ctx, undefined,
      { workspaceId: company.id, actorId: alice.userId },
    );

    expect(result).toEqual({ status: "merged", id: "co-old" });
    expect(await contentOf("co-old")).toBe("Company: the release freeze starts Monday and lifts Friday");
  });

  it("is unchanged on a solo brain, where every row is in one workspace", async () => {
    // Byte-identical: the predicate can only narrow, and on a brain with one
    // workspace there is nothing for it to narrow away — even with the filter
    // rejected, which is the arm the new predicate is the only guard on.
    seed("solo-old", alice.personalWorkspaceId, alice.userId, "Solo: the counter-offer is 180");
    const prompts: string[] = [];
    env.VECTORIZE = degradedVectorize("solo-old");
    env.AI = scriptedAI(
      '{"action":"merge","target_id":"solo-old","merged_content":"Solo: the counter-offer is 180 and the walk-away is 165"}',
      prompts,
    );

    const result = await captureEntry(ALICE_NOTE, [], "api", env, ctx, undefined, {
      workspaceId: alice.personalWorkspaceId,
      actorId: alice.userId,
    });

    expect(vectorizeFilterState().supported).toBe(false);
    expect(result).toEqual({ status: "merged", id: "solo-old" });
    expect(await contentOf("solo-old")).toBe("Solo: the counter-offer is 180 and the walk-away is 165");
    expect(prompts.join("\n")).toContain("Solo: the counter-offer is 180");
  });
});
