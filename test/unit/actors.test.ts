import { describe, expect, it } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { SYSTEM_ACTOR_LABEL, lookupActorLabels, resolveActorFilter, resolveActorLabel } from "../../src/lib/actors";
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

  // The product's name, not a subsystem's. "System" told a reader which part
  // of the pipeline wrote the row, which is not a fact they can use; SYSTEM_
  // ACTOR_LABEL is the attribution spec 4.5 asks for. Asserted against the
  // exported constant AND against the literal, so neither can be changed
  // without the other being looked at.
  it("returns the product's own name for system sources when source is provided", () => {
    expect(SYSTEM_ACTOR_LABEL).toBe("Second Brain");
    expect(resolveActorLabel("", labels, { source: "system" })).toBe("Second Brain");
    // Ahead of "You": a row the pipeline wrote is not authored by whoever
    // happens to be reading it, even when their id is on it.
    expect(resolveActorLabel("usr-ada", labels, { source: "system", viewerId: "usr-ada" })).toBe("Second Brain");
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

/**
 * The filter's own guard, below either surface that calls it.
 *
 * A blank value is not a person. It used to fall past the `me` check into the
 * NAME comparison, where `"".toLowerCase() === "".toLowerCase()` matched any
 * roster member carrying an empty name — a filter silently resolving to an
 * arbitrary colleague. Both name-write paths coerce "" to "Member" today, so
 * the row below has to be inserted directly; the point is that the resolver
 * must not depend on that coercion holding.
 */
describe("resolveActorFilter — blank input", () => {
  const COMPANY = "ws-company-blank";
  const NAMELESS = "usr-nameless";

  async function envWithNamelessMember() {
    const env = await makeEnv();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'company', 'Acme', ?)`)
        .bind(COMPANY, now),
      env.DB.prepare(
        `INSERT INTO users (id, name, email, role, token_hash, suspended, created_at) VALUES (?, '', NULL, 'member', ?, 0, ?)`,
      ).bind(NAMELESS, "hash-n", now),
      env.DB.prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, ?, ?)`)
        .bind(NAMELESS, COMPANY, now),
    ]);
    return env;
  }

  const caller = {
    userId: "usr-caller",
    role: "member" as const,
    personalWorkspaceId: "ws-caller",
    companyWorkspaceIds: [COMPANY],
    defaultShare: "" as const,
  };

  it("refuses whitespace rather than matching a member with no name", async () => {
    const env = await envWithNamelessMember();
    expect(await resolveActorFilter(env, caller, "   ")).toEqual({
      ok: false,
      error: "actor must be a member of your team",
    });
  });

  it("refuses the empty string for the same reason", async () => {
    const env = await envWithNamelessMember();
    expect(await resolveActorFilter(env, caller, "")).toEqual({
      ok: false,
      error: "actor must be a member of your team",
    });
  });

  it("still resolves me, which never reaches the roster at all", async () => {
    const env = await envWithNamelessMember();
    expect(await resolveActorFilter(env, caller, "  ME  ")).toEqual({ ok: true, actorId: "usr-caller" });
  });
});
