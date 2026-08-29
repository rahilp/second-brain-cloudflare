/**
 * The cron strings in wrangler.jsonc and the one scheduled() routes on are the
 * same fact written in two places, and nothing at build or deploy time checks
 * they agree (#290).
 *
 * Drift is silent and it is expensive in one direction: if INTEGRATION_SYNC_CRON
 * stops matching a configured schedule, every invocation falls through to the
 * maintenance branch, the mirror sync never runs at all, and the only symptom is
 * integrations quietly going stale. If a schedule is configured that nothing
 * routes, it costs an invocation an hour to run maintenance again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { INTEGRATION_SYNC_CRON } from "../../src/integrations/mirror";
import { INSIGHT_ACCRUAL_CRON, INSIGHT_TEAM_WEEKLY_CRON, INSIGHT_WEEKLY_CRON } from "../../src/insight/schedule";

const ROOT = resolve(import.meta.dirname, "../..");

function configuredCrons(): string[] {
  const raw = readFileSync(resolve(ROOT, "wrangler.jsonc"), "utf8");
  // Strip // comments (wrangler.jsonc uses them) before parsing. Deliberately
  // not a full JSONC parser: the file has no block comments and no strings
  // containing "//" outside the URLs in comments, which this removes anyway.
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
  const config = JSON.parse(stripped);
  return config.triggers?.crons ?? [];
}

/**
 * A cron field this comparison can evaluate: `*`, or a single literal value.
 * Anything carrying a range (`1-3`), a list (`SUN,MON`) or a step is NOT
 * literal — see canCollide for why that matters.
 */
const LITERAL_FIELD = /^(?:\*|[A-Z0-9]+)$/;

const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/**
 * `SUN`, `0` and `7` are the same day. Numeric fields lose leading zeros so
 * `05` and `5` compare equal too.
 */
function normaliseField(field: string, isDayOfWeek = false): string {
  if (isDayOfWeek) {
    const named = DAY_NAMES.indexOf(field);
    if (named >= 0) return String(named);
    if (field === "7") return "0";
  }
  return /^\d+$/.test(field) ? String(Number(field)) : field;
}

/**
 * Whether two cron strings can ever fire in the same minute.
 *
 * It DECIDES ONLY WHAT IT CAN READ, and reports everything else as a
 * collision. A field is comparable only when both sides are `*` or a single
 * literal; a range, a list or a step is undecidable to this comparison and
 * therefore treated as colliding. That is the direction a guard has to fail
 * in — calling two schedules distinct is what lets a collision ship, and it is
 * exactly what the earlier string-equality version did with `1,2` against `2`.
 * A false collision costs one moved schedule; a missed one costs a pass dying
 * half-written against a shared 50-subrequest budget.
 *
 * Day-of-month and day-of-week are not independent: standard cron (which
 * Cloudflare documents) fires when EITHER matches once both are restricted, so
 * `45 2 1 * MON` and `45 2 1 * TUE` both fire on the 1st despite disjoint
 * day-of-week fields. Any schedule that restricts both is therefore reported as
 * colliding rather than compared field by field.
 */
function canCollide(a: string, b: string): boolean {
  const fa = a.trim().toUpperCase().split(/\s+/);
  const fb = b.trim().toUpperCase().split(/\s+/);
  const overlaps = (x: string, y: string, isDayOfWeek = false) => {
    if (!LITERAL_FIELD.test(x) || !LITERAL_FIELD.test(y)) return true;
    if (x === "*" || y === "*") return true;
    return normaliseField(x, isDayOfWeek) === normaliseField(y, isDayOfWeek);
  };
  if (!overlaps(fa[0], fb[0]) || !overlaps(fa[1], fb[1])) return false;

  const [domA, dowA] = [fa[2], fa[4]];
  const [domB, dowB] = [fb[2], fb[4]];
  // Either side pinning BOTH day fields makes the day sets unions, and two
  // unions this comparison cannot enumerate are not something to guess at.
  if ((domA !== "*" && dowA !== "*") || (domB !== "*" && dowB !== "*")) return true;
  // At most one day field is restricted on each side now.
  if (domA !== "*" && domB !== "*") return overlaps(domA, domB);
  if (dowA !== "*" && dowB !== "*") return overlaps(dowA, dowB, true);
  // One restricts the month day and the other the weekday (or one restricts
  // nothing): some 1st of the month is a Monday.
  return true;
}

