/**
 * The house rule in `src/lib/scope.ts` — "no unscoped corpus-wide query" — was
 * enforced by review and by the isolation suite alone, and both let three
 * queries through (see the commit that scoped GET /insights/dry-run and GET
 * /stats). `scripts/check-scope.mjs` is the mechanical half. This file is the
 * checker's own test: a checker that silently matches nothing would pass CI
 * forever while enforcing nothing at all.
 *
 * There is no ESLint in this repo, so the checker is a plain Node script and
 * these cases drive its exported `scanSource` directly, plus one that runs the
 * real CLI over the real `src/`.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanSource } from "../../scripts/check-scope.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("scanSource", () => {
  it("passes a query that composes the caller's scope clause", () => {
    const r = scanSource("const q = `SELECT id FROM entries WHERE ${scope.clause} LIMIT 5`;");
    expect(r.violations).toEqual([]);
    expect(r.queries).toBe(1);
  });

  it("passes a query that names workspace_id itself", () => {
    const r = scanSource("const q = `SELECT * FROM edges WHERE workspace_id IN (?, ?)`;");
    expect(r.violations).toEqual([]);
    expect(r.queries).toBe(1);
  });

  it("fails a bare corpus-wide read", () => {
    const r = scanSource("const q = `SELECT * FROM entries`;");
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].line).toBe(1);
    expect(r.violations[0].snippet).toContain("FROM entries");
    expect(r.exceptions).toEqual([]);
  });

  it("passes a documented exception and reports its reason", () => {
    const r = scanSource([
      "// scope-exempt: by-id lookup, the id came from a scoped read",
      "const q = `SELECT * FROM entries`;",
    ].join("\n"));
    expect(r.violations).toEqual([]);
    expect(r.exceptions.length).toBe(1);
    expect(r.exceptions[0].reason).toBe("by-id lookup, the id came from a scoped read");
  });

  it("accepts the annotation up to five lines above the query", () => {
    const above = (n: number) => scanSource([
      "// scope-exempt: still in range",
      ...Array.from({ length: n }, () => "// filler"),
      "const q = `SELECT * FROM entries`;",
    ].join("\n"));
    expect(above(4).violations).toEqual([]);
    // Six lines up is out of range: an annotation that far from its query is no
    // longer plainly about it.
    expect(above(5).violations.length).toBe(1);
  });

  it("skips prose in a doc comment rather than reading it as SQL", () => {
    // src/lib/scope.ts:6 and src/tags/vocabulary.ts:4 both describe the rule in
    // exactly these words. A checker that trips on its own documentation is one
    // people switch off.
    const r = scanSource(" * writes `FROM entries` with a bare template");
    expect(r.violations).toEqual([]);
    expect(r.queries).toBe(0);

    const slashes = scanSource("// a query that says `FROM edges` and means it");
    expect(slashes.violations).toEqual([]);
    expect(slashes.queries).toBe(0);
  });

  it("fails a table reached only through JOIN", () => {
    // The case a FROM-only checker misses, and it is not hypothetical: GET
    // /insights/dry-run reached `entries` this way and returned two of a
    // colleague's private memories for it.
    const r = scanSource(
      "const q = `SELECT c.id FROM insight_candidates c JOIN entries a ON a.id = c.a_id`;",
    );
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].snippet).toContain("JOIN entries");
  });

  it("reads the scope clause from the outermost template, past a nested one", () => {
    // `${cond ? `x` : `y`}` puts backticks between the scope clause and the
    // table name. Taking the nearest backtick before the match would start the
    // span after the scope clause and report a false positive.
    const r = scanSource(
      "const q = `SELECT ${flag ? `a.id` : `b.id`} FROM entries WHERE ${scope.clause}`;",
    );
    expect(r.violations).toEqual([]);
    expect(r.queries).toBe(1);
  });

  it("does not read a quote inside a regex literal as the start of a string", () => {
    // Found by this checker's first run disagreeing with grep. src/capture/store.ts
    // contains `/[."]/` inside a `${...}`; reading that `\"` as a string opener
    // swallowed the rest of the file into one enormous span, and because some
    // other query in that span said workspace_id, two genuinely unscoped by-id
    // lookups passed. The failure mode of a mis-lex is a false PASS, which is
    // the worst kind for a checker.
    const r = scanSource([
      'const key = `tag_${t.replace(/[."]/g, "_")}`;',
      "const q = `SELECT * FROM entries`;",
    ].join("\n"));
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].line).toBe(2);
  });

  it("reports a file whose template literals it cannot read, rather than skipping it", () => {
    const r = scanSource("const q = `SELECT * FROM entries WHERE ${scope.clause}");
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].snippet).toContain("could not read");
  });

  it("counts one query per template, not one per table mentioned", () => {
    const r = scanSource("const q = `SELECT * FROM entries JOIN edges ON edges.source_id = entries.id`;");
    expect(r.queries).toBe(1);
    expect(r.violations.length).toBe(1);
  });
});

/**
 * Evasions, in the reviewer's priority order. Every case here is a query that a
 * reader would call unscoped and that an earlier draft of this checker passed.
 *
 * The governing rule is that a FALSE POSITIVE costs someone thirty seconds
 * writing an annotation, and a FALSE NEGATIVE is a leak with a green tick beside
 * it. Where the lexer cannot decide, these expect it to fail loudly.
 */
