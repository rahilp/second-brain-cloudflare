import type { Env } from "../env";
import { resolveConfig } from "../config";
import { SB_VERSION } from "../env";
import { COMPRESSION_MIN_AGE_MS, compressionEligibilitySql, isTopicTagSql } from "../compression/eligibility";
import { intParam, json } from "../lib/http";
import { D1_MAX_BOUND_PARAMS, VECTORIZE_WORKSPACE_FILTER_UNSUPPORTED_KV_KEY } from "../constants";
import { requireAdmin, requireIdentity, type Identity } from "../lib/identity";
import { effectiveWriteTarget, primaryCompanyWorkspaceId, scopeWhere } from "../lib/scope";
import { ensureTenantBootstrap } from "../lib/tenancy";
import { graceMs } from "../lib/ai";
import { classifyEntry } from "../capture/classify";
import { storeEntry } from "../capture/store";
import { INDEXABLE_SQL } from "../capture/lifecycle";
import { PENDING_INSIGHT_SQL } from "../memory/patterns";
import { STALE_REVIEW_SQL } from "../memory/stale";
import { getStatus, withStatus } from "../memory/status";
import { withKind } from "../memory/kind";
import { checkVectorizeHealth } from "../vectorize/health";
import { vectorizeFilterState } from "../vectorize/scope";
import { TAG_LIKE_ESCAPE, tagLikePattern } from "../memory/tag-sql";
import { reasonOverPair, restatesRecent } from "../insight/reason";
import { MAX_INSIGHTS_PER_RUN, RECENT_INSIGHT_WINDOW, rawInsightText } from "../insight/weekly";
import { runInsightAccrual, isEligiblePair, parseTags } from "../insight/candidates";
import { adminAuditEvent } from "../lib/admin-audit";
import { createMember, listMembers, listRoster, listTeamWorkspaces, removeMember, renameTeamWorkspace, rotateMemberToken, setMemberDefaultShare, setMemberProfile, setMemberSuspended, TeamAdminError } from "../lib/team-admin";

/**
 * Ids accepted by one bulk resolve. D1 allows 100 bound parameters per
 * statement and the id list is the whole of the SELECT's binding, so this is
 * the hard limit rather than a policy. The client pages against it.
 */
// /patterns/resolve's SELECT spends D1's bound-parameter budget on the id list
// plus the caller's workspace scope, so its cap is derived per request rather
// than fixed: three workspaces for an admin would otherwise put a full page at
// 103 bindings and fail the whole batch.