describe("cron triggers", () => {
  it("configures the integration schedule the worker routes on", () => {
    expect(configuredCrons()).toContain(INTEGRATION_SYNC_CRON);
  });

  it("configures a maintenance schedule distinct from the integration one", () => {
    const crons = configuredCrons();
    const maintenance = crons.filter(c => c !== INTEGRATION_SYNC_CRON);
    expect(maintenance.length).toBeGreaterThan(0);
  });

  // This deployment is AT five as of the team insight pass (spec 4.5) — the
  // last slot the free plan allows. The assertion stays `<= 5` rather than
  // `=== 5` because the ceiling is the fact worth pinning, but the message
  // says where we are, so the next person adding a schedule reads "there is
  // no sixth slot; displace one" instead of "five is a comfortable margin".
  it("stays inside the free plan's five triggers", () => {
    expect(
      configuredCrons().length,
      "the free plan allows five cron triggers and this deployment now uses all five — a sixth schedule has to displace one",
    ).toBeLessThanOrEqual(5);
  });

  // The two schedules must not be able to fire in the same minute: that would
  // put both invocations' work on the same wall clock, which is the contention
  // the split exists to avoid.
  it("does not schedule the two on a colliding minute", () => {
    const minuteOf = (cron: string) => cron.trim().split(/\s+/)[0];
    const integrationMinute = minuteOf(INTEGRATION_SYNC_CRON);
    for (const cron of configuredCrons()) {
      if (cron === INTEGRATION_SYNC_CRON) continue;
      expect(minuteOf(cron), `${cron} shares a minute with ${INTEGRATION_SYNC_CRON}`)
        .not.toBe(integrationMinute);
    }
  });

  it("configures both insight schedules the worker routes on", () => {
    const crons = configuredCrons();
    expect(crons).toContain(INSIGHT_ACCRUAL_CRON);
    expect(crons).toContain(INSIGHT_WEEKLY_CRON);
  });

  it("configures the team insight schedule the worker routes on", () => {
    expect(configuredCrons()).toContain(INSIGHT_TEAM_WEEKLY_CRON);
  });

  // The personal weekly pass and the team one are two budgets on the same day
  // of the week, so "distinct from the integration cron" is not enough — the
  // team pass must not be able to fire at the same instant as ANY other
  // configured schedule. That is the collision the split exists to avoid: two
  // passes on one wall clock is 76 subrequests against a 50-subrequest
  // invocation, and the second one dies half-written.
  it("gives the team insight pass a firing time no other configured schedule shares", () => {
    const others = configuredCrons().filter(c => c !== INSIGHT_TEAM_WEEKLY_CRON);
    expect(others.length).toBeGreaterThan(0);
    for (const cron of others) {
      expect(canCollide(cron, INSIGHT_TEAM_WEEKLY_CRON), `${cron} can fire with ${INSIGHT_TEAM_WEEKLY_CRON}`)
        .toBe(false);
    }
  });

  /**
   * No two configured schedules can fire at the same instant.
   *
   * This used to compare the MINUTE FIELD alone, and that was a proxy that
   * stopped being true the moment a fourth and fifth weekly schedule landed:
   * insight accrual runs at 01:45 every day and the team insight pass at
   * 02:45 on Sundays, so they share a minute field and can never share a
   * minute. The bare-minute rule would have rejected a pair that does not
   * collide, and the fix is to compare what actually collides rather than to
   * move a schedule to satisfy a proxy.
   *
   * `canCollide` is deliberately over-broad in the other direction: a `*` in
   * the hour or day-of-week field matches everything, so the hourly
   * integration sync still collides with anything sharing its minute — which
   * is the case the original rule was really protecting.
   */
  it("gives no two configured schedules a firing time they can share", () => {
    const crons = configuredCrons();
    for (let i = 0; i < crons.length; i++) {
      for (let j = i + 1; j < crons.length; j++) {
        expect(canCollide(crons[i], crons[j]), `${crons[i]} can fire with ${crons[j]}`).toBe(false);
      }
    }
  });

  /**
   * The guard above is only worth as much as `canCollide` is, and every one of
   * these pairs is a real collision a previous shape of it reported as safe —
   * four of them were caught by the bare-minute rule this replaced, so they
   * were REGRESSIONS, not merely gaps.
   *
   * The undecidable ones — a range, a list, a step — are the point: a
   * comparison that reads an expression it cannot evaluate as "distinct" is
   * wrong in the direction that ships a collision.
   */
  describe("canCollide", () => {
    const COLLIDES: [string, string, string][] = [
      ["45 1 * * *", "45 1-3 * * *", "01:45 daily is inside the 1-3 range"],
      ["15 2 * * SUN", "15 2 * * SUN,MON", "both fire 02:15 every Sunday"],
      ["45 2 * * SUN", "45 2 * * 7", "7 and SUN are the same day"],
      ["45 2 * * SUN", "45 2 * * 0", "0 and SUN are the same day"],
      ["45 2 1 * MON", "45 2 1 * TUE",
        "day-of-month and day-of-week are OR'd, so both fire 02:45 on the 1st"],
      ["45 2 1 * MON", "45 2 2 * MON",
        "OR'd again, from the other side: both fire 02:45 every Monday"],
      ["*/5 2 * * SUN", "45 2 * * SUN", "*/5 includes minute 45"],
      ["30 * * * *", "0,30 3 * * *", "both fire 03:30 daily"],
      ["30 * * * *", "30 4 * * *", "the hourly one covers every hour"],
      ["45 2 1 * *", "45 2 * * MON", "some 1st of the month is a Monday"],
    ];
    for (const [a, b, why] of COLLIDES) {
      it(`sees the collision between "${a}" and "${b}" (${why})`, () => {
        expect(canCollide(a, b)).toBe(true);
        // Symmetric: a guard that only fired one way round would depend on the
        // order wrangler.jsonc happens to list its triggers in.
        expect(canCollide(b, a)).toBe(true);
      });
    }

    // The relaxation the rewrite exists for. If these read as collisions the
    // guard is back to the bare-minute proxy and this deployment's own five
    // schedules cannot be configured.
    const DISTINCT: [string, string, string][] = [
      ["45 1 * * *", "45 2 * * SUN", "same minute field, different hour"],
      ["0 1 * * *", "30 * * * *", "different minute"],
      ["15 2 * * SUN", "45 2 * * SUN", "same hour and day, different minute"],
      ["45 2 * * SUN", "45 2 * * MON", "same time, different day"],
    ];
    for (const [a, b, why] of DISTINCT) {
      it(`clears "${a}" against "${b}" (${why})`, () => {
        expect(canCollide(a, b)).toBe(false);
        expect(canCollide(b, a)).toBe(false);
      });
    }
  });

  // wrangler.jsonc and schedule.ts agreeing with each other proves nothing
  // about whether Cloudflare's trigger API will accept the string: two files
  // can agree on a value it rejects. Confirmed empirically against the live
  // API — `wrangler triggers deploy` with "15 2 * * 0" failed registration
  // with `code 10100: invalid cron string: 15 2 * * 0`; Cloudflare does not
  // accept numeric 0 for Sunday in the day-of-week field, only "SUN". Worker
  // code deploys succeed regardless, so a bad cron string only surfaces if
  // someone reads the deploy output closely — this test exists so a future
  // schedule with the same mistake (e.g. "* * * * 0") fails the suite instead.
  it("gives every configured schedule a Cloudflare-acceptable shape", () => {
    for (const cron of configuredCrons()) {
      const fields = cron.trim().split(/\s+/);
      expect(fields, `"${cron}" must have exactly 5 whitespace-separated fields`).toHaveLength(5);
      const [, , , , dayOfWeek] = fields;
      expect(dayOfWeek, `"${cron}" uses numeric 0 for Sunday, which Cloudflare rejects (code 10100) — use "SUN" instead`)
        .not.toBe("0");
    }
  });
});
