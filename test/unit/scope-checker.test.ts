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
