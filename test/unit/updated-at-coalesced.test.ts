/**
 * entries.updated_at nullability guard.
 *
 * The column is added by a runtime ALTER (src/db/init.ts) and is deliberately never
 * backfilled, so every row that predates the staleness feature reads NULL forever. That
 * is safe only while every reader coalesces it to created_at — a reader that stops is
 * not a type error and not a test failure anywhere else, it just silently misbehaves on
 * old memories. `ORDER BY updated_at DESC` is the sharp edge: SQLite sorts NULL first,
 * so descending order puts every never-updated row last, behind rows from 1970.
 *
 * So this classifies every occurrence of the column by its syntactic position rather
 * than pattern-matching whole statements — a substring allow-list exempts the entire
 * literal, which lets a raw read ride along inside an otherwise-legitimate write.
 *
 * Scope is src/. The dashboard (public/js/) reads updated_at only from API responses,
 * which are already coalesced server-side by the rules enforced here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

// Every source extension that could hold a query, not just .ts — a .js/.mjs helper under
// src/ would otherwise be skipped silently.
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"];

function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allSourceFiles(p));
    else if (SOURCE_EXTENSIONS.some(ext => entry.name.endsWith(ext))) out.push(p);
  }
  return out;
}

/**
 * The single literal permitted to select the column bare, because the TypeScript that
 * consumes its rows coalesces at the boundary (`?? row.created_at`). Scoped to this one
 * statement: exempting the whole file would wave through the next query added to it.
 */
const HYDRATION_EXEMPTION = {
  file: "src/recall/search.ts",
  marker: "SELECT id, content, tags, source, created_at, updated_at FROM entries WHERE id IN",
};

type Finding = { kind: string; detail: string };

/**
 * Comments, stripped before anything else looks for backticks. Prose that mentions a
 * column in markdown backticks is otherwise indistinguishable from a SQL template
 * literal, and got reported as a schema violation. Real SQL never lives inside a
 * comment, so this removes false positives without narrowing what the guard catches.
 * Doing it before the backtick scan also stops a stray pair inside a comment from
 * pairing across the comment boundary and swallowing real code.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

/** SQL string literals in a source file, normalised to one line. */
function sqlLiterals(source: string): string[] {
  return [...stripComments(source).matchAll(/`([^`]*)`/g)]
    .map(m => m[1].replace(/\s+/g, " ").trim())
    .filter(s => /\bupdated_at\b/.test(s));
}

function spans(sql: string, re: RegExp): [number, number][] {
  return [...sql.matchAll(re)].map(m => [m.index!, m.index! + m[0].length] as [number, number]);
}
const inAny = (i: number, ranges: [number, number][]) => ranges.some(([a, b]) => i >= a && i < b);

/**
 * Classifies each `updated_at` occurrence in one SQL literal and returns the raw reads.
 * A raw read is any occurrence that is not a declaration, not an INSERT column-list
 * target, not a SET assignment target, and not wrapped in COALESCE(updated_at, created_at).
 */
function rawSqlReads(sql: string, relPath: string): Finding[] {
  // Only `edges` statements are exempt by table — that column is declared NOT NULL, so it
  // can never be NULL. A fragment naming NO table is NOT exempt: `ORDER BY updated_at
  // DESC` assigned to a constant and interpolated into a query elsewhere is the single
  // most likely way this bug gets reintroduced, and it names no table at all.
  if (/\bedges\b/.test(sql) && !/\bentries\b/.test(sql)) return [];

  const declarations = spans(sql, /ADD\s+COLUMN\s+updated_at/gi);
  // COALESCE or the equivalent IFNULL, with or without a table qualifier — a JOIN forces
  // qualified names, and rejecting them would block correct code.
  const coalesced = spans(
    sql,
    /(?:COALESCE|IFNULL)\s*\(\s*(?:\w+\s*\.\s*)?updated_at\s*,\s*(?:\w+\s*\.\s*)?created_at\s*\)/gi,
  );
  // The parenthesised column list of an INSERT — names the target, never reads a value.
  const insertColumns = spans(sql, /INSERT(?:\s+OR\s+\w+)?\s+INTO\s+entries\s*\([^)]*\)/gi);
  // The SET clause of an UPDATE, up to WHERE. Assignment targets live here; the WHERE
  // that follows does not, which is what makes `SET updated_at = ? WHERE updated_at < ?`
  // resolve to one write and one raw read rather than being exempted wholesale.
  const setClauses = spans(sql, /\bSET\b[\s\S]*?(?=\bWHERE\b|$)/gi);

  const findings: Finding[] = [];
  for (const m of sql.matchAll(/\bupdated_at\b/g)) {
    const i = m.index!;
    if (inAny(i, declarations) || inAny(i, coalesced) || inAny(i, insertColumns)) continue;
    // In a SET clause and followed by `=` — an assignment target.
    if (inAny(i, setClauses) && /^\s*=/.test(sql.slice(i + "updated_at".length))) continue;
    if (relPath.replace(/\\/g, "/") === HYDRATION_EXEMPTION.file && sql.includes(HYDRATION_EXEMPTION.marker)) continue;

    const at = sql.slice(Math.max(0, i - 45), i + 45);
    const clause = /\bORDER\s+BY\b/i.test(sql.slice(0, i)) ? "ORDER BY"
      : /\bWHERE\b/i.test(sql.slice(0, i)) ? "WHERE"
        : "projection";
    findings.push({ kind: `raw read in ${clause}`, detail: `…${at}…` });
  }
  return findings;
}

