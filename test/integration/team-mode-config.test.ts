/**
 * The guardrail on `PATCH /config { TEAM_MODE: "off" }`.
 *
 * Turning the switch off while colleagues are still on the team would leave the
 * flag and reality disagreeing: the dashboard drops every sharing control and
 * layer picker, while the shared workspace still exists and every member still
 * holds a token that reads it. One source of truth or none — so the write is
 * refused, with a message that names how many people are still there.
 *
 * The rule lives at the ROUTE, not inside writeOverrides: writeOverrides is the
 * generic, key-agnostic write path (per-key type/range checks and pure
 * invariants over the config object itself), and this rule is neither generic
 * nor pure — it needs a D1 headcount. Putting it there would give every config
 * write a database dependency and make the config layer import the team schema.
 * PATCH /config is writeOverrides' only non-test caller, so the route is a
 * complete boundary for it.
 *
 * Real SQLite, because the refusal is decided by a COUNT over `users` with the
 * tombstone predicate — the query IS the subject.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { createMember, removeMember } from "../../src/lib/team-admin";
import { CONFIG_KEY } from "../../src/config";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const ADMIN = "test-token";

let sqlite: SqliteD1;
let env: Env;
let roots: { companyWorkspaceId: string; ownerUserId: string; ownerPersonalWorkspaceId: string };

function patchConfig(body: Record<string, unknown>): Promise<Response> {
  return worker.fetch(
    new Request("http://localhost/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

/** The sparse override blob exactly as KV holds it. */
async function stored(): Promise<Record<string, unknown>> {
  const raw = await env.OAUTH_KV.get(CONFIG_KEY);
  return raw ? JSON.parse(raw) : {};
}

beforeEach(async () => {
  resetDatabaseInit();
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
  });
  await initializeDatabase(env);
  roots = await ensureTenantBootstrap(env);
});

afterEach(() => sqlite?.close());

describe('PATCH /config refuses TEAM_MODE "off" while anyone is still on the team', () => {
  it("refuses with a 400 naming how many people are still there", async () => {
    await createMember(env, { name: "Bob", email: "bob@example.com" });
    await createMember(env, { name: "Carol", email: "carol@example.com" });

    const res = await patchConfig({ TEAM_MODE: "off" });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    // The count, in the message. A refusal that does not say how many people
    // are involved leaves the admin guessing who to remove.
    expect(body.error).toContain("3");
    expect(body.error).toMatch(/team/i);
  });

  it("writes nothing when it refuses — not TEAM_MODE, and not the rest of the patch", async () => {
    await createMember(env, { name: "Bob", email: "bob@example.com" });
    // Seeded to a value that is NEITHER the default nor the one being written,
    // so "unchanged" is a claim only an untouched blob can satisfy.
    await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify({ TEAM_MODE: "on" }));

    const res = await patchConfig({ TEAM_MODE: "off", MMR_LAMBDA: 0.42 });
    expect(res.status).toBe(400);
    expect(await stored()).toEqual({ TEAM_MODE: "on" });
  });

  it("permits it once the owner is alone again", async () => {
    const bob = await createMember(env, { name: "Bob", email: "bob@example.com" });
    expect((await patchConfig({ TEAM_MODE: "off" })).status).toBe(400);

    await removeMember(env, roots.ownerUserId, bob.member.userId);
    const res = await patchConfig({ TEAM_MODE: "off" });
    expect(res.status).toBe(200);
    expect(await stored()).toEqual({ TEAM_MODE: "off" });
  });

  it('never blocks "on" or "auto", however many people are on the team', async () => {
    await createMember(env, { name: "Bob", email: "bob@example.com" });

    expect((await patchConfig({ TEAM_MODE: "on" })).status).toBe(200);
    expect(await stored()).toEqual({ TEAM_MODE: "on" });

    // "auto" is the shipped default, so writeOverrides drops it from the sparse
    // blob rather than pinning it — the acceptance is the 200, not a stored key.
    expect((await patchConfig({ TEAM_MODE: "auto" })).status).toBe(200);
    expect(await stored()).toEqual({});
  });

  it("leaves every other key alone on a team brain", async () => {
    await createMember(env, { name: "Bob", email: "bob@example.com" });
    const res = await patchConfig({ MMR_LAMBDA: 0.42 });
    expect(res.status).toBe(200);
    expect(await stored()).toEqual({ MMR_LAMBDA: 0.42 });
  });
});
