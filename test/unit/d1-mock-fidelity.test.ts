/**
 * Pins the parts of test/helpers/d1-mock.ts whose whole job is to behave like D1 rather
 * than to be convenient.
 *
 * A test double that filters differently from production does not fail — it passes, and
 * takes the bug with it. Both properties below were added because that happened: the
 * case-sensitive tag comparison hid a rollup bug where the candidate `Kind:Semantic`
 * selected every entry tagged `kind:semantic`, and the pattern decoder was blind to the
 * escaping compressTag now applies. Neither had anything pinning it, so reverting either
 * one broke no test at all.
 *
 * The helper's own comment lists what it deliberately does NOT model. Those axes belong in
 * a real-SQLite test — see test/integration/digest-candidates.test.ts.
 */
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../helpers/make-env";
import { tagLikePattern } from "../../src/memory/tag-sql";

describe("d1-mock LIKE fidelity", () => {
  function seed(tags: string[]) {
    const db = makeTestDb();
    const old = Date.now() - 200 * 24 * 3600 * 1000;
    tags.forEach((tag, i) => db.entries.push({
      id: `e-${i}`, content: `Memory ${i}`, tags: JSON.stringify([tag]), source: "api",
      created_at: old + i, updated_at: old + i, vector_ids: "[]",
      recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0,
    }));
    return db;
  }

  // `SELECT id FROM entries WHERE tags LIKE ?` — the shape compressTag uses to pick sources.
  const select = (db: ReturnType<typeof makeTestDb>, pattern: string) =>
    db.prepare("SELECT id FROM entries WHERE tags LIKE ?").bind(pattern).all();

  it("matches tags case-insensitively, as SQLite's LIKE does", async () => {
    const db = seed(["kind:semantic", "Kind:Semantic", "KIND:SEMANTIC", "unrelated"]);

    const { results } = await select(db, `%"kind:semantic"%`);

    expect((results as { id: string }[]).map(r => r.id)).toEqual(["e-0", "e-1", "e-2"]);
  });

  // compressTag escapes % and _ in the tag and pairs the clause with ESCAPE. A decoder that
  // did not undo that would look for a tag spelled with a backslash and match nothing —
  // silently turning every underscore-tagged fixture into an empty result.
  it("decodes the escaping tagLikePattern applies", async () => {
    const db = seed(["q3_planning", "q3-planning"]);

    const { results } = await select(db, tagLikePattern("q3_planning"));

    expect((results as { id: string }[]).map(r => r.id)).toEqual(["e-0"]);
  });
});
