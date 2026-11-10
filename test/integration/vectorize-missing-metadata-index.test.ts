/**
 * A Vectorize index without a workspace_id metadata index answers the scoped
 * query with zero matches, not an error (#394). Capture's neighbor checks must
 * still find the caller's own memories, and the marker /health reads must trip.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeMemoryKV } from "../helpers/make-env";
import { ExactVectorize } from "../eval/vectorize-emulator";
import { checkDuplicateAndContradiction } from "../../src/capture/duplicate";
import { storeEntry } from "../../src/capture/store";
import { resetVectorizeFilterState, vectorizeFilterState } from "../../src/vectorize/scope";
import { DEFAULTS } from "../../src/config";
import { VECTORIZE_WORKSPACE_FILTER_UNSUPPORTED_KV_KEY } from "../../src/constants";
import type { Env } from "../../src/env";

const DIMS = 256;

function bow(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / n);
}

function makeEnv(indexedProperties: string[]) {
  const d1 = makeSqliteD1();
  d1.db.prepare(`ALTER TABLE entries ADD COLUMN valid_from INTEGER`).run();
  d1.db.prepare(`ALTER TABLE entries ADD COLUMN valid_until INTEGER`).run();
  const kv = makeMemoryKV();
  const env = {
    DB: d1.db, OAUTH_KV: kv, VECTORIZE: new ExactVectorize({ dimensions: DIMS, indexedProperties }) as unknown as VectorizeIndex,
    AI: { run: vi.fn(async (_m: string, input: { text: string[] }) => ({ data: input.text.map(bow) })) },
    VECTORIZE_GRACE_MS: "0",
  } as unknown as Env;
  return { env, kv, d1 };
}

const NOTE = "The quarterly budget review moved to Thursday afternoon in the north meeting room";
const ctx = { waitUntil: (p: Promise<unknown>) => { void p; } };

async function seedStored(env: Env, d1: ReturnType<typeof makeEnv>["d1"], id: string, content: string, workspaceId: string) {
  d1.seed({ id, content, createdAt: 1 });
  // storeEntry commits vector_ids only onto a row in the write context's workspace.
  d1.db.prepare(`UPDATE entries SET workspace_id = ? WHERE id = ?`).bind(workspaceId, id).run();
  await storeEntry(env, id, content, [], "api", 1, undefined, { workspaceId, actorId: "u1" });
}

describe("capture against an index with no workspace_id metadata index", () => {
  beforeEach(() => resetVectorizeFilterState());

  for (const [label, indexed] of [["missing", []], ["present", ["workspace_id"]]] as const) {
    it(`finds the caller's own near-duplicate when the index is ${label}`, async () => {
      const { env, kv, d1 } = makeEnv([...indexed]);
      vi.spyOn(console, "error").mockImplementation(() => {});
      await seedStored(env, d1, "budget", NOTE, "ws-p");
      const r = await checkDuplicateAndContradiction(NOTE, env, DEFAULTS, "ws-p", ctx, { skipModelCall: true });
      expect(r.neighbors.map(n => n.id)).toContain("budget");
      expect(r.duplicate).toMatchObject({ status: "blocked", matchId: "budget" });
      const marker = await kv.get(VECTORIZE_WORKSPACE_FILTER_UNSUPPORTED_KV_KEY);
      if (label === "missing") {
        expect(vectorizeFilterState().supported).toBe(false);
        expect(marker).not.toBeNull();
      } else {
        expect(vectorizeFilterState().supported).toBe(true);
        expect(marker).toBeNull();
      }
      vi.mocked(console.error).mockRestore();
    });
  }

  // Unfiltered matches can name another member's memory; only rows the writer can read may decide.
  it("never blocks or flags a capture against another workspace's memory", async () => {
    const { env, d1 } = makeEnv([]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await seedStored(env, d1, "colleague-private", NOTE, "ws-other");
    await seedStored(env, d1, "mine", "Packing list for the lake trip: tent, stove, two headlamps", "ws-p");
    const r = await checkDuplicateAndContradiction(NOTE, env, DEFAULTS, "ws-p", ctx, { skipModelCall: true });
    expect(vectorizeFilterState().supported).toBe(false);
    expect(r.duplicate).toEqual({ status: "unique" });
    expect(JSON.stringify(r.duplicate)).not.toContain("colleague-private");
    vi.mocked(console.error).mockRestore();
  });

  it("keeps the caller's own near-duplicate when other workspaces fill the nearest slots", async () => {
    const { env, d1 } = makeEnv([]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 5; i++) await seedStored(env, d1, `foreign-${i}`, NOTE, "ws-other");
    await seedStored(env, d1, "mine", `${NOTE} today`, "ws-p");
    const r = await checkDuplicateAndContradiction(NOTE, env, DEFAULTS, "ws-p", ctx, { skipModelCall: true });
    expect(vectorizeFilterState().supported).toBe(false);
    expect(r.duplicate).toMatchObject({ matchId: "mine" });
    // Edge inference gets only rows the writer can read, so no slot goes to a foreign pair.
    expect(r.neighbors.map(n => n.id)).toEqual(["mine"]);
    vi.mocked(console.error).mockRestore();
  });

  it("offers edge inference no neighbor whose row is gone", async () => {
    const { env, d1 } = makeEnv(["workspace_id"]);
    await seedStored(env, d1, "deleted", NOTE, "ws-p");
    await seedStored(env, d1, "mine", `${NOTE} today`, "ws-p");
    // A deleted memory's vector can outlive its row.
    d1.db.prepare(`DELETE FROM entries WHERE id = ?`).bind("deleted").run();
    const r = await checkDuplicateAndContradiction(NOTE, env, DEFAULTS, "ws-p", ctx, { skipModelCall: true });
    expect(r.neighbors.map(n => n.id)).toEqual(["mine"]);
    expect(r.duplicate).toMatchObject({ matchId: "mine" });
  });
});
