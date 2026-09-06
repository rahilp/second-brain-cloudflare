import { describe, expect, it } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";
import { hashToken, resolveIdentityByUserId, resolveIdentityFromToken } from "../../src/lib/identity";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";

async function makeEnv(token = "owner-token") {
  const d1 = makeSqliteD1();
  const env = { ...makeTestEnv(d1.db as unknown as D1Mock), AUTH_TOKEN: token } as Env;
  resetDatabaseInit();
  await initializeDatabase(env);
  return env;
}

describe("identity helpers", () => {
  it("resolveIdentityByUserId maps legacy owner sentinel to bootstrap admin", async () => {
    const env = await makeEnv();
    const roots = await ensureTenantBootstrap(env);
    const identity = await resolveIdentityByUserId(env, "owner");
    expect(identity?.userId).toBe(roots.ownerUserId);
    expect(identity?.role).toBe("admin");
  });

  it("resolveIdentityFromToken resolves member tokens", async () => {
    const env = await makeEnv();
    const roots = await ensureTenantBootstrap(env);
    const memberToken = "member-test-token";
    const memberId = "usr-member-test";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, name, role, token_hash, suspended, created_at) VALUES (?, 'Ada', 'member', ?, 0, ?)`,
      ).bind(memberId, await hashToken(memberToken), Date.now()),
      env.DB.prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES ('ws-ada', 'personal', 'Ada', ?)`).bind(Date.now()),
      env.DB.prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, 'ws-ada', ?)`).bind(memberId, Date.now()),
      env.DB.prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, ?, ?)`).bind(memberId, roots.companyWorkspaceId, Date.now()),
    ]);
    const identity = await resolveIdentityFromToken(memberToken, env);
    expect(identity?.userId).toBe(memberId);
    expect(identity?.role).toBe("member");
  });
});
