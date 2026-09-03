import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { resetDatabaseInit } from "../../src/db/init";
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

    const body = await first.json() as PromptCapsulePayload;
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
    expect((await ambiguous.json() as { error: string }).error).toContain("team is required");

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

    await seed("project-state-2", "Second current state", [
      "capsule:project:p-123", "capsule-slot:current-state", "status:canonical",
    ]);
    const duplicate = await defaultHandler.fetch(
      req("GET", "/prompt-capsules/projects/p-123"), env, ctx,
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      code: "invalid_prompt_capsule",
      duplicate_slots: [{ slot: "current-state", entry_ids: ["project-state", "project-state-2"] }],
    });

    const duplicateHead = await defaultHandler.fetch(
      req("HEAD", "/prompt-capsules/projects/p-123"), env, ctx,
    );
    expect(duplicateHead.status).toBe(409);
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
    const query = sqlite.issued.find(sql => sql.includes("FROM entries") && sql.includes("instr(lower(tags)"));
    expect(query).toContain("substr(content, 1, ?)");
    expect(query).not.toContain("LIKE");
  });

  it("bounds D1 projections and omits an oversized section whole", async () => {
    // A truncated prefix of this value normalizes to "Visible prefix". The
    // stored length must therefore drive whole-slot omission, or the route
    // would publish that partial prefix and silently lose the hidden tail.
    const oversized = `Visible prefix${" ".repeat(PROMPT_CAPSULE_MAX_CHARS + 100)}Hidden tail`;
    await seed("oversized", oversized, [
      "capsule:core", "capsule-slot:identity", "status:canonical",
    ]);

    const response = await defaultHandler.fetch(req("GET", "/prompt-capsules/core"), env, ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as PromptCapsulePayload;
    expect(body.complete).toBe(false);
    expect(body.sections).toEqual([]);
    expect(body.omitted_slots).toEqual(["identity"]);
    expect(body.text).not.toContain("Visible prefix");
    expect(body.text).not.toContain("Hidden tail");
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
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "invalid_prompt_capsule",
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
    const query = sqlite.issued.find(sql => sql.includes("FROM entries") && sql.includes("instr(lower(tags)"));
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
      error: `Prompt capsule has more than ${PROMPT_CAPSULE_MAX_CANDIDATES} canonical tagged candidates; clean up the capsule tags before retrying`,
    });
  });

  it("fails closed when a tagged canonical row has malformed JSON tags", async () => {
    await seed("malformed", "Bad definition", [
      "capsule:core", "capsule-slot:identity", "status:canonical",
    ]);
    await sqlite.db.prepare(`UPDATE entries SET tags = ? WHERE id = ?`)
      .bind('["capsule:core","capsule-slot:identity","status:canonical"', "malformed").run();

    const response = await defaultHandler.fetch(req("GET", "/prompt-capsules/core"), env, ctx);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "invalid_prompt_capsule",
      invalid_entries: [{ entry_id: "malformed", reason: "malformed-tags" }],
    });
  });
});