describe("scanSource — evasions", () => {
  it("(a) does not accept workspace_id in the SELECT list as a scope clause", () => {
    // The confirmed false pass: a projected column is not a predicate. This query
    // has no WHERE at all.
    const r = scanSource(
      "const q = `SELECT id, content, workspace_id FROM entries ORDER BY created_at LIMIT ?`;",
    );
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].snippet).toContain("FROM entries");
  });

  it("(a) still accepts workspace_id when it is actually a predicate", () => {
    for (const sql of [
      "`SELECT id FROM entries WHERE workspace_id IN (?, ?)`",
      "`SELECT id FROM edges WHERE workspace_id = ?`",
      "`SELECT DISTINCT workspace_id FROM entries WHERE workspace_id > ?`",
      "`SELECT id FROM entries e WHERE e.workspace_id IN (?, ?)`",
    ]) {
      expect([sql, scanSource(`const q = ${sql};`).violations]).toEqual([sql, []]);
    }
  });

  it("(b) fails a two-alias join with one alias left unscoped", () => {
    // Exactly the /insights/dry-run leak with one alias dropped — the single
    // highest-value regression this checker exists to catch.
    const r = scanSource(
      "const q = `SELECT a.content, b.content FROM insight_candidates c" +
      " JOIN entries a ON a.id = c.a_id JOIN entries b ON b.id = c.b_id" +
      " WHERE ${aScope.clause}`;",
    );
    expect(r.violations.length).toBe(1);
  });

  it("(b) passes the same join once both aliases are scoped", () => {
    const r = scanSource(
      "const q = `SELECT a.content, b.content FROM insight_candidates c" +
      " JOIN entries a ON a.id = c.a_id JOIN entries b ON b.id = c.b_id" +
      " WHERE ${aScope.clause} AND ${bScope.clause}`;",
    );
    expect(r.violations).toEqual([]);
  });

  it("(b) does not let two clauses on the SAME alias cover a second one", () => {
    // Counting predicates is not enough: both of these name `a`, so `b` is still
    // unscoped even though there are as many clauses as tables.
    const r = scanSource(
      "const q = `SELECT a.content FROM entries a JOIN entries b ON b.id = a.parent" +
      " WHERE a.${scope.clause} AND a.${otherScope.clause}`;",
    );
    expect(r.violations.length).toBe(1);
  });

  it("(b) names the alias that is actually missing a clause", () => {
    // The GET /patterns shape (finding 1): the edges alias is pinned by id, the
    // entries alias is what returns content. An alias-prefixed clause is
    // attributed to its own alias rather than counted against whichever table
    // reference it reaches first, so the report names `edges e` and not `entries m`.
    const withScope = scanSource(
      "const q = `SELECT m.content FROM edges e" +
      " LEFT JOIN entries m ON m.id = e.target_id AND m.${scope.clause}" +
      " WHERE e.source_id IN (${ph})`;",
    );
    expect(withScope.violations.map(v => v.unscoped)).toEqual([["edges e"]]);

    // And without it, both are reported — this is the query as it shipped.
    const without = scanSource(
      "const q = `SELECT m.content FROM edges e" +
      " LEFT JOIN entries m ON m.id = e.target_id" +
      " WHERE e.source_id IN (${ph})`;",
    );
    expect(without.violations.map(v => v.unscoped)).toEqual([["edges e", "entries m"]]);
  });

  it("(c) fails a hard-coded foreign workspace literal", () => {
    const r = scanSource("const q = `SELECT content FROM entries WHERE workspace_id = 'ws-bob'`;");
    expect(r.violations.length).toBe(1);
    // A literal is not derived from the caller's identity, so it is never a scope
    // clause however it is spelled.
    expect(scanSource("const q = `SELECT content FROM entries WHERE workspace_id IN ('ws-bob', 'ws-eve')`;")
      .violations.length).toBe(1);
  });

  it("(d) does not let one annotation cover two adjacent queries", () => {
    const r = scanSource([
      "// scope-exempt: by-id, the id came from a scoped read",
      "const a = `SELECT * FROM entries WHERE id = ?`;",
      "const b = `SELECT * FROM entries`;",
    ].join("\n"));
    expect(r.exceptions.length).toBe(1);
    expect(r.exceptions[0].line).toBe(2);
    // The second query inherited nothing.
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].line).toBe(3);
  });

  it("(d) binds each annotation to its own query when both are annotated", () => {
    const r = scanSource([
      "// scope-exempt: first reason",
      "const a = `SELECT * FROM entries WHERE id = ?`;",
      "// scope-exempt: second reason",
      "const b = `SELECT * FROM edges WHERE id = ?`;",
    ].join("\n"));
    expect(r.violations).toEqual([]);
    expect(r.exceptions.map(e => e.reason)).toEqual(["first reason", "second reason"]);
  });

  it("does not read the word scope out of a SQL comment", () => {
    const r = scanSource([
      "const q = `SELECT content FROM entries",
      "   -- TODO think about scope here",
      "   ORDER BY created_at`;",
    ].join("\n"));
    expect(r.violations.length).toBe(1);
  });
});

describe("the checker over the real source tree", () => {
  it("exits 0, so a future unscoped query fails the suite as well as CI", () => {
    const run = spawnSync("node", [resolve(ROOT, "scripts/check-scope.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect([run.status, run.stdout, run.stderr]).toEqual([0, expect.any(String), ""]);
    expect(run.stdout).toContain("scope check:");
  });

  it("is wired into package.json and CI, or nothing runs it", () => {
    const pkg = JSON.parse(
      spawnSync("cat", [resolve(ROOT, "package.json")], { encoding: "utf8" }).stdout,
    );
    expect(pkg.scripts["check:scope"]).toBe("node scripts/check-scope.mjs");
    const ci = spawnSync("cat", [resolve(ROOT, ".github/workflows/ci.yml")], { encoding: "utf8" }).stdout;
    expect(ci).toContain("npm run check:scope");
  });
});
