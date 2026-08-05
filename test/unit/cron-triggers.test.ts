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

describe("cron triggers", () => {
  it("configures the integration schedule the worker routes on", () => {
    expect(configuredCrons()).toContain(INTEGRATION_SYNC_CRON);
  });

  it("configures a maintenance schedule distinct from the integration one", () => {
    const crons = configuredCrons();
    const maintenance = crons.filter(c => c !== INTEGRATION_SYNC_CRON);
    expect(maintenance.length).toBeGreaterThan(0);
  });

  it("stays inside the free plan's five triggers", () => {
    expect(configuredCrons().length).toBeLessThanOrEqual(5);
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
});
