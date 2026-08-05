/**
 * The digest-candidate query, run for real.
 *
 * Its correctness IS the SQL: which tags come back decides which tags get compressed, and
 * a nightly run only compresses COMPRESSION_MAX_TAGS_PER_RUN of them. `test/helpers/d1-mock.ts`
 * cannot evaluate SQL — its digest-candidate branch calls isTopicTag(), the TypeScript half
 * of the rule — so a WHERE clause that drifted from that predicate would pass every
 * mock-based test in the suite. This runs the clause itself against real SQLite.
 *
 * The WHERE fragments are imported rather than retyped, so this exercises the same strings
 * src/compression/nightly.ts and src/routes/admin.ts embed.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  compressionEligibilitySql,
  isTopicTag,
  isTopicTagSql,
  COMPRESSION_MIN_AGE_MS,
} from "../../src/compression/eligibility";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { tagLikePattern, TAG_LIKE_ESCAPE } from "../../src/memory/tag-sql";

let sqlite: SqliteD1 | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

async function candidateTags(seed: (s: SqliteD1) => void): Promise<string[]> {
  sqlite = makeSqliteD1();
  seed(sqlite);
  const { results } = await sqlite.db.prepare(`
    SELECT value as tag, COUNT(*) as count
    FROM entries, json_each(entries.tags)
    WHERE ${isTopicTagSql()}
      AND entries.tags NOT LIKE '%"rolled-up"%'
      AND entries.tags NOT LIKE '%"synthesized"%'
      AND entries.tags NOT LIKE '%"auto-pattern"%'
      AND ${compressionEligibilitySql("entries.")}
    GROUP BY value
    HAVING count > 10
    ORDER BY count DESC
  `).bind(Date.now() - COMPRESSION_MIN_AGE_MS).all();
  return (results as { tag: string }[]).map(r => r.tag);
}

describe("digest-candidate query", () => {
  it("excludes the tags the system writes, and keeps the ones the user does", async () => {
    const tags = await candidateTags(s => {
      // Eleven entries carrying a real topic plus every reserved namespace, exactly as an
      // entry looks after classification and a staleness pass have both run over it.
      for (let i = 0; i < 11; i++) {
        s.seed({
          id: `e-${i}`, content: `memory ${i}`, createdAt: 1,
          tags: ["work", "kind:semantic", "status:canonical", "volatility:state", "stale:as-of"],
        });
      }
    });

    expect(tags).toEqual(["work"]);
  });

  it("does not let a bulk-written system tag outrank a real topic", async () => {
    const tags = await candidateTags(s => {
      // Distinct counts, so ORDER BY fully determines the order — SQLite does not promise
      // anything about ties, and the assertion below is about position.
      for (let i = 0; i < 12; i++) s.seed({ id: `a-${i}`, content: "m", createdAt: 1, tags: ["work"] });
      for (let i = 0; i < 11; i++) s.seed({ id: `b-${i}`, content: "m", createdAt: 1, tags: ["family"] });
      // The staleness pass tags in bulk, so its tags carry the higher count.
      for (let i = 0; i < 25; i++) {
        s.seed({ id: `c-${i}`, content: "m", createdAt: 1, tags: ["volatility:state", "stale:as-of"] });
      }
    });

    // Ordered by count DESC, so a failure here is the system tags sitting at the head of
    // the list and taking the slots real topics would have had.
    expect(tags).toEqual(["work", "family"]);
  });

  // A mixed-case reserved tag must never become a candidate. If one does, compressTag
  // selects its sources with `tags LIKE '%"Kind:Semantic"%'` — LIKE ignores ASCII case — so
  // it rolls up every entry carrying `kind:semantic`, which is most of the table. Nothing
  // lowercases the tags src/integrations/mirror.ts inserts, so this is reachable.
  //
  // Only the tag-value predicate is under test. Mixed-case forms of the bookkeeping tags
  // (`SYNTHESIZED`, `Rolled-Up`) are deliberately absent from this fixture: the surrounding
  // row-level filters are `entries.tags NOT LIKE '%"synthesized"%'`, which already ignores
  // case, so such a row is dropped whole before any tag value is considered.
  it("reserves the namespace whatever its case", async () => {
    const reserved = ["Status:Active", "Kind:Personal", "Volatility:High", "Stale:As-Of"];
    const tags = await candidateTags(s => {
      for (let i = 0; i < 11; i++) {
        s.seed({ id: `e-${i}`, content: "m", createdAt: 1, tags: ["holiday-plans", ...reserved] });
      }
    });

    expect(tags).toEqual(["holiday-plans"]);
    for (const tag of reserved) expect(isTopicTag(tag)).toBe(false);
  });

  it("reserves the namespace rather than the bare word", async () => {
    const tags = await candidateTags(s => {
      for (let i = 0; i < 11; i++) {
        s.seed({ id: `e-${i}`, content: "m", createdAt: 1, tags: ["volatility", "stale", "status", "kind"] });
      }
    });

    expect(tags.sort()).toEqual(["kind", "stale", "status", "volatility"]);
  });
});

/**
 * The other half of compressTag: once a tag is chosen, this is the query that decides which
 * entries get rolled up. Its correctness is also the SQL, and for a reason the D1 mock
 * structurally cannot reach — the mock compares decoded tag strings, so LIKE wildcards in
 * the tag itself simply do not exist there. Every row this selects has its content appended
 * to and is marked `rolled-up`, permanently, so selecting one row too many is data loss.
 */
describe("compressTag source selector", () => {
  async function selected(tag: string): Promise<string[]> {
    sqlite = makeSqliteD1();
    // 11 entries on the tag being compressed, 9 on a near-miss neighbour that differs only
    // where a LIKE wildcard would paper over the difference.
    for (let i = 0; i < 11; i++) sqlite.seed({ id: `own-${i}`, content: "m", createdAt: 1, tags: ["q3_planning"] });
    for (let i = 0; i < 9; i++) sqlite.seed({ id: `other-${i}`, content: "m", createdAt: 1, tags: ["q3-planning"] });
    // The clause from src/compression/digest.ts, built from the same exported pieces.
    const { results } = await sqlite.db.prepare(
      `SELECT id FROM entries WHERE tags LIKE ? ${TAG_LIKE_ESCAPE} ORDER BY id`,
    ).bind(tagLikePattern(tag)).all();
    return (results as { id: string }[]).map(r => r.id);
  }

  // `#q3_planning` is the ordinary multi-word hashtag convention and src/text/hashtags.ts
  // matches \w, so underscore tags arrive without anyone doing anything unusual. Unescaped,
  // `_` is a single-character wildcard and this also rolls up every `q3-planning` entry.
  it("does not match a neighbouring tag through an underscore wildcard", async () => {
    const ids = await selected("q3_planning");
    expect(ids).toHaveLength(11);
    expect(ids.every(id => id.startsWith("own-"))).toBe(true);
  });

  // Reachable through the API's tags[] array and the integrations mirror, neither of which
  // constrains the characters in a tag. Unescaped this selects the entire table.
  it("does not match everything through a percent wildcard", async () => {
    expect(await selected("%")).toEqual([]);
    expect(await selected("%planning%")).toEqual([]);
  });

  it("still matches the ordinary tag it is given", async () => {
    expect(await selected("q3-planning")).toHaveLength(9);
    expect(await selected("q3_planning")).toHaveLength(11);
  });
});
