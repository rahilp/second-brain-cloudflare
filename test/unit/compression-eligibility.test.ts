import { describe, it, expect } from "vitest";
import { compressionEligibilitySql, COMPRESSION_MIN_RECALL } from "../../src/index";

describe("compressionEligibilitySql", () => {
  it("includes the importance, recall+age, and contradiction-win clauses", () => {
    const sql = compressionEligibilitySql();
    expect(sql).toContain("importance_score < 4");
    expect(sql).toContain(`recall_count < ${COMPRESSION_MIN_RECALL}`);
    expect(sql).toContain("recall_count = 0");
    expect(sql).toContain("contradiction_wins");
    expect(sql).toContain("created_at < ?");
  });

  it("contains exactly one bind placeholder (the age cutoff)", () => {
    expect(compressionEligibilitySql().match(/\?/g)?.length).toBe(1);
  });

  it("applies a column prefix to every column when given one", () => {
    const sql = compressionEligibilitySql("entries.");
    expect(sql).toContain("entries.importance_score");
    expect(sql).toContain("entries.recall_count");
    expect(sql).toContain("entries.contradiction_wins");
    expect(sql).toContain("entries.created_at < ?");
    for (const col of ["importance_score", "recall_count", "created_at", "contradiction_wins"]) {
      expect(sql).not.toMatch(new RegExp(`(^|[^.])\\b${col}\\b`));
    }
  });

  it("defaults to no prefix", () => {
    const sql = compressionEligibilitySql();
    expect(sql).not.toContain("entries.");
  });
});
