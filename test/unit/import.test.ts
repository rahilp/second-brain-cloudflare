import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  ENTRY_INSERT_COLUMNS,
  ENTRY_INSERT_SQL,
  EDGE_ENDPOINT_QUERY_BATCH,
  formatDbError,
  isImportRecordObject,
  isRetriableReason,
  parseCreatedAt,
  parseOptionalNumber,
  parseRequiredString,
  parseTags,
  parseEdgeWeight,
  collectPayloadEntryIds,
  collectEdgeEndpoints,
} from "../../src/entries/import";
import { pageCount, chunkKey } from "../../src/entries/import-job";
import {
  D1_MAX_BOUND_PARAMS,
  IMPORT_ENTRIES_PER_PAGE,
  IMPORT_EDGES_PER_PAGE,
} from "../../src/constants";

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
      if (name && !name.startsWith("UNIQUE") && !name.startsWith("PRIMARY")) cols.push(name);
      current = "";
    } else {
      current += ch;
    }
  }
  const name = current.trim().split(/\s+/)[0];
  if (name && !name.startsWith("UNIQUE") && !name.startsWith("PRIMARY")) cols.push(name);
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

  it("import_job_pages schema includes retriable_failed", () => {
    const schemaSql = readFileSync(resolve(repoRoot, "db/schema.sql"), "utf-8");
    const initTs = readFileSync(resolve(repoRoot, "src/db/init.ts"), "utf-8");
    expect(parseCreateTableColumns(schemaSql, "import_job_pages")).toContain("retriable_failed");
    expect(initTs).toContain("retriable_failed");
    expect(initTs).toContain("import_jobs");
    expect(initTs).toContain("import_job_pages");
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

  it("isRetriableReason classifies terminal vs retriable", () => {
    expect(isRetriableReason("missing_endpoint")).toBe(true);
    expect(isRetriableReason("deferred_retry")).toBe(true);
    expect(isRetriableReason("insert_error")).toBe(true);
    expect(isRetriableReason("create_failed")).toBe(true);
    expect(isRetriableReason("invalid_id")).toBe(false);
    expect(isRetriableReason("missing_content")).toBe(false);
    expect(isRetriableReason("invalid_tag")).toBe(false);
    expect(isRetriableReason("invalid_type")).toBe(false);
  });

  it("collectPayloadEntryIds / collectEdgeEndpoints skip malformed rows", () => {
    expect(collectPayloadEntryIds([
      { id: "a", content: "x" },
      { id: 42 as unknown as string, content: "y" },
      null as unknown as { id: string; content: string },
    ])).toEqual(["a"]);
    expect(collectEdgeEndpoints([
      { source_id: "a", target_id: "b" },
      { source_id: "", target_id: "c" },
    ])).toEqual(["a", "b", "c"]);
  });

  it("pageCount and chunkKey match the page-sized design", () => {
    expect(pageCount(0, IMPORT_ENTRIES_PER_PAGE)).toBe(0);
    expect(pageCount(1, IMPORT_ENTRIES_PER_PAGE)).toBe(1);
    expect(pageCount(IMPORT_ENTRIES_PER_PAGE, IMPORT_ENTRIES_PER_PAGE)).toBe(1);
    expect(pageCount(IMPORT_ENTRIES_PER_PAGE + 1, IMPORT_ENTRIES_PER_PAGE)).toBe(2);
    expect(pageCount(IMPORT_EDGES_PER_PAGE * 2, IMPORT_EDGES_PER_PAGE)).toBe(2);
    expect(chunkKey("job-1", "entries", 3)).toBe("import:job-1:e:3");
    expect(chunkKey("job-1", "edges", 0)).toBe("import:job-1:g:0");
  });
});