/**
 * TypeScript reads of a raw D1 row column: `row.updated_at`, `row["updated_at"]`, and
 * `{ updated_at }` destructuring. Object-literal keys (`updated_at: value`) are writes
 * into a response shape, not reads, so they are excluded. SQL literals and comments are
 * stripped first so column references inside them are not double-counted here.
 */
function rawTsReads(source: string): { text: string; coalesced: boolean }[] {
  const code = stripComments(source).replace(/`[^`]*`/g, "");

  const out: { text: string; coalesced: boolean }[] = [];
  for (const m of code.matchAll(/\bupdated_at\b/g)) {
    const at = m.index! + "updated_at".length;
    const after = code.slice(at);
    if (/^\s*\??:/.test(after)) continue; // object-literal key or property declaration, not a read
    // The fallback has to be attached to THIS read. A created_at mention anywhere on the
    // line is not enough: an adjacent field in the same object literal, or a sort
    // tiebreaker, satisfies that while coalescing nothing. Require `?? … created_at`
    // close by — and specifically `??`, since `||` is not null-coalescing.
    const coalesced = /^[\s\S]{0,80}?\?\?[\s\S]{0,60}?created_at/.test(after);
    out.push({ text: code.slice(Math.max(0, m.index! - 60), at + 60).replace(/\s+/g, " ").trim(), coalesced });
  }
  return out;
}

describe("entries.updated_at is never read without a created_at fallback", () => {
  const files = allSourceFiles(resolve(ROOT, "src"));

  it("no SQL in src/ reads entries.updated_at outside COALESCE", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      for (const sql of sqlLiterals(readFileSync(file, "utf8"))) {
        for (const f of rawSqlReads(sql, rel)) offenders.push(`${rel} — ${f.kind}: ${f.detail}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every TypeScript read of a raw updated_at column falls back to created_at", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const read of rawTsReads(readFileSync(file, "utf8"))) {
        if (read.coalesced) continue;
        offenders.push(`${relative(ROOT, file)} — uncoalesced read: ${read.text.slice(0, 110)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("initializeDatabase never reads or writes entries.updated_at", () => {
    // The column is migrated by ALTER alone — no backfill, no probe. Anything else here
    // runs on every cold isolate against an unindexed column.
    const init = readFileSync(resolve(ROOT, "src/db/init.ts"), "utf8");
    for (const sql of sqlLiterals(init)) {
      if (!/\bentries\b/.test(sql)) continue;
      expect(sql).toBe("ALTER TABLE entries ADD COLUMN updated_at INTEGER");
    }
    expect(init).not.toMatch(/SET updated_at = created_at/);
  });

  it("the exempted hydration literal still exists and its consumer still coalesces", () => {
    // If a refactor moves or renames it, the exemption must be revisited rather than
    // silently protecting nothing.
    const search = readFileSync(resolve(ROOT, HYDRATION_EXEMPTION.file), "utf8");
    expect(sqlLiterals(search).some(s => s.includes(HYDRATION_EXEMPTION.marker))).toBe(true);
    const tsReads = rawTsReads(search);
    expect(tsReads.length).toBeGreaterThan(0);
    expect(tsReads.every(r => r.coalesced)).toBe(true);
  });

  // The guard is only worth having if it catches the constructs that motivated it.
  // These are the bypasses an earlier substring-based version waved through.
  describe("guard self-tests", () => {
    const OTHER = "src/somewhere/else.ts";

    it.each([
      ["ORDER BY, in the exempted file — NULLs sort last on DESC",
        HYDRATION_EXEMPTION.file,
        "SELECT id, content, updated_at FROM entries ORDER BY updated_at DESC LIMIT ?"],
      ["bare projection in a non-exempt file",
        OTHER,
        "SELECT id, content, updated_at FROM entries WHERE id = ?"],
      ["raw read in the WHERE of an otherwise-legitimate write",
        OTHER,
        "UPDATE entries SET updated_at = ? WHERE updated_at < ?"],
      ["INSERT ... SELECT copying the column through",
        OTHER,
        "INSERT INTO entries (id, content, updated_at) SELECT id, content, updated_at FROM entries"],
      ["WHERE updated_at IS NULL probe",
        OTHER,
        "SELECT 1 AS n FROM entries WHERE updated_at IS NULL LIMIT 1"],
      // Fragments that name no table at all. These are the realistic way the ORDER BY
      // bug returns — a sort constant or a dynamically appended clause — and an earlier
      // version of this guard dropped every one of them before classification.
      ["a bare ORDER BY constant", OTHER, "ORDER BY updated_at DESC"],
      ["a dynamically appended sort clause", OTHER, " ORDER BY updated_at DESC"],
      ["an exported sort fragment with a tiebreaker", OTHER, "ORDER BY updated_at DESC, id ASC"],
      ["a bare column name used as a sort key", OTHER, "updated_at"],
    ])("flags: %s", (_label, file, sql) => {
      expect(rawSqlReads(sql, file)).not.toEqual([]);
    });

    it.each([
      ["the ALTER that creates the column", "ALTER TABLE entries ADD COLUMN updated_at INTEGER"],
      ["a COALESCEd read", "SELECT id FROM entries WHERE COALESCE(updated_at, created_at) < ?"],
      ["a plain write", "UPDATE entries SET content = ?, tags = ?, updated_at = ? WHERE id = ?"],
      ["a write whose column order differs", "UPDATE entries SET importance_score = ?, updated_at = ? WHERE id = ?"],
      ["INSERT OR REPLACE naming the column", "INSERT OR REPLACE INTO entries (id, content, updated_at) VALUES (?, ?, ?)"],
      ["an INSERT column list", "INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids) VALUES (?, ?, ?, ?, ?, ?, ?)"],
      ["the edges table's own NOT NULL column", "DELETE FROM edges WHERE provenance = 'inferred' AND weight < ? AND updated_at < ?"],
      // Correct code a stricter matcher would wrongly reject.
      ["a table-qualified COALESCE, as any JOIN forces", "SELECT e.id FROM entries e JOIN edges g ON g.source_id = e.id WHERE COALESCE(e.updated_at, e.created_at) < ?"],
      ["IFNULL, the idiomatic SQLite equivalent", "SELECT id FROM entries WHERE IFNULL(updated_at, created_at) < ?"],
    ])("allows: %s", (_label, sql) => {
      expect(rawSqlReads(sql, OTHER)).toEqual([]);
    });

    it.each([
      ["bracket access", `return row["updated_at"];`],
      ["destructured read", `const { updated_at } = row;`],
      ["destructured in a callback", `results.map(({ updated_at }) => updated_at);`],
      ["property access", `const v = row.updated_at;`],
      // Co-occurrence on the same line is not coalescing — these are the two shapes an
      // earlier version of this guard exempted by looking for created_at anywhere.
      ["a sibling field in the same object literal", `return { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at };`],
      ["a sort with a created_at tiebreaker", `rows.sort((a, b) => (b.updated_at - a.updated_at) || (b.created_at - a.created_at));`],
    ])("flags uncoalesced TypeScript read: %s", (_label, line) => {
      const reads = rawTsReads(line);
      expect(reads).not.toEqual([]);
      expect(reads.some(r => !r.coalesced)).toBe(true);
    });

    it("accepts a genuine nullish-coalescing fallback", () => {
      const reads = rawTsReads(`updatedAt: (row.updated_at as number | null) ?? (row.created_at as number),`);
      expect(reads).not.toEqual([]);
      expect(reads.every(r => r.coalesced)).toBe(true);
    });

    it("does not mistake an object-literal key for a read", () => {
      expect(rawTsReads(`return { updated_at: m.updatedAt };`)).toEqual([]);
    });
  });
});
