import { describe, expect, it } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember, listMembers, removeMember, rotateMemberToken, setMemberDefaultShare, setMemberProfile, setMemberSuspended, TeamAdminError } from "../../src/lib/team-admin";
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

async function activeAdminIds(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM users
      WHERE role = 'admin' AND suspended = 0
        AND (removed_at IS NULL OR removed_at = 0)
      ORDER BY id`,
  ).all<{ id: string }>();
  return (results ?? []).map((row) => row.id);
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

  it("rejects member shapes a rogue client could post", async () => {
    const { env } = await makeEnv();
    // createMember: name is required, bounded, and the email must look like one.
    await expect(createMember(env, {})).rejects.toMatchObject({ status: 400 });
    await expect(createMember(env, { name: "   " })).rejects.toMatchObject({ status: 400 });
    await expect(createMember(env, { name: "x".repeat(61) })).rejects.toMatchObject({ status: 400 });
    await expect(createMember(env, { name: "Ada", email: "not-an-email" })).rejects.toMatchObject({ status: 400 });
    await expect(createMember(env, { name: "Ada", email: `${"a".repeat(250)}@x.io` })).rejects.toMatchObject({ status: 400 });
    // setMemberProfile: same rules, with the empty-string-cleared email allowed.
    const { member } = await createMember(env, { name: "Ada" });
    await expect(setMemberProfile(env, member.userId, { name: "  " })).rejects.toMatchObject({ status: 400 });
    await expect(setMemberProfile(env, member.userId, { name: "y".repeat(61) })).rejects.toMatchObject({ status: 400 });
    await expect(setMemberProfile(env, member.userId, { email: "nope" })).rejects.toMatchObject({ status: 400 });
    // The good path is untouched, including clearing an email with null/"".
    await expect(setMemberProfile(env, member.userId, { name: "Ada Lovelace", email: "ada@co.io" })).resolves.toBeUndefined();
    await expect(setMemberProfile(env, member.userId, { email: "" })).resolves.toBeUndefined();
  });

  it("idx_users_email exists and enforces what the pre-check cannot", async () => {
    const { env } = await makeEnv();
    // The constraint is schema, not behaviour: prove it is there, and that a raw
    // INSERT which never ran the app-level guard still cannot double-book an
    // address. NULL emails stay exempt, as they must — most members have none.
    const index = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_email'`,
    ).first();
    expect(index).toBeTruthy();
    await createMember(env, { name: "A", email: "a@co.io" });
    await createMember(env, { name: "NoEmail1" });
    await createMember(env, { name: "NoEmail2" });
    await expect(
      env.DB.prepare(
        `INSERT INTO users (id, name, email, role, token_hash, suspended, created_at)
         VALUES ('usr-race', 'R', 'a@co.io', 'member', 'hash-race', 0, 1)`,
      ).run(),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  it("maps a lost unique-index race to the same 409 the pre-check produces", async () => {
    const { env } = await makeEnv();
    await createMember(env, { name: "A", email: "a@co.io" });
    // Simulate the race the pre-check cannot close: it runs, finds nothing, and
    // a concurrent writer commits the same email before this batch lands. Blind
    // the pre-check and let the index decide — the loser must read as 409, not 500.
    const original = env.DB.prepare.bind(env.DB);
    (env.DB as unknown as { prepare: unknown }).prepare = (sql: string) => {
      if (sql.includes("SELECT id FROM users WHERE email = ?")) {
        return {
          bind: () => ({ first: async () => null }),
          first: async () => null,
        } as unknown as ReturnType<typeof original>;
      }
      return original(sql);
    };
    await expect(createMember(env, { name: "B", email: "a@co.io" })).rejects.toMatchObject({
      status: 409,
      message: "A member with that email already exists",
    });
  });

  it("refuses to rotate a token or set a default share for a removed member", async () => {
    const { env, roots } = await makeEnv();
    const { member } = await createMember(env, { name: "Ada" });
    await removeMember(env, roots.ownerUserId, member.userId);
    // Both writes used to succeed against the tombstone — the rotated token was
    // a credential-shaped dead end no identity could ever resolve.
    await expect(rotateMemberToken(env, member.userId)).rejects.toMatchObject({
      status: 404,
      message: `No member found with ID: ${member.userId}`,
    });
    await expect(setMemberDefaultShare(env, member.userId, "company")).rejects.toMatchObject({
      status: 404,
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

  it("atomically preserves one active admin when two admins suspend each other", async () => {
    const { env, roots } = await makeEnv();
    const { member: ada } = await createMember(env, { name: "Ada", role: "admin" });

    const results = await Promise.allSettled([
      setMemberSuspended(env, ada.userId, roots.ownerUserId, true),
      setMemberSuspended(env, roots.ownerUserId, ada.userId, true),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { status: 400, message: "Cannot suspend the last active admin" },
    });
    expect(await activeAdminIds(env)).toHaveLength(1);
  });

  it("allows concurrent suspension of ordinary members", async () => {
    const { env, roots } = await makeEnv();
    const { member: ada } = await createMember(env, { name: "Ada" });
    const { member: bob } = await createMember(env, { name: "Bob" });

    await expect(Promise.all([
      setMemberSuspended(env, roots.ownerUserId, ada.userId, true),
      setMemberSuspended(env, roots.ownerUserId, bob.userId, true),
    ])).resolves.toEqual([undefined, undefined]);
    expect(await activeAdminIds(env)).toEqual([roots.ownerUserId]);
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

  describe("removeMember", () => {
    it("deletes the personal workspace and private entries — but keeps shared ones and soft-deletes the identity", async () => {
      const { env, roots } = await makeEnv();
      const { member } = await createMember(env, { name: "Ada" });
      // One private memory, one shared to company, one vector id on each.
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES ('p1', 'private', '[]', 'api', 1, '["v-p1"]', ?, ?)`,
        ).bind(member.personalWorkspaceId, member.userId),
        env.DB.prepare(
          `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES ('c1', 'shared', '[]', 'api', 2, '["v-c1"]', ?, ?)`,
        ).bind(roots.companyWorkspaceId, member.userId),
        env.DB.prepare(
          `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id) VALUES ('e1', 'p1', 'c1', 'relates_to', 0.5, 'explicit', '{}', 1, 1, ?)`,
        ).bind(member.personalWorkspaceId),
      ]);

      const result = await removeMember(env, roots.ownerUserId, member.userId);
      expect(result.removedEntries).toBe(1);
      expect(result.vectorIds).toEqual(["v-p1"]);

      // Personal workspace: gone. User row: soft-deleted, not erased.
      const user = await env.DB.prepare(`SELECT removed_at FROM users WHERE id = ?`).bind(member.userId).first<{ removed_at: number | null }>();
      expect(user?.removed_at).toBeTruthy();
      const ws = await env.DB.prepare(`SELECT id FROM workspaces WHERE id = ?`).bind(member.personalWorkspaceId).first();
      expect(ws).toBeNull();
      // Private row and its edge: gone. Shared row: stays, with its author on record.
      const shared = await env.DB.prepare(`SELECT actor_id FROM entries WHERE id = 'c1'`).first<{ actor_id: string }>();
      expect(shared?.actor_id).toBe(member.userId);
      const orphanEdge = await env.DB.prepare(`SELECT id FROM edges WHERE id = 'e1'`).first();
      expect(orphanEdge).toBeNull();
      const danglingShared = await env.DB.prepare(`SELECT id FROM entries WHERE id = 'p1'`).first();
      expect(danglingShared).toBeNull();
    });

    it("refuses self-removal and last-active-admin removal", async () => {
      const { env, roots } = await makeEnv();
      await expect(removeMember(env, roots.ownerUserId, roots.ownerUserId)).rejects.toMatchObject({ status: 400 });
      const { member } = await createMember(env, { name: "Ada", role: "admin" });
      // Make the owner inactive directly (the suspension route blocks self-
      // suspension by design) so Ada becomes the only active admin.
      await env.DB.prepare(`UPDATE users SET suspended = 1 WHERE id = ?`).bind(roots.ownerUserId).run();
      await expect(removeMember(env, roots.ownerUserId, member.userId)).rejects.toMatchObject({ status: 400 });
    });

    it("atomically preserves one active admin when two admins remove each other", async () => {
      const { env, roots } = await makeEnv();
      const { member: ada } = await createMember(env, { name: "Ada", role: "admin" });

      const results = await Promise.allSettled([
        removeMember(env, ada.userId, roots.ownerUserId),
        removeMember(env, roots.ownerUserId, ada.userId),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        reason: { status: 400, message: "Cannot remove the last active admin" },
      });
      expect(await activeAdminIds(env)).toHaveLength(1);
    });

    it("preserves one active admin when suspension races removal", async () => {
      const { env, roots } = await makeEnv();
      const { member: ada } = await createMember(env, { name: "Ada", role: "admin" });

      const results = await Promise.allSettled([
        setMemberSuspended(env, ada.userId, roots.ownerUserId, true),
        removeMember(env, roots.ownerUserId, ada.userId),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(await activeAdminIds(env)).toHaveLength(1);
    });

    it("resumes cleanup after the account was claimed but its cleanup batch failed", async () => {
      const { env, roots } = await makeEnv();
      const { member, token } = await createMember(env, { name: "Ada" });
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
         VALUES ('retry-private', 'private', '[]', 'api', 1, '["retry-vector"]', ?, ?)`,
      ).bind(member.personalWorkspaceId, member.userId).run();

      const originalBatch = env.DB.batch.bind(env.DB);
      let failCleanup = true;
      env.DB.batch = (async (statements: D1PreparedStatement[]) => {
        if (failCleanup) {
          failCleanup = false;
          throw new Error("injected cleanup failure");
        }
        return originalBatch(statements);
      }) as Env["DB"]["batch"];

      await expect(removeMember(env, roots.ownerUserId, member.userId)).rejects.toThrow("injected cleanup failure");

      const claimed = await env.DB.prepare(
        `SELECT removed_at FROM users WHERE id = ?`,
      ).bind(member.userId).first<{ removed_at: number | null }>();
      expect(Number(claimed?.removed_at)).toBeGreaterThan(0);
      expect(await env.DB.prepare(
        `SELECT id FROM workspaces WHERE id = ?`,
      ).bind(member.personalWorkspaceId).first()).not.toBeNull();

      const { resolveIdentityFromToken } = await import("../../src/lib/identity");
      expect(await resolveIdentityFromToken(token, env)).toBeNull();

      const retried = await removeMember(env, roots.ownerUserId, member.userId);
      expect(retried).toEqual({ removedEntries: 1, vectorIds: ["retry-vector"] });
      expect(await env.DB.prepare(
        `SELECT id FROM workspaces WHERE id = ?`,
      ).bind(member.personalWorkspaceId).first()).toBeNull();
      expect(await env.DB.prepare(
        `SELECT id FROM entries WHERE id = 'retry-private'`,
      ).first()).toBeNull();
    });

    it("removes ordinary members concurrently without weakening the admin invariant", async () => {
      const { env, roots } = await makeEnv();
      const { member: ada } = await createMember(env, { name: "Ada" });
      const { member: bob } = await createMember(env, { name: "Bob" });

      await expect(Promise.all([
        removeMember(env, roots.ownerUserId, ada.userId),
        removeMember(env, roots.ownerUserId, bob.userId),
      ])).resolves.toHaveLength(2);
      expect(await activeAdminIds(env)).toEqual([roots.ownerUserId]);
    });
  });
});
