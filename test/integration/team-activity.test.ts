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
 *  - SCOPE on the memory arm, AT THE ROW. requireAdmin authorises a SURFACE; it
 *    never widens which memory rows a caller may read. An event naming a memory
 *    the caller cannot read is not in the feed at all — not its text, not its
 *    id, not its actor, not the workspace id in its detail. A row hidden in one
 *    column and disclosed in three others is not scoped, which is why the
 *    second-company block below exists: every same-company case passes with the
 *    predicate on either side of the join and so can never tell the two apart.
 *  - NAMES, never ids, in `actor` and `subject` — including for the two events
 *    an auditor most needs, member_suspended and member_removed, whose subjects
 *    are exactly the people listRoster deliberately hides. Two states only:
 *    a name or null, never "".
 *
 * Timestamps are driven by a stubbed clock, so "newest first" is a fact rather
 * than a coin toss. The one place ties are deliberate is the tied-timestamp
 * paging case, which is what production actually produces — a bulk resolve
 * stamps ~97 rows with one Date.now().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember } from "../../src/lib/team-admin";
import { D1_MAX_BOUND_PARAMS } from "../../src/constants";
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

/** `id` and `payload` are overridable so a test can build a deliberate tie. */
interface RowOpts { id?: string; payload?: string }

async function adminRow(
  at: number, event: string, actorId = "", targetId = "", opts: RowOpts = {},
): Promise<void> {
  await sqlite.db
    .prepare(
      `INSERT INTO admin_events (id, actor_id, target_user_id, workspace_id, event, payload, created_at)
       VALUES (?, ?, ?, '', ?, ?, ?)`,
    )
    .bind(opts.id ?? `ae-${at}-${event}`, actorId, targetId, event, opts.payload ?? "{}", at)
    .run();
}