export async function handleAdminRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const cfg = await resolveConfig(env);
  // ── Team administration (v3). Administrative routes are behind requireAdmin;
  // the member-facing reads (/team/roster, /team/me, /team/workspaces) are
  // behind requireIdentity and scope themselves to the caller's own identity.
  // Which gate a route uses is stated on the route. ──────────────────────
  if (url.pathname === "/team/members" && request.method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    return json({ ok: true, members: await listMembers(env), you: auth.userId });
  }

  // GET /team/roster — the member-facing people list: names and roles, and no
  // more. requireIdentity, not requireAdmin, because knowing who is on your team
  // is what makes "share with the team" mean anything; the admin row with its
  // emails, private-entry counts and suspension state stays on /team/members.
  //
  // Not audited. An audit row records an administrative ACTION taken on someone
  // (src/lib/admin-audit.ts); reading your own team's names is neither.
  if (url.pathname === "/team/roster" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    // Both lists are derived from the SAME resolved ids, so the teams named here
    // and the people listed here cannot disagree about who the caller is — and
    // because neither read depends on the other, they are issued together rather
    // than one after the next. This is a page-load endpoint; serially awaiting
    // two independent D1 reads inside the object literal costs both round trips.
    const [teams, members] = await Promise.all([
      listTeamWorkspaces(env, auth.companyWorkspaceIds),
      listRoster(env, auth.companyWorkspaceIds),
    ]);
    return json({
      ok: true,
      teams,
      members,
      you: auth.userId,
      admin: auth.role === "admin",
    });
  }

  if (url.pathname === "/team/members" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { name?: string; email?: string; role?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (body.role !== undefined && body.role !== "admin" && body.role !== "member") {
      return json({ ok: false, error: 'role must be "admin" or "member"' }, 400);
    }
    try {
      const { member, token } = await createMember(env, {
        name: body.name,
        email: body.email,
        role: body.role as "admin" | "member" | undefined,
      });
      // Never the token or its hash: this trail is read by more people than the
      // token is, and a role plus "was an email supplied" is the whole of what an
      // auditor needs to reconstruct the decision.
      adminAuditEvent(env, ctx, {
        actorId: auth.userId,
        targetUserId: member.userId,
        event: "member_created",
        payload: { role: member.role, hasEmail: !!member.email },
      });
      // The token is returned exactly once — only its hash is stored.
      return json({ ok: true, member, token }, 201);
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  if (url.pathname === "/team/members/token" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    try {
      const token = await rotateMemberToken(env, body.id.trim());
      // Deliberately an empty payload: that the rotation happened, to whom and by
      // whom is the whole record. The new secret is not part of it.
      adminAuditEvent(env, ctx, {
        actorId: auth.userId,
        targetUserId: body.id.trim(),
        event: "member_token_rotated",
      });
      return json({ ok: true, id: body.id.trim(), token });
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  if (url.pathname === "/team/members/suspend" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string; suspended?: boolean };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    try {
      const suspended = body.suspended !== false;
      await setMemberSuspended(env, auth.userId, body.id.trim(), suspended);
      // Two event names rather than one with a boolean: an auditor scanning for
      // "who lost access" should not have to read a payload to find out.
      adminAuditEvent(env, ctx, {
        actorId: auth.userId,
        targetUserId: body.id.trim(),
        event: suspended ? "member_suspended" : "member_unsuspended",
      });
      return json({ ok: true, id: body.id.trim(), suspended });
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  // POST /team/members/default-share — per-member capture-visibility override.
  // "inherit" clears it; the org-level default lives in config
  // (TEAM_DEFAULT_WORKSPACE) and is what "inherit" falls back to.
  if (url.pathname === "/team/members/default-share" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string; default?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    if (body.default !== "personal" && body.default !== "company" && body.default !== "inherit") {
      return json({ ok: false, error: 'default must be "personal", "company", or "inherit"' }, 400);
    }
    try {
      await setMemberDefaultShare(env, body.id.trim(), body.default as "personal" | "company" | "inherit");
      // Where a member's future captures land is a visibility decision, so the
      // value set is the point of the record.
      adminAuditEvent(env, ctx, {
        actorId: auth.userId,
        targetUserId: body.id.trim(),
        event: "member_default_share_set",
        payload: { default: body.default },
      });
      return json({ ok: true, id: body.id.trim(), default: body.default });
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  // POST /team/me/default-share — a member's own capture-visibility override.
  //
  // requireIdentity, and the body has NO id field. That is the security
  // property: the admin route above takes a target and must therefore be gated
  // on who the caller is, while this one cannot name a target at all, so there
  // is no branch to get wrong. The subject is auth.userId, which came from the
  // resolved identity and not from anything the request could say. An `id` in
  // the body is not rejected, it is simply unreadable from here.
  //
  // Returns the three recomputed fields rather than { ok: true } so the caller
  // re-renders from the server's own precedence answer instead of predicting
  // it — the same drift GET /team/me's effectiveDefault exists to prevent.
  if (url.pathname === "/team/me/default-share" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    let body: { default?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (body.default !== "personal" && body.default !== "company" && body.default !== "inherit") {
      return json({ ok: false, error: 'default must be "personal", "company", or "inherit"' }, 400);
    }
    // setMemberDefaultShare throws TeamAdminError(404) when no row changed, and
    // that cannot happen here: requireIdentity already resolved this row. No
    // try/catch — the same argument GET /team/me's unreachable 404 records
    // above. If the invariant ever breaks, it should reach the 500 handler.
    await setMemberDefaultShare(env, auth.userId, body.default);
    const orgDefault = cfg.TEAM_DEFAULT_WORKSPACE === "company" ? "company" : "personal";
    const defaultShare = body.default === "inherit" ? "" : body.default;
    // Audited like the admin twin, with self: true. Where a person's captures
    // land is a visibility decision whether or not an admin made it, so the
    // compliance view must not go blind the moment members can act.
    adminAuditEvent(env, ctx, {
      actorId: auth.userId,
      targetUserId: auth.userId,
      event: "member_default_share_set",
      payload: { default: body.default, self: true },
    });
    return json({
      ok: true,
      default: body.default,
      defaultShare,
      orgDefault,
      effectiveDefault: effectiveWriteTarget({ ...auth, defaultShare }, undefined, orgDefault),
    });
  }

  // POST /team/members/remove — soft offboarding. Marks the member removed,
  // deletes the personal workspace and everything in it; company-layer entries
  // the member authored stay (they are shared memory now). Guardrails inside
  // removeMember: not self, not the last active admin. The confirmation UX is
  // the dashboard's.
  if (url.pathname === "/team/members/remove" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    if (!body.id?.trim()) return json({ ok: false, error: "id is required" }, 400);
    try {
      const result = await removeMember(env, auth.userId, body.id.trim());
      // Audited before the Vectorize delete, not after: the D1 rows are already
      // gone by here, so a Vectorize failure must not also cost the record of the
      // destruction. The counts, never the content — this is the one
      // administration action that destroys memories, so how many is what a later
      // reader needs.
      adminAuditEvent(env, ctx, {
        actorId: auth.userId,
        targetUserId: body.id.trim(),
        event: "member_removed",
        payload: { removedEntries: result.removedEntries, removedVectors: result.vectorIds.length },
      });
      if (result.vectorIds.length) {
        await env.VECTORIZE.deleteByIds(result.vectorIds);
      }
      return json({ ok: true, id: body.id.trim(), removedEntries: result.removedEntries, removedVectors: result.vectorIds.length });
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  // GET /team/me — caller's own profile row (any signed-in identity).
  if (url.pathname === "/team/me" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const row = await env.DB.prepare(
      `SELECT id AS userId, name, email, role FROM users WHERE id = ? AND (removed_at IS NULL OR removed_at = 0)`,
    ).bind(auth.userId).first<{ userId: string; name: string; email: string | null; role: string }>();
    // Unreachable through a bearer token, and kept anyway. IDENTITY_SQL and
    // IDENTITY_BY_ID_SQL (src/lib/identity.ts) both exclude suspended and removed
    // users, so a caller who got past requireIdentity always has a row here — a
    // removed member gets 401 from the auth layer, never this 404. The
    // unreachability is therefore an invariant maintained in a DIFFERENT file:
    // deleting this branch would trade one line for a non-null assertion or a
    // crash if that invariant ever loosened, so it stays and fails closed.
    // Do not write a test for this 404 through the HTTP surface — the state it
    // guards cannot be reached from one.
    if (!row) return json({ ok: false, error: "Not found" }, 404);
    // Where this member's next capture lands, and the two inputs that decided
    // it. All three are additive — the four fields above keep their names and
    // values, so loadProfileName() in public/js/settings.js is untouched.
    //
    // TEAM_DEFAULT_WORKSPACE is a free-text config key, so it is narrowed to the
    // enum here rather than passed through: anything that is not "company" is
    // private-by-default, matching effectiveWriteTarget's own reading of it.
    const orgDefault = cfg.TEAM_DEFAULT_WORKSPACE === "company" ? "company" : "personal";
    // Who owns the deployment — the one thing `role` cannot say. tenancy.ts
    // hashes this brain's AUTH_TOKEN into a users row with role 'admin'
    // (invariant 4), and rowToIdentity narrows role to "admin" | "member", so
    // the person who created the brain and a colleague they promoted are the
    // same value on this route. The desktop app has to tell them apart: a
    // password change and a Worker update both need a Cloudflare session for
    // the account the Worker is deployed into, and only the owner has one.
    // Offering either to a promoted admin dead-ends at ErrorWrongCfAccount
    // after a full sign-in; withholding them from the owner takes away their
    // only in-app route to both.
    //
    // Free: requireIdentity above has already awaited this bootstrap, which is
    // memoised per DB binding, so no second query is issued and the scope
    // checker sees no new statement.
    const roots = await ensureTenantBootstrap(env);
    return json({
      ok: true,
      profile: {
        ...row,
        // Consumed by installer/src-tauri/src/commands.rs::connection_role,
        // which hands it to installer/src/connection-role.ts.
        owner: row.userId === roots.ownerUserId,
        // Already on the resolved Identity — no second column read, no second query.
        defaultShare: auth.defaultShare,
        orgDefault,
        // Resolved by the same function the write path calls (src/lib/scope.ts),
        // with no explicit target, because that is the case the composer's
        // "Default" option describes. Computed here rather than in the client:
        // a client that re-derives the precedence order drifts from it silently,
        // showing "Personal" while the capture lands in the company layer.
        effectiveDefault: effectiveWriteTarget(auth, undefined, orgDefault),
      },
    });
  }

  // GET /team/workspaces — the teams the caller belongs to, with names.
  //
  // Open to every member, not just admins: the name is how a member knows which
  // company they are sharing into, and the dashboard shows it in the sidebar for
  // everyone. Only the caller's own teams are ever returned, because the ids come
  // from their resolved identity.
  if (url.pathname === "/team/workspaces" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    return json({
      ok: true,
      teams: await listTeamWorkspaces(env, auth.companyWorkspaceIds),
      admin: auth.role === "admin",
    });
  }

  // POST /team/workspaces/rename — name a team. Admin-only.
  if (url.pathname === "/team/workspaces/rename" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string; name?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    // Defaults to the caller's primary team so a single-team brain — every brain
    // today — need not know its own workspace id to name itself.
    const id = body.id?.trim() || primaryCompanyWorkspaceId(auth);
    // An admin of one company cannot rename another's: the id has to be a team
    // this caller is actually in.
    if (!id || !auth.companyWorkspaceIds.includes(id)) {
      return json({ ok: false, error: "No team found with that ID" }, 404);
    }
    try {
      const name = await renameTeamWorkspace(env, id, body.name ?? "");
      // The only administration event whose subject is a workspace rather than a
      // member, so target_user_id stays empty and workspace_id carries the team.
      adminAuditEvent(env, ctx, {
        actorId: auth.userId,
        targetUserId: "",
        workspaceId: id,
        event: "team_renamed",
        payload: { name },
      });
      return json({ ok: true, id, name });
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  // POST /team/profile — rename self, or any member when caller is admin.
  if (url.pathname === "/team/profile" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    let body: { id?: string; name?: string; email?: string | null };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
    const targetId = body.id?.trim() || auth.userId;
    if (targetId !== auth.userId && auth.role !== "admin") {
      return json({ ok: false, error: "Forbidden" }, 403);
    }
    try {
      await setMemberProfile(env, targetId, { name: body.name, email: body.email });
      // `self` separates a member renaming themselves — routine, and the common
      // case — from an admin renaming someone else, which is administration.
      // The new name and email are omitted: they are member-supplied content.
      adminAuditEvent(env, ctx, {
        actorId: auth.userId,
        targetUserId: targetId,
        event: "member_profile_updated",
        payload: { self: targetId === auth.userId },
      });
      return json({ ok: true, id: targetId });
    } catch (e) {
      if (e instanceof TeamAdminError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  // GET /stats
  if (url.pathname === "/stats" && request.method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;
    const graceCutoff = Date.now() - graceMs(env);
    // This route answers two different questions and they need two different
    // scopes, which is why the first query carries the scope as a CASE rather
    // than a WHERE.
    //
    //  - Deployment health — `unvectorized`, `unclassified`, `digest_candidates`
    //    — stays corpus-wide. They drive repairs (POST /vectorize-pending,
    //    /classify-pending) and the nightly compression pass, all of which act on
    //    every workspace, so a scoped count would under-report the work and leave
    //    rows unrepairable with no sign of it.
    //
    //  - "What is my brain about" — `count`, `avg_importance`, `top_tags` — is
    //    content, and is scoped to the admin's own readable set. Unscoped, it
    //    reported colleagues' memories as the admin's own: `brain stats` in the
    //    CLI prints `top_tags` under "Top tags", so an admin's terminal listed
    //    members' private tag names, and "Total memories" disagreed with the
    //    /count and /list the same token got back.
    const scope = scopeWhere(auth);
    const [summary, tagRows, candidateRows] = await Promise.all([
      env.DB.prepare(
        // unvectorized skips deprecated entries: their vectors were deleted
        // deliberately, so counting them here offered the user a repair for
        // something that is not broken.
        // scope-exempt: the row set here is deliberately corpus-wide — unvectorized and unclassified are deployment repair counters and would under-report if narrowed (see the block comment above and team-isolation.test.ts). The caller's clause is applied INSIDE the CASE for count/avg_importance, which scopes those two numbers and not the rows read; that is why it is spelled as a CASE and not a WHERE
        `SELECT
           SUM(CASE WHEN ${scope.clause} THEN 1 ELSE 0 END) as count,
           AVG(CASE WHEN ${scope.clause} THEN importance_score END) as avg_importance,
           SUM(CASE WHEN vector_ids = '[]' AND created_at < ? AND ${INDEXABLE_SQL} THEN 1 ELSE 0 END) as unvectorized,
           SUM(CASE WHEN tags NOT LIKE '%"status:%' AND tags NOT LIKE '%"kind:%' THEN 1 ELSE 0 END) as unclassified
         FROM entries`
      ).bind(...scope.bindings, ...scope.bindings, graceCutoff).first() as Promise<Record<string, any> | null>,
      // Reserved namespaces and pipeline markers are excluded here rather than
      // hidden in the client: this panel answers "what is my brain about?", and
      // kind:episodic outranked every real topic on a production brain. Numeric
      // tags are legacy issue references (see src/text/hashtags.ts). LIMIT is
      // raised because the filter now discards rows the ORDER BY ranked first.
      env.DB.prepare(
        `SELECT value, COUNT(*) as n FROM entries, json_each(entries.tags)
         WHERE value NOT LIKE 'kind:%' AND value NOT LIKE 'status:%'
           AND value NOT LIKE 'volatility:%' AND value NOT LIKE 'stale:%'
           AND value NOT IN ('auto-pattern', 'auto-insight', 'synthesized', 'rolled-up', 'duplicate-candidate')
           AND value NOT GLOB '[0-9]*'
           AND ${scope.clause}
         GROUP BY value ORDER BY n DESC LIMIT 5`,
      ).bind(...scope.bindings).all(),
      // Scoped like top_tags directly above, and for the same reason: this list
      // is tag NAMES, and it is rendered on the admin's dashboard. Unscoped it
      // named colleagues' private topics — "divorce-paperwork" beside a count —
      // from workspaces the same token gets a 404 from /entry for. The nightly
      // compression pass picks its own tags per workspace (src/compression), so
      // narrowing this display list costs no repair coverage.
      env.DB.prepare(`
        SELECT value as tag, COUNT(*) as count
        FROM entries, json_each(entries.tags)
        WHERE ${isTopicTagSql()}
          AND entries.tags NOT LIKE '%"rolled-up"%'
          AND entries.tags NOT LIKE '%"synthesized"%'
          AND entries.tags NOT LIKE '%"auto-pattern"%'
          AND entries.tags NOT LIKE '%"auto-insight"%'
          AND ${compressionEligibilitySql("entries.", cfg)}
          AND entries.${scope.clause}
        GROUP BY value
        HAVING count > 10
        ORDER BY count DESC
        LIMIT 10
      `).bind(Date.now() - cfg.COMPRESSION_MIN_AGE_MS, ...scope.bindings).all(),
    ]);

    const cutoff = Date.now() - 86400000;
    const digestCandidates: { tag: string; count: number }[] = [];
    for (const row of candidateRows.results as any[]) {
      // Scoped to match the query that produced `row`: "has this tag already
      // been digested?" has to be asked of the same rows the tag was counted
      // over, or a colleague's digest in an unreadable workspace silently
      // removes a real candidate from the admin's own list.
      const existing = await env.DB.prepare(
        `SELECT id FROM entries WHERE tags LIKE '%"synthesized"%' AND tags LIKE ? ${TAG_LIKE_ESCAPE} AND created_at > ? AND ${scope.clause} LIMIT 1`
      ).bind(tagLikePattern(row.tag as string), cutoff, ...scope.bindings).first();
      if (!existing) digestCandidates.push({ tag: row.tag as string, count: row.count as number });
    }

    return json({
      count: (summary?.count as number) ?? 0,
      avg_importance: summary?.avg_importance != null ? Math.round((summary.avg_importance as number) * 10) / 10 : null,
      top_tags: (tagRows.results as any[]).map(r => r.value as string),
      digest_candidates: digestCandidates,
      unvectorized: (summary?.unvectorized as number) ?? 0,
      vectorize_grace_ms: graceMs(env),
      unclassified: (summary?.unclassified as number) ?? 0,
    });
  }

  // GET /health — index/runtime health, used by the dashboard banner, the
  // README verify step, and external uptime checks. Authenticated like the
  // rest of the API but deliberately NOT admin-gated: it reports index state,
  // not cross-workspace data, and every signed-in member's dashboard banner
  // reads it.
  if (url.pathname === "/health" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const vectorize = await checkVectorizeHealth(env);
    // "team" is the dashboard's signal to show the layer controls (capture
    // target, share actions, layer filters). Layers exist on every v3 brain,
    // but until a second member is invited the toggle is noise for a solo
    // owner, so the flag reads actual membership, not provisioning.
    const members = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
    // Result-quality signal, not correctness: every hydration below this is
    // scoped at the SQL layer regardless, so a degraded filter never leaks
    // another workspace's data — it just lets foreign candidates crowd out
    // the caller's own in the vector index's own topK before SQL filters
    // them back out. `latchedAt` reads the durable KV marker rather than
    // trusting the in-memory latch alone, so the signal survives isolate
    // churn between deploys.
    const { supported, degradedQueries } = vectorizeFilterState();
    // A KV blip must not turn this route's other, independently-available
    // signals (vectorize.ok, team) into a 500 — /health previously depended
    // on describe() and one D1 count only. `.catch(() => null)` degrades
    // latchedAt to "unknown" instead, exactly like a marker that was never
    // written.
    const latchedAtRaw = await env.OAUTH_KV.get(VECTORIZE_WORKSPACE_FILTER_UNSUPPORTED_KV_KEY).catch(() => null);
    const latchedAt = latchedAtRaw ? Number(latchedAtRaw) : null;
    return json({
      ok: vectorize.ok,
      version: SB_VERSION,
      vectorize: { ...vectorize, workspaceFilter: { supported, degradedQueries, latchedAt } },
      team: (members?.n ?? 0) > 1,
    });
  }

  // GET /patterns — the whole review queue, paged.
  //
  // The dashboard used to build this list from `/list?n=20&tag=auto-pattern`
  // (the old producer) and drop the deprecated rows in the browser, which
  // cannot work on a brain that has been running a while: dismissed insight
  // proposals keep their tag forever, so once there are more than a page of
  // them the filter throws away every row and the panel renders empty while
  // real proposals wait behind them. Filtering belongs in the query.
  // The three review surfaces below are per-caller, not administration: each
  // member confirms or dismisses their OWN pending insights and stale claims, and
  // every query is scoped to their readable set.
  //
  // They were requireAdmin, which cost nothing while a brain had one user and two
  // things once it had more. A member's Home screen calls /patterns on every load
  // (public/js/brief.js) and got a 403, so the insight feature was invisible to
  // everyone but the admin; and the admin's queues were unscoped, so they printed
  // colleagues' private memories in full — the same rows GET /entry answers 404
  // for with the same token. Scoping alone would have left members' flagged
  // memories reviewable by nobody at all.
  if (url.pathname === "/patterns" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const limit = intParam(url, "limit", { fallback: 50, min: 1, max: 100 });
    if (limit instanceof Response) return limit;
    const offset = intParam(url, "offset", { fallback: 0, min: 0 });
    if (offset instanceof Response) return offset;

    // Scoped, like every other route that returns memory content. This queue is
    // admin-only, but "admin" does not mean "may read a member's personal
    // workspace" anywhere else in this codebase: the same token gets a 404 from
    // GET /entry for the very row this queue was printing in full. An insight is
    // drawn from the memories it cites, so an unscoped queue handed the admin a
    // member's private material verbatim.
    const scope = scopeWhere(auth);
    const [rows, countRow] = await Promise.all([
      env.DB.prepare(
        `SELECT id, content, created_at FROM entries
         WHERE ${PENDING_INSIGHT_SQL} AND ${scope.clause}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ).bind(...scope.bindings, limit, offset).all(),
      // The total drives "N waiting" and the pager. It is a second query rather
      // than a window function so the shape survives D1's SQLite build.
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM entries WHERE ${PENDING_INSIGHT_SQL} AND ${scope.clause}`,
      ).bind(...scope.bindings).first() as Promise<Record<string, any> | null>,
    ]);

    const pageIds = (rows.results as Record<string, any>[]).map(r => r.id as string);
    // One query for the whole page rather than one per insight. LEFT JOIN so a
    // source deleted after the edge was written still surfaces as a row — the
    // edges table has no foreign keys, so an edge can outlive its target, and
    // the reviewer needs to be told the source is gone rather than shown a gap.
    const sourcesByInsight = new Map<string, ({ id: string; content: string } | { id: string; missing: true })[]>();
    if (pageIds.length) {
      // The scope goes in the JOIN's ON clause, not the WHERE. Only `e.source_id`
      // was ever constrained here — those are the scoped page's insight ids — but
      // the CONTENT returned comes from `e.target_id`, which nothing constrained,
      // so an insight the caller may read handed back the full text of a memory
      // in a colleague's personal workspace. It is the same defect as the
      // /insights/dry-run pair query: a join through an unscoped table, not a
      // by-id lookup.
      //
      // In the ON clause rather than the WHERE because this is a LEFT JOIN whose
      // whole point is that a source deleted after the edge was written still
      // surfaces as a row. A WHERE predicate would drop those rows (NULL IN (...)
      // is never true) and take the "missing" signal with them. In the ON clause,
      // an unreadable source reads exactly like a deleted one — the reviewer is
      // told the source is unavailable rather than shown a colleague's memory,
      // which is the same answer GET /entry gives for that id.
      //
      // Written `m.${scope.clause}` rather than building the clause with the
      // alias baked in, so the alias is visible in the template itself: that is
      // what lets scripts/check-scope.mjs attribute the clause to `m` instead of
      // counting it against whichever table reference it reaches first.
      const mScope = scopeWhere(auth);
      // scope-exempt: the edges alias e is pinned by source_id IN (the scoped insight page above); the entries alias m carries its own clause in the ON below
      const sourceRows = (await env.DB.prepare(
        `SELECT e.source_id AS insight_id, e.target_id AS id, m.content AS content
         FROM edges e LEFT JOIN entries m ON m.id = e.target_id AND m.${mScope.clause}
         WHERE e.type = 'drawn_from' AND e.source_id IN (${pageIds.map(() => "?").join(",")})`,
      ).bind(...mScope.bindings, ...pageIds).all()).results as Record<string, any>[];
      for (const r of sourceRows) {
        const list = sourcesByInsight.get(r.insight_id as string) ?? [];
        list.push(
          r.content == null
            ? { id: r.id as string, missing: true }
            : { id: r.id as string, content: r.content as string },
        );
        sourcesByInsight.set(r.insight_id as string, list);
      }
    }

    return json({
      ok: true,
      patterns: (rows.results as Record<string, any>[]).map(r => ({
        id: r.id as string,
        content: r.content as string,
        created_at: r.created_at as number,
        sources: sourcesByInsight.get(r.id as string) ?? [],
      })),
      total: (countRow?.n as number) ?? 0,
      limit,
      offset,
    });
  }

  // GET /stale — the out-of-date review queue.
  //
  // Home's chip reads "N may be out of date" off an exact tag predicate, so the
  // entries behind that number are knowable exactly. It used to be wired to a
  // free-text recall for the phrase "What might be out of date?" — a vector
  // search over the whole brain, which returns the flagged entries only by
  // coincidence, and on a real brain returned two memories that merely contained
  // the words while the one actually flagged never appeared.
  //
  // A client-side filter over /list is not the alternative: the dashboard holds
  // the 50 most recent entries, and a memory old enough to be flagged stale is
  // almost never among them. That is the same mistake the insight panel made
  // before /patterns existed, and it renders an empty list rather than a wrong
  // one. Filtering belongs in the query.
  if (url.pathname === "/stale" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const limit = intParam(url, "limit", { fallback: 50, min: 1, max: 100 });
    if (limit instanceof Response) return limit;
    const offset = intParam(url, "offset", { fallback: 0, min: 0 });
    if (offset instanceof Response) return offset;

    // Scoped for the same reason as /patterns: this queue prints memory content,
    // and an admin gets a 404 from GET /entry for a member's personal row. The
    // reviewer confirms or corrects their own claims, not a colleague's.
    const scope = scopeWhere(auth);
    const [rows, countRow] = await Promise.all([
      env.DB.prepare(
        `SELECT id, content, tags, source, created_at, COALESCE(updated_at, created_at) AS last_updated
         FROM entries
         WHERE ${STALE_REVIEW_SQL} AND ${scope.clause}
         ORDER BY COALESCE(updated_at, created_at) ASC LIMIT ? OFFSET ?`,
      ).bind(...scope.bindings, limit, offset).all(),
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM entries WHERE ${STALE_REVIEW_SQL} AND ${scope.clause}`,
      ).bind(...scope.bindings).first() as Promise<Record<string, any> | null>,
    ]);

    return json({
      ok: true,
      // Oldest-touched first: the least recently confirmed claim is the one most
      // worth a human's attention, and it keeps paging stable while entries drop
      // out of the queue as they are edited.
      entries: (rows.results as Record<string, any>[]).map(r => ({
        id: r.id as string,
        content: r.content as string,
        tags: JSON.parse((r.tags as string) ?? "[]") as string[],
        source: r.source as string,
        created_at: r.created_at as number,
        last_updated: r.last_updated as number,
      })),
      total: (countRow?.n as number) ?? 0,
      limit,
      offset,
    });
  }

  // POST /patterns/resolve — confirm or dismiss a proposed insight.
  // Dashboard-only, no MCP twin: insight review is a human curation act, not
  // an agent capability. Confirm promotes an insight into a real recallable
  // memory; dismiss deprecates it (audit row kept, vectors removed).
  //
  // Takes `id` for one or `ids` for many. Ruling on a backlog one at a time is
  // the actual complaint this answers, and doing it as N single requests would
  // be N round trips against a Worker that gets ~50 D1 queries per invocation.
  if (url.pathname === "/patterns/resolve" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    let body: { id?: string; ids?: unknown; action?: string };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

    const action = body.action;
    if (action !== "confirm" && action !== "dismiss") {
      return json({ ok: false, error: `action must be "confirm" or "dismiss"` }, 400);
    }

    // Scoped like the /patterns queue these ids come from. Confirm promotes a
    // memory and dismiss deprecates it and drops its vectors, so an unscoped
    // lookup let an admin rewrite rows in a member's personal workspace — rows
    // the same token cannot read through GET /entry.
    const scope = scopeWhere(auth);
    const bulkLimit = D1_MAX_BOUND_PARAMS - scope.bindings.length;

    const single = body.id?.trim();
    let ids: string[];
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids) || body.ids.some(i => typeof i !== "string")) {
        return json({ ok: false, error: "ids must be an array of strings" }, 400);
      }
      // De-duplicated because the same id twice would bind two parameters and
      // count the same row twice in the reply.
      ids = [...new Set((body.ids as string[]).map(i => i.trim()).filter(Boolean))];
      if (!ids.length) return json({ ok: false, error: "ids must not be empty" }, 400);
      // D1 allows 100 bound parameters per statement, and the id list is the
      // whole of the SELECT's binding. The client pages; this refuses rather
      // than silently truncating, because a silent truncation here reads as
      // "those patterns were resolved" when they were not.
      if (ids.length > bulkLimit) {
        return json({ ok: false, error: `ids must not exceed ${bulkLimit} per request` }, 400);
      }
    } else {
      if (!single) return json({ ok: false, error: "id is required" }, 400);
      ids = [single];
    }

    const placeholders = ids.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, tags, vector_ids FROM entries WHERE id IN (${placeholders}) AND ${scope.clause}`,
    ).bind(...ids, ...scope.bindings).all();
    const found = results as Record<string, any>[];

    // The single-id form keeps its precise errors, because a client asking about
    // one pattern can act on "not found" and the bulk form cannot.
    if (body.ids === undefined) {
      if (!found.length) return json({ ok: false, error: `No entry found with ID: ${ids[0]}` }, 404);
      if (!(JSON.parse(found[0].tags ?? "[]") as string[]).includes("auto-insight")) {
        return json({ ok: false, error: "Entry is not a derived insight" }, 400);
      }
    }

    const statements: D1PreparedStatement[] = [];
    const vectorsToDrop: string[] = [];
    const resolved: string[] = [];

    for (const row of found) {
      const tags: string[] = JSON.parse(row.tags ?? "[]");
      // Anything that is not an unresolved pattern is skipped rather than
      // rejected: a bulk request built from a list the user was looking at can
      // legitimately race a nightly pass or a second tab.
      if (!tags.includes("auto-insight") || getStatus(tags) === "deprecated") continue;

      if (action === "confirm") {
        // Losing the auto-insight tag is what exits the recall exclusion — it is
        // enforced at D1 hydration, not vector metadata, so this tag update alone
        // makes the entry recallable. No re-embed: content is unchanged and vectors
        // already exist (the stale auto-insight flag in vector metadata is harmless).
        const promoted = withStatus(withKind(tags.filter(t => t !== "auto-insight"), "semantic"), "canonical");
        statements.push(
          env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(promoted), row.id),
        );
      } else {
        // Inlined rather than calling deprecateEntry per id: that reads the row
        // again and issues its own UPDATE and its own Vectorize delete, so a
        // hundred dismissals would be three hundred subrequests. Same effect —
        // status:deprecated, vectors emptied, vectors deleted — in a fixed three.
        statements.push(
          env.DB.prepare(`UPDATE entries SET tags = ?, vector_ids = ? WHERE id = ?`)
            .bind(JSON.stringify(withStatus(tags, "deprecated")), "[]", row.id),
        );
        vectorsToDrop.push(...(JSON.parse(row.vector_ids ?? "[]") as string[]));
      }
      resolved.push(row.id as string);
    }

    // One subrequest however many statements it holds, which is the whole reason
    // the loop above builds them instead of running them.
    if (statements.length) await env.DB.batch(statements);

    if (vectorsToDrop.length) {
      try {
        await env.VECTORIZE.deleteByIds(vectorsToDrop);
      } catch (e) {
        // D1 already says deprecated and recall filters on that, so the entries
        // are out of recall either way; the index just keeps some dead vectors.
        console.error("Vectorize deleteByIds failed during bulk dismiss (non-fatal):", e);
      }
    }

    return json({
      ok: true,
      action,
      resolved: resolved.length,
      // Named, so a client that showed the user N rows can tell which survived a
      // race rather than assuming all of them were ruled on.
      ids: resolved,
      skipped: ids.length - resolved.length,
      ...(body.ids === undefined ? { id: ids[0] } : {}),
    });
  }

  // POST /vectorize-pending
  if (url.pathname === "/vectorize-pending" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;

    const graceCutoff = Date.now() - graceMs(env);

    // Deprecated entries are skipped, matching the migration path
    // (src/migration/embedding.ts). Without this, dismissing a pattern deleted
    // its vectors and then this button put them straight back — spending the
    // daily embedding budget to reindex something the user had just told the
    // brain to drop, and crowding the vector query with candidates that recall
    // discards at hydration anyway.
    const { results: toProcess } = await env.DB.prepare(
      // scope-exempt: admin repair backlog: deployment-wide by design, returns counts not content
      `SELECT id, content, tags, source, created_at, workspace_id, actor_id FROM entries
       WHERE vector_ids = '[]' AND created_at < ? AND ${INDEXABLE_SQL}
       ORDER BY created_at DESC LIMIT 25`
    ).bind(graceCutoff).all();

    let processed = 0;
    let failed = 0;

    for (const row of toProcess as Record<string, any>[]) {
      try {
        await storeEntry(
          env,
          row.id as string,
          row.content as string,
          JSON.parse(row.tags as string),
          row.source as string,
          row.created_at as number,
          // Without this the backfill embeds with DEFAULTS.EMBEDDING_MODEL while
          // capture and recall use the configured one, writing vectors from the
          // wrong model into the index — scores go quietly wrong, nothing throws.
          cfg,
          // This route repairs OTHER members' rows by design — the context comes
          // from the row, never from `auth`. Stamping the admin's workspace here
          // would move every repaired vector into the admin's own space.
          { workspaceId: row.workspace_id as string, actorId: row.actor_id as string },
        );
        processed++;
      } catch (e) {
        console.error("Re-embed failed for entry", row.id, e);
        failed++;
      }
    }

    // Same filter as the select above, or the loop never reaches zero: the
    // dashboard presses this until `remaining` is 0, so counting rows the select
    // refuses to process would spin until the batch-made-no-progress guard.
    const remaining = await env.DB.prepare(
      // scope-exempt: admin repair backlog: must match the SELECT above or the loop never reaches zero
      `SELECT COUNT(*) as count FROM entries WHERE vector_ids = '[]' AND created_at < ? AND ${INDEXABLE_SQL}`
    ).bind(graceCutoff).first() as Record<string, any> | null;

    return json({ processed, failed, remaining: (remaining?.count as number) ?? 0 });
  }

  // POST /classify-pending
  // One-time, opt-in backfill: runs classifyEntry over entries that predate the
  // status (#119) and kind (#12) features and writes status:/kind: tags. Bounded
  // batch per call, idempotent (skips entries that already carry either tag), and
  // resumable (safe to stop/restart). No schema migration — only writes tags.
  if (url.pathname === "/classify-pending" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;

    const UNCLASSIFIED_WHERE = `tags NOT LIKE '%"status:%' AND tags NOT LIKE '%"kind:%'`;

    const { results: toProcess } = await env.DB.prepare(
      // scope-exempt: admin repair backlog: deployment-wide by design, returns counts not content
      `SELECT id, content, tags FROM entries
       WHERE ${UNCLASSIFIED_WHERE}
       ORDER BY created_at ASC LIMIT 25`
    ).all();

    let processed = 0;
    let failed = 0;

    for (const row of toProcess as Record<string, any>[]) {
      try {
        // cfg carries the user's LLM_MODEL choice; without it this backfill
        // classifies with the shipped default and ignores their setting.
        const { canonical, kind } = await classifyEntry(row.content as string, env, cfg);
        let tags: string[] = JSON.parse(row.tags as string);
        if (kind) tags = withKind(tags, kind);
        if (canonical && getStatus(tags) === null) tags = withStatus(tags, "canonical");
        await env.DB.prepare(`UPDATE entries SET tags = ? WHERE id = ?`).bind(JSON.stringify(tags), row.id).run();
        processed++;
      } catch (e) {
        console.error("Classification backfill failed for entry", row.id, e);
        failed++;
      }
    }

    const remaining = await env.DB.prepare(
      // scope-exempt: admin repair backlog: must match the SELECT above or the loop never reaches zero
      `SELECT COUNT(*) as count FROM entries WHERE ${UNCLASSIFIED_WHERE}`
    ).first() as Record<string, any> | null;

    return json({ processed, failed, remaining: (remaining?.count as number) ?? 0 });
  }

  // POST /insights/accrue — run one accrual pass on demand, right now.
  //
  // The nightly cron (runInsightAccrual, src/insight/candidates.ts) examines
  // only ACCRUAL_SEED_LIMIT (25) entries per run, topped up from a backfill
  // cursor on quiet nights. That is fine for a brain that grows a little
  // every day, but a self-hoster installing this against an EXISTING brain
  // of a few thousand entries would otherwise wait months for the backfill
  // cursor to cross it once — the weekly pass would have almost nothing to
  // reason over, and the feature would look broken with no way to prime it.
  //
  // This calls the exact same function the cron does, once, synchronously,
  // and reports what it found — no separate accrual logic lives here. The
  // cursor it walks is the SAME cursor the nightly cron uses (KV key
  // ACCRUAL_CURSOR_KEY), so calling this repeatedly walks it forward exactly
  // like repeated nights would: that is the intended way to prime a large
  // brain, not a one-shot backfill. Call it until `seeds_examined` comes back
  // small — that means the cursor has caught up to the present.
  if (url.pathname === "/insights/accrue" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;

    const pendingCount = () =>
      env.DB.prepare(`SELECT COUNT(*) AS n FROM insight_candidates WHERE status = 'pending'`)
        .first() as Promise<Record<string, any> | null>;

    // Before/after rather than threading a write-count out of
    // runInsightAccrual itself: every row it inserts starts 'pending' and
    // nothing else in this request can change that count concurrently, so
    // the delta is exactly how many candidates this pass newly recorded —
    // including the ON CONFLICT(a_id, b_id) DO NOTHING case, where an
    // attempted insert did not actually add a row.
    const before = await pendingCount();
    const { seedsExamined } = await runInsightAccrual(env, ctx);
    const after = await pendingCount();

    const pendingTotal = (after?.n as number) ?? 0;
    const pendingBefore = (before?.n as number) ?? 0;

    return json({
      ok: true,
      seeds_examined: seedsExamined,
      candidates_recorded: pendingTotal - pendingBefore,
      pending_total: pendingTotal,
    });
  }

  // GET /insights/dry-run — what the weekly pass would say, without saying it.
  //
  // Ships ahead of the weekly writer being enabled. The design was validated
  // against a brain that is not representative, so the first question is
  // whether the shortlist is any good on real data — and this answers it for
  // the price of a few model calls and no writes at all. A declined candidate
  // is reported with null shape/text rather than dropped, so a reader can see
  // a high-scoring pair was considered and rejected, not just what survived.
  if (url.pathname === "/insights/dry-run" && request.method === "GET") {
    const auth = await requireAdmin(request, env);
    if (auth instanceof Response) return auth;

    const limit = intParam(url, "limit", { fallback: 10, min: 1, max: 25 });
    if (limit instanceof Response) return limit;

    // a.tags/b.tags added so this can apply the same D1 pair rule the weekly
    // pass applies (src/insight/weekly.ts) — without them, this endpoint
    // could not tell an assistant-authored pair from any other and would
    // report exactly what production refuses as if it would be written.
    //
    // requireAdmin authorises this surface; it does not widen the readable row
    // set (src/lib/scope.ts). Both sides of the pair are scoped independently:
    // a candidate is previewable only when the caller could have read BOTH of
    // the memories it draws on, which is the same rule GET /entry applies one
    // row at a time. This one reaches `entries` through JOIN rather than FROM,
    // which is how it stayed unscoped while every sibling query was fixed.
    const aScope = scopeWhere(auth, undefined, "a.workspace_id");
    const bScope = scopeWhere(auth, undefined, "b.workspace_id");
    const { results } = await env.DB.prepare(
      `SELECT c.id, c.a_id, c.b_id, c.score, a.content AS a_content, b.content AS b_content,
              a.tags AS a_tags, b.tags AS b_tags
       FROM insight_candidates c
       JOIN entries a ON a.id = c.a_id
       JOIN entries b ON b.id = c.b_id
       WHERE c.status = 'pending'
         AND a.tags NOT LIKE '%"status:deprecated"%'
         AND b.tags NOT LIKE '%"status:deprecated"%'
         AND ${aScope.clause} AND ${bScope.clause}
       ORDER BY c.score DESC
       LIMIT ?`,
    ).bind(...aScope.bindings, ...bScope.bindings, limit).all() as { results: Record<string, any>[] };

    // D2's comparison list, built exactly as src/insight/weekly.ts builds it:
    // insights still unreviewed from earlier runs, seeded before the loop and
    // grown as this preview accepts candidates. Without this, the dry run
    // could not reproduce the spec's own motivating case — a candidate
    // restating an insight a PRIOR run already wrote is invisible to a
    // same-run-only check.
    //
    // Scoped for the same reason the candidate query is, and the leak here is
    // quieter: the comparison text is never printed, but an unscoped list lets a
    // colleague's private proposal suppress the caller's own candidate with the
    // reason "restates a recently written insight" — an admin told her preview
    // duplicates something she cannot see and did not write.
    const scope = scopeWhere(auth);
    const { results: recentInsightRows } = await env.DB.prepare(
      `SELECT content FROM entries WHERE ${PENDING_INSIGHT_SQL} AND ${scope.clause}
       ORDER BY created_at DESC LIMIT ?`,
    ).bind(...scope.bindings, RECENT_INSIGHT_WINDOW).all() as { results: { content: string }[] };
    const writtenThisRun: string[] = recentInsightRows.map(r => rawInsightText(r.content));

    const candidates = [];
    // Reasons over every row the query returned, deliberately past the three
    // production would ever write (src/insight/weekly.ts's own
    // MAX_INSIGHTS_PER_RUN cap) — seeing candidates four and beyond is how the
    // ranking itself gets judged. `would_write` marks the first three
    // candidates, in score order, that clear D1 (pair-eligible), the model
    // (an "insight" outcome), AND D2 (not restatesRecent against
    // writtenThisRun) — the same three gates runWeeklyInsights applies before
    // it ever calls captureEntry. This is close to but not exactly what
    // production's `written` counter tracks: that increments only when
    // captureEntry returns `status: "stored"`, so an accepted, non-restating
    // insight that turns out to duplicate an earlier ENTRY (not a recent
    // insight — captureEntry's own separate duplicate check) consumes no slot
    // there but is still counted here. A dry run cannot resolve that without
    // calling captureEntry, which would make it a write rather than a preview
    // — this is the one place that gap between preview and production is
    // recorded.
    let written = 0;
    for (const row of results) {
      // D1 at the draw (src/insight/weekly.ts): a pair this disqualified is
      // never sent to the model in production, so the preview must not spend
      // a model call on it either — otherwise the dry run reports as
      // writable exactly what production refuses, which is the bug the
      // Rollout section's comparison exists to catch.
      const aTags = parseTags(row.a_tags as string);
      const bTags = parseTags(row.b_tags as string);
      if (!isEligiblePair({ tags: aTags }, { tags: bTags })) {
        candidates.push({
          a_id: row.a_id as string,
          b_id: row.b_id as string,
          score: row.score as number,
          outcome: "pair_rejected",
          shape: null,
          text: null,
          would_write: false,
          reason: "both memories are assistant-authored (D1)",
        });
        continue;
      }

      // cfg carries the user's LLM_MODEL choice, same as the real weekly pass
      // (src/insight/weekly.ts) — without it this would preview reasoning from
      // the shipped default model rather than the one that will actually run.
      const result = await reasonOverPair(
        { content: row.a_content as string },
        { content: row.b_content as string },
        env,
        cfg,
      );

      // would_write and `reason` are worked out in the same order
      // runWeeklyInsights actually applies its checks: the cap (a candidate
      // reached only after production's loop would already have broken),
      // then D2's novelty floor, then acceptance. A decline or a failed call
      // is definitive regardless of where it falls in that order.
      let would_write = false;
      let reason: string | null = null;
      if (result.outcome === "declined") {
        reason = "the model declined this pair";
      } else if (result.outcome === "failed") {
        reason = "the model call itself failed";
      } else if (written >= MAX_INSIGHTS_PER_RUN) {
        reason = `the weekly cap of ${MAX_INSIGHTS_PER_RUN} insights would already be reached`;
      } else if (restatesRecent(result.text, writtenThisRun)) {
        // Same rule src/insight/weekly.ts applies (D2): reasoned to a real
        // insight, but the text lands where a reader has already been.
        reason = "restates a recently written insight";
      } else {
        would_write = true;
        written++;
        writtenThisRun.push(result.text);
      }

      candidates.push({
        a_id: row.a_id as string,
        b_id: row.b_id as string,
        score: row.score as number,
        // "declined" and "failed" are both reported, distinctly, rather than
        // collapsed to null: a human reading the shortlist can tell "the model
        // looked and said no" apart from "the call itself never answered",
        // which matters for judging whether the ranking or the model call is
        // the thing worth investigating.
        outcome: result.outcome,
        shape: result.outcome === "insight" ? result.shape : null,
        text: result.outcome === "insight" ? result.text : null,
        would_write,
        reason,
      });
    }

    return json({ ok: true, candidates });
  }

  return null;
}
