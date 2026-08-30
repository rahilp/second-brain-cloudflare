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
    // As they actually appear: a JSDoc continuation line inside a block comment.
    // A bare `*` line outside one cannot occur in real source, and treating the
    // backticks in it as a template literal is the correct reading.
    const r = scanSource("/**\n * writes `FROM entries` with a bare template\n */");
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
    // Only the two operators that NARROW to a named set. See the inverse case below.
    for (const sql of [
      "`SELECT id FROM entries WHERE workspace_id IN (?, ?)`",
      "`SELECT id FROM edges WHERE workspace_id = ?`",
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
    // reference it reaches first, so the report names `edges e` and not
    // `entries m` — with the join INNER, where the ON clause is a row filter.
    const withScope = scanSource(
      "const q = `SELECT m.content FROM edges e" +
      " JOIN entries m ON m.id = e.target_id AND m.${scope.clause}" +
      " WHERE e.source_id IN (${ph})`;",
    );
    expect(withScope.violations.map(v => v.unscoped)).toEqual([["edges e"]]);

    // UPDATED by the outer-join rule, and the update is the point: the real
    // /patterns statement writes LEFT JOIN, and in that shape the ON clause
    // nulls a column instead of dropping a row, so `entries m` is no longer
    // satisfied by it. Same clause, same place, different join — see
    // "a scoped table reached by an OUTER join" below.
    const outer = scanSource(
      "const q = `SELECT m.content FROM edges e" +
      " LEFT JOIN entries m ON m.id = e.target_id AND m.${scope.clause}" +
      " WHERE e.source_id IN (${ph})`;",
    );
    expect(outer.violations.map(v => v.unscoped)).toEqual([["edges e", "entries m"]]);

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

/**
 * Round two: what a 38-attack adversarial sweep got past the round-one rules.
 * Same governing rule — a false positive costs thirty seconds, a false negative
 * is a leak with a green tick beside it.
 */
describe("scanSource — inverse and near-miss predicates", () => {
  it("(A) rejects every operator that does not narrow to a named set", () => {
    // `!=` returns precisely everyone ELSE's rows: the tool was green-lighting
    // the exact opposite of what it exists to enforce. `>` is how
    // src/runtime/rotation.ts walks the ring — a real corpus query that passed
    // on this alone. Only `=` and `IN` narrow to a set the caller named.
    for (const op of ["!=", "<>", ">", "<", ">=", "<=", "NOT IN", "LIKE", "IS NOT"]) {
      const rhs = op === "NOT IN" ? "(?, ?)" : "?";
      const sql = `const q = \`SELECT content FROM entries WHERE workspace_id ${op} ${rhs}\`;`;
      expect([op, scanSource(sql).violations.length]).toEqual([op, 1]);
    }
    // BETWEEN takes two bounds and is a range, never a scope.
    expect(scanSource("const q = `SELECT content FROM entries WHERE workspace_id BETWEEN ? AND ?`;")
      .violations.length).toBe(1);
  });

  it("(B1) does not read a scope interpolation out of a SQL comment", () => {
    // stripSqlComments already ran on the literal-workspace_id path and never on
    // the interpolation path, so the round-one test passed while this shipped.
    for (const commented of [
      "`SELECT content FROM entries\n   -- AND ${scope.clause}\n   ORDER BY created_at`",
      "`SELECT content FROM entries /* ${scope.clause} */ ORDER BY created_at`",
    ]) {
      expect([commented, scanSource(`const q = ${commented};`).violations.length])
        .toEqual([commented, 1]);
    }
  });

  it("(B2) does not accept an identifier that merely contains the letters scope", () => {
    for (const name of ["periscopeStart", "unscopedId", "scopeless", "telescope"]) {
      const sql = `const q = \`SELECT content FROM entries WHERE x = \${${name}}\`;`;
      expect([name, scanSource(sql).violations.length]).toEqual([name, 1]);
    }
  });

  it("(B2) still accepts the scope shapes the codebase actually writes", () => {
    for (const expr of [
      "scope.clause", "aScope.clause", "mScope.clause", "scopeSql",
      "nodeScopeSql", "rcScopeSql", "tagScopeSql", "scopeWhere(identity).clause",
    ]) {
      const sql = `const q = \`SELECT content FROM entries WHERE \${${expr}}\`;`;
      expect([expr, scanSource(sql).violations]).toEqual([expr, []]);
    }
  });

  it("(B3) sees a quoted or schema-qualified table name, and counts it", () => {
    // The worst failure shape available: these produced queries=0, so they were
    // neither flagged NOR counted, and the summary line looked healthier for it.
    for (const ref of ['"entries"', "[entries]", "main.entries", 'main."edges"']) {
      const r = scanSource(`const q = \`SELECT content FROM ${ref} ORDER BY created_at\`;`);
      expect([ref, r.queries, r.violations.length]).toEqual([ref, 1, 1]);
    }
    // And they are still satisfiable by a real clause, so this is not a blanket ban.
    expect(scanSource('const q = `SELECT content FROM "entries" WHERE ${scope.clause}`;').violations)
      .toEqual([]);
  });

  it("(B3) fails loudly on a table reference it matched but cannot parse", () => {
    // The rule that makes B3 safe in general rather than for three known
    // spellings: if the file-level sweep saw a reference and the per-statement
    // parse cannot account for it, that is reported, never dropped.
    const r = scanSource('const q = `SELECT content FROM "entries WHERE ${scope.clause}`;');
    expect(r.queries).toBe(1);
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].snippet).toContain("could not");
  });

  it("(B4) rejects every conditional spelling of a scope clause, not just one", () => {
    // Limitation 7 claimed conditional clauses were refused; it caught exactly
    // `: ""` and `: ''`. All of these were passing.
    for (const expr of [
      'scope ? `AND ${scope.clause}` : ``',
      'scope ? `AND ${scope.clause}` : "1=1"',
      '!scope ? "" : `AND ${scope.clause}`',
      'scope?.clause ?? ""',
      'scope && `AND ${scope.clause}`',
      'scope || ""',
    ]) {
      const sql = `const q = \`SELECT content FROM entries WHERE 1=1 \${${expr}}\`;`;
      expect([expr, scanSource(sql).violations.length]).toEqual([expr, 1]);
    }
  });
});

