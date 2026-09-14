/**
 * The three insight schedules, in one place.
 *
 * They are separate from the maintenance cron because they are separate
 * budgets, the same argument wrangler.jsonc already makes for the integration
 * sync (#290): every Worker invocation gets only 10 ms of CPU on the free plan
 * regardless of subrequest count (the platform's real subrequest ceiling is
 * 1,000 D1/KV/Vectorize calls and 50 external fetch()es per invocation), and
 * this codebase holds itself to a self-imposed D1 budget of ~50 calls per
 * invocation for cost discipline; maintenance already spends about 30 of them,
 * and accrual needs about 34 on its own (see src/insight/candidates.ts's
 * ACCRUAL_SEED_LIMIT comment for the measurement).
 *
 * These strings must match wrangler.jsonc exactly. test/unit/cron-triggers.test.ts
 * fails if they drift.
 */

/** Nightly. Offset from maintenance at :00 so the two never share a minute. */
export const INSIGHT_ACCRUAL_CRON = "45 1 * * *";

/**
 * Sundays, after the night's accrual has landed.
 *
 * Day-of-week is spelled "SUN", not "0": Cloudflare's trigger API rejects the
 * numeric form. `wrangler triggers deploy` with "15 2 * * 0" fails registration
 * with `code 10100: invalid cron string: 15 2 * * 0`, confirmed empirically
 * against the live API — Worker code deploys still succeed, so this fails
 * silently unless the deploy output is read closely. Do not "tidy" this back
 * to 0.
 */
export const INSIGHT_WEEKLY_CRON = "15 2 * * SUN";

/**
 * The team pass, thirty minutes after the personal one.
 *
 * Its own trigger because it cannot share an invocation: the weekly pass
 * measures 38 of this codebase's self-imposed 50-call D1 budget at a full
 * candidate slate (test/integration/insight-cron-budget.test.ts), so two passes
 * in one invocation is 76 — well under the platform's real 1,000-call ceiling,
 * but twice the CPU of one pass inside a single 10 ms-CPU invocation, and the
 * second one would find its share of the D1 cost budget already mostly spent.
 * Two budgets, two triggers — the same answer #290 gave the integration sync.
 *
 * "SUN", not "0", for the reason INSIGHT_WEEKLY_CRON gives.
 */
export const INSIGHT_TEAM_WEEKLY_CRON = "45 2 * * SUN";