async function entryRow(
  at: number, event: string, entryId: string, actorId = "", opts: RowOpts = {},
): Promise<void> {
  await sqlite.db
    .prepare(
      `INSERT INTO entry_events (id, entry_id, actor_id, event, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(opts.id ?? `ee-${at}-${event}`, entryId, actorId, event, opts.payload ?? "{}", at)
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

describe("GET /team/activity — pattern resolutions reach the feed", () => {
  /** An insight: no author, `actor_id = ""`, living in the shared layer. */
  async function insight(id: string, content: string): Promise<void> {
    await sqlite.db
      .prepare(
        `INSERT INTO entries (id, content, tags, source, created_at, vector_ids, workspace_id, actor_id)
         VALUES (?, ?, '["auto-insight"]', 'system', ?, '[]', ?, '')`,
      )
      .bind(id, content, clock, roots.companyWorkspaceId)
      .run();
  }

  it("shows an admin WHICH MEMBER dismissed a company-layer insight", async () => {
    // The sentence this exists to make true. There is deliberately no author
    // lock on /patterns/resolve — an insight has no author and any member
    // ruling on one is the feature working — so the record is the only thing
    // standing between "a shared suggestion was deleted for everyone" and
    // nobody being able to find out who did it.
    await insight("i-1", "The team ships on Fridays");
    tick();

    const res = await call("POST", "/patterns/resolve", bob.token, { id: "i-1", action: "dismiss" });
    expect(res.status).toBe(200);
    await settle();

    const body = await activity();
    expect(body.events.length).toBe(1);
    expect(body.events[0]).toMatchObject({
      kind: "entry",
      event: "insight_dismissed",
      actor: "Bob",
      subject: null,
      entryId: "i-1",
      title: "The team ships on Fridays",
    });
  });

  it("shows a confirmation under its own name, not the same one as a dismissal", async () => {
    await insight("i-2", "The team writes tests first");
    tick();
    expect((await call("POST", "/patterns/resolve", bob.token, {
      id: "i-2", action: "confirm",
    })).status).toBe(200);
    await settle();

    const body = await activity();
    expect(body.events.map((e: any) => e.event)).toEqual(["insight_confirmed"]);
    expect(body.events[0].actor).toBe("Bob");
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
      // The memory has to EXIST and be readable: the entry arm is scoped at the
      // row, so an event naming an entry the caller cannot read is not in the
      // feed at all and there would be nothing to interleave.
      await entry(`e-${i}`, `Memory ${i}`, roots.companyWorkspaceId, bob.member.userId);
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

  it("pages TIED timestamps deterministically, in both trails at once", async () => {
    // The case the rest of this file's stubbed clock deliberately avoids, and
    // the case production produces on purpose: POST /patterns/resolve writes
    // one entry_events row per resolved id in a tight loop, so a 97-id resolve
    // stamps ~97 rows with the same Date.now(). `ORDER BY created_at DESC`
    // alone leaves the window boundary to whatever order the sorter happens to
    // emit a tie group in, which is the classic skip/duplicate across pages.
    //
    // Six rows, one millisecond, alternating trails, ids chosen so the
    // tiebreaker's answer is knowable: the marker in `detail.n` must come back
    // 6..1 whichever way the rows are paged.
    await entry("e-tie", "Tied memory", roots.companyWorkspaceId, bob.member.userId);
    for (let n = 1; n <= 6; n++) {
      const opts = { id: `tie-${n}`, payload: JSON.stringify({ n }) };
      if (n % 2) await adminRow(clock, "member_created", roots.ownerUserId, "", opts);
      else await entryRow(clock, "shared", "e-tie", bob.member.userId, opts);
    }

    const whole = await activity();
    expect(new Set(whole.events.map((e: any) => e.at)).size).toBe(1);
    expect(whole.events.map((e: any) => e.detail.n)).toEqual([6, 5, 4, 3, 2, 1]);

    const pages = [
      ...(await activity("?limit=2&offset=0")).events,
      ...(await activity("?limit=2&offset=2")).events,
      ...(await activity("?limit=2&offset=4")).events,
    ];
    // Same order, and — the property that actually matters — every row exactly
    // once across the three pages.
    expect(pages.map((e: any) => e.detail.n)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(new Set(pages.map((e: any) => e.detail.n)).size).toBe(6);
  });
});

describe("GET /team/activity — scope", () => {
  it("returns NO ROW AT ALL for a memory the admin cannot read", async () => {
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
    // And not the id either. A null title with the row still present is HALF
    // scoped: the row is hidden in one column and disclosed in three others.
    expect(raw).not.toContain("e-bob");

    const body = JSON.parse(raw);
    expect(body.events).toEqual([]);
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

  it("DROPS the share event of a deleted entry — the documented limit of a scoped arm", async () => {
    // Pinned as a known, accepted loss rather than left to be discovered.
    //
    // entry_events carries no workspace column, so the ONLY way to decide
    // whether a row belongs to the caller is to join the entry it names. Once
    // that entry is gone there is nothing left to decide with, and a row that
    // cannot be attributed cannot be shown without showing every other
    // company's deleted rows along with it. So share/unshare history for a
    // DELETED memory does not appear in this feed.
    //
    // Keeping it would require either a workspace column on entry_events —
    // which is blank for every row already written, so it would buy a
    // half-true trail — or a second unscoped join on entries to prove the id
    // is dead, which discloses "a memory that no longer exists was shared to
    // ws-companyY" to an admin of company X. Both are worse than this gap.
    await entryRow(clock, "shared", "e-gone", bob.member.userId);
    const body = await activity();
    expect(body.events).toEqual([]);
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

/**
 * The axis nothing covered, and the one the two-layer tenancy exists for.
 *
 * Every other scope case in this file is same-deployment, same-company: Bob's
 * personal layer against Alice's. That case passes with the workspace
 * predicate on either side of the join, so it could never have shown that the
 * predicate governed only which TITLE was populated and not which ROWS came
 * back. A second company is what tells the two apart.
 */
describe("GET /team/activity — a SECOND COMPANY on the same deployment", () => {
  const OTHER_WS = "ws-companyY";
  const OTHER_USER = "usr-yankee";

  /** A whole second tenant: its own company workspace, member and memory. */
  async function companyY(): Promise<void> {
    await sqlite.db
      .prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'company', 'Company Y', ?)`)
      .bind(OTHER_WS, clock).run();
    await sqlite.db
      .prepare(
        `INSERT INTO users (id, name, email, role, token_hash, suspended, created_at)
         VALUES (?, 'Yankee', NULL, 'admin', 'hash-yankee', 0, ?)`,
      )
      .bind(OTHER_USER, clock).run();
    await sqlite.db
      .prepare(`INSERT INTO memberships (user_id, workspace_id, role, created_at) VALUES (?, ?, 'admin', ?)`)
      .bind(OTHER_USER, OTHER_WS, clock).run();
    await entry("e-y", "Company Y acquisition memo", OTHER_WS, OTHER_USER);
  }

  it("returns none of company Y's entry rows to an admin of company X", async () => {
    await companyY();
    // The real payload shape POST /entry/share writes: { workspaceId }.
    await entryRow(clock, "shared", "e-y", OTHER_USER, {
      payload: JSON.stringify({ workspaceId: OTHER_WS }),
    });

    const res = await call("GET", "/team/activity", ALICE);
    await settle();
    expect(res.status).toBe(200);
    const raw = await res.text();
    // Four separate crossings, asserted against the whole serialised body
    // because a row hidden in one column and disclosed in another is not
    // scoped: the memory's TEXT, its ID, the ACTOR who shared it, and the
    // TARGET WORKSPACE ID out of detail — the last of which is reachable
    // nowhere else, since listTeamWorkspaces binds only the caller's own ids.
    expect(raw).not.toContain("acquisition");
    expect(raw).not.toContain("e-y");
    expect(raw).not.toContain(OTHER_WS);
    expect(JSON.parse(raw).events).toEqual([]);
  });

  it("still returns the caller's OWN company rows in the same request", async () => {
    // So the arm is scoped, not switched off.
    await companyY();
    await entryRow(clock, "shared", "e-y", OTHER_USER, {
      payload: JSON.stringify({ workspaceId: OTHER_WS }),
    });
    tick();
    await entry("e-x", "Company X hiring plan", roots.companyWorkspaceId, bob.member.userId);
    await entryRow(clock, "shared", "e-x", bob.member.userId, {
      payload: JSON.stringify({ workspaceId: roots.companyWorkspaceId }),
    });

    const body = await activity();
    expect(body.events.length).toBe(1);
    expect(body.events[0]).toMatchObject({
      kind: "entry",
      event: "shared",
      entryId: "e-x",
      title: "Company X hiring plan",
      actor: "Bob",
      detail: { workspaceId: roots.companyWorkspaceId },
    });
  });

  it("DOES return company Y's ADMIN rows — deployment-wide, and accepted", async () => {
    // Stated as a pinned fact rather than left implicit. admin_events carries
    // no usable workspace ('' on every member event), and GET /team/members is
    // already scope-exempt and names every user on the deployment, so this arm
    // adds no exposure that the roster does not already have. If that ever
    // stops being true, this test is the one that has to be argued with.
    await companyY();
    await adminRow(clock, "member_suspended", OTHER_USER, OTHER_USER);

    const body = await activity();
    expect(body.events.length).toBe(1);
    expect(body.events[0]).toMatchObject({
      kind: "admin",
      event: "member_suspended",
      actor: "Yankee",
      subject: "Yankee",
      entryId: null,
      title: null,
    });
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

  it("resolves a member whose name is EMPTY to null, not to an empty string", async () => {
    // `actor` and `subject` are documented as "a name or null" — two states.
    // A users row with a blank name used to produce a third, "", which every
    // consumer written as `actor ?? "System"` renders as an empty cell while
    // one written as `actor || "Removed account"` renders a label. Two
    // consumers disagreeing about the same row is the drift; the fix is that
    // the third state does not exist.
    await sqlite.db
      .prepare(
        `INSERT INTO users (id, name, email, role, token_hash, suspended, created_at)
         VALUES ('usr-nameless', '', NULL, 'member', 'hash-nameless', 0, ?)`,
      )
      .bind(clock).run();
    await adminRow(clock, "member_created", "usr-nameless", "usr-nameless");

    const body = await activity();
    expect(body.events.length).toBe(1);
    expect(body.events[0].actor).toBeNull();
    expect(body.events[0].subject).toBeNull();
    // Asserted as identity, not falsiness: "" is falsy and would pass a
    // `toBeFalsy()` written for this.
    expect(body.events[0].actor).not.toBe("");
    expect(body.events[0].subject).not.toBe("");
  });

  it("leaves actor and subject null for a row that carries neither", async () => {
    await entry("e-x", "Nobody's memory", roots.companyWorkspaceId, "");
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

/**
 * Start counting the route's own two statements. Module scope rather than
 * inside the cost group below, because the solo group at the bottom of this
 * file asks the same question of the same route on the other kind of brain,
 * and one counter means the two answers are directly comparable.
 */
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

/**
 * A D1 facade that enforces the ONE limit real D1 enforces and this route can
 * break: at most D1_MAX_BOUND_PARAMS bound parameters per statement.
 *
 * `node:sqlite` accepts parameters in the thousands, so a test driven against
 * the bare helper passes while the deployed Worker's statement is rejected
 * outright — and this path has no try/catch anywhere between it and the
 * platform, so the rejection is a 500 rather than a degraded page. Same
 * technique and same reason as test/unit/insight-team-pass.test.ts's
 * withBoundParamLimit; a test that does not enforce 100 proves nothing here.
 *
 * A Proxy rather than a hand-written stand-in: env.DB is the whole worker's
 * database for the duration of the request, not just this route's, so
 * everything the facade does not care about has to keep working unchanged.
 */
function withBoundParamLimit(): { sql: string; params: number }[] {
  const executed: { sql: string; params: number }[] = [];
  const real = env.DB.prepare.bind(env.DB);
  const check = (sql: string, params: unknown[]) => {
    executed.push({ sql, params: params.length });
    if (params.length > D1_MAX_BOUND_PARAMS) {
      throw new Error("D1_ERROR: too many SQL variables: SQLITE_ERROR");
    }
  };
  const wrap = (sql: string, stmt: unknown, params: unknown[]): unknown =>
    new Proxy(stmt as object, {
      get(target, prop) {
        if (prop === "bind") {
          return (...args: unknown[]) => wrap(sql, (target as any).bind(...args), args);
        }
        if (prop === "all" || prop === "first" || prop === "run" || prop === "raw") {
          return async (...rest: unknown[]) => {
            check(sql, params);
            return (target as any)[prop](...rest);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  (env.DB as any).prepare = (sql: string) => wrap(sql, real(sql), []);
  return executed;
}

const worstBind = (executed: { sql: string; params: number }[]) =>
  executed.reduce((worst, s) => Math.max(worst, s.params), 0);

const nameStatements = (executed: { sql: string; params: number }[]) =>
  executed.filter((s) => /SELECT id, name\s+FROM users WHERE id IN/.test(s.sql));

/**
 * THE BOUND-PARAMETER CEILING on the name lookup.
 *
 * The feed's own statement binds the caller's scope plus LIMIT/OFFSET — a
 * fixed handful. The name lookup binds one parameter PER DISTINCT PERSON on
 * the page, and the page is caller-controlled: `limit` is admitted up to 100
 * and every admin row can carry two different people, so one request can ask
 * for 200 bound parameters against a platform ceiling of 100.
 *
 * The number that makes this urgent rather than theoretical is the
 * dashboard's own: ACTIVITY_PAGE = 50 (public/js/activity.js) puts a full
 * page at exactly 100 of 100. The shipped client is one distinct person short
 * of a 500 on every load, forever, for that team.
 */
describe("GET /team/activity — the bound-parameter ceiling", () => {
  /** `n` admin rows: one actor throughout, a different subject on each row. */
  async function distinctSubjects(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await adminRow(clock + i, "member_created", roots.ownerUserId, `u-${String(i).padStart(3, "0")}`);
    }
  }

  /** A named users row, so a resolved name proves which chunk answered. */
  async function named(id: string, name: string): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO users (id, name, role, token_hash, created_at) VALUES (?, ?, 'member', ?, 0)`,
    ).bind(id, name, `hash-${id}`).run();
  }

  it("answers a full page naming more people than one statement may bind", async () => {
    // 101 rows, one actor and 101 distinct subjects, read at the largest
    // `limit` the route admits. The page carries 100 rows naming 101 distinct
    // people — one over the ceiling, which is the smallest input that breaks
    // an unchunked list and therefore the one worth pinning.
    await distinctSubjects(101);
    await named("u-001", "Zoe");

    const executed = withBoundParamLimit();
    const res = await call("GET", "/team/activity?limit=100", ALICE);
    await settle();

    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.events.length).toBe(100);
    expect(worstBind(executed)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    // Two chunks, not one truncated one — and the SECOND chunk's names have to
    // reach the response. `u-001` is the oldest subject on the page, so it is
    // last into the deduplicated list and lands in the second chunk: a fix that
    // chunked the query but kept only the last map would answer null here.
    expect(nameStatements(executed).length).toBe(2);
    expect(body.events[99].subject).toBe("Zoe");
    expect(body.events[99].actor).toBe("Owner");
  });

  it("holds at the page size the dashboard actually requests", async () => {
    // ACTIVITY_PAGE = 50 with two different people per row is exactly 100 of
    // 100 — the shipped client's real worst case, and the reason this is not
    // a limit=100 curiosity.
    for (let i = 0; i < 50; i++) {
      await adminRow(clock + i, "member_created", `a-${i}`, `s-${i}`);
    }

    const executed = withBoundParamLimit();
    const res = await call("GET", "/team/activity?limit=50", ALICE);
    await settle();

    expect(res.status).toBe(200);
    expect((await jsonOf(res)).events.length).toBe(50);
    expect(worstBind(executed)).toBe(D1_MAX_BOUND_PARAMS);
    expect(nameStatements(executed).length).toBe(1);
  });
});

/**
 * THE RULING ON FAILURE, asserted rather than only written down.
 *
 * This route is deliberately uncaught — see the note above the handler. The
 * property that makes that the right call is the one below: a feed that cannot
 * be read must not answer as a feed with nothing in it. `{ ok: true, events: [] }`
 * is the single most dangerous response this endpoint could give, because it is
 * the same response a clean brain gives and an auditor cannot tell them apart.
 *
 * Written as a failure the route cannot anticipate — the feed statement itself
 * rejecting — because that is exactly the class a well-meaning try/catch would
 * catch, and the class this route must let through.
 */
describe("GET /team/activity — an unreadable feed is not an empty one", () => {
  it("lets a rejected feed statement through rather than answering it as no events", async () => {
    await adminRow(clock, "member_suspended", roots.ownerUserId, bob.member.userId);
    const real = env.DB.prepare.bind(env.DB);
    // Rejected at EXECUTION, the way D1 rejects: a stub that threw from
    // prepare() would be unreachable by the `.catch()` a degrading fix would
    // reach for, and so could not tell a catch from no catch.
    const locked = () => Promise.reject(new Error("D1_ERROR: database is locked"));
    const failing: any = { bind: () => failing, all: locked, first: locked, run: locked };
    (env.DB as any).prepare = (sql: string) =>
      sql.includes("FROM admin_events") ? failing : real(sql);

    await expect(call("GET", "/team/activity", ALICE)).rejects.toThrow(/D1_ERROR/);
    await settle();
  });
});

describe("GET /team/activity — cost", () => {
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
    await entry("e-anon", "Nobody's memory", roots.companyWorkspaceId, "");
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

/**
 * The solo brain — the shape every deployed brain has today.
 *
 * requireAdmin is not a team gate. src/lib/tenancy.ts hashes this deployment's
 * AUTH_TOKEN into a users row with role 'admin' (invariant 4), so on a brain
 * with one person that one person passes it, and this route answers them 200.
 * Which means "does /team/activity 403 on a solo brain?" is the wrong question:
 * it does not, and cannot be made to without taking the feed away from the
 * owner of a real team as well. The right questions are what it RETURNS to
 * them, and what it COSTS them — a route the dashboard never calls on a solo
 * brain (js/activity.js hides the section and issues no request) still runs for
 * anyone who types the URL, and phase 4 is the release that gave a solo brain
 * rows to put in it: POST /patterns/resolve now audits insight_confirmed /
 * insight_dismissed, and the integrations routes now audit connect/disconnect.
 *
 * The answer both tests establish: what comes back is a record of the one
 * person's own administration of their own brain — no team, no second name, no
 * subject, and no second statement to say so.
 */
describe("GET /team/activity — a solo brain", () => {
  beforeEach(async () => {
    // The outer beforeEach invites Bob, which is the whole of what makes that
    // fixture a team. Removing him leaves the v2-upgrade shape exactly: one
    // users row, the owner's, holding AUTH_TOKEN.
    await env.DB.prepare(`DELETE FROM memberships WHERE user_id = ?`).bind(bob.member.userId).run();
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(bob.member.userId).run();
    // The dashboard's own gate agrees this is a solo brain, so the two halves
    // of this audit are talking about the same fixture: /health drives
    // TEAM_MODE, and TEAM_MODE is what hides the section this route feeds.
    expect((await jsonOf(await call("GET", "/health", ALICE))).team).toBe(false);
  });

  it("answers the owner 200 with an empty feed, in one statement", async () => {
    const counts = countPrepares();
    const body = await activity();
    expect(body).toEqual({ ok: true, events: [], limit: 50, offset: 0 });
    // One compound SELECT and NO name lookup: lookupAuditNames issues nothing
    // for an empty id list, which is the case a solo brain is almost always in.
    expect(counts).toEqual({ feed: 1, names: 0 });
  });

  it("shows the solo owner their own administration and nobody else's", async () => {
    // The two trails a solo brain now actually writes, both new in this phase.
    await entry("e-solo", "Weekly review ritual", roots.ownerPersonalWorkspaceId, "");
    await entryRow(clock, "insight_confirmed", "e-solo", roots.ownerUserId);
    tick();
    await adminRow(clock, "integration_connected", roots.ownerUserId);

    const body = await activity();
    expect(body.events.map((e: any) => e.event)).toEqual([
      "integration_connected", "insight_confirmed",
    ]);
    // Named, not id'd, on a brain whose only name is the owner's — and with no
    // subject on any row, because there is nobody to be the subject of an
    // administrative act here.
    expect(body.events.map((e: any) => e.actor)).toEqual(["Owner", "Owner"]);
    expect(body.events.map((e: any) => e.subject)).toEqual([null, null]);
    // The memory arm is scoped at the row on this brain too: the owner's own
    // personal memory is one they can read, so its event carries a title.
    expect(body.events[1].title).toBe("Weekly review ritual");
  });
});