/**
 * Round three. Two classes: references that VANISH (the worst shape available —
 * the summary line gets healthier as the tree gets worse), and a licence
 * mechanism that could be triggered by accident rather than by a human decision.
 */
describe("scanSource — silent drops", () => {
  it("(A1) sees a corpus table inside a nested template inside an interpolation", () => {
    // The natural way anyone writes an \"admin sees everything\" branch, and
    // exactly the conditional shape (B4) exists to catch — but it was erased
    // rather than caught: maskInterpolations skipped nested templates whole, so
    // the second FROM entries never reached the parser, and the file sweep had
    // already keyed this span. queries=1, zero violations.
    const r = scanSource(
      "const q = `SELECT id, content FROM entries WHERE workspace_id = ?" +
      " ${includeAll ? `UNION ALL SELECT id, content FROM entries` : \"\"}" +
      " ORDER BY created_at`;",
    );
    expect(r.queries).toBe(1);
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].snippet).toMatch(/nested template|could not/i);
  });

  it("(A1) a hidden table can be licensed by a human, like every other category", () => {
    // The escape hatch is deliberate. Making this one category unannotatable
    // would leave no way past it but deleting the query, and the reason
    // requirement is what does the work everywhere else in this file.
    const r = scanSource([
      "// scope-exempt: the UNION arm is admin-only and returns counts",
      "const q = `SELECT id FROM entries WHERE workspace_id = ?" +
      " ${includeAll ? `UNION ALL SELECT id FROM entries` : \"\"}`;",
    ].join("\n"));
    expect(r.violations).toEqual([]);
    expect(r.exceptions.length).toBe(1);
  });

  it("(A1) still passes an interpolation with no corpus table in it", () => {
    // The guard must fire on a hidden table, not on every nested template.
    const r = scanSource(
      "const q = `SELECT id FROM entries WHERE workspace_id = ?" +
      " ${extra ? `AND tags LIKE ?` : \"\"}`;",
    );
    expect(r.violations).toEqual([]);
  });

  it("(A2) sees a quoted schema qualifier, in every spelling", () => {
    // B3 covered main.entries and main.\"edges\"; these three still gave
    // queries=0 with nothing reported, which is the same defect B3 was raised for.
    for (const ref of ['"main"."entries"', "[main].[entries]", '"main".entries']) {
      const r = scanSource(`const q = \`SELECT content FROM ${ref} ORDER BY created_at\`;`);
      expect([ref, r.queries, r.violations.length]).toEqual([ref, 1, 1]);
    }
    // And still satisfiable, so this is not a blanket ban on qualified names.
    expect(scanSource('const q = `SELECT content FROM "main"."entries" WHERE ${scope.clause}`;')
      .violations).toEqual([]);
  });
});

describe("scanSource — a licence must be a human decision", () => {
  it("(A3) refuses a marker with no reason", () => {
    const r = scanSource([
      "// scope-exempt:",
      "const q = `SELECT * FROM entries`;",
    ].join("\n"));
    expect(r.exceptions).toEqual([]);
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].snippet).toMatch(/no reason/i);
  });

  it("(A4) is not licensed by the marker text appearing in a string or a doc comment", () => {
    // A raw .includes() meant a test fixture, an error message or a JSDoc line
    // mentioning the marker granted a real licence to the next query below it.
    for (const line of [
      'const ERR = "use scope-exempt: to document";',
      "/** see scope-exempt: docs */",
      "const help = `write scope-exempt: above the query`;",
      "// TODO: we should add scope-exempt: here one day",
    ]) {
      const r = scanSource([line, "const q = `SELECT * FROM entries`;"].join("\n"));
      expect([line, r.violations.length, r.exceptions.length]).toEqual([line, 1, 0]);
    }
  });

  it("(A4) still accepts a marker that opens a real comment", () => {
    for (const line of [
      "// scope-exempt: by-id, gated at the route",
      "  //   scope-exempt: by-id, gated at the route",
      " * scope-exempt: by-id, gated at the route",
    ]) {
      const r = scanSource([line, "const q = `SELECT * FROM entries`;"].join("\n"));
      expect([line, r.violations, r.exceptions.length]).toEqual([line, [], 1]);
    }
  });
});

