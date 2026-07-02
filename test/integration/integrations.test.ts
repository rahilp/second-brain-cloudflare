import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb, makeMemoryKV } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

// ─── Notion API stub ────────────────────────────────────────────────────────
// A mutable fixture the stubbed global fetch serves: /users/me validates the
// token, /search returns `pages`, /blocks/:id/children returns `blocks[id]`.

interface NotionFixture {
  validToken: string;
  pages: any[];
  blocks: Record<string, any[]>;
}

function notionPage(id: string, title: string, lastEdited: string, archived = false) {
  return {
    object: "page",
    id,
    last_edited_time: lastEdited,
    url: `https://notion.so/${id}`,
    archived,
    in_trash: false,
    properties: { title: { type: "title", title: [{ plain_text: title }] } },
  };
}

function paragraph(text: string) {
  return { object: "block", id: `blk-${text}`, type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: text }] } };
}

function stubNotionApi(fixture: NotionFixture) {
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const auth = init?.headers?.Authorization ?? "";
    if (auth !== `Bearer ${fixture.validToken}`) {
      return new Response(JSON.stringify({ message: "API token is invalid." }), { status: 401 });
    }
    if (url.endsWith("/users/me")) {
      return new Response(JSON.stringify({ object: "user", type: "bot", name: "Second Brain", bot: { workspace_name: "Test Workspace" } }), { status: 200 });
    }
    if (url.endsWith("/search")) {
      return new Response(JSON.stringify({ results: fixture.pages, has_more: false, next_cursor: null }), { status: 200 });
    }
    const m = url.match(/\/blocks\/([^/?]+)\/children/);
    if (m) {
      return new Response(JSON.stringify({ results: fixture.blocks[m[1]] ?? [], has_more: false, next_cursor: null }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }));
}

