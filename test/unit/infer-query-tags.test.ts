import { describe, it, expect, vi } from "vitest";
import { inferQueryTags } from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";

function makeSseStream(response: string) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

describe("inferQueryTags", () => {
  it("returns hashtags extracted from the query without hitting the DB", async () => {
    const db = makeTestDb();
    const aiRun = vi.fn();
    const dbPrepareSpy = vi.spyOn(db, "prepare");
    const env = makeTestEnv(db, { AI: { run: aiRun } as unknown as Ai });
    const tags = await inferQueryTags("what did I decide about #work today?", env);
    expect(tags).toEqual(["work"]);
    // Early return — no DB or LLM call
    expect(dbPrepareSpy).not.toHaveBeenCalled();
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("returns keyword-matched known tags (whole-word match, case-insensitive)", async () => {
    const db = makeTestDb();
    db.entries.push({ id: "e1", content: "Office lease note", tags: '["work","legal"]', source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 });
    const env = makeTestEnv(db);
    const tags = await inferQueryTags("what work and legal things did I decide?", env);
    expect(tags).toHaveLength(2);
    expect(tags).toEqual(expect.arrayContaining(["work", "legal"]));
  });

  it("does not call the LLM when keyword matches are found", async () => {
    const db = makeTestDb();
    db.entries.push({ id: "e1", content: "Note", tags: '["work"]', source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 });
    const aiRun = vi.fn().mockResolvedValue(makeSseStream("work"));
    const env = makeTestEnv(db, { AI: { run: aiRun } as unknown as Ai });
    const tags = await inferQueryTags("work meeting notes", env);
    expect(tags).toContain("work");
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("calls the LLM and intersects with known tags when cheap inference finds nothing", async () => {
    const db = makeTestDb();
    db.entries.push({ id: "e1", content: "Note", tags: '["work","personal"]', source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 });
    const aiRun = vi.fn().mockResolvedValue(makeSseStream("work, personal"));
    const env = makeTestEnv(db, { AI: { run: aiRun } as unknown as Ai });
    const tags = await inferQueryTags("quarterly planning session", env);
    expect(tags).toHaveLength(2);
    expect(tags).toEqual(expect.arrayContaining(["work", "personal"]));
    expect(aiRun).toHaveBeenCalledTimes(1);
  });

  it("filters out unknown tags returned by the LLM (intersects with known set)", async () => {
    const db = makeTestDb();
    db.entries.push({ id: "e1", content: "Note", tags: '["work"]', source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 });
    const aiRun = vi.fn().mockResolvedValue(makeSseStream("work, invented-tag, random"));
    const env = makeTestEnv(db, { AI: { run: aiRun } as unknown as Ai });
    const tags = await inferQueryTags("quarterly planning session", env);
    expect(tags).toEqual(["work"]);
  });

  it("returns empty array when the LLM throws — never propagates error", async () => {
    const db = makeTestDb();
    db.entries.push({ id: "e1", content: "Note", tags: '["work"]', source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 });
    const aiRun = vi.fn().mockRejectedValue(new Error("AI unavailable"));
    const env = makeTestEnv(db, { AI: { run: aiRun } as unknown as Ai });
    await expect(inferQueryTags("quarterly planning session", env)).resolves.toEqual([]);
  });

  it("returns empty array when DB has no entries (no vocabulary to match against)", async () => {
    const db = makeTestDb();
    const env = makeTestEnv(db);
    const tags = await inferQueryTags("quarterly planning session", env);
    expect(tags).toEqual([]);
  });

  it("does not partially match — 'networking' does not match tag 'net'", async () => {
    const db = makeTestDb();
    db.entries.push({ id: "e1", content: "Note", tags: '["net"]', source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 });
    const env = makeTestEnv(db);
    const tags = await inferQueryTags("networking event", env);
    expect(tags).not.toContain("net");
  });

  it("does not match a hyphenated compound — 'my-claude-response-thing' does not match tag 'claude-response'", async () => {
    const db = makeTestDb();
    db.entries.push({ id: "e1", content: "Note", tags: '["claude-response"]', source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 });
    const env = makeTestEnv(db);
    const tags = await inferQueryTags("my-claude-response-thing happened", env);
    expect(tags).not.toContain("claude-response");
  });

  it("matches a hyphenated tag that appears standalone in the query", async () => {
    const db = makeTestDb();
    db.entries.push({ id: "e1", content: "Note", tags: '["claude-response"]', source: "api", created_at: 1000, vector_ids: "[]", recall_count: 0, importance_score: 0 });
    const env = makeTestEnv(db);
    const tags = await inferQueryTags("what claude-response notes do I have", env);
    expect(tags).toContain("claude-response");
  });
});
