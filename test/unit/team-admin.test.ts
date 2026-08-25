import { describe, expect, it } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember, listMembers, rotateMemberToken, setMemberSuspended, TeamAdminError } from "../../src/lib/team-admin";
import { hashToken } from "../../src/lib/identity";
import type { Env } from "../../src/env";

async function makeEnv() {
  const d1 = makeSqliteD1();
  const env = { ...makeTestEnv(d1.db as unknown as D1Mock), AUTH_TOKEN: "owner-token" } as unknown as Env;
  resetDatabaseInit();
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  return { env, roots };
}

describe("team member administration", () => {
  it("creates a member with a personal workspace and both memberships", async () => {
    const { env, roots } = await makeEnv();
    const { member, token } = await createMember(env, { name: "Ada", email: "ada@co.io" });
    // The token is real credentials — it must resolve through identity's hash.
    expect(await hashToken(token)).toBeTruthy();
    const row = await env.DB.prepare(`SELECT role, suspended FROM users WHERE id = ?`).bind(member.userId).first<{ role: string; suspended: number }>();
    expect(row?.role).toBe("member");
    expect(row?.suspended).toBe(0);
    const memberships = await env.DB.prepare(
      `SELECT w.kind FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ?`,
    ).bind(member.userId).all<{ kind: string }>();
    expect(memberships.results?.map((m) => m.kind).sort()).toEqual(["company", "personal"]);
    expect(roots.companyWorkspaceId).toBeTruthy();
  });

  it("rejects duplicate emails with 409 semantics", async () => {
    const { env } = await makeEnv();
    await createMember(env, { name: "A", email: "a@co.io" });
    await expect(createMember(env, { name: "B", email: "a@co.io" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("lists members with their private-entry counts", async () => {
    const { env } = await makeEnv();
    await createMember(env, { name: "Ada" });
    const members = await listMembers(env);
    // Owner + Ada. Same-ms creation makes list order a tie — assert by identity.
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.role === "admin")?.name).toBe("Owner");
    const ada = members.find((m) => m.name === "Ada");
    expect(ada?.role).toBe("member");
    expect(members.every((m) => typeof m.privateEntries === "number")).toBe(true);
  });

  it("rotating a token invalidates the old one immediately", async ({ }) => {
    const { env } = await makeEnv();
    const { member, token } = await createMember(env, { name: "Ada" });
    const newToken = await rotateMemberToken(env, member.userId);
    expect(newToken).not.toBe(token);
    const storedHash = (await env.DB.prepare(`SELECT token_hash FROM users WHERE id = ?`).bind(member.userId).first<{ token_hash: string }>())?.token_hash;
    expect(storedHash).toBe(await hashToken(newToken));
  });

  it("refuses to suspend yourself or the last active admin", async () => {
    const { env, roots } = await makeEnv();
    const { member } = await createMember(env, { name: "Ada", role: "admin" });
    // Self-suspension.
    await expect(setMemberSuspended(env, roots.ownerUserId, roots.ownerUserId, true)).rejects.toMatchObject({ status: 400 });
    // Two admins exist, so suspending the owner is fine...
    await setMemberSuspended(env, member.userId, roots.ownerUserId, true);
    // ...but now Ada is the last active admin and cannot be suspended.
    await expect(setMemberSuspended(env, "x", member.userId, true)).rejects.toMatchObject({ status: 400 });
  });

  it("suspension keeps rows but blocks identity resolution", async () => {
    const { env } = await makeEnv();
    const { member, token } = await createMember(env, { name: "Ada" });
    await setMemberSuspended(env, "someone-else", member.userId, true);
    const { resolveIdentity } = await import("../../src/lib/identity");
    const request = new Request("https://x/", { headers: { Authorization: `Bearer ${token}` } });
    expect(await resolveIdentity(request, env)).toBeNull();
    // Unsuspend restores access.
    await setMemberSuspended(env, "someone-else", member.userId, false);
    expect(await resolveIdentity(request, env)).not.toBeNull();
  });

  it("surfaces unknown members as 404-class errors", async () => {
    const { env } = await makeEnv();
    await expect(rotateMemberToken(env, "usr-none")).rejects.toBeInstanceOf(TeamAdminError);
  });
});