describe("scanSource — interpolations must be in predicate position too", () => {
  it("(A6) rejects a scope clause that is projected, ordered or limited by", () => {
    for (const sql of [
      "`SELECT ${scope.clause} AS x FROM entries`",
      "`SELECT id FROM entries ORDER BY ${nodeScopeSql}`",
      "`SELECT id FROM entries LIMIT ${scope}`",
      "`SELECT DISTINCT ${scope.clause} FROM entries`",
    ]) {
      expect([sql, scanSource(`const q = ${sql};`).violations.length]).toEqual([sql, 1]);
    }
  });

  it("(A6) still accepts every predicate position the codebase writes", () => {
    for (const sql of [
      "`SELECT id FROM entries WHERE ${scope.clause}`",
      "`SELECT id FROM entries WHERE tags LIKE ? AND ${scope.clause}`",
      "`SELECT id FROM entries a WHERE x = 1 AND a.${scope.clause}`",
      "`SELECT id FROM entries WHERE (${scope.clause})`",
    ]) {
      expect([sql, scanSource(`const q = ${sql};`).violations]).toEqual([sql, []]);
    }
  });

  it("(A6) rejects a fragment appended after a bound parameter or a closing paren", () => {
    // These two ARE scoped in src/recall/search.ts — their leading AND is inside
    // the JS fragment, where nothing here can see it. Round three accepted them
    // on trust, using a blocklist; that blocklist turned out to be evadable
    // eleven ways, so the allowlist replaced it and these are the price. They
    // carry `// scope-checked:` in the tree, which is the marker for precisely
    // "this IS scoped, the lexer just cannot see it".
    for (const sql of [
      "`SELECT id FROM entries WHERE tags LIKE ? ${tagScopeSql}`",
      "`SELECT id FROM entries WHERE id IN (${ph})${rcScopeSql}`",
    ]) {
      expect([sql, scanSource(`const q = ${sql};`).violations.length]).toEqual([sql, 1]);
    }
  });

  it("(A6) rejects a clause that narrows an aggregate rather than the row set", () => {
    // `SUM(CASE WHEN ${scope.clause} …) FROM entries` reads the whole corpus and
    // scopes the NUMBER. Round three counted it as a scope clause; it is not one,
    // and GET /stats does this deliberately, so it is annotated in the tree.
    const r = scanSource("const q = `SELECT SUM(CASE WHEN ${scope.clause} THEN 1 ELSE 0 END) FROM entries`;");
    expect(r.violations.length).toBe(1);
  });
});

/**
 * Round four. The blocklist of round three fired only when one of its tokens was
 * the LAST thing before `${`, so one character of punctuation walked through it.
 * These are the eleven shapes that did, plus the regression set that must keep
 * passing under the allowlist that replaced it.
 */
describe("scanSource — interpolation predicate position, by allowlist", () => {
  const REJECTED = {
    "parenthesised projection": "SELECT id, content, (${entryScope}) AS in_scope FROM entries ORDER BY created_at",
    "coalesce": "SELECT COALESCE(${entryScope}, 0) FROM entries",
    "case when": "SELECT CASE WHEN ${entryScope} THEN 1 END FROM entries",
    "concatenation": "SELECT 'x' || ${entryScope} FROM entries",
    "arithmetic": "SELECT 1 + ${entryScope} FROM entries",
    "order by case": "SELECT id FROM entries ORDER BY CASE WHEN ${entryScope} THEN 1 END",
    "limit paren": "SELECT id FROM entries LIMIT (${entryScope})",
    "offset arithmetic": "SELECT id FROM entries LIMIT 1 OFFSET 0 + ${entryScope}",
    "group by paren": "SELECT id FROM entries GROUP BY (${entryScope})",
    "returning": "DELETE FROM entries RETURNING ${entryScope}",
    "values": "INSERT INTO entries VALUES (${entryScope}) FROM entries",
  };

  for (const [name, sql] of Object.entries(REJECTED)) {
    it(`rejects a clause rendered into a ${name}`, () => {
      expect(scanSource(`const q = \`${sql}\`;`).violations.length).toBe(1);
    });
  }

  it("still accepts every predicate position that is real", () => {
    for (const sql of [
      "`SELECT id FROM entries WHERE ${scope.clause}`",
      "`SELECT id FROM entries GROUP BY tags HAVING ${entryScope}`",
      "`SELECT id FROM edges e JOIN entries a ON a.id = e.source_id AND ${aScope} AND ${eScope}`",
      '`SELECT id FROM entries WHERE ${scopeWhere("e")}`',
      "`SELECT id FROM entries WHERE tags LIKE ? AND ${scope.clause}`",
      "`SELECT id FROM entries a WHERE x = 1 AND a.${scope.clause}`",
      "`SELECT id FROM entries WHERE (${scope.clause})`",
      "`SELECT id FROM entries WHERE ((${scope.clause}))`",
      // Earlier fragments blank to spaces, so the last real token is still WHERE.
      "`SELECT id FROM entries WHERE ${tokenWhere}${timeWhere}${scopeSql}`",
    ]) {
      expect([sql, scanSource(`const q = ${sql};`).violations]).toEqual([sql, []]);
    }
  });
});

describe("scanSource — negation is not scoping", () => {
  it("rejects a clause the statement negates", () => {
    // Round three restricted operators to = and IN under the heading "stop
    // accepting the inverse of a scope clause". NOT sat in the predicate-keyword
    // allowlist, which reopened exactly that class one token to the left:
    // `WHERE NOT workspace_id IN (...)` returns precisely everyone else's rows.
    //
    // Round four then added an assertion that this SHOULD pass. That is worse
    // than the hole: a green test asserting a false negative tells the next
    // reader the behaviour was considered and wanted. It has been deleted and
    // replaced by this.
    for (const sql of [
      "`SELECT id FROM entries WHERE NOT ${scope.clause}`",
      "`SELECT id FROM entries WHERE NOT(${scope.clause})`",
      "`SELECT id FROM entries WHERE x = 1 AND NOT ${scope.clause}`",
      "`SELECT id FROM entries WHERE NOT workspace_id = ?`",
      "`SELECT id FROM entries WHERE NOT workspace_id IN (?, ?)`",
    ]) {
      expect([sql, scanSource(`const q = ${sql};`).violations.length]).toEqual([sql, 1]);
    }
  });

  it("still accepts a NOT that applies to something else in the statement", () => {
    // The rule is about the token immediately left of the clause, not about the
    // word appearing anywhere in the statement.
    const sql = "`SELECT id FROM entries WHERE NOT (tags LIKE ?) AND ${scope.clause}`";
    expect([sql, scanSource(`const q = ${sql};`).violations]).toEqual([sql, []]);
  });
});

