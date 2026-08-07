import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  ENTRY_INSERT_COLUMNS,
  ENTRY_INSERT_SQL,
  EDGE_ENDPOINT_QUERY_BATCH,
  formatDbError,
  isImportRecordObject,
  parseCreatedAt,
  parseImportLimit,
  parseImportOffset,
  parseOptionalNumber,
  parseRequiredString,
  parseTags,
  parseEdgeWeight,
} from "../../src/entries/import";
import { D1_MAX_BOUND_PARAMS } from "../../src/constants";

const repoRoot = resolve(import.meta.dirname, "../..");

function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, "");
}

function parseColumnList(body: string): string[] {
  const cols: string[] = [];
  let current = "";
  let inQuote = false;
  for (const ch of body) {
    if (ch === "'") inQuote = !inQuote;
    if (ch === "," && !inQuote) {
      const name = current.trim().split(/\s+/)[0];
      if (name && !name.startsWith("UNIQUE")) cols.push(name);
      current = "";
    } else {
      current += ch;
    }
  }
  const name = current.trim().split(/\s+/)[0];
  if (name && !name.startsWith("UNIQUE")) cols.push(name);
  return cols;
}

function parseCreateTableColumns(sql: string, table: string): string[] {
  const cleaned = stripSqlComments(sql);
  const match = cleaned.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([^)]*)\\)`, "i"));
  if (!match) return [];
  return parseColumnList(match[1]);
}

function parseAlterColumns(initSource: string, table: string): string[] {
  const cols: string[] = [];
  const re = new RegExp(`ALTER TABLE ${table} ADD COLUMN (\\w+)`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(initSource)) !== null) {
    cols.push(m[1]);
  }
  return cols;
}

function parseSchemaRuntimeColumns(schemaSql: string): string[] {
  const match = schemaSql.match(/Runtime ALTER columns.*?:\s*([^\n]+)/);
  if (!match) return [];
  return match[1].split(",").map(s => s.trim()).filter(Boolean);
}

describe("import helpers", () => {
  it("ENTRY_INSERT_COLUMNS are a subset of schema.sql and init.ts columns", () => {
    const schemaSql = readFileSync(resolve(repoRoot, "db/schema.sql"), "utf-8");
    const initTs = readFileSync(resolve(repoRoot, "src/db/init.ts"), "utf-8");

    const schemaCols = [
      ...parseCreateTableColumns(schemaSql, "entries"),
      ...parseSchemaRuntimeColumns(schemaSql),
    ];
    const initCols = [
      ...parseCreateTableColumns(initTs, "entries"),
      ...parseAlterColumns(initTs, "entries"),
    ];

    for (const col of ENTRY_INSERT_COLUMNS) {
      expect(schemaCols, `missing ${col} in schema.sql`).toContain(col);
      expect(initCols, `missing ${col} in init.ts`).toContain(col);
    }

    expect(ENTRY_INSERT_SQL).toContain("INSERT INTO entries (");
    expect(ENTRY_INSERT_SQL).toContain("updated_at");
  });

  it("EDGE_ENDPOINT_QUERY_BATCH halves D1_MAX_BOUND_PARAMS for double-bound lookups", () => {
    expect(EDGE_ENDPOINT_QUERY_BATCH).toBe(Math.floor(D1_MAX_BOUND_PARAMS / 2));
  });

  it("parseRequiredString rejects non-string values without throwing", () => {
    expect(parseRequiredString(42, "missing_id", "invalid_id")).toEqual({ ok: false, reason: "invalid_id" });
    expect(parseRequiredString("  abc  ", "missing_id", "invalid_id")).toEqual({ ok: true, value: "abc" });
  });

  it("parseTags rejects non-string tag values", () => {
    expect(parseTags([42])).toEqual({ ok: false, reason: "invalid_tag" });
    expect(parseTags(["work", "kind:semantic"])).toEqual({ ok: true, tags: ["work", "kind:semantic"] });
    expect(parseTags(undefined)).toEqual({ ok: true, tags: [] });
  });

  it("isImportRecordObject rejects null and arrays", () => {
    expect(isImportRecordObject(null)).toBe(false);
    expect(isImportRecordObject([])).toBe(false);
    expect(isImportRecordObject({ id: "x" })).toBe(true);
  });

  it("parseImportLimit clamps invalid and oversized values", () => {
    expect(parseImportLimit(null)).toBe(40);
    expect(parseImportLimit("0")).toBe(40);
    expect(parseImportLimit("50")).toBe(50);
    expect(parseImportLimit("99999")).toBe(1000);
  });

  it("formatDbError truncates long messages", () => {
    const long = "x".repeat(300);
    expect(formatDbError(new Error(long)).length).toBe(200);
  });

  it("parseEdgeWeight rejects non-finite values", () => {
    expect(parseEdgeWeight({ nested: 1 })).toEqual({ ok: false, reason: "invalid_weight" });
    expect(parseEdgeWeight(0.5)).toEqual({ ok: true, value: 0.5 });
  });

  it("parseOptionalNumber rejects non-finite values and defaults nullish to 0", () => {
    expect(parseOptionalNumber(undefined, "invalid_recall_count")).toEqual({ ok: true, value: 0 });
    expect(parseOptionalNumber(null, "invalid_recall_count")).toEqual({ ok: true, value: 0 });
    expect(parseOptionalNumber("3", "invalid_recall_count")).toEqual({ ok: false, reason: "invalid_recall_count" });
    expect(parseOptionalNumber(4, "invalid_importance_score")).toEqual({ ok: true, value: 4 });
  });

  it("parseCreatedAt rejects non-finite values and defaults nullish to now", () => {
    const now = Date.now();
    const parsed = parseCreatedAt(undefined);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toBeGreaterThanOrEqual(now);
    expect(parseCreatedAt("yesterday")).toEqual({ ok: false, reason: "invalid_created_at" });
    expect(parseCreatedAt(1234)).toEqual({ ok: true, value: 1234 });
  });

  it("parseImportOffset defaults absent, invalid, and negative values to 0", () => {
    expect(parseImportOffset(null)).toBe(0);
    expect(parseImportOffset("")).toBe(0);
    expect(parseImportOffset("abc")).toBe(0);
    expect(parseImportOffset("-5")).toBe(0);
    expect(parseImportOffset("120")).toBe(120);
  });
});
