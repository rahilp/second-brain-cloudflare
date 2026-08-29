import type { Env } from "../env";
import { hashToken } from "./identity";

/**
 * Tenant bootstrap: makes the tenancy tables true on any database, old or new.
 *
 * Invariants (asserted by test/unit/tenancy.test.ts):
 *   1. Exactly one company workspace.
 *   2. Every user has exactly one personal workspace.
 *   3. Every user is a member of the company workspace.
 *   4. The owner user exists with role admin and holds the AUTH_TOKEN hash, so the
 *      static token every existing install already uses resolves to a real identity
 *      through the same code path as issued member tokens.
 *   5. Legacy rows (workspace_id '') belong to the owner's personal workspace once
 *      the backfill has run — a brain upgraded from v2 keeps every memory private
 *      to its owner with zero user-visible change until team members are added.
 *
 * Memoised per isolate keyed on the DB binding (tests use many envs against one
 * module instance — keying on nothing would let env A's memo satisfy env B).
 */
const memo = new WeakMap<object, Promise<TenantRoots>>();

export interface TenantRoots {
  companyWorkspaceId: string;
  ownerUserId: string;
  ownerPersonalWorkspaceId: string;
}

export async function ensureTenantBootstrap(env: Env): Promise<TenantRoots> {
  const cached = memo.get(env.DB);
  if (cached) return cached;
  const promise = bootstrap(env).catch((e) => {
    // Key on success, mirroring initializeDatabase: a failed bootstrap must be
    // retryable, not cached as done.
    memo.delete(env.DB);
    throw e;
  });
  memo.set(env.DB, promise);
  return promise;
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function findCompanyId(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM workspaces WHERE kind = 'company' ORDER BY created_at LIMIT 1`,
  ).first<{ id: string }>();
  return row?.id ?? null;
}

async function findOwner(env: Env): Promise<{ userId: string; personalWorkspaceId: string } | null> {
  const row = await env.DB.prepare(
    `SELECT u.id AS userId, w.id AS personalWorkspaceId FROM users u` +
    ` JOIN memberships m ON m.user_id = u.id JOIN workspaces w ON w.id = m.workspace_id AND w.kind = 'personal'` +
    ` WHERE u.role = 'admin' ORDER BY u.created_at LIMIT 1`,
  ).first<{ userId: string; personalWorkspaceId: string }>();
  return row ?? null;
}

async function ownerHasPersonalWorkspace(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM memberships m JOIN workspaces w ON w.id = m.workspace_id AND w.kind = 'personal'` +
    ` WHERE m.user_id = ? LIMIT 1`,
  )
    .bind(userId)
    .first();
  return row !== null;
}

/**
 * Get-or-create each piece independently rather than seeding everything or
 * nothing: a batch that died halfway (D1 has no transactional DDL, two isolates
 * can cold-start together) must be completed by the next run, never doubled.
 */
async function bootstrap(env: Env): Promise<TenantRoots> {
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];

  let companyId = await findCompanyId(env);
  if (!companyId) {
    companyId = id("ws");
    // Every value bound, none inlined: keeps the statement trivially testable
    // against doubles that match parameters positionally.
    statements.push(
      env.DB.prepare(
        `INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, ?, ?, ?)`,
      ).bind(companyId, "company", "Company", now),
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO maintenance_cursor (id, workspace_id, advanced_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    ).bind(1, "", now),
  );

  let owner = await findOwner(env);
  let ownerIsNew = false;
  if (!owner) {
    const ownerId = id("usr");
    // The owner's token is whatever this deployment already guards itself with,
    // so AUTH_TOKEN keeps working unchanged and gains an identity it never had.
    statements.push(
      env.DB.prepare(
        `INSERT INTO users (id, name, email, role, token_hash, suspended, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(ownerId, "Owner", null, "admin", await hashToken(env.AUTH_TOKEN), 0, now),
    );
    owner = { userId: ownerId, personalWorkspaceId: "" };
    ownerIsNew = true;
  }

  if (ownerIsNew || !(await ownerHasPersonalWorkspace(env, owner.userId))) {
    const personalId = owner.personalWorkspaceId || id("ws");
    if (!owner.personalWorkspaceId) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, ?, ?, ?)`,
        ).bind(personalId, "personal", "Owner", now),
      );
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO memberships (user_id, workspace_id, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = ? AND workspace_id = ?)`,
      ).bind(owner.userId, personalId, now, owner.userId, personalId),
    );
    owner.personalWorkspaceId = personalId;
  }

  // Membership in the company workspace (invariant 3). Runs on every bootstrap
  // pass for the owner found above — the NOT EXISTS makes it free when present.
  statements.push(
    env.DB.prepare(
      `INSERT INTO memberships (user_id, workspace_id, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = ? AND workspace_id = ?)`,
    ).bind(owner.userId, companyId, now, owner.userId, companyId),
  );

  // One-time legacy backfill: '' rows are the pre-team owner's own writes. On a
  // re-run the WHERE matches nothing and both statements write zero rows.
  statements.push(
    env.DB.prepare(`UPDATE entries SET workspace_id = ? WHERE workspace_id = ''`).bind(owner.personalWorkspaceId),
    env.DB.prepare(`UPDATE edges SET workspace_id = ? WHERE workspace_id = ''`).bind(owner.personalWorkspaceId),
  );

  // One subrequest for the whole set, however many statements it carries — the
  // reason every write path in src/ batches. Called unconditionally: batch() is
  // non-optional on D1Database, and miniflare and wrangler dev both implement
  // it, so a `typeof env.DB.batch === "function"` guard here would only tell the
  // next reader it is optional and invite a second fallback somewhere it
  // matters.
  await env.DB.batch(statements);
  return {
    companyWorkspaceId: companyId,
    ownerUserId: owner.userId,
    ownerPersonalWorkspaceId: owner.personalWorkspaceId,
  };
}