describe("scanSource — a reference must never be dropped", () => {
  it("(A2) sees a SPACED schema qualifier, even beside a scoped sibling", () => {
    // The exact statement from the review. Standalone this survived on the
    // total===0 guard; with a parseable sibling it was silently dropped —
    // queries=1, violations=[], exceptions=[] — which is the failure shape this
    // whole line of work exists to eliminate.
    const r = scanSource(
      "const q = `SELECT a.id FROM entries a WHERE a.workspace_id = ?" +
      " UNION ALL SELECT b.id FROM main . entries b`;",
    );
    expect(r.queries).toBe(1);
    expect(r.violations.length).toBe(1);
    expect(r.exceptions).toEqual([]);
  });

  it("(A2) sees every spaced qualifier spelling", () => {
    for (const ref of ["main . entries b", '"main" . "entries" b', "[main] . [entries] b"]) {
      const r = scanSource(`const q = \`SELECT b.id FROM ${ref}\`;`);
      expect([ref, r.queries, r.violations.length]).toEqual([ref, 1, 1]);
    }
  });

  it("sees a table on a line that ordinary SQL wrapping began with an asterisk", () => {
    // The comment skip exists for JSDoc continuation lines and is right there.
    // Applied inside a template it ate ordinary formatting: this is one of the
    // most common ways anyone wraps a SELECT, and it reported queries=0 —
    // matched by the sweep, then dropped, which is the vanishing shape.
    const r = scanSource("const q = `SELECT\n  * FROM entries`;");
    expect([r.queries, r.violations.length]).toEqual([1, 1]);
  });

  it("sees a table on a line inside a template that begins with a slash-slash", () => {
    // The reference must sit ON the slash-slash line, or the skip is not exercised.
    const r = scanSource("const q = `SELECT id\n  // FROM entries\n  WHERE 1=1`;");
    expect([r.queries, r.violations.length]).toEqual([1, 1]);
  });

  it("still treats a real JSDoc line as prose", () => {
    // src/lib/scope.ts:6 and src/tags/vocabulary.ts:4 describe the rule in these
    // words. A checker that trips on its own documentation is one people switch off.
    expect(scanSource("/**\n * writes `FROM entries` with a bare template\n */").queries).toBe(0);
    expect(scanSource("// a query that says `FROM edges` and means it").queries).toBe(0);
  });

  it("(A2) sees a multi-part dotted name", () => {
    // Found by attacking the round-four build rather than by the review: both the
    // file sweep and the token normaliser allowed exactly ONE qualifier, so
    // `a . b . entries` matched nothing at all and reported queries=0 — the same
    // disappearance, one dot further along.
    const r = scanSource("const q = `SELECT x.id FROM a . b . entries x`;");
    expect([r.queries, r.violations.length]).toEqual([1, 1]);
  });

  it("reports when the parser accounts for fewer references than the sweep found", () => {
    // The structural backstop behind both A2 fixes: rather than patching one
    // spelling at a time, the two counts are compared, and a shortfall is
    // reported. Any future shape that slips past the token grammar lands here
    // instead of vanishing.
    const r = scanSource("const q = `SELECT id FROM entries WHERE ${scope.clause} UNION SELECT id FROM \"main\" . entries`;");
    expect(r.violations.length).toBe(1);
  });
});

describe("scanSource — annotations inside a template are not annotations", () => {
  it("(A4) refuses a licence written on a line inside a template literal", () => {
    // annotationOn is per-line and had no idea it was inside a span, so SQL or
    // fixture text carrying a line that starts with // granted a real licence.
    const r = scanSource([
      "const sample = `",
      "// scope-exempt: this is documentation, not a decision",
      "`;",
      "const q = `SELECT * FROM entries`;",
    ].join("\n"));
    expect(r.exceptions).toEqual([]);
    expect(r.violations.length).toBe(1);
  });

  it("(A4) still accepts a real comment directly above the query", () => {
    const r = scanSource([
      "// scope-exempt: by-id, gated at the route",
      "const q = `SELECT * FROM entries`;",
    ].join("\n"));
    expect(r.violations).toEqual([]);
    expect(r.exceptions.length).toBe(1);
  });
});