describe("integrations routes", () => {
  let env: Env;
  let db: D1Mock;
  let fixture: NotionFixture;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db, { OAUTH_KV: makeMemoryKV() });
    fixture = { validToken: "ntn_valid", pages: [], blocks: {} };
    stubNotionApi(fixture);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const connect = () =>
    worker.fetch(req("POST", "/integrations/notion/connect", { body: { token: "ntn_valid" } }), env, ctx);
  const sync = () =>
    worker.fetch(req("POST", "/integrations/notion/sync", { body: {} }), env, ctx);

  describe("GET /integrations", () => {
    it("requires auth", async () => {
      const res = await worker.fetch(req("GET", "/integrations", { token: null }), env, ctx);
      expect(res.status).toBe(401);
    });

    it("lists notion as disconnected by default", async () => {
      const res = await worker.fetch(req("GET", "/integrations"), env, ctx);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.integrations).toEqual([
        expect.objectContaining({ provider: "notion", connected: false, itemCount: 0 }),
      ]);
    });
  });

  describe("POST /integrations/notion/connect", () => {
    it("requires a token", async () => {
      const res = await worker.fetch(req("POST", "/integrations/notion/connect", { body: {} }), env, ctx);
      expect(res.status).toBe(400);
    });

    it("rejects a token Notion does not accept, storing nothing", async () => {
      const res = await worker.fetch(
        req("POST", "/integrations/notion/connect", { body: { token: "ntn_wrong" } }), env, ctx
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toContain("API token is invalid");

      const status = await (await worker.fetch(req("GET", "/integrations"), env, ctx)).json() as any;
      expect(status.integrations[0].connected).toBe(false);
    });

    it("validates the token and stores the connection with the workspace name", async () => {
      const res = await connect();
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(data.workspaceName).toBe("Test Workspace");

      const status = await (await worker.fetch(req("GET", "/integrations"), env, ctx)).json() as any;
      expect(status.integrations[0]).toMatchObject({ connected: true, workspaceName: "Test Workspace" });
    });
  });

  describe("POST /integrations/notion/sync", () => {
    it("404s when not connected", async () => {
      const res = await sync();
      expect(res.status).toBe(404);
    });

    it("mirrors accessible pages into entries with source notion", async () => {
      fixture.pages = [notionPage("p1", "Project Plan", "2026-01-01T00:00:00.000Z")];
      fixture.blocks["p1"] = [paragraph("Ship the beta in March")];
      await connect();

      const res = await sync();
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data).toMatchObject({ ok: true, created: 1, updated: 0, deleted: 0, remaining: 0, total: 1 });

      expect(db.entries).toHaveLength(1);
      const entry = db.entries[0];
      expect(entry.source).toBe("notion");
      expect(JSON.parse(entry.tags)).toEqual(["notion"]);
      expect(entry.content).toContain("# Project Plan");
      expect(entry.content).toContain("https://notion.so/p1");
      expect(entry.content).toContain("Ship the beta in March");

      const status = await (await worker.fetch(req("GET", "/integrations"), env, ctx)).json() as any;
      expect(status.integrations[0].itemCount).toBe(1);
    });

    it("is a no-op when nothing changed", async () => {
      fixture.pages = [notionPage("p1", "Note", "2026-01-01T00:00:00.000Z")];
      fixture.blocks["p1"] = [paragraph("test")];
      await connect();
      await sync();

      const data = await (await sync()).json() as any;
      expect(data).toMatchObject({ created: 0, updated: 0, deleted: 0 });
      expect(db.entries).toHaveLength(1);
    });

    it("replaces a mirrored entry in place when the page is edited", async () => {
      fixture.pages = [notionPage("p1", "Note A", "2026-01-01T00:00:00.000Z")];
      fixture.blocks["p1"] = [paragraph("test")];
      await connect();
      await sync();
      const originalId = db.entries[0].id;

      // The page changes: "test" → "test2", with a newer last_edited_time.
      fixture.pages = [notionPage("p1", "Note A", "2026-01-08T00:00:00.000Z")];
      fixture.blocks["p1"] = [paragraph("test2")];

      const data = await (await sync()).json() as any;
      expect(data).toMatchObject({ created: 0, updated: 1 });
      expect(db.entries).toHaveLength(1);
      expect(db.entries[0].id).toBe(originalId); // same entry — graph edges/recall counts survive
      expect(db.entries[0].content).toContain("test2");
      expect(db.entries[0].content).not.toContain("test\n");
    });

    it("deletes the mirror when a page disappears from the listing", async () => {
      fixture.pages = [notionPage("p1", "Note", "2026-01-01T00:00:00.000Z")];
      fixture.blocks["p1"] = [paragraph("test")];
      await connect();
      await sync();
      expect(db.entries).toHaveLength(1);

      fixture.pages = []; // page unshared
      const data = await (await sync()).json() as any;
      expect(data).toMatchObject({ deleted: 1 });
      expect(db.entries).toHaveLength(0);

      const status = await (await worker.fetch(req("GET", "/integrations"), env, ctx)).json() as any;
      expect(status.integrations[0].itemCount).toBe(0);
    });

    it("deletes the mirror when a page is archived", async () => {
      fixture.pages = [notionPage("p1", "Note", "2026-01-01T00:00:00.000Z")];
      fixture.blocks["p1"] = [paragraph("test")];
      await connect();
      await sync();

      fixture.pages = [notionPage("p1", "Note", "2026-01-02T00:00:00.000Z", true)];
      const data = await (await sync()).json() as any;
      expect(data).toMatchObject({ deleted: 1, created: 0 });
      expect(db.entries).toHaveLength(0);
    });

    it("processes large backlogs in bounded batches and reports remaining", async () => {
      fixture.pages = Array.from({ length: 7 }, (_, i) =>
        notionPage(`p${i}`, `Note ${i}`, `2026-01-0${i + 1}T00:00:00.000Z`)
      );
      for (let i = 0; i < 7; i++) fixture.blocks[`p${i}`] = [paragraph(`body ${i}`)];
      await connect();

      const first = await (await sync()).json() as any;
      expect(first).toMatchObject({ created: 5, remaining: 2 });
      const second = await (await sync()).json() as any;
      expect(second).toMatchObject({ created: 2, remaining: 0 });
      expect(db.entries).toHaveLength(7);
    });

    it("records the error and returns 502 when the Notion API fails", async () => {
      fixture.pages = [notionPage("p1", "Note", "2026-01-01T00:00:00.000Z")];
      fixture.blocks["p1"] = [paragraph("test")];
      await connect();
      fixture.validToken = "ntn_rotated"; // stored token no longer works

      const res = await sync();
      expect(res.status).toBe(502);

      const status = await (await worker.fetch(req("GET", "/integrations"), env, ctx)).json() as any;
      expect(status.integrations[0].status).toBe("error");
      expect(status.integrations[0].lastSyncError).toContain("API token is invalid");
    });
  });

  describe("mirror edit protection", () => {
    beforeEach(async () => {
      fixture.pages = [notionPage("p1", "Note", "2026-01-01T00:00:00.000Z")];
      fixture.blocks["p1"] = [paragraph("test")];
      await connect();
      await sync();
    });

    it("409s on POST /update for a mirrored entry while connected", async () => {
      const id = db.entries[0].id;
      const res = await worker.fetch(req("POST", "/update", { body: { id, content: "manual edit" } }), env, ctx);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.error).toContain("synced from Notion");
      expect(db.entries[0].content).toContain("test");
    });

    it("409s on POST /append for a mirrored entry while connected", async () => {
      const id = db.entries[0].id;
      const res = await worker.fetch(req("POST", "/append", { body: { id, addition: "manual note" } }), env, ctx);
      expect(res.status).toBe(409);
    });

    it("allows edits again after disconnect", async () => {
      const id = db.entries[0].id;
      await worker.fetch(req("POST", "/integrations/notion/disconnect", { body: {} }), env, ctx);
      const res = await worker.fetch(req("POST", "/update", { body: { id, content: "manual edit" } }), env, ctx);
      expect(res.status).toBe(200);
    });
  });

  describe("POST /integrations/notion/disconnect", () => {
    beforeEach(async () => {
      fixture.pages = [
        notionPage("p1", "Note 1", "2026-01-01T00:00:00.000Z"),
        notionPage("p2", "Note 2", "2026-01-02T00:00:00.000Z"),
      ];
      fixture.blocks["p1"] = [paragraph("one")];
      fixture.blocks["p2"] = [paragraph("two")];
      await connect();
      await sync();
    });

    it("404s when not connected", async () => {
      await worker.fetch(req("POST", "/integrations/notion/disconnect", { body: {} }), env, ctx);
      const res = await worker.fetch(req("POST", "/integrations/notion/disconnect", { body: {} }), env, ctx);
      expect(res.status).toBe(404);
    });

    it("keeps mirrored memories by default", async () => {
      const res = await worker.fetch(req("POST", "/integrations/notion/disconnect", { body: {} }), env, ctx);
      const data = await res.json() as any;
      expect(data).toMatchObject({ ok: true, purged: 0, kept: 2 });
      expect(db.entries).toHaveLength(2);

      const status = await (await worker.fetch(req("GET", "/integrations"), env, ctx)).json() as any;
      expect(status.integrations[0].connected).toBe(false);
    });

    it("purges mirrored memories when asked", async () => {
      const res = await worker.fetch(
        req("POST", "/integrations/notion/disconnect", { body: { purge: true } }), env, ctx
      );
      const data = await res.json() as any;
      expect(data).toMatchObject({ ok: true, purged: 2, kept: 0 });
      expect(db.entries).toHaveLength(0);
    });
  });
});
