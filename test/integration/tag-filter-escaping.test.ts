/**
 * Tag filters, run for real.
 *
 * A tag is user data and it goes into a LIKE pattern, where `_` matches any character and
 * `%` matches everything. `#q3_planning` is the ordinary multi-word hashtag convention and
 * src/text/hashtags.ts matches \w, so underscore tags arrive without anyone doing anything
 * unusual; the API's tags[] array and the integrations mirror accept any string at all.
 *
 * These are read paths, so the failure is over-broad results rather than the permanent
 * rollup the same bug caused in compressTag — a `#q3_planning` filter also returning
 * `q3-planning` entries is wrong but recoverable. `?tag=%` is the sharper one: the filter
 * silently stops filtering and returns the whole brain, which looks like a valid answer.
 *
 * test/helpers/d1-mock.ts cannot cover any of this — it compares decoded tag strings, so
 * LIKE wildcards in the tag do not exist there. That is stated on the helper itself.
 */
import { describe, it, expect, afterEach } from "vitest";
import { buildEntryFilterQuery } from "../../src/capture/entry";
import { recallEntries } from "../../src/recall/search";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestDb, makeTestEnv } from "../helpers/make-env";
import { tagLikePattern, TAG_LIKE_ESCAPE } from "../../src/memory/tag-sql";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

let sqlite: SqliteD1 | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

/** Eleven entries on an underscore tag, nine on the neighbour a `_` wildcard would reach. */
function seeded(): SqliteD1 {
  const s = makeSqliteD1();
  for (let i = 0; i < 11; i++) s.seed({ id: `own-${i}`, content: `m${i}`, createdAt: 1000 + i, tags: ["q3_planning"] });
  for (let i = 0; i < 9; i++) s.seed({ id: `other-${i}`, content: `m${i}`, createdAt: 2000 + i, tags: ["q3-planning"] });
  return s;
}

describe("GET /entries and /list tag filter", () => {
  // buildEntryFilterQuery is the real builder both routes use, so this exercises the
  // shipped SQL and bindings rather than a copy of them.
  async function ids(tag: string): Promise<string[]> {
    sqlite = seeded();
    const { sql, bindings } = buildEntryFilterQuery({ n: 100, tag });
    const { results } = await sqlite.db.prepare(sql).bind(...bindings).all();
    return (results as { id: string }[]).map(r => r.id).sort();
  }

  it("does not reach a neighbouring tag through an underscore wildcard", async () => {
    const matched = await ids("q3_planning");
    expect(matched).toHaveLength(11);
    expect(matched.every(id => id.startsWith("own-"))).toBe(true);
  });

  it("does not return everything for a percent tag", async () => {
    expect(await ids("%")).toEqual([]);
    expect(await ids("%planning%")).toEqual([]);
  });

  it("still returns exactly the entries carrying the tag it was given", async () => {
    expect(await ids("q3-planning")).toHaveLength(9);
    expect(await ids("q3_planning")).toHaveLength(11);
  });
});

describe("tag-scoped recall candidate query", () => {
  /**
   * Two halves, because neither alone is worth much. This half captures the statement
   * recallEntries actually issues and checks it carries an escaped pattern and the ESCAPE
   * clause; the half below proves that combination behaves correctly in SQLite. Asserting
   * only the second would pass against a recallEntries that never adopted the helpers —
   * it did, when this test was first written that way.
   */
  it("issues an escaped pattern and an ESCAPE clause", async () => {
    const db = makeTestDb();
    db.entries.push({
      id: "e-0", content: "m", tags: JSON.stringify(["q3_planning"]), source: "api",
      created_at: 1, updated_at: 1, vector_ids: JSON.stringify(["v-0"]),
      recall_count: 0, importance_score: 0, contradiction_wins: 0, contradiction_losses: 0,
    });
    const prepared: string[] = [];
    const bound: unknown[][] = [];
    const DB = {
      prepare(sql: string) {
        const flat = sql.replace(/\s+/g, " ").trim();
        prepared.push(flat);
        const stmt = db.prepare(sql);
        return {
          ...stmt,
          bind: (...args: unknown[]) => { if (flat.includes("tags LIKE ?")) bound.push(args); return stmt.bind(...args); },
        };
      },
      exec: (sql: string) => db.exec(sql),
      batch: (stmts: any[]) => db.batch(stmts),
    } as unknown as D1Database;
    const env = makeTestEnv(db, { DB });

    await recallEntries({ query: "planning", topK: 5, tag: "q3_planning" }, env, ctx);

    const tagQuery = prepared.find(s => s.includes("FROM entries WHERE tags LIKE ?"));
    expect(tagQuery).toBeDefined();
    expect(tagQuery).toContain("ESCAPE");
    expect(bound[0]?.[0]).toBe(tagLikePattern("q3_planning"));
    expect(bound[0]?.[0]).not.toBe(`%"q3_planning"%`); // the unescaped form
  });

  // The clause from src/recall/search.ts, built from the same exported pieces it uses.
  async function ids(tag: string): Promise<string[]> {
    sqlite = seeded();
    const { results } = await sqlite.db.prepare(
      `SELECT id, vector_ids, content, tags, source, created_at FROM entries WHERE tags LIKE ? ${TAG_LIKE_ESCAPE}`,
    ).bind(tagLikePattern(tag)).all();
    return (results as { id: string }[]).map(r => r.id).sort();
  }

  it("scopes recall to the tag it was given, wildcards and all", async () => {
    expect((await ids("q3_planning")).every(id => id.startsWith("own-"))).toBe(true);
    expect(await ids("%")).toEqual([]);
    expect(await ids("q3-planning")).toHaveLength(9);
  });
});