describe("scanSource — documented limitations, pinned so the header cannot drift", () => {
  it("limitation 3: does not parse boolean structure, so `OR 1=1` defeats a real clause", () => {
    // Asserted as CURRENT BEHAVIOUR, not as desired behaviour. The clause is
    // present and unconditional; seeing that an OR at the same level undoes it
    // needs a SQL parser. The header says so in exactly these terms, and this
    // test is what keeps the sentence and the code honest with each other. If
    // someone teaches the checker boolean structure, this test goes red and the
    // header limitation gets deleted in the same commit.
    const r = scanSource("const q = `SELECT content FROM entries WHERE ${scope.clause} OR 1=1`;");
    expect(r.violations).toEqual([]);
  });

  it("limitation 2 + item 4: a conditional hoisted one line up is not caught", () => {
    // Asserted as CURRENT BEHAVIOUR. The rejection in item 4 is a test on the
    // text between ${ and }, so moving the ternary into a const defeats it —
    // the interpolation is then a bare scope-shaped identifier. Pinned because
    // the header now says this in as many words, and the sentence and the code
    // must go red together if either changes.
    const r = scanSource([
      'const scopeSql = isAdmin ? "1=1" : scope.clause;',
      "const q = `SELECT content FROM entries WHERE ${scopeSql}`;",
    ].join("\n"));
    expect(r.violations).toEqual([]);
  });

  it("limitation 1: what remains invisible is a split THROUGH an identifier", () => {
    // The two concatenation shapes worth writing by accident — a dangling
    // `FROM "` and an interpolated table name — are now reported (see
    // "table names the lexer cannot follow" above). This is what is left: a
    // split that falls INSIDE the table's identifier, so there is no FROM/JOIN
    // adjacent to a concatenation boundary to notice. Pinned as CURRENT
    // BEHAVIOUR so the header's narrowed claim and the code go red together.
    const r = scanSource('const q = "SELECT id FROM ent" + "ries WHERE 1=1";');
    expect([r.queries, r.violations]).toEqual([0, []]);
  });
});

describe("scanSource — scope-checked, for clauses the lexer cannot see", () => {
  it("counts a scope-checked marker separately from an exemption", () => {
    // src/recall/search.ts and src/recall/distill.ts ARE scoped; the clause is
    // assembled in JavaScript. Filing them as permanent licences made the
    // exemption count overstate how much of src/ is deliberately unscoped.
    const r = scanSource([
      "// scope-checked: the caller's clause is inside d1Filters, built above",
      "const a = `SELECT * FROM entries WHERE id IN (${ph})${d1Filters}`;",
      "// scope-exempt: by-id, gated at the route",
      "const b = `SELECT * FROM entries WHERE id = ?`;",
    ].join("\n"));
    expect(r.violations).toEqual([]);
    expect(r.exceptions.map(e => [e.kind, e.line])).toEqual([["checked", 2], ["exempt", 4]]);
  });

  it("reports the aliases the machine found unscoped alongside the human reason", () => {
    // So the sentence and the machine's own alias list sit side by side and any
    // drift between them is visible without re-deriving it.
    //
    // UPDATED by the outer-join rule. This is src/routes/admin.ts's /patterns
    // source hydration, and it is a LEFT JOIN: the marker is now
    // `scope-outer-join:` (scope-exempt no longer answers this finding) and the
    // derived list names BOTH aliases, because the ON clause stopped counting
    // for `m`. The property under test is unchanged — the machine's list, next
    // to the human's sentence.
    const r = scanSource([
      "// scope-outer-join: e is pinned by id; m contributes only a column, which nulls",
      "const q = `SELECT m.content FROM edges e LEFT JOIN entries m ON m.id = e.target_id AND m.${scope.clause}`;",
    ].join("\n"));
    expect(r.exceptions.length).toBe(1);
    expect(r.exceptions[0].unscoped).toEqual(["edges e", "entries m"]);
  });
});

describe("scanSource — table names the lexer cannot follow", () => {
  // Both of these were SILENT evasions: not flagged and not counted, because
  // neither text ever contains the token `FROM entries`. A checker whose
  // summary line gets healthier as the tree gets worse is the one outcome this
  // script exists to prevent, so the rule is that an unfollowable table name
  // fails loudly and is answered with an annotation like any other exception.
  it("fails a FROM whose table name is an interpolation", () => {
    const r = scanSource("const q = `SELECT id, content FROM ${TBL} ORDER BY created_at`;");
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].snippet).toContain("the table name is an interpolation");
    expect(r.queries).toBe(1);
  });

  it("fails a FROM split across a string concatenation", () => {
    const r = scanSource('const q = "SELECT id, content FROM " + "entries ORDER BY created_at";');
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].snippet).toContain("split across a string concatenation");
    expect(r.queries).toBe(1);
  });

  it("counts and licenses an unfollowable table name when a reason is written", () => {
    // The whole pipeline, not just the detection: a construct that genuinely
    // cannot be parsed must be answerable the same way every other one is.
    const r = scanSource([
      "// scope-exempt: table name chosen from a fixed allowlist, rows pinned by id",
      "const q = `SELECT id FROM ${TBL} WHERE id = ?`;",
    ].join("\n"));
    expect(r.violations).toEqual([]);
    expect(r.exceptions.length).toBe(1);
    expect(r.exceptions[0].kind).toBe("exempt");
    expect(r.queries).toBe(1);
  });

  // The gate that keeps this on by default. Both strings below are real in
  // src/ (integrations/mirror.ts, compression/digest.ts) and neither is SQL;
  // flagging them would have made the whole check unusable.
  it("does not read English prose containing the word 'from' as a query", () => {
    const prose = scanSource(
      "const msg = `This memory is synced from ${name}. Edit it in ${name} instead.`;",
    );
    expect(prose.violations).toEqual([]);
    expect(prose.queries).toBe(0);

    const other = scanSource('const label = "imported from " + source;');
    expect(other.violations).toEqual([]);
    expect(other.queries).toBe(0);
  });

  it("does not trip on this checker's own prose about the constructs", () => {
    const r = scanSource([
      "// A FROM ${TBL} is not something this can follow.",
      '// Nor is "SELECT x FROM " + "entries".',
      "const q = `SELECT id FROM entries WHERE ${scope.clause}`;",
    ].join("\n"));
    expect(r.violations).toEqual([]);
    expect(r.queries).toBe(1);
  });
});

