/**
 * GET /team/activity — the compliance feed.
 *
 * admin_events has recorded every team administration action since Phase 1 and
 * nothing has ever read a row of it. This is the reader, and these are the
 * properties that make it a trail rather than a list:
 *
 *  - ORDERING and PAGING across BOTH trails. The route issues one compound
 *    statement precisely so LIMIT/OFFSET applies to the merged order. Two
 *    independently-paged selects stitched together in JavaScript pass a
 *    "rows come back" test and silently drop rows the moment one trail is
 *    busier than the other, so the interleave case below is written to fail
 *    against that implementation specifically.
 *  - SCOPE on the memory half. requireAdmin authorises a SURFACE; it never
 *    widens which memory rows a caller may read. A share event an admin may
 *    read must still not hand back the text of a memory that has since moved
 *    into someone's personal layer.
 *  - NAMES, never ids, in `actor` and `subject` — including for the two events
 *    an auditor most needs, member_suspended and member_removed, whose subjects
 *    are exactly the people listRoster deliberately hides.
 *
 * Timestamps are driven by a stubbed clock. Every event in this file is written
 * within the same millisecond of wall time otherwise, and an ordering assertion
 * over tied keys asserts nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import type { Env } from "../../src/env";

const BASE = "http://localhost";
const ALICE = "test-token"; // the owner/admin, per makeTestEnv's AUTH_TOKEN

let sqlite: SqliteD1;
let env: Env;
let pending: Promise<unknown>[] = [];
let roots: Awaited<ReturnType<typeof ensureTenantBootstrap>>;
let bob: Awaited<ReturnType<typeof createMember>>;

/** A controlled clock, so "newest first" is a fact and not a coin toss. */
let clock = 1_760_000_000_000;
const tick = (ms = 1000) => { clock += ms; };

const ctx = {
  waitUntil: (p: Promise<unknown>) => { pending.push(p); },
} as unknown as ExecutionContext;

