/**
 * Structured 401s: a suspended or removed member learns why, a wrong token does not.
 *
 * IDENTITY_SQL filters suspended and removed rows out in its WHERE clause, so
 * before this every one of those cases resolved to null and came back as the
 * same `{ ok: false, error: "Unauthorized" }` a typo gets. That is correct for a
 * typo and useless for a member whose access an admin revoked — the dashboard
 * told them to check their token, which is not the problem and not something
 * they can fix.
 *
 * The security property this must not trade away is that the extra information
 * is reachable ONLY by someone already holding a token that hashes to a real
 * users row. A token that does not is answered exactly as before, so the
 * endpoint never becomes an oracle for "does this account exist". The
 * `does not reveal whether an account exists` block below is that assertion.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember, setMemberSuspended, removeMember } from "../../src/lib/team-admin";
import { hashToken, requireIdentityForMcp, type Identity } from "../../src/lib/identity";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const OWNER = "test-token";

const SUSPENDED_MESSAGE = "Your account is suspended. Ask a team admin to restore it.";
const REMOVED_MESSAGE = "Your account has been removed from this team.";

let sqlite: SqliteD1;
let env: Env;
let ownerUserId: string;
let dana: { userId: string; token: string };

function call(method: string, path: string, token: string | null, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers["Authorization"] = `Bearer ${token}`;
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

const jsonOf = (res: Response) => res.json() as Promise<any>;

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
  });
  await initializeDatabase(env);
  const roots = await ensureTenantBootstrap(env);
  ownerUserId = roots.ownerUserId;
  const created = await createMember(env, { name: "Dana" });
  dana = { userId: created.member.userId, token: created.token };
});

afterEach(() => sqlite?.close());

describe("REST 401 codes", () => {
  it("answers an unknown token with the unchanged generic failure", async () => {
    const res = await call("GET", "/list", "not-a-real-token");
    expect(res.status).toBe(401);
    const body = await jsonOf(res);
    expect(body.error).toBe("Unauthorized");
    expect(body.code).toBe("invalid_token");
  });

  it("answers a missing token with the unchanged generic failure", async () => {
    const res = await call("GET", "/list", null);
    expect(res.status).toBe(401);
    const body = await jsonOf(res);
    expect(body.error).toBe("Unauthorized");
    expect(body.code).toBe("invalid_token");
  });

  it("tells a suspended member their account is suspended", async () => {
    await setMemberSuspended(env, ownerUserId, dana.userId, true);
    const res = await call("GET", "/list", dana.token);
    expect(res.status).toBe(401);
    const body = await jsonOf(res);
    expect(body.code).toBe("suspended");
    expect(body.error).toBe(SUSPENDED_MESSAGE);
  });

  it("tells a removed member their account was removed", async () => {
    await removeMember(env, ownerUserId, dana.userId);
    const res = await call("GET", "/list", dana.token);
    expect(res.status).toBe(401);
    const body = await jsonOf(res);
    expect(body.code).toBe("removed");
    expect(body.error).toBe(REMOVED_MESSAGE);
  });

  it("reports removal rather than suspension when the member is both", async () => {
    // removeMember leaves suspended = 1 behind when an admin suspended first.
    // Removal is the more final fact and the one the member has to act on.
    await setMemberSuspended(env, ownerUserId, dana.userId, true);
    await removeMember(env, ownerUserId, dana.userId);
    const body = await jsonOf(await call("GET", "/list", dana.token));
    expect(body.code).toBe("removed");
  });
});

describe("does not reveal whether an account exists", () => {
  const CLASSIFY = /SELECT suspended, removed_at FROM users WHERE token_hash = \?/;

  it("gives a token that hashes to no row the same answer as no token at all", async () => {
    // Dana's real token is suspended, so this brain HAS a row that would answer
    // "suspended" — the wrong token must still not find it.
    await setMemberSuspended(env, ownerUserId, dana.userId, true);
    const wrong = await jsonOf(await call("GET", "/list", "definitely-not-danas-token"));
    const absent = await jsonOf(await call("GET", "/list", null));
    expect(wrong).toEqual(absent);
    expect(wrong.code).toBe("invalid_token");
    expect(wrong.error).toBe("Unauthorized");
  });

  it("looks up only the SHA-256 of the presented token, never a user id or name", async () => {
    await setMemberSuspended(env, ownerUserId, dana.userId, true);
    sqlite.issued.length = 0;
    await call("GET", "/list", "definitely-not-danas-token");

    const classify = sqlite.issued.filter((s) => CLASSIFY.test(s));
    expect(classify).toHaveLength(1);
    // Nothing in the failure path selects by anything but the hash — so the only
    // way to reach the suspended row is to already hold the token it hashes to.
    expect(classify[0]).not.toMatch(/WHERE (u\.)?(id|name|email)\b/);
  });

  it("costs the happy path nothing: a valid token issues no classify query", async () => {
    sqlite.issued.length = 0;
    const res = await call("GET", "/list", OWNER);
    expect(res.status).toBe(200);
    expect(sqlite.issued.filter((s) => CLASSIFY.test(s))).toEqual([]);
  });

  it("issues no classify query when there was no token to classify", async () => {
    sqlite.issued.length = 0;
    expect((await call("GET", "/list", null)).status).toBe(401);
    expect(sqlite.issued.filter((s) => CLASSIFY.test(s))).toEqual([]);
  });

  it("cannot be reached by guessing a token hash, only by holding the token", async () => {
    // The stored value is the digest; presenting the digest itself is just
    // another wrong token, because the server hashes whatever it is given.
    await setMemberSuspended(env, ownerUserId, dana.userId, true);
    const digest = await hashToken(dana.token);
    const body = await jsonOf(await call("GET", "/list", digest));
    expect(body.code).toBe("invalid_token");
    expect(body.error).toBe("Unauthorized");
  });
});

describe("MCP 401 codes", () => {
  /** A request carrying whatever credential the MCP client presented. */
  const mcpRequest = (token: string | null) =>
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    });

  it("returns the same three codes as the REST surface", async () => {
    const unknown = await jsonOf(await requireIdentityForMcp(mcpRequest("not-a-real-token"), env) as Response);
    expect(unknown.code).toBe("invalid_token");
    expect(unknown.error).toBe("Unauthorized");

    await setMemberSuspended(env, ownerUserId, dana.userId, true);
    const suspended = await jsonOf(await requireIdentityForMcp(mcpRequest(dana.token), env) as Response);
    expect(suspended.code).toBe("suspended");
    expect(suspended.error).toBe(SUSPENDED_MESSAGE);

    await removeMember(env, ownerUserId, dana.userId);
    const removed = await jsonOf(await requireIdentityForMcp(mcpRequest(dana.token), env) as Response);
    expect(removed.code).toBe("removed");
    expect(removed.error).toBe(REMOVED_MESSAGE);
  });

  it("classifies a browser-OAuth grant, whose access token is not in users", async () => {
    // The realistic suspension case on MCP: the client authorized through the
    // browser flow months ago and holds the provider's own opaque access token.
    // Hashing that finds no row, so the grant's user id is the only thing left
    // that can say why the client stopped working.
    await setMemberSuspended(env, ownerUserId, dana.userId, true);
    const res = await requireIdentityForMcp(mcpRequest("provider-opaque:access:token"), env, dana.userId) as Response;
    const body = await jsonOf(res);
    expect(res.status).toBe(401);
    expect(body.code).toBe("suspended");
    expect(body.error).toBe(SUSPENDED_MESSAGE);
  });

  it("still refuses to classify a grant for a user id that is not a member", async () => {
    const res = await requireIdentityForMcp(mcpRequest(null), env, "usr-does-not-exist") as Response;
    const body = await jsonOf(res);
    expect(body.code).toBe("invalid_token");
    expect(body.error).toBe("Unauthorized");
  });

  it("lets a valid grant through untouched", async () => {
    const identity = await requireIdentityForMcp(mcpRequest(null), env, dana.userId);
    expect(identity).not.toBeInstanceOf(Response);
    expect((identity as Identity).userId).toBe(dana.userId);
  });

  /**
   * The gap this pins, deliberately rather than hiding it.
   *
   * @cloudflare/workers-oauth-provider guards /mcp itself: when
   * `resolveExternalToken` returns null it answers with its own OAuth-spec
   * `invalid_token` 401 and never calls apiHandler, so requireIdentityForMcp —
   * and with it the codes above — is unreachable for a raw bearer token the
   * provider could not resolve. Closing that would mean returning props from
   * `resolveExternalToken` for accounts we have just decided are not allowed
   * in, which trades a real access-control boundary for a better message. Not
   * worth it. This asserts today's behaviour so the trade stays visible.
   */
  it("is still answered by the OAuth provider, not this guard, for a raw bearer token", async () => {
    await setMemberSuspended(env, ownerUserId, dana.userId, true);
    const res = await call("POST", "/mcp", dana.token);
    expect(res.status).toBe(401);
    expect(await jsonOf(res)).toEqual({ error: "Unauthorized" });
  });
});

describe("the legacy AUTH_TOKEN-only guard", () => {
  it("carries the invalid_token code for shape consistency", async () => {
    const res = await call("POST", "/oauth/revoke-all", "wrong-token");
    expect(res.status).toBe(401);
    const body = await jsonOf(res);
    expect(body.error).toBe("Unauthorized");
    expect(body.code).toBe("invalid_token");
  });
});