describe("scanSource — a scoped table reached by an OUTER join", () => {
  // THE PROVEN HOLE, and the reason this whole describe exists.
  //
  // Phase 4 shipped GET /team/activity with the statement below, and
  // `check:scope` passed it BEFORE the fix and AFTER it — the tool had no
  // opinion either way, because its entire question was "is there a scope
  // clause attributed to alias m", and there was one.
  //
  // `entry_events` carries no workspace column. With a LEFT JOIN, the ON clause
  // decides which row supplies a TITLE, not which rows appear: every event row
  // survives, and an unmatched one arrives with `title` NULL and `entryId` and
  // `detail.workspaceId` fully populated. An admin of company X read company
  // Y's rows that way. A row hidden in one column and disclosed in another is
  // not scoped, so a scope predicate that can only null a column is not a scope
  // predicate.
  const LEAK =
    "const q = `SELECT 'entry', ev.id, ev.event, ev.actor_id, ev.entry_id," +
    " substr(m.content, 1, 160), ev.payload, ev.created_at" +
    " FROM entry_events ev" +
    " LEFT JOIN entries m ON m.id = ev.entry_id AND m.${scope.clause}" +
    " WHERE ev.event IN ('shared', 'unshared')" +
    " ORDER BY created_at DESC LIMIT ? OFFSET ?`;";

  it("flags the /team/activity leak the clause-presence test called satisfied", () => {
    const r = scanSource(LEAK);
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].snippet).toContain("outer join");
    expect(r.violations[0].unscoped).toEqual(["entries m"]);
    // Still one query, so the summary line moves for the right reason: this is
    // a verdict changing, not a reference appearing.
    expect(r.queries).toBe(1);
  });

  it("flags the fix's own shape only when the join is outer", () => {
    // The one-word fix that closed the leak. The ON clause of an INNER join IS
    // a row filter — it is the same predicate in the same place, and the join
    // type is the whole difference — so this must stay green or the rule is a
    // ban on ON clauses rather than a rule about outer joins.
    const r = scanSource(LEAK.replace("LEFT JOIN", "JOIN"));
    expect(r.violations).toEqual([]);
    expect(r.queries).toBe(1);
  });

  it("reads every spelling of an outer join, whitespace and all", () => {
    // Each of these renders the same plan. A rule that matched the literal
    // string "LEFT JOIN" would pass four of the five.
    const spellings = [
      "LEFT JOIN",
      "left  join",
      "LEFT OUTER JOIN",
      "left\n     outer\n     join",
      "LEFT\nJOIN",
      "RIGHT JOIN",
      "RIGHT OUTER JOIN",
      "FULL OUTER JOIN",
      "full join",
    ];
    for (const spelling of spellings) {
      const r = scanSource(LEAK.replace("LEFT JOIN", spelling));
      expect(r.violations.length, `not flagged: ${JSON.stringify(spelling)}`).toBe(1);
      expect(r.violations[0].snippet, spelling).toContain("outer join");
    }
  });

  it("does not read the words in a SQL comment as a join", () => {
    // The mirror of the clause-in-a-comment evasion the checker already closes,
    // pointed the other way: prose cannot MANUFACTURE an outer join any more
    // than it can manufacture a scope clause.
    const r = scanSource(
      "const q = `SELECT m.content FROM entry_events ev" +
      " -- was a LEFT JOIN until Phase 4; see the note above the route\n" +
      " JOIN entries m ON m.id = ev.entry_id AND m.${scope.clause}`;",
    );
    expect(r.violations).toEqual([]);
  });

  it("does not read the words in a SQL string literal as a join", () => {
    // `LEFT JOIN` inside a quoted literal is data. Reading it as structure
    // would flag a correct query; NOT blanking literals would also let a
    // literal containing `WHERE` truncate the ON clause and hide a real outer
    // join, which is the dangerous direction — so literals are blanked for this
    // rule and both cases are pinned here.
    // The literal sits BEFORE the join, inside the window the rule reads for
    // LEFT/RIGHT/FULL — putting it after the ON would prove nothing.
    const inner = scanSource(
      "const q = `SELECT 'LEFT JOIN' AS note, m.content FROM entry_events ev" +
      " JOIN entries m ON m.id = ev.entry_id AND m.${scope.clause}`;",
    );
    expect(inner.violations).toEqual([]);

    const outer = scanSource(
      "const q = `SELECT m.content FROM entry_events ev" +
      " LEFT JOIN entries m ON m.id = ev.entry_id AND ev.note != 'WHERE'" +
      " AND m.${scope.clause}`;",
    );
    expect(outer.violations.length).toBe(1);
    expect(outer.violations[0].snippet).toContain("outer join");
  });

  it("does not fire on an alias that merely shares a corpus table's name", () => {
    // `entries` here is an ALIAS for `users`, on the outer join, carrying a
    // workspace_id predicate in its ON clause. The corpus table in the
    // statement is scoped in the WHERE and is not reached by the outer join at
    // all, so there is nothing to flag.
    const r = scanSource(
      "const q = `SELECT e.id FROM entries e" +
      " LEFT JOIN users entries ON entries.id = e.actor_id AND entries.workspace_id = ?" +
      " WHERE e.${scope.clause}`;",
    );
    expect(r.violations).toEqual([]);
  });

  it("does not flag a LEFT JOIN whose scope predicate is ALSO in the WHERE", () => {
    // The genuinely safe shape, and the one a rule that banned outer joins
    // outright would get wrong. A predicate on the null-producing side in the
    // WHERE discards the unmatched rows (`NULL IN (...)` is never true), so the
    // scope clause governs the row set after all.
    const both = scanSource(
      "const q = `SELECT m.content FROM entry_events ev" +
      " LEFT JOIN entries m ON m.id = ev.entry_id AND m.${scope.clause}" +
      " WHERE m.${scope.clause}`;",
    );
    expect(both.violations).toEqual([]);

    // And with the clause ONLY in the WHERE, which is the same guarantee
    // spelled once.
    const whereOnly = scanSource(
      "const q = `SELECT m.content FROM entry_events ev" +
      " LEFT JOIN entries m ON m.id = ev.entry_id" +
      " WHERE m.workspace_id IN (?, ?)`;",
    );
    expect(whereOnly.violations).toEqual([]);
  });

  it("flags the half-scoped case: one alias in the WHERE, one only in the ON", () => {
    const r = scanSource(
      "const q = `SELECT a.content, b.content FROM entries a" +
      " LEFT JOIN entries b ON b.id = a.parent_id AND b.${scope.clause}" +
      " WHERE a.${scope.clause}`;",
    );
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].unscoped).toEqual(["entries b"]);
  });

  it("keeps the ON clause of an inner join in a statement that also outer-joins", () => {
    // Two joins, one of each. Only the outer one's ON is discounted, and only
    // for the table it reaches — the rule is per ON clause, not per statement.
    const r = scanSource(
      "const q = `SELECT e.id FROM entries e" +
      " JOIN edges g ON g.source_id = e.id AND g.${scope.clause}" +
      " LEFT JOIN users u ON u.id = e.actor_id" +
      " WHERE e.${scope.clause}`;",
    );
    expect(r.violations).toEqual([]);
  });

  it("treats an interpolated join keyword as undecidable rather than as inner", () => {
    // Commit 81e5fc6's precedent: what the lexer cannot follow FAILS, it does
    // not default to safe. `${joinKind}` may render LEFT, and a guard that
    // silently reads an unparseable construct as fine is the failure mode that
    // produced the leak this rule closes.
    const before = scanSource(
      "const q = `SELECT m.content FROM entry_events ev ${joinKind}" +
      " JOIN entries m ON m.id = ev.entry_id AND m.${scope.clause}`;",
    );
    expect(before.violations.length).toBe(1);
    expect(before.violations[0].snippet).toContain("cannot be read");

    const inside = scanSource(
      "const q = `SELECT m.content FROM entry_events ev LEFT ${maybeOuter}" +
      " JOIN entries m ON m.id = ev.entry_id AND m.${scope.clause}`;",
    );
    expect(inside.violations.length).toBe(1);
  });

  it("treats a join onto a subquery as undecidable", () => {
    const r = scanSource(
      "const q = `SELECT m.content FROM entry_events ev" +
      " JOIN (SELECT id, content FROM entries WHERE ${scope.clause}) m" +
      " ON m.id = ev.entry_id`;",
    );
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].snippet).toContain("cannot be read");
  });

  it("treats a subquery inside an ON clause as undecidable", () => {
    const r = scanSource(
      "const q = `SELECT m.content FROM entry_events ev" +
      " JOIN entries m ON m.id = (SELECT entry_id FROM entry_events WHERE id = ev.id)" +
      " AND m.${scope.clause}`;",
    );
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].snippet).toContain("cannot be read");
  });

  it("is not licensed by `scope-exempt:`, which answers a different question", () => {
    // scope-exempt says "this query is not scoped and that is correct".
    // scope-checked says "it is scoped where you cannot see". Neither answers
    // the outer-join question, which is "why is nulling a column enough here?"
    // — and 49 scope-exempt annotations already exist in this tree, so letting
    // that word cover this finding would have made the rule a no-op at the one
    // real site that has the shape.
    for (const marker of ["scope-exempt", "scope-checked"]) {
      const r = scanSource([`// ${marker}: the id came from a scoped read`, LEAK].join("\n"));
      expect(r.violations.length, marker).toBe(1);
      expect(r.violations[0].snippet, marker).toContain("outer join");
    }
  });

  it("is licensed by `scope-outer-join:` with a reason, and counted apart", () => {
    const r = scanSource([
      "// scope-outer-join: the preserved side is pinned by id to the scoped page above, so an unreadable memory nulls the content column and reads exactly like a deleted one",
      LEAK,
    ].join("\n"));
    expect(r.violations).toEqual([]);
    expect(r.exceptions.map(e => e.kind)).toEqual(["outer-join"]);
    expect(r.exceptions[0].unscoped).toEqual(["entries m"]);
  });

  it("refuses `scope-outer-join:` with no reason, exactly as the other markers do", () => {
    const r = scanSource(["// scope-outer-join:", LEAK].join("\n"));
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].snippet).toContain("has no reason after it");
    expect(r.exceptions).toEqual([]);
  });

  it("still reports a sweep-versus-parser shortfall, ahead of this verdict", () => {
    // The structural backstop, re-asserted here because this rule adds a second
    // reason a predicate can leave the pool and the two must never be confused:
    // a DISCOUNTED PREDICATE must not turn into a DISCOUNTED REFERENCE. The
    // table token here is unparseable, so the sweep sees a reference the parser
    // does not, and that shortfall outranks the outer join — a reference nobody
    // can attribute is the worse of the two findings.
    const r = scanSource(
      "const q = `SELECT x.id FROM entry_events ev" +
      " LEFT JOIN 'entries' x ON x.id = ev.entry_id AND x.${scope.clause}`;",
    );
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].snippet).toContain("the sweep found and the parser did not");
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

  // THE COUNTS ARE PINNED, and that is the point of this test rather than a
  // sanity check.
  //
  // Two evasions were found in this checker whose defining property was that
  // the SUMMARY DID NOT MOVE — a query slipped through and the line CI prints
  // said exactly what it said the day before. Nothing in the repo asserted
  // those numbers, so the only thing standing between a silent evasion and a
  // green build was a human noticing that a three-digit total had not changed.
  //
  // Pinning them turns every movement into a deliberate edit. A legitimate
  // change WILL fail this: when it does, read the new numbers, satisfy yourself
  // that each one moved for a reason you can name, and update them here in the
  // same commit as the change that moved them.
  // MOVED 88 -> 89 by Phase 4 Task 2. GET /team/activity is the one statement
  // in that phase that references `entries`: its second UNION arm joins the
  // table so a share event is emitted only for a memory the caller may read,
  // `JOIN entries m ON m.id = ev.entry_id AND m.${scope.clause}` — the caller's
  // own scope, carried in the ON clause. The checker read the whole compound as
  // ONE query, so this is +1 and not +2 — recorded as the tool printed it, with
  // the SQL left in the shape the paging correctness needs rather than reshaped
  // for the lexer. Exceptions stay 49 and scope-checked stays 7: nothing was
  // exempted.
  //
  // The later change from LEFT JOIN to JOIN — which is what made that predicate
  // govern the ROW SET rather than only the title — moved NONE of the three
  // numbers, since the checker's unit is the query and its verdict was already
  // "satisfied". Re-run and confirmed at 89/49/7. That silence is what the
  // outer-join rule was written to end, and adding it moved two of the numbers:
  //
  //   queries        89 -> 89, UNCHANGED. The rule changes a VERDICT, not what
  //                  counts as a query: no statement is newly seen or newly
  //                  dropped, and holding this number still while the others
  //                  move is itself the evidence that nothing vanished.
  //   exempt         49 -> 48. src/routes/admin.ts's /patterns source hydration
  //                  is the ONE statement in src/ with the shape — `FROM edges e
  //                  LEFT JOIN entries m ON ... AND m.${mScope.clause}` — and it
  //                  carried a scope-exempt licence written for its OTHER alias.
  //                  scope-exempt no longer answers an outer-join finding, so
  //                  that annotation became a scope-outer-join one whose reason
  //                  now has to say why nulling m.content is enough. -1 here,
  //                  +1 below: a licence moved between kinds, none was added.
  //   scope-checked  7 -> 7, UNCHANGED. Nothing about a clause assembled in
  //                  JavaScript changed.
  //   outer-join     0 -> 1, the new fourth count. One statement in src/, named
  //                  above. GET /team/activity is NOT among them: its join is
  //                  INNER, so its ON clause is a row filter and it passes on
  //                  the merits — which is the whole point of pinning it.
  //
  // MOVED 48 -> 47 by the per-company novelty floor in src/insight/weekly.ts.
  // That query's workspace predicate used to be an interpolated `${floorSliceClause}`
  // — invisible to the lexer, so it needed a `scope-exempt:` licence. Narrowing
  // the floor to the drawn candidates' own workspaces put a LITERAL
  // `workspace_id IN (?, …)` in the source, which the checker is satisfied by on
  // the merits, and the licence became one nothing used. It was removed rather
  // than left in place: a dead licence is a sentence a future reader would trust.
  //
  //   queries        89 -> 89, UNCHANGED. One prepare() was replaced by one
  //                  prepare(); nothing was newly seen or newly dropped, and
  //                  holding this still while exempt moves is the evidence of it.
  //   exempt         48 -> 47, the licence named above, removed and not moved.
  //   scope-checked  7 -> 7, UNCHANGED. Nothing about a clause assembled in
  //                  JavaScript changed — the clause stopped being assembled in
  //                  JavaScript, which is why it landed in neither bucket.
  //   outer-join     1 -> 1, UNCHANGED. The floor's read is a bare FROM.
  //
  // The SQL was NOT reshaped to please the lexer: the predicate is literal
  // because the workspace list is now bounded by WEEKLY_CANDIDATE_LIMIT rather
  // than by the slice, which is the fix, and the lexer's opinion of it followed.
  //
  // As the tool printed it:
  //   ✔ scope check: 90 queries, 47 documented exceptions, 7 scope-checked
  //     (clause assembled in JS), 1 scope-outer-join (clause governs a column,
  //     not the row set)
  it("reports exactly 90 queries, 47 exceptions, 7 scope-checked and 1 outer-join", () => {
    const run = spawnSync("node", [resolve(ROOT, "scripts/check-scope.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    const m = run.stdout.match(
      /scope check: (\d+) queries, (\d+) documented exceptions, (\d+) scope-checked[^,]*, (\d+) scope-outer-join/,
    );
    expect(m, `summary line not found in:\n${run.stdout}`).not.toBeNull();
    const [queries, exempt, checked, outerJoin] = (m as RegExpMatchArray).slice(1).map(Number);
    expect(
      { queries, exempt, checked, outerJoin },
      "check:scope counts moved. If that was deliberate, say so out loud and " +
        "update this expectation in the same commit.",
    ).toEqual({ queries: 90, exempt: 47, checked: 7, outerJoin: 1 });
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
