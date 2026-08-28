import { describe, expect, it } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import type { Env } from "../../src/env";
import { hashToken } from "../../src/lib/identity";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { captureEntry } from "../../src/capture/entry";
import { moveEntry } from "../../src/capture/share";

/** A second member with their own personal workspace and a membership in company. */
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

async function makeEnv() {
  const d1 = makeSqliteD1();
  // Full mock bindings (AI/Vectorize/KV) so captureEntry's embed + classification
  // paths run; the DB underneath is real SQLite.
  const env = { ...makeTestEnv(d1.db as unknown as D1Mock), AUTH_TOKEN: "owner-token" } as Env;
  const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;
  // The runtime ALTERs (updated_at et al.) before any capture. The init memo is
  // module-scoped, so each fresh database needs the seam reset first.
  resetDatabaseInit();
  await initializeDatabase(env);
  return { env, ctx };
}

describe("share semantics", () => {
  it("moves an entry and its edges to the company workspace and back", async ({ }) => {
    const { env, ctx } = await makeEnv();
    const roots = await ensureTenantBootstrap(env);
    const owner = {
      userId: roots.ownerUserId,
      role: "admin" as const,
      personalWorkspaceId: roots.ownerPersonalWorkspaceId,
      companyWorkspaceIds: [roots.companyWorkspaceId],
      defaultShare: "" as const,
    };
    await captureEntry("Q3 pricing decision", ["work"], "api", env, ctx, undefined, {
      workspaceId: owner.personalWorkspaceId,
      actorId: owner.userId,
    });
    const { id } = await env.DB.prepare(`SELECT id FROM entries LIMIT 1`).first<{ id: string }>() ?? {};
    expect(id).toBeTruthy();
    await env.DB.prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id) VALUES ('e1', ?, 'other', 'relates_to', 0.5, 'explicit', '{}', 1, 1, ?)`)
      .bind(id!, owner.personalWorkspaceId).run();

    // Share: row AND edge re-namespace together.
    const shared = await moveEntry(id!, "company", env, owner);
    expect(shared.status).toBe("shared");
    const row = await env.DB.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(id!).first<{ workspace_id: string }>();
    expect(row?.workspace_id).toBe(roots.companyWorkspaceId);
    const edge = await env.DB.prepare(`SELECT workspace_id FROM edges WHERE id = 'e1'`).first<{ workspace_id: string }>();
    expect(edge?.workspace_id).toBe(roots.companyWorkspaceId);

    // Already there: no change, no second move.
    expect((await moveEntry(id!, "company", env, owner)).status).toBe("no_change");

    // Un-share: back to the mover's personal workspace.
    const unshared = await moveEntry(id!, "personal", env, owner);
    expect(unshared.status).toBe("unshared");
    const back = await env.DB.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(id!).first<{ workspace_id: string }>();
    expect(back?.workspace_id).toBe(owner.personalWorkspaceId);
  });

  it("lets a member share their own entry but only the author or an admin un-share someone else's", async () => {
    const { env, ctx } = await makeEnv();
    const roots = await ensureTenantBootstrap(env);
    await seedMember(env, "u-b", "b-token", roots.companyWorkspaceId);
    const memberB = {
      userId: "u-b",
      role: "member" as const,
      personalWorkspaceId: "ws-u-b",
      companyWorkspaceIds: [roots.companyWorkspaceId],
      defaultShare: "" as const,
    };

    // B captures privately...
    const result = await captureEntry("B's private note", [], "api", env, ctx, undefined, {
      workspaceId: memberB.personalWorkspaceId,
      actorId: memberB.userId,
    });
    expect(result.status).toBe("stored");
    const { id } = await env.DB.prepare(`SELECT id FROM entries LIMIT 1`).first<{ id: string }>() ?? {};

    // ...shares it to company...
    expect((await moveEntry(id!, "company", env, memberB)).status).toBe("shared");

    // ...and because B is the author, B can take it private again.
    expect((await moveEntry(id!, "personal", env, memberB)).status).toBe("unshared");

    // Now simulate authorship by someone else: actor field rewritten to u-a.
    await env.DB.prepare(`UPDATE entries SET actor_id = 'u-a', workspace_id = ? WHERE id = ?`)
      .bind(roots.companyWorkspaceId, id!).run();
    const memberC = {
      userId: "u-c",
      role: "member" as const,
      personalWorkspaceId: "ws-u-c",
      companyWorkspaceIds: [roots.companyWorkspaceId],
      defaultShare: "" as const,
    };
    await seedMember(env, "u-c", "c-token", roots.companyWorkspaceId);
    expect((await moveEntry(id!, "personal", env, memberC)).status).toBe("forbidden");

    const owner = {
      userId: roots.ownerUserId,
      role: "admin" as const,
      personalWorkspaceId: roots.ownerPersonalWorkspaceId,
      companyWorkspaceIds: [roots.companyWorkspaceId],
      defaultShare: "" as const,
    };
    const byAdmin = await moveEntry(id!, "personal", env, owner);
    expect(byAdmin.status).toBe("unshared");
    // The admin moved it into THEIR personal workspace, per scopeWrite.
    const row = await env.DB.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind(id!).first<{ workspace_id: string }>();
    expect(row?.workspace_id).toBe(roots.ownerPersonalWorkspaceId);
  });

  it("reads another member's private entry as missing, never as forbidden", async () => {
    const { env, ctx } = await makeEnv();
    const roots = await ensureTenantBootstrap(env);
    await seedMember(env, "u-b", "b-token", roots.companyWorkspaceId);
    await seedMember(env, "u-c", "c-token", roots.companyWorkspaceId);
    await captureEntry("C's secret", [], "api", env, ctx, undefined, {
      workspaceId: "ws-u-c",
      actorId: "u-c",
    });
    const { id } = await env.DB.prepare(`SELECT id FROM entries LIMIT 1`).first<{ id: string }>() ?? {};
    const memberB = {
      userId: "u-b",
      role: "member" as const,
      personalWorkspaceId: "ws-u-b",
      companyWorkspaceIds: [roots.companyWorkspaceId],
      defaultShare: "" as const,
    };
    // Invisible ids read as absent — existence is not leaked through the error.
    expect((await moveEntry(id!, "company", env, memberB)).status).toBe("not_found");
  });

  it("audits shares as immutable events", async () => {
    const { env, ctx } = await makeEnv();
    const roots = await ensureTenantBootstrap(env);
    const owner = {
      userId: roots.ownerUserId,
      role: "admin" as const,
      personalWorkspaceId: roots.ownerPersonalWorkspaceId,
      companyWorkspaceIds: [roots.companyWorkspaceId],
      defaultShare: "" as const,
    };
    await captureEntry("to be shared", [], "api", env, ctx, undefined, {
      workspaceId: owner.personalWorkspaceId,
      actorId: owner.userId,
    });
    const { id } = await env.DB.prepare(`SELECT id FROM entries LIMIT 1`).first<{ id: string }>() ?? {};
    // Route-level audit: exercise the same helper the REST/MCP surfaces call.
    const { auditEvent } = await import("../../src/lib/audit");
    const moved = await moveEntry(id!, "company", env, owner);
    auditEvent(env, ctx, { entryId: id!, actorId: owner.userId, event: moved.status === "shared" ? "shared" : "unshared", payload: { workspaceId: roots.companyWorkspaceId } });
    // waitUntil is synchronous here, so the insert has already been issued.
    const event = await env.DB.prepare(`SELECT entry_id, actor_id, event FROM entry_events ORDER BY created_at DESC LIMIT 1`).first<{ entry_id: string; actor_id: string; event: string }>();
    expect(event?.event).toBe("shared");
    expect(event?.entry_id).toBe(id!);
    expect(event?.actor_id).toBe(roots.ownerUserId);
  });
});
