import { describe, expect, it } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { hashToken } from "../../src/lib/identity";
import type { Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";
import {
  assertCanEditContent,
  assertCanMutateEntry,
  getReadableEntry,
} from "../../src/lib/entry-access";

async function seedMember(env: Env, id: string, token: string, companyId: string) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, name, email, role, token_hash, suspended, created_at) VALUES (?, ?, NULL, 'member', ?, 0, ?)`,
    ).bind(id, `User ${id}`, await hashToken(token), Date.now()),
    env.DB.prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'personal', ?, ?)`).bind(`ws-${id}`, id, Date.now()),
    env.DB.prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) SELECT ?, 'ws-${id}', ? WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = ? AND workspace_id = 'ws-${id}')`).bind(id, Date.now(), id),
    env.DB.prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = ? AND workspace_id = ?)`).bind(id, companyId, Date.now(), id, companyId),
  ]);
}

function identity(userId: string, personal: string, company: string, role: "admin" | "member" = "member"): Identity {
  return { userId, role, personalWorkspaceId: personal, companyWorkspaceId: company, defaultShare: "" };
}

async function makeEnv() {
  const d1 = makeSqliteD1();
  const env = { ...makeTestEnv(d1.db as unknown as D1Mock), AUTH_TOKEN: "owner-token" } as Env;
  resetDatabaseInit();
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  return { env, roots };
}

async function seedEntry(env: Env, id: string, workspaceId: string, actorId: string) {
  await env.DB.prepare(
    `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, recall_count, importance_score, workspace_id, actor_id)
     VALUES (?, ?, '[]', 'api', ?, '[]', 0, 0, ?, ?)`,
  ).bind(id, `content of ${id}`, Date.now(), workspaceId, actorId).run();
}

describe("getReadableEntry", () => {
  it("returns rows in the caller's personal or company workspace", async () => {
    const { env, roots } = await makeEnv();
    await seedMember(env, "u-b", "b-token", roots.companyWorkspaceId);
    await seedEntry(env, "mine", "ws-u-b", "u-b");
    await seedEntry(env, "shared", roots.companyWorkspaceId, "u-a");

    const memberB = identity("u-b", "ws-u-b", roots.companyWorkspaceId);
    expect(await getReadableEntry(env, memberB, "mine")).toMatchObject({ id: "mine" });
    expect(await getReadableEntry(env, memberB, "shared")).toMatchObject({ id: "shared" });
  });

  it("reads another member's private entry as missing, never as forbidden", async () => {
    const { env, roots } = await makeEnv();
    await seedMember(env, "u-b", "b-token", roots.companyWorkspaceId);
    await seedMember(env, "u-c", "c-token", roots.companyWorkspaceId);
    await seedEntry(env, "secret", "ws-u-c", "u-c");

    const memberB = identity("u-b", "ws-u-b", roots.companyWorkspaceId);
    expect(await getReadableEntry(env, memberB, "secret")).toBeNull();
  });

  it("without an Identity falls back to an unscoped by-id read", async () => {
    const { env, roots } = await makeEnv();
    await seedEntry(env, "legacy", roots.ownerPersonalWorkspaceId, roots.ownerUserId);
    expect(await getReadableEntry(env, undefined, "legacy")).toMatchObject({ id: "legacy" });
  });
});

describe("assertCanMutateEntry / assertCanEditContent", () => {
  it("allows the author and admins to edit company-layer rows", () => {
    const company = "ws-co";
    const row = { workspace_id: company, actor_id: "u-author" };
    const author = identity("u-author", "ws-author", company);
    const admin = identity("u-admin", "ws-admin", company, "admin");
    const stranger = identity("u-stranger", "ws-stranger", company);

    expect(assertCanMutateEntry(author, row)).toBeNull();
    expect(assertCanEditContent(author, row)).toBeNull();
    expect(assertCanMutateEntry(admin, row)).toBeNull();
    expect(assertCanMutateEntry(stranger, row)).toEqual({
      code: "forbidden",
      message: "Only the entry's author or an admin can modify a shared company memory",
    });
  });

  it("does not restrict personal-workspace rows reachable through scope", () => {
    const row = { workspace_id: "ws-me", actor_id: "someone-else" };
    const me = identity("u-me", "ws-me", "ws-co");
    expect(assertCanMutateEntry(me, row)).toBeNull();
    expect(assertCanEditContent(me, row)).toBeNull();
  });

  it("is a no-op without an Identity (pre-tenancy callers)", () => {
    const row = { workspace_id: "ws-co", actor_id: "u-other" };
    expect(assertCanMutateEntry(undefined, row)).toBeNull();
    expect(assertCanEditContent(undefined, row)).toBeNull();
  });
});

describe("company edit lock integration", () => {
  it("forbids a member from mutating another author's company entry", async () => {
    const { env, roots } = await makeEnv();
    await seedMember(env, "u-b", "b-token", roots.companyWorkspaceId);
    await seedEntry(env, "team-note", roots.companyWorkspaceId, "u-a");

    const memberB = identity("u-b", "ws-u-b", roots.companyWorkspaceId);
    const row = await getReadableEntry(env, memberB, "team-note");
    expect(row).not.toBeNull();
    expect(assertCanMutateEntry(memberB, row!)).toMatchObject({ code: "forbidden" });
    expect(assertCanEditContent(memberB, row!)).toMatchObject({ code: "forbidden" });
  });
});
