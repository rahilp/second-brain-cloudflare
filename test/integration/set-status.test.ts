import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyStatus } from "../../src/index";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("applyStatus()", () => {
  let db: D1Mock;
  let env: Env;
  let deleteByIdsMock: any;

  beforeEach(() => {
    db = makeTestDb();
    deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });

    db.entries.push({
      id: "entry-1",
      content: "Some important work content",
      tags: JSON.stringify(["work"]),
      source: "api",
      created_at: Date.now(),
      vector_ids: JSON.stringify(["v1"]),
    });
  });

  it("canonical: returns true, sets status:canonical tag, vectors untouched", async () => {
    const result = await applyStatus("entry-1", "canonical", env);
    expect(result).toBe(true);

    const row = db.entries.find((e: any) => e.id === "entry-1");
    const tags: string[] = JSON.parse(row.tags);
    expect(tags).toContain("status:canonical");
    expect(row.vector_ids).toBe(JSON.stringify(["v1"]));
    expect(deleteByIdsMock).not.toHaveBeenCalled();
  });

  it("draft: replaces status:canonical with status:draft (only one status tag)", async () => {
    // First set to canonical
    await applyStatus("entry-1", "canonical", env);

    // Now set to draft
    const result = await applyStatus("entry-1", "draft", env);
    expect(result).toBe(true);

    const row = db.entries.find((e: any) => e.id === "entry-1");
    const tags: string[] = JSON.parse(row.tags);
    expect(tags).toContain("status:draft");
    expect(tags).not.toContain("status:canonical");
    // Only one status tag
    const statusTags = tags.filter((t: string) => t.startsWith("status:"));
    expect(statusTags).toHaveLength(1);
  });

  it("deprecated: deletes vectors, clears vector_ids, sets status:deprecated", async () => {
    const result = await applyStatus("entry-1", "deprecated", env);
    expect(result).toBe(true);

    const row = db.entries.find((e: any) => e.id === "entry-1");
    const tags: string[] = JSON.parse(row.tags);
    expect(tags).toContain("status:deprecated");
    expect(row.vector_ids).toBe("[]");
    expect(deleteByIdsMock).toHaveBeenCalledWith(["v1"]);
  });

  it("returns false for a missing id", async () => {
    const result = await applyStatus("missing-id", "canonical", env);
    expect(result).toBe(false);
  });
});

describe("POST /status", () => {
  let db: D1Mock;
  let env: Env;
  let deleteByIdsMock: any;

  beforeEach(() => {
    db = makeTestDb();
    deleteByIdsMock = vi.fn().mockResolvedValue({ mutationId: "m" });
    env = makeTestEnv(db, {
      VECTORIZE: makeVectorizeMock({ deleteByIds: deleteByIdsMock }),
    });

    db.entries.push({
      id: "entry-1",
      content: "Some work content",
      tags: JSON.stringify(["work"]),
      source: "api",
      created_at: Date.now(),
      vector_ids: JSON.stringify(["v1"]),
    });
  });

  it("valid {id, status} applies the change and returns success", async () => {
    const res = await worker.fetch(
      req("POST", "/status", { body: { id: "entry-1", status: "canonical" } }),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.status).toBe("canonical");

    const row = db.entries.find((e: any) => e.id === "entry-1");
    const tags: string[] = JSON.parse(row.tags);
    expect(tags).toContain("status:canonical");
  });

  it("invalid status returns 400 and makes no change", async () => {
    const res = await worker.fetch(
      req("POST", "/status", { body: { id: "entry-1", status: "bogus" } }),
      env,
      ctx
    );
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toBeDefined();

    // Tags should be unchanged
    const row = db.entries.find((e: any) => e.id === "entry-1");
    const tags: string[] = JSON.parse(row.tags);
    expect(tags).not.toContain("status:bogus");
    expect(tags.filter((t: string) => t.startsWith("status:"))).toHaveLength(0);
  });

  it("returns 404-style error when id does not exist", async () => {
    const res = await worker.fetch(
      req("POST", "/status", { body: { id: "no-such-id", status: "draft" } }),
      env,
      ctx
    );
    expect(res.status).toBe(404);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toBeDefined();
  });

  it("missing id returns 400 with ok:false and id is required error", async () => {
    const res = await worker.fetch(
      req("POST", "/status", { body: { status: "canonical" } }),
      env,
      ctx
    );
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toBe("id is required");
  });

  it("deprecated via route: deletes vectors, clears vector_ids, sets status:deprecated tag", async () => {
    const res = await worker.fetch(
      req("POST", "/status", { body: { id: "entry-1", status: "deprecated" } }),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);

    const row = db.entries.find((e: any) => e.id === "entry-1");
    expect(row.vector_ids).toBe("[]");
    const tags: string[] = JSON.parse(row.tags);
    expect(tags).toContain("status:deprecated");
    expect(deleteByIdsMock).toHaveBeenCalledWith(["v1"]);
  });
});
