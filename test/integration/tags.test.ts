import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

describe("GET /tags", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("returns empty array when no entries", async () => {
    const res = await worker.fetch(req("GET", "/tags"), env, ctx);
    expect(res.status).toBe(200);
    const data = await res.json() as any[];
    expect(data).toEqual([]);
  });

  it("returns distinct sorted tags across all entries", async () => {
    db.entries.push(
      { id: "1", content: "A", tags: '["work","react"]', source: "api", created_at: 1, vector_ids: "[]" },
      { id: "2", content: "B", tags: '["react","typescript"]', source: "api", created_at: 2, vector_ids: "[]" },
    );

    const res = await worker.fetch(req("GET", "/tags"), env, ctx);
    const data = await res.json() as string[];
    expect(data).toEqual(["react", "typescript", "work"]);
  });
});
