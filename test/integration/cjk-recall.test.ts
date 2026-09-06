/**
 * Issue #326 acceptance, on real SQLite.
 *
 * The dense arm is forced down (VECTORIZE.query rejects) so the keyword arm is
 * the entire candidate source — the criterion the issue states. Every
 * assertion about retrieval is a property of SQLite's LIKE, which the D1 mock
 * does not evaluate (and whose JavaScript stand-in folds full-width case that
 * SQLite does not), so this file uses test/helpers/sqlite-d1.ts throughout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { buildMcpServer } from "../../src/mcp/server";
import { recallEntries } from "../../src/recall/search";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CJK_RECALL_FIXTURE, CJK_RECALL_EXTRA } from "../fixtures/cjk-recall";
import type { RecallDiagnostics } from "../../src/recall/types";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function recallEnv(sqlite: SqliteD1): Env {
  return makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({ query: vi.fn().mockRejectedValue(new Error("index unavailable")) }),
  });
}

async function callMcpRecall(env: Env, query: string) {
  const server = buildMcpServer(env, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await client.callTool({ name: "recall", arguments: { query } });
  } finally {
    await client.close();
  }
}

describe("CJK and compatibility-form recall (#326)", () => {
  let sqlite: SqliteD1;
  let env: Env;

  beforeEach(async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    env = recallEnv(sqlite);
    await initializeDatabase(env);
    let t = 1_000;
    for (const item of CJK_RECALL_FIXTURE) sqlite.seed({ id: item.id, content: item.content, createdAt: t++ });
    for (const item of CJK_RECALL_EXTRA) sqlite.seed({ id: item.id, content: item.content, createdAt: t++ });
  });
  afterEach(() => sqlite.close());

  it.each(CJK_RECALL_FIXTURE)("keyword-only recall ranks $id first for “$query”", async ({ id, query }) => {
    const res = await recallEntries({ query, topK: 5, synthesize: false }, env, ctx);
    expect(res.semanticUnavailable).toBe(true);
    expect(res.matches[0]?.id).toBe(id);
  });

  it("a full-width query reaches content stored normalized AND content stored full-width (criterion 4)", async () => {
    const res = await recallEntries({ query: "Ｔｅｒｒａｆｏｒｍ", topK: 5, synthesize: false }, env, ctx);
    const ids = res.matches.map(m => m.id);
    expect(ids).toContain("fw-ascii");
    expect(ids).toContain("fw-wide");
    // Canonical token first, typed surface as the probe.
    expect(res.queryTokens).toEqual(["terraform", "Ｔｅｒｒａｆｏｒｍ"]);
  });

  it("a half-width query reaches half-width content through its probe", async () => {
    const res = await recallEntries({ query: "ｷｬﾘｱ", topK: 5, synthesize: false }, env, ctx);
    expect(res.matches[0]?.id).toBe("mx-12");
  });

  it("retrieves the exact CJK memory through GET /recall (criterion 2, REST)", async () => {
    const res = await worker.fetch(req("GET", `/recall?query=${encodeURIComponent("認証方式を変更した理由")}`), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as { results: { id: string; content: string }[] };
    expect(data.results[0]?.id).toBe("jp-01");
    expect(data.results[0]?.content).toContain("パスキー");
  });

  it("retrieves the exact CJK memory through the MCP recall tool (criterion 2, MCP)", async () => {
    const result = await callMcpRecall(env, "認証方式を変更した理由");
    const text = (result.content as { type: string; text: string }[]).map(c => c.text).join("\n");
    expect(text).toContain("パスキー");
  });

  it("reports the lexical arm in diagnostics, so an empty keyword result is no longer ambiguous", async () => {
    const diagnostics: RecallDiagnostics = {};
    await recallEntries({ query: "認証方式を変更した理由", topK: 5, synthesize: false }, env, ctx, undefined, { diagnostics });
    expect(diagnostics.retrievalTokenCount).toBe(4);
    expect(diagnostics.lexicalArmSkipped).toBe(false);
    expect(diagnostics.corpusIdfUsed).toBe(true);
  });
});
