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

  it("moves the D1 row even when vector_ids is malformed, and returns an empty vectorIds rather than throwing", async () => {
    const { env } = await makeEnv();
    const roots = await ensureTenantBootstrap(env);
    const owner = {
      userId: roots.ownerUserId,
      role: "admin" as const,
      personalWorkspaceId: roots.ownerPersonalWorkspaceId,
      companyWorkspaceIds: [roots.companyWorkspaceId],
      defaultShare: "" as const,
    };
    // Unreachable via captureEntry (vector_ids is NOT NULL DEFAULT '[]' and
    // always written as a JSON array) — this simulates a corrupted row
    // directly, the case the try/catch around the parse exists for.
    await env.DB.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, '[]', 'api', ?, 'not-json', ?, ?)`
    ).bind("bad-vec-entry", "entry with a corrupted vector_ids column", Date.now(), owner.personalWorkspaceId, owner.userId).run();

    const result = await moveEntry("bad-vec-entry", "company", env, owner);
    expect(result.status).toBe("shared");
    if (result.status === "shared") expect(result.vectorIds).toEqual([]);

    const row = await env.DB.prepare(`SELECT workspace_id FROM entries WHERE id = ?`).bind("bad-vec-entry").first<{ workspace_id: string }>();
    expect(row?.workspace_id).toBe(roots.companyWorkspaceId);
  });
});

/**
 * Task 15a. `edges.workspace_id` is denormalized from the entry, so a share has
 * to carry every edge the entry is an endpoint of — and `edgeInsertStatement`
 * REORDERS a symmetric pair lexically, so which endpoint column the moved entry
 * occupies is decided by its id, not by who linked what.
 *
 * Re-stamping `WHERE source_id = ?` alone therefore moved an X<->Y `relates_to`
 * edge only when `X < Y`. On the other half of the ids the entry moved to the
 * company layer and its edge stayed behind in the sharer's personal workspace,
 * pointing at a row that is no longer there.
 *
 * Both orderings are asserted below, from ids chosen for their sort order rather
 * than generated — a test that happened to draw `X < Y` passes against the
 * unfixed code and proves nothing.
 */
describe("a share carries every edge the entry is an endpoint of", () => {
  async function ownerBrain() {
    const { env, ctx } = await makeEnv();
    const roots = await ensureTenantBootstrap(env);
    const owner = {
      userId: roots.ownerUserId,
      role: "admin" as const,
      personalWorkspaceId: roots.ownerPersonalWorkspaceId,
      companyWorkspaceIds: [roots.companyWorkspaceId],
      defaultShare: "" as const,
    };
    const put = async (id: string, content: string) => {
      await env.DB.prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id)
         VALUES (?, ?, '[]', 'api', ?, ?, '[]', ?, ?)`,
      ).bind(id, content, Date.now(), Date.now(), owner.personalWorkspaceId, owner.userId).run();
    };
    const edgeRow = async (edgeId: string) => await env.DB
      .prepare(`SELECT source_id, target_id, workspace_id FROM edges WHERE id = ?`)
      .bind(edgeId)
      .first<{ source_id: string; target_id: string; workspace_id: string }>();
    return { env, ctx, roots, owner, put, edgeRow };
  }

  // The half that already worked. Kept so the fix is shown to be a widening of
  // the re-stamp and not a swap of one broken half for the other.
  it("follows a symmetric edge when the shared entry sorts FIRST", async () => {
    const { env, roots, owner, put, edgeRow } = await ownerBrain();
    await put("aaa-shared", "Owner: the pricing decision");
    await put("zzz-other", "Owner: the note that explains it");
    // Stored exactly as edgeInsertStatement would: min(id) in source_id.
    await env.DB.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES ('sym-first', 'aaa-shared', 'zzz-other', 'relates_to', 0.5, 'explicit', '{}', 1, 1, ?)`,
    ).bind(owner.personalWorkspaceId).run();

    expect((await moveEntry("aaa-shared", "company", env, owner)).status).toBe("shared");

    expect(await edgeRow("sym-first")).toEqual({
      source_id: "aaa-shared",
      target_id: "zzz-other",
      workspace_id: roots.companyWorkspaceId,
    });
  });

  it("follows a symmetric edge when the shared entry sorts SECOND", async () => {
    const { env, roots, owner, put, edgeRow } = await ownerBrain();
    await put("aaa-other", "Owner: the note that explains it");
    await put("zzz-shared", "Owner: the pricing decision");
    // The same link, the same two entries — only the ids sort the other way, so
    // the lexical reorder puts the entry being shared in target_id.
    await env.DB.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES ('sym-second', 'aaa-other', 'zzz-shared', 'relates_to', 0.5, 'explicit', '{}', 1, 1, ?)`,
    ).bind(owner.personalWorkspaceId).run();

    expect((await moveEntry("zzz-shared", "company", env, owner)).status).toBe("shared");

    // Endpoints untouched: only the layer changed.
    expect(await edgeRow("sym-second")).toEqual({
      source_id: "aaa-other",
      target_id: "zzz-shared",
      workspace_id: roots.companyWorkspaceId,
    });
  });

  it("keeps an asymmetric edge pointing the way it was written", async () => {
    // `supersedes` is directed, so edgeInsertStatement never reorders it and the
    // shared entry can legitimately be the TARGET. Direction is meaning here —
    // "the draft supersedes the decision" is not the claim — so the fix must
    // change workspace_id and nothing else.
    const { env, roots, owner, put, edgeRow } = await ownerBrain();
    await put("zzz-superseder", "Owner: the corrected fact");
    await put("aaa-shared", "Owner: the fact it corrected");
    await env.DB.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES ('asym', 'zzz-superseder', 'aaa-shared', 'supersedes', 1.0, 'system', '{}', 1, 1, ?)`,
    ).bind(owner.personalWorkspaceId).run();

    expect((await moveEntry("aaa-shared", "company", env, owner)).status).toBe("shared");

    expect(await edgeRow("asym")).toEqual({
      source_id: "zzz-superseder",
      target_id: "aaa-shared",
      workspace_id: roots.companyWorkspaceId,
    });
  });

  it("leaves an edge the entry is not an endpoint of alone", async () => {
    // The re-stamp widened from source_id to either endpoint, not to the table.
    const { env, owner, put, edgeRow } = await ownerBrain();
    await put("zzz-shared", "Owner: the pricing decision");
    await put("aaa-one", "Owner: unrelated one");
    await put("bbb-two", "Owner: unrelated two");
    await env.DB.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES ('bystander', 'aaa-one', 'bbb-two', 'relates_to', 0.5, 'explicit', '{}', 1, 1, ?)`,
    ).bind(owner.personalWorkspaceId).run();

    await moveEntry("zzz-shared", "company", env, owner);

    expect((await edgeRow("bystander"))?.workspace_id).toBe(owner.personalWorkspaceId);
  });

  it("returns the edge to the personal layer when the entry is un-shared again", async () => {
    // The round trip, which is where a half-fixed re-stamp would show up as an
    // edge stranded in the company layer after the entry came back. Both
    // endpoints' columns are asserted, so the un-share is shown not to have
    // rewritten them either.
    const { env, roots, owner, put, edgeRow } = await ownerBrain();
    await put("zzz-solo", "Solo: the decision");
    await put("aaa-solo", "Solo: the reason");
    await env.DB.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, provenance, metadata, created_at, updated_at, workspace_id)
       VALUES ('solo', 'aaa-solo', 'zzz-solo', 'relates_to', 0.5, 'explicit', '{}', 1, 1, ?)`,
    ).bind(owner.personalWorkspaceId).run();

    await moveEntry("zzz-solo", "company", env, owner);
    expect((await edgeRow("solo"))?.workspace_id).toBe(roots.companyWorkspaceId);

    await moveEntry("zzz-solo", "personal", env, owner);
    expect(await edgeRow("solo")).toEqual({
      source_id: "aaa-solo",
      target_id: "zzz-solo",
      workspace_id: owner.personalWorkspaceId,
    });
  });
});