function call(method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

const jsonOf = async (res: Response) => res.json() as Promise<any>;

async function settle(): Promise<void> {
  while (pending.length) {
    const batch = pending;
    pending = [];
    await Promise.all(batch);
  }
}

/** GET the feed as Alice, settled, parsed. */
async function activity(query = ""): Promise<any> {
  const res = await call("GET", `/team/activity${query}`, ALICE);
  await settle();
  expect(res.status).toBe(200);
  return jsonOf(res);
}

async function adminRow(at: number, event: string, actorId = "", targetId = ""): Promise<void> {
  await sqlite.db
    .prepare(
      `INSERT INTO admin_events (id, actor_id, target_user_id, workspace_id, event, payload, created_at)
       VALUES (?, ?, ?, '', ?, '{}', ?)`,
    )
    .bind(`ae-${at}-${event}`, actorId, targetId, event, at)
    .run();
}

async function entryRow(at: number, event: string, entryId: string, actorId = ""): Promise<void> {
  await sqlite.db
    .prepare(
      `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at)
       VALUES (?, ?, ?, ?, '{}', ?)`,
    )
    .bind(`ee-${at}-${event}`, entryId, actorId, event, at)
    .run();
}

async function entry(id: string, content: string, workspaceId: string, actorId: string): Promise<void> {
  await sqlite.db
    .prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
       VALUES (?, ?, '[]', 'test', ?, '[]', ?, ?)`,
    )
    .bind(id, content, clock, workspaceId, actorId)
    .run();
}

beforeEach(async () => {
  resetDatabaseInit();
  pending = [];
  clock = 1_760_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
  });
  await initializeDatabase(env);
  roots = await ensureTenantBootstrap(env);
  bob = await createMember(env, { name: "Bob" });
  await settle();
  // The bootstrap and the direct createMember above are not routes; the feed
  // should read only what each test itself caused.
  await env.DB.prepare(`DELETE FROM admin_events`).run();
  await env.DB.prepare(`DELETE FROM entry_events`).run();
  tick();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sqlite?.close();
});

describe("GET /team/activity — content", () => {
  it("merges member changes and share events into one newest-first feed", async () => {
    const created = await jsonOf(await call("POST", "/team/members", ALICE, { name: "Carol" }));
    await settle();
    tick();
    expect((await call("POST", "/team/members/suspend", ALICE, {
      id: created.member.userId, suspended: true,
    })).status).toBe(200);
    await settle();
    tick();
    await entry("e-shared", "Quarterly hiring plan", roots.companyWorkspaceId, bob.member.userId);
    await entryRow(clock, "shared", "e-shared", bob.member.userId);

    const body = await activity();
    expect(body.ok).toBe(true);
    expect(body.events.length).toBe(3);
    // Newest first, and the two trails interleave by time rather than by source.
    expect(body.events.map((e: any) => e.kind)).toEqual(["entry", "admin", "admin"]);
    expect(body.events.map((e: any) => e.event)).toEqual([
      "shared", "member_suspended", "member_created",
    ]);
    expect(body.events[0].actor).toBe("Bob");
    expect(body.events[0].entryId).toBe("e-shared");
    expect(body.events[0].title).toBe("Quarterly hiring plan");
    expect(body.events[1].actor).toBe("Owner");
    expect(body.events[1].subject).toBe("Carol");
    // Admin-trail rows are about a person, not a memory.
    expect(body.events[1].entryId).toBeNull();
    expect(body.events[1].title).toBeNull();
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    // No total: a COUNT(*) over the same compound is a second full scan for a
    // number nobody acts on.
    expect("total" in body).toBe(false);
  });

  it("round-trips a payload as detail, and answers 200 for one that is not JSON", async () => {
    await call("POST", "/team/members", ALICE, { name: "Dan" });
    await settle();
    tick();
    await sqlite.db
      .prepare(
        `INSERT INTO admin_events (id, actor_id, target_user_id, workspace_id, event, payload, created_at)
         VALUES ('ae-bad', '', '', '', 'team_renamed', 'not json', ?)`,
      )
      .bind(clock)
      .run();

    const body = await activity();
    const bad = body.events.find((e: any) => e.event === "team_renamed");
    const created = body.events.find((e: any) => e.event === "member_created");
    expect(created.detail).toEqual({ role: "member", hasEmail: false });
    // A hand-edited payload must not 500 the feed.
    expect(bad.detail).toEqual({});
  });

  it("records the two integration names Task 1 writes", async () => {
    await adminRow(clock, "integration_connected", roots.ownerUserId);
    tick();
    await adminRow(clock, "integration_disconnected", roots.ownerUserId);
    const body = await activity();
    expect(body.events.map((e: any) => e.event)).toEqual([
      "integration_disconnected", "integration_connected",
    ]);
  });
});

describe("GET /team/activity — ordering and paging", () => {
  /**
   * The reason the route is ONE compound statement. Four rows in each trail,
   * alternating in time, so any implementation that pages the two trails
   * separately and merges in JavaScript returns a different second page.
   */
  async function interleave(): Promise<number[]> {
    const times: number[] = [];
    for (let i = 0; i < 4; i++) {
      tick();
      await adminRow(clock, "member_created");
      times.push(clock);
      tick();
      await entryRow(clock, "shared", `e-${i}`);
      times.push(clock);
    }
    return times.slice().reverse(); // newest first
  }

  it("orders strictly descending across both sources", async () => {
    const expected = await interleave();
    const body = await activity();
    expect(body.events.length).toBe(8);
    expect(body.events.map((e: any) => e.at)).toEqual(expected);
    expect(body.events.map((e: any) => e.kind)).toEqual([
      "entry", "admin", "entry", "admin", "entry", "admin", "entry", "admin",
    ]);
    for (let i = 1; i < body.events.length; i++) {
      expect(body.events[i - 1].at).toBeGreaterThan(body.events[i].at);
    }
  });

  it("pages over the MERGED order, so no row appears twice and none is skipped", async () => {
    const expected = await interleave();
    const first = await activity("?limit=3&offset=0");
    const second = await activity("?limit=3&offset=3");
    const third = await activity("?limit=3&offset=6");

    expect(first.events.map((e: any) => e.at)).toEqual(expected.slice(0, 3));
    // Rows 4-6 of the SAME descending order. A JS merge of two independently
    // paged selects returns rows 4-6 of each trail here instead.
    expect(second.events.map((e: any) => e.at)).toEqual(expected.slice(3, 6));
    expect(third.events.map((e: any) => e.at)).toEqual(expected.slice(6, 8));
    expect(second.offset).toBe(3);

    const seen = [...first.events, ...second.events, ...third.events].map((e: any) => e.at);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(8);
    // The client's Show-more button reads events.length === limit; the last
    // page is short, which is how it stops.
    expect(third.events.length).toBeLessThan(3);
  });
});

describe("GET /team/activity — scope", () => {
  it("never hands back the text of a memory the admin cannot read", async () => {
    const SECRET = "Bob's private salary negotiation notes";
    // Bob shares, then un-shares: the row now lives in Bob's personal layer.
    await entry("e-bob", SECRET, bob.member.personalWorkspaceId, bob.member.userId);
    await entryRow(clock, "shared", "e-bob", bob.member.userId);
    tick();
    await entryRow(clock, "unshared", "e-bob", bob.member.userId);

    const res = await call("GET", "/team/activity", ALICE);
    await settle();
    expect(res.status).toBe(200);
    const raw = await res.text();
    // Asserted on the WHOLE serialised body, not on the field: a leak that
    // reaches any other key is still a leak.
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("salary");

    const body = JSON.parse(raw);
    expect(body.events.map((e: any) => e.event)).toEqual(["unshared", "shared"]);
    // Both events are visible — the admin may read that it happened.
    expect(body.events[0].title).toBeNull();
    expect(body.events[1].title).toBeNull();
    expect(body.events[0].entryId).toBe("e-bob");
  });

  it("names a memory the admin CAN read, first line only, truncated at 120", async () => {
    const long = "x".repeat(200);
    await entry("e-long", `${long}\nsecond line`, roots.companyWorkspaceId, bob.member.userId);
    await entryRow(clock, "shared", "e-long", bob.member.userId);

    const body = await activity();
    expect(body.events[0].title).toBe("x".repeat(120));
    expect(body.events[0].title).not.toContain("\n");
    expect(body.events[0].title).not.toContain("second line");
  });

  it("keeps the share event of a deleted entry, with a null title", async () => {
    // The LEFT JOIN's other reason: a trail that loses its rows when the thing
    // they are about is deleted is not a trail.
    await entryRow(clock, "shared", "e-gone", bob.member.userId);
    const body = await activity();
    expect(body.events.length).toBe(1);
    expect(body.events[0].entryId).toBe("e-gone");
    expect(body.events[0].title).toBeNull();
  });

  it("shows only shares and un-shares from the entry trail", async () => {
    await entry("e-c", "Company note", roots.companyWorkspaceId, bob.member.userId);
    for (const e of ["created", "updated", "appended", "deleted", "status_changed"]) {
      tick();
      await entryRow(clock, e, "e-c", bob.member.userId);
    }
    tick();
    await entryRow(clock, "shared", "e-c", bob.member.userId);
    const body = await activity();
    expect(body.events.map((e: any) => e.event)).toEqual(["shared"]);
  });
});

describe("GET /team/activity — names, never ids", () => {
  it("names a REMOVED member as the subject of member_removed", async () => {
    // The assertion lookupAuditNames exists for. listRoster excludes removed
    // people, so resolving through it would print a raw user id on exactly the
    // row an auditor came for.
    const res = await call("POST", "/team/members/remove", ALICE, { id: bob.member.userId });
    expect(res.status).toBe(200);
    await settle();

    const body = await activity();
    const removed = body.events.find((e: any) => e.event === "member_removed");
    expect(removed).toBeTruthy();
    expect(removed.subject).toBe("Bob");
    expect(removed.subject).not.toBe(bob.member.userId);
    expect(removed.actor).toBe("Owner");
  });

  it("names a SUSPENDED member as the subject of member_suspended", async () => {
    expect((await call("POST", "/team/members/suspend", ALICE, {
      id: bob.member.userId, suspended: true,
    })).status).toBe(200);
    await settle();

    const body = await activity();
    const row = body.events.find((e: any) => e.event === "member_suspended");
    expect(row.subject).toBe("Bob");
    expect(row.actor).toBe("Owner");
  });

  it("resolves an actor whose users row is gone to null, and never prints an id", async () => {
    await adminRow(clock, "member_created", "usr-ghost", "usr-also-ghost");
    tick();
    await adminRow(clock, "member_suspended", roots.ownerUserId, bob.member.userId);

    const body = await activity();
    const ghost = body.events.find((e: any) => e.event === "member_created");
    expect(ghost.actor).toBeNull();
    expect(ghost.subject).toBeNull();

    const knownIds = new Set([
      roots.ownerUserId, bob.member.userId, "usr-ghost", "usr-also-ghost",
    ]);
    for (const e of body.events) {
      expect(knownIds.has(e.actor)).toBe(false);
      expect(knownIds.has(e.subject)).toBe(false);
    }
  });

  it("leaves actor and subject null for a row that carries neither", async () => {
    await entryRow(clock, "shared", "e-x");
    const body = await activity();
    expect(body.events[0].actor).toBeNull();
    expect(body.events[0].subject).toBeNull();
  });
});

describe("GET /team/activity — gate and parameters", () => {
  it("is admin-only: 403 for a member, 401 for no token", async () => {
    const member = await call("GET", "/team/activity", bob.token);
    expect(member.status).toBe(403);
    expect((await jsonOf(member)).error).toBe("Forbidden");

    const anon = await call("GET", "/team/activity");
    expect(anon.status).toBe(401);
  });

  it("clamps limit and offset, and rejects a value that is not an integer", async () => {
    // NOTE, deliberately not the brief's wording: intParam CLAMPS out of range
    // and rejects only what cannot parse (src/lib/http.ts — "?n=200 means 'as
    // many as you'll give me' and has always been answered with 100"). This
    // route takes intParam as it is rather than changing a helper shared with
    // /list, /recall and /stale, so the pinned behaviour here is the clamp.
    expect((await activity("?limit=0")).limit).toBe(1);
    expect((await activity("?limit=101")).limit).toBe(100);
    expect((await activity("?offset=-1")).offset).toBe(0);

    for (const q of ["?limit=abc", "?limit=", "?offset=1.5"]) {
      const res = await call("GET", `/team/activity${q}`, ALICE);
      expect([q, res.status]).toEqual([q, 400]);
      expect((await jsonOf(res)).error).toMatch(/must be an integer/);
    }
  });
});

describe("GET /team/activity — cost", () => {
  function countPrepares(): { feed: number; names: number } {
    const counts = { feed: 0, names: 0 };
    const real = env.DB.prepare.bind(env.DB);
    (env.DB as any).prepare = (sql: string) => {
      if (sql.includes("FROM admin_events")) counts.feed++;
      if (/SELECT id, name\s+FROM users WHERE id IN/.test(sql)) counts.names++;
      return real(sql);
    };
    return counts;
  }

  it("issues one statement for the feed and one for the names", async () => {
    await adminRow(clock, "member_suspended", roots.ownerUserId, bob.member.userId);
    const counts = countPrepares();
    const body = await activity();
    expect(body.events.length).toBe(1);
    expect(counts).toEqual({ feed: 1, names: 1 });
  });

  it("issues NO name statement when every row's actor and subject are empty", async () => {
    await adminRow(clock, "team_renamed");
    tick();
    await entryRow(clock, "shared", "e-anon");
    const counts = countPrepares();
    const body = await activity();
    expect(body.events.length).toBe(2);
    expect(counts).toEqual({ feed: 1, names: 0 });
  });

  it("issues no name statement for an empty feed", async () => {
    const counts = countPrepares();
    const body = await activity();
    expect(body.events).toEqual([]);
    expect(counts).toEqual({ feed: 1, names: 0 });
  });
});
