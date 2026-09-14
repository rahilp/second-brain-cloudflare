import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { resolveIdentityFromToken, type Identity } from "../../src/lib/identity";
import { createMember } from "../../src/lib/team-admin";
import { defaultHandler } from "../../src/routes";
import { buildMcpServer } from "../../src/mcp/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { PromptCapsulePayload } from "../../src/prompt-capsule/build";
import { promptCapsuleCacheKey } from "../../src/prompt-capsule/cache";
import { strongEtag } from "../../src/prompt-capsule/etag";
import {
  PROMPT_CAPSULE_MAX_CANDIDATES,
  PROMPT_CAPSULE_MAX_CHARS,
  PROMPT_CAPSULE_MAX_ENTRY_ID_CHARS,
  PROMPT_CAPSULE_MAX_TAG_CHARS,
} from "../../src/prompt-capsule/types";

const ctx = { waitUntil: (_promise: Promise<unknown>) => {} } as ExecutionContext;

describe("prompt capsule routes", () => {
  let sqlite: SqliteD1;
  let env: Env;
  let identity: Identity;

  beforeEach(async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    env = makeTestEnv(undefined, {
      DB: sqlite.db as unknown as D1Database,
      OAUTH_KV: makeMemoryKV(),
      AUTH_TOKEN: "test-token",
    });
    const resolved = await resolveIdentityFromToken("test-token", env);
    if (!resolved) throw new Error("owner identity was not bootstrapped");
    identity = resolved;
  });

  afterEach(() => sqlite.close());

  async function seed(
    id: string,
    content: string,
    tags: string[],
    workspaceId = identity.personalWorkspaceId,
  ): Promise<void> {
    sqlite.seed({ id, content, tags, createdAt: 1000 });
    await sqlite.db.prepare(`UPDATE entries SET workspace_id = ?, actor_id = ? WHERE id = ?`)
      .bind(workspaceId, identity.userId, id).run();
  }

  function conditionalRequest(method: string, path: string, etag?: string): Request {
    const base = req(method, path);
    if (!etag) return base;
    const headers = new Headers(base.headers);
    headers.set("If-None-Match", etag);
    return new Request(base, { headers });
  }

  it("returns a deterministic private core capsule with ETag, HEAD, and 304 support", async () => {
    await seed("mem-constraints", "Never expose credentials.  \r\n", [
      "capsule:core", "capsule-slot:constraints", "status:canonical",
    ]);
    await seed("mem-identity", "The user prefers concise answers.", [
      "capsule:core", "capsule-slot:identity", "status:canonical",
    ]);
    await seed("mem-draft", "This must not enter the prompt.", [
      "capsule:core", "capsule-slot:preferences", "status:draft",
    ]);
    await seed("mem-malformed-draft", "This must not block the Capsule.", [
      "capsule:core", "capsule:project:not-active", "capsule-slot:not-a-slot", "status:draft",
    ]);

    const first = await defaultHandler.fetch(req("GET", "/prompt-capsules/core"), env, ctx);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/vnd.second-brain.prompt-capsule+json");
    expect(first.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"pcv1-[0-9a-f]{64}"$/);

    const bodyText = await first.text();
    const body = JSON.parse(bodyText) as PromptCapsulePayload;
    const byteLength = String(new TextEncoder().encode(bodyText).length);
    expect(first.headers.get("content-length")).toBe(byteLength);
    expect(body).toMatchObject({
      ok: true,
      schema: "prompt-capsule.v1",
      kind: "core",
      workspace: "personal",
      team: null,
      complete: true,
      omitted_slots: [],
    });
    expect(body.sections).toEqual([
      { slot: "identity", source_entry_id: "mem-identity" },
      { slot: "constraints", source_entry_id: "mem-constraints" },
    ]);
    expect(JSON.parse(body.text).sections).toEqual([
      { slot: "identity", content: "The user prefers concise answers." },
      { slot: "constraints", content: "Never expose credentials." },
    ]);
    expect(body.text).not.toContain("mem-identity");
    expect(body.text).not.toContain("mem-constraints");
    expect(body.text).not.toContain("mem-draft");
    expect(body.text).not.toContain("mem-malformed-draft");
    expect(body.text).not.toContain("This must not block the Capsule");

    const head = await defaultHandler.fetch(conditionalRequest("HEAD", "/prompt-capsules/core"), env, ctx);
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBe(etag);
    expect(head.headers.get("content-length")).toBe(byteLength);
    expect(await head.text()).toBe("");

    const cached = await defaultHandler.fetch(
      conditionalRequest("GET", "/prompt-capsules/core", etag!), env, ctx,
    );
    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
    expect(await cached.text()).toBe("");

    await sqlite.db.prepare(`UPDATE entries SET content = ? WHERE id = ?`)
      .bind("The user prefers concise answers in Japanese.", "mem-identity").run();
    const changed = await defaultHandler.fetch(
      conditionalRequest("GET", "/prompt-capsules/core", etag!), env, ctx,
    );
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    expect((await changed.json() as PromptCapsulePayload).text).toContain("in Japanese");
  });

  it("allows browser clients to preflight HEAD and ETag revalidation", async () => {
    const response = await defaultHandler.fetch(
      req("OPTIONS", "/prompt-capsules/core", { token: null }), env, ctx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-methods")).toContain("HEAD");
    expect(response.headers.get("access-control-allow-headers")).toContain("If-None-Match");
  });

  it("keeps text, hash, and ETag stable when only timestamps or unrelated memories change", async () => {
    await seed("stable-identity", "Stable identity", [
      "capsule:core", "capsule-slot:identity", "status:canonical",
    ]);
    const first = await defaultHandler.fetch(req("GET", "/prompt-capsules/core"), env, ctx);
    const firstBody = await first.json() as PromptCapsulePayload;
    const firstEtag = first.headers.get("etag");

    await sqlite.db.prepare(`UPDATE entries SET updated_at = ? WHERE id = ?`)
      .bind(999999, "stable-identity").run();
    await seed("unrelated", "This must not affect the Capsule", ["work", "status:canonical"]);

    const second = await defaultHandler.fetch(req("GET", "/prompt-capsules/core"), env, ctx);
    const secondBody = await second.json() as PromptCapsulePayload;
    expect(secondBody.text).toBe(firstBody.text);
    expect(secondBody.prompt_hash).toBe(firstBody.prompt_hash);
    expect(second.headers.get("etag")).toBe(firstEtag);
  });

  it("keeps Capsule bookkeeping out of human topic summaries", async () => {
    await seed("topic-summary", "A project constraint", [
      "work", "capsule:core", "capsule-slot:constraints", "status:canonical",
    ]);
    await sqlite.db.prepare(`UPDATE entries SET created_at = ? WHERE id = ?`)
      .bind(Date.now(), "topic-summary").run();

    const stats = await defaultHandler.fetch(req("GET", "/stats"), env, ctx);
    expect(stats.status).toBe(200);
    const topTags = (await stats.json() as { top_tags: string[] }).top_tags;
    expect(topTags).toContain("work");
    expect(topTags).not.toContain("capsule:core");
    expect(topTags).not.toContain("capsule-slot:constraints");

    const brief = await defaultHandler.fetch(req("GET", "/brief"), env, ctx);
    expect(brief.status).toBe(200);
    const topics = (await brief.json() as { topics: Array<{ tag: string }> }).topics.map(topic => topic.tag);
    expect(topics).toContain("work");
    expect(topics).not.toContain("capsule:core");
    expect(topics).not.toContain("capsule-slot:constraints");
  });

  it("returns the exact REST capsule and ETag through authenticated MCP", async () => {
    await seed("mem-constraints", "Never expose credentials.", [
      "capsule:core", "capsule-slot:constraints", "status:canonical",
    ]);
    const rest = await defaultHandler.fetch(req("GET", "/prompt-capsules/core"), env, ctx);
    const restPayload = await rest.json();
    const restEtag = rest.headers.get("etag");

    const server = buildMcpServer(env, ctx, identity);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "prompt-capsule-test", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({
        name: "get_prompt_capsule",
        arguments: { kind: "core", workspace: "personal" },
      });
      expect(result.isError).toBeFalsy();
      const output = result.content as Array<{ type: string; text?: string }>;
      const envelope = JSON.parse(output[0]?.text ?? "null");
      expect(envelope).toEqual({
        ok: true,
        schema: "prompt-capsule-mcp.v1",
        etag: restEtag,
        capsule: restPayload,
      });

      const failed = await client.callTool({
        name: "get_prompt_capsule",
        arguments: { kind: "project", workspace: "personal" },
      });
      expect(failed.isError).toBe(true);
      const failedOutput = failed.content as Array<{ type: string; text?: string }>;
      expect(JSON.parse(failedOutput[0]?.text ?? "null")).toMatchObject({
        ok: false,
        schema: "prompt-capsule-mcp.v1",
        status: 400,
        code: "invalid_request",
      });
    } finally {
      await client.close();
    }
  });

  it("keeps personal and company capsules separate and requires a team when ambiguous", async () => {
    const primaryTeam = identity.companyWorkspaceIds[0];
    if (!primaryTeam) throw new Error("bootstrap company workspace is missing");
    await seed("private-core", "Private constraint", [
      "capsule:core", "capsule-slot:constraints", "status:canonical",
    ]);
    await seed("company-core", "Company constraint", [
      "capsule:core", "capsule-slot:constraints", "status:canonical",
    ], primaryTeam);

    const personal = await defaultHandler.fetch(req("GET", "/prompt-capsules/core"), env, ctx);
    expect((await personal.json() as PromptCapsulePayload).text).toContain("Private constraint");

    const company = await defaultHandler.fetch(
      req("GET", "/prompt-capsules/core?workspace=company"), env, ctx,
    );
    const companyBody = await company.json() as PromptCapsulePayload;
    expect(companyBody.team).toBe(primaryTeam);
    expect(companyBody.text).toContain("Company constraint");
    expect(companyBody.text).not.toContain("Private constraint");

    const secondTeam = "ws-company-second";
    await sqlite.db.prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'company', ?, ?)`)
      .bind(secondTeam, "Second", 2000).run();
    await sqlite.db.prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, ?, ?)`)
      .bind(identity.userId, secondTeam, 2000).run();

    const ambiguous = await defaultHandler.fetch(
      req("GET", "/prompt-capsules/core?workspace=company"), env, ctx,
    );
    expect(ambiguous.status).toBe(400);
    const ambiguousBody = await ambiguous.json() as { code: string; error: string };
    expect(ambiguousBody.code).toBe("invalid_request");
    expect(ambiguousBody.error).toContain("team is required");

    const scoped = await defaultHandler.fetch(
      req("GET", `/prompt-capsules/core?workspace=company&team=${encodeURIComponent(primaryTeam)}`),
      env,
      ctx,
    );
    expect(scoped.status).toBe(200);
    expect((await scoped.json() as PromptCapsulePayload).text).toContain("Company constraint");
  });

  it("keeps different users' Personal Capsules isolated", async () => {
    const other = await createMember(env, { name: "Other member" });
    await seed("owner-private", "Owner-only constraint", [
      "capsule:core", "capsule-slot:constraints", "status:canonical",
    ]);
    await seed("other-private", "Other-only constraint", [
      "capsule:core", "capsule-slot:constraints", "status:canonical",
    ], other.member.personalWorkspaceId);

    const ownerResponse = await defaultHandler.fetch(req("GET", "/prompt-capsules/core"), env, ctx);
    expect(ownerResponse.status).toBe(200);
    const ownerText = (await ownerResponse.json() as PromptCapsulePayload).text;
    expect(ownerText).toContain("Owner-only constraint");
    expect(ownerText).not.toContain("Other-only constraint");

    const otherResponse = await defaultHandler.fetch(
      req("GET", "/prompt-capsules/core", { token: other.token }), env, ctx,
    );
    expect(otherResponse.status).toBe(200);
    const otherText = (await otherResponse.json() as PromptCapsulePayload).text;
    expect(otherText).toContain("Other-only constraint");
    expect(otherText).not.toContain("Owner-only constraint");
  });

  it("never serves a company Capsule to another member after its entry is unshared", async () => {
    const companyWorkspaceId = identity.companyWorkspaceIds[0];
    if (!companyWorkspaceId) throw new Error("bootstrap company workspace is missing");
    const other = await createMember(env, { name: "Other member" });
    await seed("shared-secret", "Shared until explicitly withdrawn", [
      "capsule:core", "capsule-slot:constraints", "status:canonical",
    ], companyWorkspaceId);

    const path = "/prompt-capsules/core?workspace=company";
    const warm = await defaultHandler.fetch(req("GET", path, { token: other.token }), env, ctx);
    expect(warm.status).toBe(200);
    const staleEtag = warm.headers.get("etag")!;
    expect((await warm.json() as PromptCapsulePayload).text).toContain("explicitly withdrawn");

    const unshared = await defaultHandler.fetch(req("POST", "/share", {
      body: { id: "shared-secret", workspace: "personal" },
    }), env, ctx);
    expect(unshared.status).toBe(200);

    const base = req("GET", path, { token: other.token });
    const headers = new Headers(base.headers);
    headers.set("If-None-Match", staleEtag);
    const after = await defaultHandler.fetch(new Request(base, { headers }), env, ctx);
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(staleEtag);
    expect((await after.json() as PromptCapsulePayload).sections).toEqual([]);
  });

  it("serves project capsules and rejects ambiguous, malformed, or invalid requests", async () => {
    await seed("project-state", "Current state", [
      "capsule:project:p-123", "capsule-slot:current-state", "status:canonical",
    ]);
    const project = await defaultHandler.fetch(
      req("GET", "/prompt-capsules/projects/p-123"), env, ctx,
    );
    expect(project.status).toBe(200);
    expect(await project.json()).toMatchObject({
      kind: "project",
      project_id: "p-123",
      sections: [{ slot: "current-state", source_entry_id: "project-state" }],
    });

    expect((await defaultHandler.fetch(
      req("GET", "/prompt-capsules/projects/UpperCase"), env, ctx,
    )).status).toBe(400);
    expect((await defaultHandler.fetch(
      req("GET", "/prompt-capsules/projects/%E0%A4%A"), env, ctx,
    )).status).toBe(400);
    const wrongMethod = await defaultHandler.fetch(
      req("POST", "/prompt-capsules/core", { body: {} }), env, ctx,
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET, HEAD");

    // Anonymous callers are refused before the id or method is judged.
    expect((await defaultHandler.fetch(
      req("GET", "/prompt-capsules/projects/UpperCase", { token: null }), env, ctx,
    )).status).toBe(401);
    expect((await defaultHandler.fetch(
      req("POST", "/prompt-capsules/core", { token: null, body: {} }), env, ctx,
    )).status).toBe(401);

    await seed("project-state-2", "Second current state", [
      "capsule:project:p-123", "capsule-slot:current-state", "status:canonical",
    ]);
    const duplicate = await defaultHandler.fetch(
      req("GET", "/prompt-capsules/projects/p-123"), env, ctx,
    );
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      complete: false,
      duplicate_slots: [{ slot: "current-state", entry_ids: ["project-state", "project-state-2"] }],
    });

    const duplicateHead = await defaultHandler.fetch(
      req("HEAD", "/prompt-capsules/projects/p-123"), env, ctx,
    );
    expect(duplicateHead.status).toBe(200);
    expect(await duplicateHead.text()).toBe("");
  });

  it("supports the full 64-character project id without a D1 LIKE pattern", async () => {
    const projectId = `p_${"a".repeat(62)}`;
    await seed("long-project", "Long project state", [
      `capsule:project:${projectId}`,
      "capsule-slot:current-state",
      "status:canonical",
    ]);

    const response = await defaultHandler.fetch(
      req("GET", `/prompt-capsules/projects/${projectId}`), env, ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      project_id: projectId,
      sections: [{ slot: "current-state", source_entry_id: "long-project" }],
    });
    const query = executedSql().find(sql => sql.includes("FROM entries") && sql.includes("instr(lower(tags)"));
    expect(query).toContain("substr(content, 1, ?)");
    expect(query).not.toContain("LIKE");
  });

  it("bounds D1 projections and fails closed on an oversized section", async () => {
    // A truncated prefix of this value normalizes to "Visible prefix". The
    // stored length must therefore drive the refusal, or the route would
    // publish that partial prefix and silently lose the hidden tail.
    const oversized = `Visible prefix${" ".repeat(PROMPT_CAPSULE_MAX_CHARS + 100)}Hidden tail`;
    await seed("oversized", oversized, [
      "capsule:core", "capsule-slot:identity", "status:canonical",
    ]);

    const response = await defaultHandler.fetch(req("GET", "/prompt-capsules/core"), env, ctx);
    expect(response.status).toBe(409);
    const bodyText = await response.text();
    expect(bodyText).not.toContain("Visible prefix");
    expect(bodyText).not.toContain("Hidden tail");
    expect(JSON.parse(bodyText)).toMatchObject({
      code: "invalid_prompt_capsule",
      invalid_entries: [{ entry_id: "oversized", reason: "content-too-large" }],
    });
  });

  it("fails closed before returning an oversized tag document", async () => {
    await seed("oversized-tags", "Definition", [
      "capsule:core", "capsule-slot:identity", "status:canonical",
    ]);
    const oversizedTags = JSON.stringify([
      "capsule:core",
      "capsule-slot:identity",
      "status:canonical",
      "x".repeat(PROMPT_CAPSULE_MAX_TAG_CHARS),
    ]);
    await sqlite.db.prepare(`UPDATE entries SET tags = ? WHERE id = ?`)
      .bind(oversizedTags, "oversized-tags").run();

    const response = await defaultHandler.fetch(req("GET", "/prompt-capsules/core"), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      complete: false,
      invalid_entries: [{ entry_id: "oversized-tags", reason: "malformed-tags" }],
    });
  });

  it("bounds imported entry ids and never reflects an oversized id", async () => {
    const oversizedId = `private-marker-${"x".repeat(PROMPT_CAPSULE_MAX_ENTRY_ID_CHARS)}`;
    const imported = await defaultHandler.fetch(req("POST", "/import", {
      body: {
        version: 2,
        entries: [{
          id: oversizedId,
          content: "Imported definition",
          tags: ["capsule:core", "capsule-slot:identity", "status:canonical"],
          created_at: 1000,
        }],
        edges: [],
      },
    }), env, ctx);
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ imported: 1, failed: 0 });

    const response = await defaultHandler.fetch(req("GET", "/prompt-capsules/core"), env, ctx);
    expect(response.status).toBe(409);
    const bodyText = await response.text();
    expect(bodyText).not.toContain("private-marker");
    expect(JSON.parse(bodyText)).toMatchObject({
      code: "invalid_prompt_capsule",
      invalid_entries: [{ entry_id: "[omitted]", reason: "entry-id-too-large" }],
    });
    const query = executedSql().find(sql => sql.includes("FROM entries") && sql.includes("instr(lower(tags)"));
    expect(query).toContain("substr(id, 1, ?)");
  });

  it("rejects more than the bounded number of canonical candidates", async () => {
    for (let index = 0; index <= PROMPT_CAPSULE_MAX_CANDIDATES; index++) {
      await seed(`candidate-${String(index).padStart(3, "0")}`, `Candidate ${index}`, [
        "capsule:core", "capsule-slot:identity", "status:canonical",
      ]);
    }

    const response = await defaultHandler.fetch(req("GET", "/prompt-capsules/core"), env, ctx);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "too_many_candidates",
      error: `Prompt capsule has more than ${PROMPT_CAPSULE_MAX_CANDIDATES} canonical tagged candidates; clean up the capsule tags before retrying`,
    });
  });

  it("re-slots an entry when POST /update replaces its capsule tags", async () => {
    await seed("slotted", "The user prefers concise answers.", [
      "capsule:core", "capsule-slot:identity", "status:canonical",
    ]);

    const updated = await defaultHandler.fetch(req("POST", "/update", {
      body: {
        id: "slotted",
        content: "The user prefers concise answers.",
        tags: ["capsule:core", "capsule-slot:preferences"],
      },
    }), env, ctx);
    expect(updated.status).toBe(200);

    const response = await defaultHandler.fetch(req("GET", "/prompt-capsules/core"), env, ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as PromptCapsulePayload;
    expect(body.sections).toEqual([{ slot: "preferences", source_entry_id: "slotted" }]);
    expect(body.omitted_slots).toEqual([]);
    expect(body.text).not.toContain("identity");
  });

  function capturingCtx(): { ctx: ExecutionContext; drain: () => Promise<unknown> } {
    const pending: Promise<unknown>[] = [];
    return {
      ctx: { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext,
      drain: () => Promise.allSettled(pending),
    };
  }

  it("includes an entry captured with status:canonical through POST /capture", async () => {
    const capture = capturingCtx();
    const stored = await defaultHandler.fetch(req("POST", "/capture", {
      body: {
        content: "The user prefers concise answers.",
        tags: ["capsule:core", "capsule-slot:identity", "status:canonical"],
      },
    }), env, capture.ctx);
    expect(stored.status).toBe(200);
    const { id } = await stored.json() as { id: string };
    await capture.drain();

    const response = await defaultHandler.fetch(req("GET", "/prompt-capsules/core"), env, ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as PromptCapsulePayload;
    expect(body.sections).toEqual([{ slot: "identity", source_entry_id: id }]);
    expect(JSON.parse(body.text).sections).toEqual([
      { slot: "identity", content: "The user prefers concise answers." },
    ]);
  });

  it("leaves a captured entry without status:canonical out of the capsule", async () => {
    const capture = capturingCtx();
    const stored = await defaultHandler.fetch(req("POST", "/capture", {
      body: {
        content: "The user prefers concise answers.",
        tags: ["capsule:core", "capsule-slot:identity"],
      },
    }), env, capture.ctx);
    expect(stored.status).toBe(200);
    await capture.drain();

    const response = await defaultHandler.fetch(req("GET", "/prompt-capsules/core"), env, ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as PromptCapsulePayload;
    expect(body.sections).toEqual([]);
    expect(body.complete).toBe(false);
  });

  it("fails closed when a tagged canonical row has malformed JSON tags", async () => {
    await seed("malformed", "Bad definition", [
      "capsule:core", "capsule-slot:identity", "status:canonical",
    ]);
    await sqlite.db.prepare(`UPDATE entries SET tags = ? WHERE id = ?`)
      .bind('["capsule:core","capsule-slot:identity","status:canonical"', "malformed").run();

    const response = await defaultHandler.fetch(req("GET", "/prompt-capsules/core"), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      complete: false,
      invalid_entries: [{ entry_id: "malformed", reason: "malformed-tags" }],
    });
  });

  // ── KV cache ───────────────────────────────────────────────────────────────

  /** How many times the capsule candidate scan has hit D1 so far. */
  function executedSql(): string[] {
    return [...sqlite.issued, ...sqlite.batches.flat()];
  }

  function capsuleQueries(): number {
    return executedSql()
      .filter(sql => sql.includes("FROM entries") && sql.includes("instr(lower(tags)")).length;
  }

  function getCore(token?: string): Promise<Response> {
    return defaultHandler.fetch(req("GET", "/prompt-capsules/core", token ? { token } : undefined), env, ctx);
  }

  it("serves a repeat read from KV without rescanning workspace entries", async () => {
    await seed("cached-identity", "Cached identity", [
      "capsule:core", "capsule-slot:identity", "status:canonical",
    ]);
    const first = await getCore();
    expect(first.status).toBe(200);
    const firstText = await first.text();
    const etag = first.headers.get("etag")!;
    expect(capsuleQueries()).toBe(1);

    const second = await getCore();
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(firstText);
    expect(second.headers.get("etag")).toBe(etag);
    expect(capsuleQueries()).toBe(1);

    const revalidated = await defaultHandler.fetch(
      conditionalRequest("GET", "/prompt-capsules/core", etag), env, ctx,
    );
    expect(revalidated.status).toBe(304);
    expect(capsuleQueries()).toBe(1);
  });

  it("does not create KV entries for arbitrary empty project ids", async () => {
    const puts: string[] = [];
    const kv = env.OAUTH_KV;
    const realPut = kv.put.bind(kv);
    env.OAUTH_KV = {
      ...kv,
      put: (async (key: string, ...args: unknown[]) => {
        puts.push(key);
        return (realPut as (...values: unknown[]) => Promise<void>)(key, ...args);
      }) as KVNamespace["put"],
    } as KVNamespace;

    for (let i = 0; i < 20; i++) {
      const response = await defaultHandler.fetch(
        req("GET", `/prompt-capsules/projects/missing-${i}`), env, ctx,
      );
      expect(response.status).toBe(200);
      expect((await response.json() as PromptCapsulePayload).sections).toEqual([]);
    }

    expect(puts.filter(key => key.startsWith("prompt-capsule:"))).toEqual([]);
    expect(capsuleQueries()).toBe(20);
  });

  it("caches a project Capsule once a definition exists", async () => {
    await seed("project-state", "The implementation is ready for review.", [
      "capsule:project:cacheable", "capsule-slot:current-state", "status:canonical",
    ]);
    const path = "/prompt-capsules/projects/cacheable";

    const first = await defaultHandler.fetch(req("GET", path), env, ctx);
    expect(first.status).toBe(200);
    const firstText = await first.text();
    expect(capsuleQueries()).toBe(1);

    const second = await defaultHandler.fetch(req("GET", path), env, ctx);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(firstText);
    expect(capsuleQueries()).toBe(1);
  });

  it("never maps a missing revision row to a reusable sentinel cache key", async () => {
    const empty = await getCore();
    expect(empty.status).toBe(200);
    const staleBodyText = await empty.text();
    const staleEtag = empty.headers.get("etag")!;

    await seed("restored-identity", "Current restored identity", [
      "capsule:core", "capsule-slot:identity", "status:canonical",
    ]);
    const current = await getCore();
    expect((await current.json() as PromptCapsulePayload).text).toContain("Current restored identity");
    expect(capsuleQueries()).toBe(2);

    // Simulate restoring/importing entries without this derived revision row,
    // while a valid-looking cache value addressed by the old fixed sentinel is
    // still inside its KV TTL.
    await sqlite.db.prepare(
      `DELETE FROM prompt_capsule_revisions WHERE workspace_id = ?`,
    ).bind(identity.personalWorkspaceId).run();
    await env.OAUTH_KV.put(
      promptCapsuleCacheKey(identity.personalWorkspaceId, "0", "core"),
      JSON.stringify({ bodyText: staleBodyText, etag: staleEtag }),
    );

    const recovered = await getCore();
    expect(recovered.status).toBe(200);
    expect((await recovered.json() as PromptCapsulePayload).text).toContain("Current restored identity");
    expect(capsuleQueries()).toBe(3);
    const revision = await sqlite.db.prepare(
      `SELECT revision FROM prompt_capsule_revisions WHERE workspace_id = ?`,
    ).bind(identity.personalWorkspaceId).first() as { revision: string } | null;
    expect(revision?.revision).toMatch(/^[0-9a-f]{32}$/);
  });

  it("treats a cached Capsule with mismatched target, prompt hash, or ETag as a miss", async () => {
    await seed("validated-cache", "Validated cache entry", [
      "capsule:core", "capsule-slot:identity", "status:canonical",
    ]);
    const first = await getCore();
    expect(first.status).toBe(200);
    expect(capsuleQueries()).toBe(1);

    const revision = await sqlite.db.prepare(
      `SELECT revision FROM prompt_capsule_revisions WHERE workspace_id = ?`,
    ).bind(identity.personalWorkspaceId).first() as { revision: string } | null;
    if (!revision) throw new Error("capsule revision is missing");
    const key = promptCapsuleCacheKey(identity.personalWorkspaceId, String(revision.revision), "core");

    const cachedText = await env.OAUTH_KV.get(key);
    if (!cachedText) throw new Error("capsule cache value is missing");
    const cached = JSON.parse(cachedText) as { bodyText: string; etag: string };
    const payload = JSON.parse(cached.bodyText) as PromptCapsulePayload;

    const wrongTargetBody = JSON.stringify({ ...payload, workspace: "company" }, null, 2);
    await env.OAUTH_KV.put(key, JSON.stringify({
      bodyText: wrongTargetBody,
      etag: await strongEtag("pcv1", wrongTargetBody),
    }));
    expect((await (await getCore()).json() as PromptCapsulePayload).workspace).toBe("personal");
    expect(capsuleQueries()).toBe(2);

    const wrongHashBody = JSON.stringify({ ...payload, prompt_hash: "sha256:invalid" }, null, 2);
    await env.OAUTH_KV.put(key, JSON.stringify({
      bodyText: wrongHashBody,
      etag: await strongEtag("pcv1", wrongHashBody),
    }));
    expect((await (await getCore()).json() as PromptCapsulePayload).prompt_hash).toBe(payload.prompt_hash);
    expect(capsuleQueries()).toBe(3);

    await env.OAUTH_KV.put(key, JSON.stringify({ bodyText: cached.bodyText, etag: '"wrong"' }));
    expect((await getCore()).headers.get("etag")).toBe(cached.etag);
    expect(capsuleQueries()).toBe(4);
  });

  it("never publishes a stale D1 build into a revision created while that build was in flight", async () => {
    await seed("racing-identity", "Before the concurrent update", [
      "capsule:core", "capsule-slot:identity", "status:canonical",
    ]);

    const realBatch = env.DB.batch.bind(env.DB);
    let injected = false;
    env.DB = {
      ...env.DB,
      batch: (async (statements: D1PreparedStatement[]) => {
        const isCapsuleSnapshot = statements.some(statement =>
          (statement as any).sourceSql?.().includes("instr(lower(tags)"));
        const result = await realBatch(statements);
        if (isCapsuleSnapshot && !injected) {
          injected = true;
          // The old rows and revision were read atomically. The update lands
          // immediately afterwards, so the old payload may be written only to
          // its now-unreachable old revision key.
          await sqlite.db.prepare(`UPDATE entries SET content = ? WHERE id = ?`)
            .bind("After the concurrent update", "racing-identity").run();
        }
        return result;
      }) as D1Database["batch"],
    } as D1Database;

    const racingRead = await getCore();
    expect(racingRead.status).toBe(200);
    expect((await racingRead.json() as PromptCapsulePayload).text).toContain("Before the concurrent update");

    const after = await getCore();
    expect(after.status).toBe(200);
    expect((await after.json() as PromptCapsulePayload).text).toContain("After the concurrent update");
    expect(capsuleQueries()).toBe(2);
  });

  it("does not poison a restored revision key when Time Travel races a build", async () => {
    await seed("time-travel-identity", "Version zero", [
      "capsule:core", "capsule-slot:identity", "status:canonical",
    ]);
    const original = await sqlite.db.prepare(
      `SELECT revision FROM prompt_capsule_revisions WHERE workspace_id = ?`,
    ).bind(identity.personalWorkspaceId).first() as { revision: string } | null;
    if (!original) throw new Error("initial capsule revision is missing");

    const kv = env.OAUTH_KV;
    const realGet = kv.get.bind(kv);
    let updated = false;
    env.OAUTH_KV = {
      ...kv,
      get: (async (key: string, ...args: unknown[]) => {
        if (key.startsWith("prompt-capsule:") && !updated) {
          updated = true;
          // The cache-key revision has already been read; advance the entry and
          // revision immediately before returning the intentional KV miss.
          await sqlite.db.prepare(`UPDATE entries SET content = ? WHERE id = ?`)
            .bind("Version one from the future", "time-travel-identity").run();
        }
        return (realGet as (...values: unknown[]) => Promise<unknown>)(key, ...args);
      }) as KVNamespace["get"],
    } as KVNamespace;

    const realBatch = env.DB.batch.bind(env.DB);
    let restorationInjected = false;
    env.DB = {
      ...env.DB,
      batch: (async (statements: D1PreparedStatement[]) => {
        const isCapsuleSnapshot = statements.some(statement =>
          (statement as any).sourceSql?.().includes("instr(lower(tags)"));
        if (!isCapsuleSnapshot || restorationInjected) return realBatch(statements);
        restorationInjected = true;
        const result = await realBatch(statements);

        // The batch observed both V1 and its R1 revision. Simulate Time Travel
        // completing after that snapshot: content and revision return together
        // to V0/R0.
        await sqlite.db.prepare(`UPDATE entries SET content = ? WHERE id = ?`)
          .bind("Version zero", "time-travel-identity").run();
        await sqlite.db.prepare(
          `UPDATE prompt_capsule_revisions SET revision = ? WHERE workspace_id = ?`,
        ).bind(original.revision, identity.personalWorkspaceId).run();
        return result;
      }) as D1Database["batch"],
    } as D1Database;

    const racing = await getCore();
    expect(racing.status).toBe(200);
    expect((await racing.json() as PromptCapsulePayload).text).toContain("Version one from the future");

    const restored = await getCore();
    expect(restored.status).toBe(200);
    const restoredText = (await restored.json() as PromptCapsulePayload).text;
    expect(restoredText).toContain("Version zero");
    expect(restoredText).not.toContain("Version one from the future");
    expect(capsuleQueries()).toBe(2);
  });

  it("re-queries after POST /update changes a capsule entry", async () => {
    await seed("slotted", "The user prefers concise answers.", [
      "capsule:core", "capsule-slot:identity", "status:canonical",
    ]);
    const before = await getCore();
    expect(before.status).toBe(200);
    expect(capsuleQueries()).toBe(1);

    const updated = await defaultHandler.fetch(req("POST", "/update", {
      body: { id: "slotted", content: "The user prefers concise answers in Japanese." },
    }), env, ctx);
    expect(updated.status).toBe(200);

    const after = await getCore();
    expect(after.status).toBe(200);
    expect(capsuleQueries()).toBe(2);
    expect((await after.json() as PromptCapsulePayload).text).toContain("in Japanese");
    expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
  });

  it("leaves the cache alone when POST /update touches an entry without capsule tags", async () => {
    await seed("slotted", "The user prefers concise answers.", [
      "capsule:core", "capsule-slot:identity", "status:canonical",
    ]);
    await seed("plain", "Groceries: eggs, milk.", ["errand"]);
    const before = await getCore();
    expect(before.status).toBe(200);
    const beforeText = await before.text();
    expect(capsuleQueries()).toBe(1);

    const puts: string[] = [];
    const kv = env.OAUTH_KV;
    const realPut = kv.put.bind(kv);
    kv.put = ((key: string, ...rest: unknown[]) => {
      puts.push(key);
      return (realPut as (...args: unknown[]) => Promise<void>)(key, ...rest);
    }) as typeof kv.put;

    const updated = await defaultHandler.fetch(req("POST", "/update", {
      body: { id: "plain", content: "Groceries: eggs, milk, bread." },
    }), env, ctx);
    expect(updated.status).toBe(200);
    expect(puts.filter(k => k.startsWith("prompt-capsule:"))).toEqual([]);

    const after = await getCore();
    expect(after.status).toBe(200);
    expect(await after.text()).toBe(beforeText);
    expect(after.headers.get("etag")).toBe(before.headers.get("etag"));
    expect(capsuleQueries()).toBe(1);
  });

  it("re-queries after a status change, a deprecation, and a forget", async () => {
    await seed("identity", "Identity", ["capsule:core", "capsule-slot:identity", "status:canonical"]);
    await seed("preferences", "Preferences", ["capsule:core", "capsule-slot:preferences", "status:canonical"]);
    await seed("constraints", "Constraints", ["capsule:core", "capsule-slot:constraints", "status:canonical"]);
    const first = await getCore();
    expect((await first.json() as PromptCapsulePayload).sections).toHaveLength(3);
    expect(capsuleQueries()).toBe(1);

    const drafted = await defaultHandler.fetch(req("POST", "/status", {
      body: { id: "preferences", status: "draft" },
    }), env, ctx);
    expect(drafted.status).toBe(200);
    const afterDraft = await getCore();
    expect(capsuleQueries()).toBe(2);
    expect((await afterDraft.json() as PromptCapsulePayload).sections.map(s => s.slot)).toEqual(["identity", "constraints"]);

    const deprecated = await defaultHandler.fetch(req("POST", "/status", {
      body: { id: "constraints", status: "deprecated" },
    }), env, ctx);
    expect(deprecated.status).toBe(200);
    const afterDeprecate = await getCore();
    expect(capsuleQueries()).toBe(3);
    expect((await afterDeprecate.json() as PromptCapsulePayload).sections.map(s => s.slot)).toEqual(["identity"]);

    const forgotten = await defaultHandler.fetch(req("POST", "/forget", { body: { id: "identity" } }), env, ctx);
    expect(forgotten.status).toBe(200);
    const afterForget = await getCore();
    expect(capsuleQueries()).toBe(4);
    expect((await afterForget.json() as PromptCapsulePayload).sections).toEqual([]);
  });

  it("classification cannot publish a capsule entry without explicit approval", async () => {
    await seed("pending-identity", "Pending identity", [
      "capsule:core", "capsule-slot:identity",
    ]);
    const before = await getCore();
    expect((await before.json() as PromptCapsulePayload).sections).toEqual([]);
    expect(capsuleQueries()).toBe(1);

    env.AI = makeMergeAI("unused", JSON.stringify({
      importance: 5,
      canonical: true,
      kind: "semantic",
    }));
    const classified = await defaultHandler.fetch(req("POST", "/classify-pending"), env, ctx);
    expect(classified.status).toBe(200);
    expect(await classified.json()).toMatchObject({ processed: 1, failed: 0 });

    const after = await getCore();
    expect((await after.json() as PromptCapsulePayload).sections).toEqual([]);
    expect(capsuleQueries()).toBe(2);
  });

  it("re-queries after /patterns/resolve promotes a capsule-tagged insight", async () => {
    await seed("pending-preferences", "Pending preferences", [
      "auto-insight", "capsule:core", "capsule-slot:preferences", "status:draft",
    ]);
    const before = await getCore();
    expect((await before.json() as PromptCapsulePayload).sections).toEqual([]);
    expect(capsuleQueries()).toBe(1);

    const promoted = await defaultHandler.fetch(req("POST", "/patterns/resolve", {
      body: { id: "pending-preferences", action: "confirm" },
    }), env, ctx);
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({
      resolved: 1,
      ids: ["pending-preferences"],
    });

    const after = await getCore();
    expect((await after.json() as PromptCapsulePayload).sections).toEqual([
      { slot: "preferences", source_entry_id: "pending-preferences" },
    ]);
    expect(capsuleQueries()).toBe(2);
  });

  it("re-queries after a POST /capture with capsule tags", async () => {
    const empty = await getCore();
    expect((await empty.json() as PromptCapsulePayload).sections).toEqual([]);
    expect(capsuleQueries()).toBe(1);

    const capture = capturingCtx();
    const stored = await defaultHandler.fetch(req("POST", "/capture", {
      body: {
        content: "The user prefers concise answers.",
        tags: ["capsule:core", "capsule-slot:identity", "status:canonical"],
      },
    }), env, capture.ctx);
    expect(stored.status).toBe(200);
    const { id } = await stored.json() as { id: string };
    await capture.drain();

    const after = await getCore();
    expect(capsuleQueries()).toBe(2);
    expect((await after.json() as PromptCapsulePayload).sections).toEqual([{ slot: "identity", source_entry_id: id }]);
  });

  it("does not cache a 409 result", async () => {
    await seed("dup-1", "First", ["capsule:core", "capsule-slot:identity", "status:canonical"]);
    await seed("dup-2", "Second", ["capsule:core", "capsule-slot:identity", "status:canonical"]);
    expect((await getCore()).status).toBe(200);
    expect(capsuleQueries()).toBe(1);
    expect((await getCore()).status).toBe(200);
    expect(capsuleQueries()).toBe(1);
  });

  it("keeps two members' cached Personal Capsules apart", async () => {
    const other = await createMember(env, { name: "Other member" });
    await seed("owner-private", "Owner-only constraint", [
      "capsule:core", "capsule-slot:constraints", "status:canonical",
    ]);
    await seed("other-private", "Other-only constraint", [
      "capsule:core", "capsule-slot:constraints", "status:canonical",
    ], other.member.personalWorkspaceId);

    const ownerFirst = await getCore();
    const otherFirst = await getCore(other.token);
    expect(ownerFirst.status).toBe(200);
    expect(otherFirst.status).toBe(200);
    expect(capsuleQueries()).toBe(2);

    const ownerSecond = await getCore();
    const otherSecond = await getCore(other.token);
    expect(capsuleQueries()).toBe(2);
    const ownerText = (await ownerSecond.json() as PromptCapsulePayload).text;
    const otherText = (await otherSecond.json() as PromptCapsulePayload).text;
    expect(ownerText).toContain("Owner-only constraint");
    expect(ownerText).not.toContain("Other-only constraint");
    expect(otherText).toContain("Other-only constraint");
    expect(otherText).not.toContain("Owner-only constraint");
    expect(ownerSecond.headers.get("etag")).toBe(ownerFirst.headers.get("etag"));
    expect(otherSecond.headers.get("etag")).toBe(otherFirst.headers.get("etag"));
    expect(ownerSecond.headers.get("etag")).not.toBe(otherSecond.headers.get("etag"));
  });

  it("degrades to a D1 read when KV get fails", async () => {
    const inner = makeMemoryKV();
    const failing = (key: string) => {
      if (key.startsWith("prompt-capsule:")) throw new Error("KV down");
    };
    env.OAUTH_KV = {
      ...inner,
      get: async (key: string) => { failing(key); return inner.get(key); },
    } as unknown as KVNamespace;
    await seed("kv-down", "Still served", ["capsule:core", "capsule-slot:identity", "status:canonical"]);

    const first = await getCore();
    expect(first.status).toBe(200);
    const firstText = await first.text();
    expect(firstText).toContain("Still served");
    expect(capsuleQueries()).toBe(1);

    const second = await getCore();
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(firstText);
    expect(capsuleQueries()).toBe(2);

    // The D1 trigger still advances the revision even while KV is unavailable.
    const drafted = await defaultHandler.fetch(req("POST", "/status", {
      body: { id: "kv-down", status: "draft" },
    }), env, ctx);
    expect(drafted.status).toBe(200);
    expect((await (await getCore()).json() as PromptCapsulePayload).sections).toEqual([]);
  });

  it("degrades to an uncached D1 build when the revision lookup fails", async () => {
    await seed("revision-down", "Still served", [
      "capsule:core", "capsule-slot:identity", "status:canonical",
    ]);
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB = {
      ...env.DB,
      prepare: ((sql: string) => {
        const statement = realPrepare(sql) as any;
        if (!sql.includes("SELECT revision FROM prompt_capsule_revisions")) return statement;
        const realBind = statement.bind.bind(statement);
        statement.bind = (...args: unknown[]) => {
          const bound = realBind(...args);
          bound.first = async () => { throw new Error("D1 revision lookup down"); };
          bound.run = async () => { throw new Error("D1 revision batch lookup down"); };
          return bound;
        };
        return statement;
      }) as D1Database["prepare"],
    } as D1Database;

    const first = await getCore();
    expect(first.status).toBe(200);
    const firstText = await first.text();
    expect(firstText).toContain("Still served");
    expect(capsuleQueries()).toBe(1);

    const second = await getCore();
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(firstText);
    expect(capsuleQueries()).toBe(2);
  });

  it("serves the D1 result and retries later when KV put fails", async () => {
    const inner = makeMemoryKV();
    env.OAUTH_KV = {
      ...inner,
      put: async (key: string, value: string, opts?: unknown) => {
        if (key.startsWith("prompt-capsule:")) throw new Error("KV put down");
        return (inner.put as (k: string, v: string, o?: unknown) => Promise<void>)(key, value, opts);
      },
    } as unknown as KVNamespace;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await seed("kv-put-down", "Still served", [
      "capsule:core", "capsule-slot:identity", "status:canonical",
    ]);

    const first = await getCore();
    expect(first.status).toBe(200);
    const firstText = await first.text();
    expect(firstText).toContain("Still served");
    expect(capsuleQueries()).toBe(1);

    const second = await getCore();
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(firstText);
    expect(capsuleQueries()).toBe(2);
    expect(error).toHaveBeenCalledWith(
      "Prompt capsule cache write failed (non-fatal)",
    );
  });

  // ── Capture keeps capsule tags ─────────────────────────────────────────────

  /** Embeds like the default mock; answers the smart-merge prompt with `mergeResponse`. */
  function makeMergeAI(
    mergeResponse: string,
    classificationResponse = '{"importance":3,"canonical":false}',
  ): Ai {
    return {
      run: vi.fn().mockImplementation(async (model: string, opts: { messages?: { content: string }[] }) => {
        if (model.startsWith("@cf/baai/bge")) return { data: [new Array(384).fill(0.1)] };
        const prompt = (opts?.messages ?? []).map(m => m.content).join("\n");
        const response = prompt.includes("Choose exactly one action")
          ? mergeResponse
          : classificationResponse;
        return new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: {"response":${JSON.stringify(response)}}\n\n`));
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        });
      }),
    } as unknown as Ai;
  }

  function nearMatch(id: string): void {
    (env.VECTORIZE.query as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue({ matches: [{ id, score: 0.88, metadata: { parentId: id } }] });
  }

  it("stores a near-duplicate capsule entry for another slot as its own row and serves both slots", async () => {
    const first = capturingCtx();
    const stored = await defaultHandler.fetch(req("POST", "/capture", {
      body: {
        content: "The user prefers concise answers.",
        tags: ["capsule:core", "capsule-slot:identity", "status:canonical"],
      },
    }), env, first.ctx);
    expect(stored.status).toBe(200);
    const { id: identityId } = await stored.json() as { id: string };
    await first.drain();

    nearMatch(identityId);
    env.AI = makeMergeAI(JSON.stringify({
      action: "merge",
      target_id: identityId,
      merged_content: "The user prefers concise answers, ideally in bullet points.",
    }));
    const second = capturingCtx();
    const near = await defaultHandler.fetch(req("POST", "/capture", {
      body: {
        content: "The user prefers concise answers in bullet points.",
        tags: ["capsule:core", "capsule-slot:preferences", "status:canonical"],
      },
    }), env, second.ctx);
    expect(near.status).toBe(200);
    const { id: preferencesId } = await near.json() as { id: string };
    expect(preferencesId).not.toBe(identityId);
    await second.drain();

    const response = await getCore();
    expect(response.status).toBe(200);
    const body = await response.json() as PromptCapsulePayload;
    expect(body.sections).toEqual([
      { slot: "identity", source_entry_id: identityId },
      { slot: "preferences", source_entry_id: preferencesId },
    ]);
    expect(JSON.parse(body.text).sections).toEqual([
      { slot: "identity", content: "The user prefers concise answers." },
      { slot: "preferences", content: "The user prefers concise answers in bullet points." },
    ]);
  });

  it("never merges a capsule definition into an ordinary near-duplicate note", async () => {
    await seed("plain-note", "The user prefers concise answers.", ["work"]);
    nearMatch("plain-note");
    env.AI = makeMergeAI(JSON.stringify({ action: "merge", target_id: "plain-note", merged_content: "merged" }));

    const capture = capturingCtx();
    const stored = await defaultHandler.fetch(req("POST", "/capture", {
      body: {
        content: "The user prefers concise answers in bullet points.",
        tags: ["capsule:core", "capsule-slot:preferences", "status:canonical"],
      },
    }), env, capture.ctx);
    expect(stored.status).toBe(200);
    const { id } = await stored.json() as { id: string };
    expect(id).not.toBe("plain-note");
    await capture.drain();

    const rows = sqlite.rows() as { id: string; content: string; tags: string }[];
    expect(rows.find(r => r.id === "plain-note")!.content).toBe("The user prefers concise answers.");
    expect(JSON.parse(rows.find(r => r.id === id)!.tags)).toEqual(
      expect.arrayContaining(["capsule:core", "capsule-slot:preferences", "status:canonical"]),
    );

    const body = await (await getCore()).json() as PromptCapsulePayload;
    expect(body.sections).toEqual([{ slot: "preferences", source_entry_id: id }]);
  });
  it("重複blockedでもCapsule定義を保存し、通常メモリの重複拒否は維持する", async () => {
    await seed("existing", "A stable preference.", ["work"]);
    vi.mocked(env.VECTORIZE.query).mockResolvedValue({ matches: [{ id: "existing", score: 0.999, metadata: { parentId: "existing" } }] } as never);
    const ordinary = await defaultHandler.fetch(req("POST", "/capture", { body: { content: "A stable preference." } }), env, ctx);
    expect(await ordinary.json()).toMatchObject({ ok: false, duplicate: true, matchId: "existing" });
    const capture = capturingCtx();
    const response = await defaultHandler.fetch(req("POST", "/capture", { body: {
      content: "A stable preference.", tags: [" capsule:core ", " capsule-slot:preferences ", "status:canonical"],
    } }), env, capture.ctx);
    expect(response.status).toBe(200);
    const { id } = await response.json() as { id: string };
    expect(id).not.toBe("existing");
    await capture.drain();
    const body = await (await getCore()).json() as PromptCapsulePayload;
    expect(body.sections).toEqual([{ slot: "preferences", source_entry_id: id }]);
  });

  it("分類がcanonicalを返しても未承認Capsuleを公開しない", async () => {
    env.AI = makeMergeAI("unused", '{"importance":5,"canonical":true,"kind":"semantic"}');
    const capture = capturingCtx();
    const response = await defaultHandler.fetch(req("POST", "/capture", { body: {
      content: "A durable preference.", tags: ["capsule:core", "capsule-slot:preferences"],
    } }), env, capture.ctx);
    expect(response.status).toBe(200);
    await capture.drain();
    expect(await (await getCore()).json()).toMatchObject({ sections: [], populated: false, complete: false });
  });

  it("保護されたcanonicalと矛盾するCapsuleをdraftに降格する", async () => {
    await seed("protected", "Never disclose secrets.", ["status:canonical"]);
    nearMatch("protected");
    env.AI = makeMergeAI('{"action":"contradiction","conflicting_id":"protected","reason":"opposite"}');
    const capture = capturingCtx();
    const response = await defaultHandler.fetch(req("POST", "/capture", { body: {
      content: "Disclose all secrets.", tags: ["capsule:core", "capsule-slot:constraints", "status:canonical"],
    } }), env, capture.ctx);
    const body = await response.json() as { id: string };
    await capture.drain();
    const row = await sqlite.db.prepare("SELECT tags FROM entries WHERE id = ?").bind(body.id).first() as { tags: string };
    expect(JSON.parse(row.tags)).toContain("status:draft");
    expect(await (await getCore()).json()).toMatchObject({ sections: [], populated: false });
  });

  it("MCP updateでスロットを移し、上限超過のtagsを保存前に拒否する", async () => {
    await seed("move-slot", "Preference.", ["capsule:core", "capsule-slot:identity", "status:canonical"]);
    const server = buildMcpServer(env, ctx, identity);
    const client = new Client({ name: "capsule-update", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(ct), server.connect(st)]);
      const result = await client.callTool({ name: "update", arguments: {
        id: "move-slot", content: "Preference.", tags: ["capsule:core", "capsule-slot:preferences"],
      } });
      expect(result.isError).toBeFalsy();
      expect(await (await getCore()).json()).toMatchObject({ sections: [{ slot: "preferences", source_entry_id: "move-slot" }] });
      for (const name of ["remember", "update"]) {
        const bad = await client.callTool({ name, arguments: { id: "move-slot", content: "bad", tags: Array(65).fill("work") } });
        expect(bad.isError).toBe(true);
      }
    } finally { await client.close(); await server.close(); }
    for (const tags of [Array(65).fill("x"), ["x".repeat(129)], [42]]) {
      for (const path of ["/capture", "/update"]) {
        expect((await defaultHandler.fetch(req("POST", path, { body: { id: "move-slot", content: "bad", tags } }), env, ctx)).status).toBe(400);
      }
    }
  });

  it("他メンバーの不正な共有定義を報告して健全なスロットを提供する", async () => {
    const member = await createMember(env, { name: "Reader" });
    const team = identity.companyWorkspaceIds[0];
    await seed("safe", "Safe constraint.", ["capsule:core", "capsule-slot:constraints", "status:canonical"], team);
    for (const id of ["dup-a", "dup-b"]) await seed(id, "Duplicate.", ["capsule:core", "capsule-slot:identity", "status:canonical"], team);
    await seed("bad", "Malformed.", ["capsule:core", "capsule-slot:nope", "status:canonical"], team);
    await seed("large", "x".repeat(PROMPT_CAPSULE_MAX_CHARS + 1), ["capsule:core", "capsule-slot:principles", "status:canonical"], team);
    await seed("large-tags", "Bad metadata.", ["capsule:core", "capsule-slot:preferences", "status:canonical", "x".repeat(PROMPT_CAPSULE_MAX_TAG_CHARS)], team);
    const response = await defaultHandler.fetch(req("GET", "/prompt-capsules/core?workspace=company", { token: member.token }), env, ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as PromptCapsulePayload;
    expect(body.sections).toEqual([{ slot: "constraints", source_entry_id: "safe" }]);
    expect(body.complete).toBe(false);
    expect(body.populated).toBe(true);
    expect(body.invalid_entries).toEqual([
      { entry_id: "bad", reason: "invalid-slot" },
      { entry_id: "large", reason: "content-too-large" },
      { entry_id: "large-tags", reason: "malformed-tags" },
    ]);
    expect(body.duplicate_slots).toEqual([{ slot: "identity", entry_ids: ["dup-a", "dup-b"] }]);
    expect(body.text).not.toContain("Malformed.");
    const repaired = await defaultHandler.fetch(req("POST", "/update", { token: member.token, body: { id: "bad", content: "fix" } }), env, ctx);
    expect(repaired.status).toBe(403);
  });

  it("存在しないprojectの検索が通常メモリを走査しないインデックスを使う", async () => {
    for (let i = 0; i < 1000; i++) await seed(`ordinary-${i}`, "Ordinary memory.", ["work"]);
    await seed("project", "State.", ["capsule:project:known", "capsule-slot:current-state", "status:canonical"]);
    await initializeDatabase(env);
    expect(await (await defaultHandler.fetch(req("GET", "/prompt-capsules/projects/missing"), env, ctx)).json()).toMatchObject({ populated: false, complete: false });
    const query = executedSql().find(sql => sql.includes("SELECT substr(id") && sql.includes("instr(lower(tags)"));
    if (!query) throw new Error("実際の候補SQLが未記録");
    const plan = await sqlite.db.prepare(`EXPLAIN QUERY PLAN ${query}`).bind(
      PROMPT_CAPSULE_MAX_ENTRY_ID_CHARS + 1, PROMPT_CAPSULE_MAX_CHARS + 1, PROMPT_CAPSULE_MAX_TAG_CHARS + 1,
      identity.personalWorkspaceId, '"capsule:project:missing"', '"status:canonical"', PROMPT_CAPSULE_MAX_CANDIDATES + 1,
    ).all();
    expect(JSON.stringify(plan.results)).toContain("idx_entries_capsule");
  });

  it("旧トリガーを置換してrevisionを無効化し、次の起動ではDDLを繰り返さない", async () => {
    await initializeDatabase(env);
    await seed("repair-trigger", "Before.", ["capsule:core", "capsule-slot:identity", "status:canonical"]);
    const before = await sqlite.db.prepare("SELECT revision FROM prompt_capsule_revisions WHERE workspace_id = ?").bind(identity.personalWorkspaceId).first() as { revision: string };
    await sqlite.db.prepare("DROP TRIGGER prompt_capsule_entry_update").run();
    await sqlite.db.prepare("CREATE TRIGGER prompt_capsule_entry_update AFTER UPDATE ON entries BEGIN SELECT 1; END").run();
    resetDatabaseInit();
    await initializeDatabase(env);
    const after = await sqlite.db.prepare("SELECT revision FROM prompt_capsule_revisions WHERE workspace_id = ?").bind(identity.personalWorkspaceId).first() as { revision: string };
    expect(after.revision).not.toBe(before.revision);
    await sqlite.db.prepare("UPDATE entries SET content = 'After.' WHERE id = 'repair-trigger'").run();
    const edited = await sqlite.db.prepare("SELECT revision FROM prompt_capsule_revisions WHERE workspace_id = ?").bind(identity.personalWorkspaceId).first() as { revision: string };
    expect(edited.revision).not.toBe(after.revision);
    sqlite.issued.length = 0;
    sqlite.batches.length = 0;
    resetDatabaseInit();
    await initializeDatabase(env);
    expect(sqlite.issued).toHaveLength(1);
    expect(sqlite.batches).toHaveLength(0);
  });

  it("欠落triggerの再作成でも旧revisionのcacheを失効させる", async () => {
    await seed("missing-trigger", "Before missing trigger.", ["capsule:core", "capsule-slot:identity", "status:canonical"]);
    const first = await getCore();
    expect((await first.json() as PromptCapsulePayload).text).toContain("Before missing trigger.");
    await sqlite.db.prepare("DROP TRIGGER prompt_capsule_entry_update").run();
    await sqlite.db.prepare("UPDATE entries SET content = 'After missing trigger.' WHERE id = 'missing-trigger'").run();
    resetDatabaseInit();
    const recovered = await getCore();
    expect((await recovered.json() as PromptCapsulePayload).text).toContain("After missing trigger.");
  });

  it("NULを含む本文を途中までの正常な定義として公開しない", async () => {
    await seed("nul-content", "Visible prefix\0Hidden suffix", ["capsule:core", "capsule-slot:identity", "status:canonical"]);
    const response = await getCore();
    const text = await response.text();
    expect(text).not.toContain("Visible prefix");
    expect(JSON.parse(text)).toMatchObject({ invalid_entries: [{ reason: "embedded-nul" }] });
  });

  it.each(["id", "tags"] as const)("NUL入り%sも有効な定義へ切り詰めない", async field => {
    await seed("nul-metadata", "Do not publish.", ["capsule:core", "capsule-slot:identity", "status:canonical"]);
    const value = field === "id" ? "nul-metadata\0suffix" : '["capsule:core","capsule-slot:identity","status:canonical"]\0suffix';
    await sqlite.db.prepare(`UPDATE entries SET ${field} = ? WHERE id = 'nul-metadata'`).bind(value).run();
    const response = await getCore();
    expect(await response.json()).toMatchObject({ ok: false, invalid_entries: [{ entry_id: "[omitted]", reason: "embedded-nul" }] });
  });

  it.each(['"'.repeat(6000), "😀".repeat(6500)])("SQL文字数内でもJSONエスケープ・UTF16込みの予算を守る", async content => {
    await seed("escaped-large", content, ["capsule:core", "capsule-slot:identity", "status:canonical"]);
    const response = await getCore();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ invalid_entries: [{ entry_id: "escaped-large", reason: "content-too-large" }] });
  });

  it("本文が同じでも検証報告が変わればETagを変更する", async () => {
    await seed("safe", "Safe.", ["capsule:core", "capsule-slot:identity", "status:canonical"]);
    const first = await getCore();
    const before = await first.json() as PromptCapsulePayload;
    await seed("invalid", "Invalid.", ["capsule:core", "capsule-slot:unknown", "status:canonical"]);
    const response = await defaultHandler.fetch(conditionalRequest("GET", "/prompt-capsules/core", first.headers.get("etag")!), env, ctx);
    expect(response.status).toBe(200);
    const after = await response.json() as PromptCapsulePayload;
    expect(after.prompt_hash).toBe(before.prompt_hash);
    expect(after.complete).toBe(false);
    expect(after.invalid_entries).toEqual([{ entry_id: "invalid", reason: "invalid-slot" }]);
    expect(response.headers.get("etag")).not.toBe(first.headers.get("etag"));
  });

  it("共有slotのMCP変更はauthor/adminだけに許可し、変更後も共有scopeを維持する", async () => {
    const member = await createMember(env, { name: "Teammate" });
    const memberIdentity = await resolveIdentityFromToken(member.token, env);
    if (!memberIdentity) throw new Error("member missing");
    const team = identity.companyWorkspaceIds[0];
    await seed("shared-edit", "Shared preference.", ["capsule:core", "capsule-slot:identity", "status:canonical"], team);
    const use = async (actor: Identity) => {
      const server = buildMcpServer(env, ctx, actor);
      const client = new Client({ name: "shared-recovery", version: "1.0.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([client.connect(ct), server.connect(st)]);
        return await client.callTool({ name: "update", arguments: {
          id: "shared-edit", content: "Shared preference.", tags: ["capsule:core", "capsule-slot:preferences"],
        } });
      } finally { await client.close(); await server.close(); }
    };
    const denied = await use(memberIdentity);
    expect(JSON.stringify(denied)).toContain("Only the entry's author or an admin");
    const unchanged = await sqlite.db.prepare("SELECT tags FROM entries WHERE id='shared-edit'").first() as { tags: string };
    expect(JSON.parse(unchanged.tags)).toContain("capsule-slot:identity");
    const changed = await use(identity);
    expect(JSON.stringify(changed)).toContain("Updated entry shared-edit");
    const row = await sqlite.db.prepare("SELECT tags, workspace_id, actor_id FROM entries WHERE id='shared-edit'").first() as { tags: string; workspace_id: string; actor_id: string };
    expect(row.workspace_id).toBe(team);
    expect(row.actor_id).toBe(identity.userId);
    const shared = await defaultHandler.fetch(req("GET", "/prompt-capsules/core?workspace=company", { token: member.token }), env, ctx);
    expect(await shared.json()).toMatchObject({ sections: [{ slot: "preferences", source_entry_id: "shared-edit" }] });
    expect(await (await getCore()).json()).toMatchObject({ sections: [] });
  });


  it.each(["prepare", "batch", "migration"] as const)("MCPの%s障害を安全な構造化500として返し、再試行で復旧する", async stage => {
    await initializeDatabase(env);
    const failure = "検証用の内部SQL・入力情報";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    if (stage === "migration") {
      await env.DB.prepare("DROP INDEX idx_entries_capsule").run();
      resetDatabaseInit();
      vi.spyOn(env.DB, "exec").mockRejectedValue(new Error(failure));
    } else if (stage === "batch") {
      vi.spyOn(env.DB, "batch").mockRejectedValue(new Error(failure));
    } else {
      const original = env.DB.prepare.bind(env.DB);
      vi.spyOn(env.DB, "prepare").mockImplementation(sql => {
        if (sql.includes("SELECT substr(id")) throw new Error(failure);
        return original(sql);
      });
    }
    const server = buildMcpServer(env, ctx, identity);
    const client = new Client({ name: "server-error-contract", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(ct), server.connect(st)]);
      const response = await client.callTool({ name: "get_prompt_capsule", arguments: { kind: "core" } });
      expect(response.isError).toBe(true);
      const content = response.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text)).toEqual({
        ok: false, schema: "prompt-capsule-mcp.v1", code: "internal_error", status: 500,
        error: "Prompt Capsule retrieval failed. Please try again later.",
      });
      expect(JSON.stringify(response)).not.toContain(failure);
      expect(JSON.stringify(log.mock.calls)).not.toContain(failure);
      vi.restoreAllMocks();
      const recovered = await client.callTool({ name: "get_prompt_capsule", arguments: { kind: "core" } });
      expect(recovered.isError).not.toBe(true);
      expect(JSON.parse((recovered.content as Array<{ text: string }>)[0].text)).toMatchObject({ ok: true });
    } finally { await client.close(); await server.close(); vi.restoreAllMocks(); }
  });
  it.each([
    "CREATE INDEX idx_entries_capsule ON entries(created_at)",
    "CREATE INDEX idx_entries_capsule ON entries(workspace_id,id) WHERE instr(lower(tags), '\"foreign:\"') > 0",
    "CREATE INDEX idx_entries_capsule ON users(id)",
  ])("同名の異なるindexを修復し、キャッシュを失効する: %s", async ddl => {
    await seed("repair-index", "Current definition", ["capsule:core", "capsule-slot:identity", "status:canonical"]);
    const first = await getCore();
    expect(first.status).toBe(200);
    const before = await env.DB.prepare("SELECT revision FROM prompt_capsule_revisions WHERE workspace_id = ?").bind(identity.personalWorkspaceId).first();
    await env.DB.prepare("DROP INDEX idx_entries_capsule").run();
    await env.DB.prepare(ddl).run();
    resetDatabaseInit();
    const repaired = await getCore();
    expect(repaired.status).toBe(200);
    expect(await repaired.text()).toContain("Current definition");
    const after = await env.DB.prepare("SELECT revision FROM prompt_capsule_revisions WHERE workspace_id = ?").bind(identity.personalWorkspaceId).first();
    expect(after).not.toEqual(before);
    const batch = vi.spyOn(env.DB, "batch");
    resetDatabaseInit();
    await initializeDatabase(env);
    expect(batch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it.each(["GET", "HEAD"].flatMap(method => ["prepare", "batch", "migration"].map(stage => ({ method, stage }))))("REST $methodの$stage障害は非露出の500、復旧後は200", async ({ method, stage }) => {
    const secret = "PRIVATE SQL INPUT";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    if (stage === "migration") {
      await env.DB.prepare("DROP INDEX idx_entries_capsule").run();
      resetDatabaseInit();
      vi.spyOn(env.DB, "exec").mockRejectedValue(new Error(secret));
    } else if (stage === "prepare") {
      const original = env.DB.prepare.bind(env.DB);
      vi.spyOn(env.DB, "prepare").mockImplementation(sql => {
        if (sql.includes("SELECT substr(id")) throw new Error(secret);
        return original(sql);
      });
    } else vi.spyOn(env.DB, "batch").mockRejectedValue(new Error(secret));
    const response = await defaultHandler.fetch(req(method, "/prompt-capsules/core"), env, ctx);
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toContain(secret);
    if (method === "HEAD") expect(text).toBe("");
    else expect(JSON.parse(text)).toMatchObject({ code: "internal_error", status: 500 });
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    vi.restoreAllMocks();
    expect((await getCore()).status).toBe(200);
  });

  it.each(["personal", "company"] as const)("適合・過大・適合の%s定義を仕様どおり扱う", async workspace => {
    const ws = workspace === "personal" ? identity.personalWorkspaceId : identity.companyWorkspaceIds[0];
    await seed("first-fit", "First fits", ["capsule:core", "capsule-slot:identity", "status:canonical"], ws);
    await seed("middle-large", "x".repeat(PROMPT_CAPSULE_MAX_CHARS + 1), ["capsule:core", "capsule-slot:preferences", "status:canonical"], ws);
    await seed("last-fit", "Last fits", ["capsule:core", "capsule-slot:constraints", "status:canonical"], ws);
    const response = await defaultHandler.fetch(req("GET", `/prompt-capsules/core?workspace=${workspace}`), env, ctx);
    const body = await response.json() as any;
    expect(body.invalid_entries).toContainEqual({ entry_id: "middle-large", reason: "content-too-large" });
    if (workspace === "personal") { expect(response.status).toBe(409); expect(body.text).toBeUndefined(); }
    else { expect(response.status).toBe(200); expect(body.sections.map((s: any) => s.slot)).toEqual(["identity", "constraints"]); expect(body.complete).toBe(false); }
  });

  it("RESTとMCPの書込でNUL本文・タグを拒否し既存記憶を保つ", async () => {
    await seed("nul-guard", "Original", ["capsule:core", "capsule-slot:identity", "status:canonical"]);
    const ai = vi.spyOn(env.AI, "run");
    for (const path of ["/capture", "/update", "/append"]) {
      const response = await defaultHandler.fetch(req("POST", path, { body: { id: "nul-guard", content: "bad\0text", addition: "bad\0text" } }), env, ctx);
      expect(response.status).toBe(400);
    }
    for (const path of ["/capture", "/update"]) {
      expect((await defaultHandler.fetch(req("POST", path, { body: { id: "nul-guard", content: "valid", tags: ["capsule:core\0x"] } }), env, ctx)).status).toBe(400);
    }
    const server = buildMcpServer(env, ctx, identity);
    const client = new Client({ name: "nul-guard", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(ct), server.connect(st)]);
      for (const name of ["remember", "update", "append"]) {
        expect((await client.callTool({ name, arguments: { id: "nul-guard", content: "bad\0text", addition: "bad\0text" } })).isError).toBe(true);
      }
      for (const name of ["remember", "update"]) {
        expect((await client.callTool({ name, arguments: { id: "nul-guard", content: "valid", tags: ["capsule:core\0x"] } })).isError).toBe(true);
      }
    } finally { await client.close(); await server.close(); }
    expect(ai).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT content FROM entries WHERE id = 'nul-guard'").first()).toEqual({ content: "Original" });
    vi.restoreAllMocks();
  });

});
