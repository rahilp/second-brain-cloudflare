import { describe, expect, it } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { lookupActorLabels, resolveActorLabel } from "../../src/lib/actors";
import type { Env } from "../../src/env";

async function makeEnv() {
  const d1 = makeSqliteD1();
  const env = { ...makeTestEnv(d1.db as unknown as D1Mock), AUTH_TOKEN: "owner-token" } as unknown as Env;
  resetDatabaseInit();
  await initializeDatabase(env);
  await ensureTenantBootstrap(env);
  return env;
}

describe("resolveActorLabel", () => {
  const labels = new Map([["usr-ada", "Ada"]]);

  it("returns You when the viewer is the actor", () => {
    expect(resolveActorLabel("usr-ada", labels, { viewerId: "usr-ada" })).toBe("You");
  });

  it("returns the member name when known", () => {
    expect(resolveActorLabel("usr-ada", labels)).toBe("Ada");
  });

  it("returns Owner for the legacy empty actor_id", () => {
    expect(resolveActorLabel("", labels)).toBe("Owner");
  });

  it("returns Former member when the id is absent from the label map", () => {
    expect(resolveActorLabel("usr-gone", labels)).toBe("Former member");
  });

  it("returns System for system sources when source is provided", () => {
    expect(resolveActorLabel("", labels, { source: "system" })).toBe("System");
    expect(resolveActorLabel("usr-ada", labels, { source: "system", viewerId: "usr-ada" })).toBe("System");
  });
});

describe("lookupActorLabels", () => {
  it("returns active member names and skips soft-deleted users", async () => {
    const env = await makeEnv();
    const now = Date.now();
    const activeId = "usr-active";
    const removedId = "usr-removed";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, name, email, role, token_hash, suspended, created_at) VALUES (?, 'Active', NULL, 'member', ?, 0, ?)`,
      ).bind(activeId, "hash-a", now),
      env.DB.prepare(
        `INSERT INTO users (id, name, email, role, token_hash, suspended, created_at, removed_at) VALUES (?, 'Removed', NULL, 'member', ?, 0, ?, ?)`,
      ).bind(removedId, "hash-r", now, now),
    ]);

    const map = await lookupActorLabels(env, [activeId, removedId, "usr-missing"]);
    expect(map.get(activeId)).toBe("Active");
    expect(map.has(removedId)).toBe(false);
    expect(map.has("usr-missing")).toBe(false);
  });

  it("deduplicates ids and ignores blanks", async () => {
    const env = await makeEnv();
    expect(await lookupActorLabels(env, ["", "", "usr-none"])).toEqual(new Map());
  });
});
