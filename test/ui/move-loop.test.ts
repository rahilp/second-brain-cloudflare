/**
 * #347's pure drain loop for the "move already-synced memories" action,
 * following restore-loop.test.ts's pattern — the only existing multi-call
 * drain test in test/ui/ (see docs/superpowers/plans/2026-09-12-347-ui-contract.md
 * §7.1, which names this file's absence explicitly and gives this exact
 * skeleton as the thing to write).
 *
 * Contract this test pins for the implementer (not specified by the plan, so
 * fixed here — see the test-author's final report for the full list):
 *   - a function `runMoveLoop(provider, post, onProgress)` is a module-level
 *     global in public/js/integrations.js, extracted the same way
 *     `runImportLoop` is extracted in public/js/settings.js;
 *   - `post` is `(cursor) => Promise<{ moved, alreadyThere, missing, refused, remaining, cursor }>`,
 *     called with `undefined` on the first call and the previous response's
 *     `cursor` afterwards, until `cursor` is falsy;
 *   - `onProgress({ done, total })` fires after every page, `done` being the
 *     cumulative moved+alreadyThere+missing+refused so far;
 *   - `runMoveLoop` resolves `{ moved, alreadyThere, missing, refused }` totals
 *     on a full drain;
 *   - on a page rejecting, `runMoveLoop` rejects too (propagates, following
 *     runImportLoop's own precedent), but the rejection's Error carries a
 *     `.partial` property with the totals accumulated before the failure, so
 *     the caller can report "N moved so far, stopped, safe to resume" instead
 *     of losing that count the way syncIntegration's plain throw does today;
 *   - a batch making zero progress while remaining stays positive is treated
 *     as a stall and rejects with a message matching /stalled|did not advance/i,
 *     the same "fail loudly, don't spin" contract runImportLoop already has.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function loadRunMoveLoop(): (provider: string, post: any, onProgress?: any) => Promise<any> {
  const src = readFileSync(resolve(ROOT, "public/js/integrations.js"), "utf8");
  const ctx: any = { window: {}, document: {}, fetch: () => {}, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  vm.runInContext(src, ctx);
  return ctx.runMoveLoop;
}

/** A Worker-side double: pages by an opaque cursor, exactly like the real move route. */
function fakeWorker(total: number, limit: number) {
  const calls: (string | undefined)[] = [];
  const post = async (cursor?: string) => {
    calls.push(cursor);
    const start = cursor ? Number(cursor) : 0;
    const page = Math.max(0, Math.min(limit, total - start));
    const next = start + page;
    return {
      moved: page, alreadyThere: 0, missing: 0, refused: 0,
      remaining: total - next,
      cursor: next < total ? String(next) : null,
    };
  };
  return { post, calls };
}

/** A Worker-side double for the repair-pass contract: `pass` increments every
 * time `post` is called with a falsy cursor (a fresh walk of the item map),
 * and `failuresByPass[pass]` is reported once, on that pass's FIRST page —
 * mirroring the real route's `vectorFailures`, which the server computes
 * once per call and which a pass can accumulate across several pages. Pages
 * after the first repeat pass report entries as `alreadyThere`, not `moved`
 * — moveEntry's own no_change branch is what a repair pass actually walks
 * into, per #347's self-healing contract. */
function fakeWorkerWithRepair(total: number, limit: number, failuresByPass: number[], onPass?: (pass: number) => void) {
  const calls: (string | undefined)[] = [];
  let pass = -1;
  const post = async (cursor?: string) => {
    calls.push(cursor);
    if (!cursor) { pass++; onPass?.(pass); }
    const isRepairPass = pass > 0;
    const start = cursor ? Number(cursor) : 0;
    const page = Math.max(0, Math.min(limit, total - start));
    const next = start + page;
    return {
      moved: isRepairPass ? 0 : page,
      alreadyThere: isRepairPass ? page : 0,
      missing: 0,
      refused: 0,
      vectorFailures: !cursor ? (failuresByPass[pass] ?? 0) : 0,
      remaining: total - next,
      cursor: next < total ? String(next) : null,
    };
  };
  return { post, calls, passIndex: () => pass };
}

describe("#347 runMoveLoop", () => {
  it("is exported as a real function on public/js/integrations.js's module scope", () => {
    const runMoveLoop = loadRunMoveLoop();
    expect(typeof runMoveLoop).toBe("function");
  });

  it("drains to completion across batches and accumulates totals", async () => {
    const runMoveLoop = loadRunMoveLoop();
    const { post, calls } = fakeWorker(150, 40);

    const totals = await runMoveLoop("notion", post);

    expect(totals.moved).toBe(150);
    expect(totals.alreadyThere).toBe(0);
    expect(totals.missing).toBe(0);
    expect(totals.refused).toBe(0);
    // 4 pages: 40+40+40+30, called with undefined then the running cursor.
    expect(calls).toEqual([undefined, "40", "80", "120"]);
  });

  it("reports progress after every page", async () => {
    const runMoveLoop = loadRunMoveLoop();
    const { post } = fakeWorker(80, 40);
    const seen: number[] = [];

    await runMoveLoop("notion", post, ({ done }: any) => seen.push(done));

    expect(seen).toEqual([40, 80]);
  });

  it("stops and carries partial progress on a mid-drain failure, instead of losing it", async () => {
    const runMoveLoop = loadRunMoveLoop();
    let n = 0;
    const { post } = fakeWorker(150, 40);
    const flaky = async (cursor?: string) => {
      if (++n === 2) throw new Error("Server error: 500");
      return post(cursor);
    };

    let caught: any;
    try {
      await runMoveLoop("notion", flaky);
    } catch (e) {
      caught = e;
    }
    expect(caught, "expected runMoveLoop to reject on a mid-drain failure").toBeDefined();
    expect(caught.message).toMatch(/500/);
    // The first page (40 moved) must not be thrown away just because the
    // second page failed — this is what lets the caller say "stopped after
    // 40, safe to resume" instead of "failed" with no count.
    expect(caught.partial).toBeDefined();
    expect(caught.partial.moved).toBe(40);
  });

  it("fails loudly rather than looping forever against a cursor that never advances", async () => {
    const runMoveLoop = loadRunMoveLoop();
    const post = async () => ({ moved: 0, alreadyThere: 0, missing: 0, refused: 0, remaining: 60, cursor: "0" });

    await expect(runMoveLoop("notion", post)).rejects.toThrow(/stalled|did not advance/i);
  });

  it("keeps draining a batch that is entirely refusals, as long as the cursor keeps advancing", async () => {
    const runMoveLoop = loadRunMoveLoop();
    // Every item in this batch is refused (author lock, or scope loss), but
    // the cursor still moves — real forward progress through the item map,
    // just not forward progress on MOVING anything. Must not be confused with
    // the never-advancing stall above, and must not be reported as if 40
    // items moved.
    const post = async (cursor?: string) => {
      const next = cursor ? Number(cursor) + 10 : 10;
      return { moved: 0, alreadyThere: 0, missing: 0, refused: 10, remaining: 40 - next, cursor: next < 40 ? String(next) : null };
    };

    const totals = await runMoveLoop("notion", post);
    expect(totals.moved).toBe(0);
    expect(totals.refused).toBe(40);
  });

  // Mutation-pass finding (#347 review item 15): a naive re-read of
  // syncIntegration's OWN drain loop (public/js/integrations.js) would copy
  // its `guard < 40` iteration cap, which resolves SUCCESSFULLY once the cap
  // is hit even with real backlog left (see the header comment in this file
  // and UI contract §2/§9 trap 10) — silent, not thrown. This file's earlier
  // tests never exceed 4 pages, so a reintroduced cap at, say, 40 would sail
  // through them unnoticed. Drive it past any plausible hardcoded cap.
  it("does not silently report completion if a hardcoded iteration cap is reintroduced — drives well past 40 pages", async () => {
    const runMoveLoop = loadRunMoveLoop();
    const TOTAL = 500 * 40; // 500 pages at a realistic per-page size
    const { post, calls } = fakeWorker(TOTAL, 40);

    const totals = await runMoveLoop("notion", post);

    // Either it genuinely completed (this assertion), or — if some future
    // change caps iterations — runMoveLoop must reject rather than resolve,
    // which the assertion below would catch instead.
    expect(totals.moved).toBe(TOTAL);
    expect(calls.length).toBe(500);
  });

  // ─── Repair passes (#347, the "vectorFailures reaches no one" round) ──────
  //
  // The server counts entries whose D1 row moved but whose Vectorize
  // re-stamp was not confirmed (`vectorFailures`, src/routes/integrations.ts)
  // — a real and common outcome once the budget-bounded restamp
  // (move-subrequest-budget.test.ts) has to skip entries to stay under the
  // free-plan ceiling. moveEntry's `no_change` branch now carries vectorIds
  // specifically so a SECOND walk of the same item map repairs them. Nothing
  // triggered that second walk: `grep -n vectorFailures public/js/integrations.js`
  // finds no reads at all today, so an operator sees "10 moved" and has no
  // reason to run anything again.

  describe("self-repair when a pass ends with outstanding vectorFailures", () => {
    it("starts a repair pass when the first pass ends with vectorFailures > 0, and stops once a pass reports zero", async () => {
      const runMoveLoop = loadRunMoveLoop();
      const { post, calls } = fakeWorkerWithRepair(40, 40, [3, 0]);

      const totals = await runMoveLoop("notion", post);

      // One page per pass here (limit === total) — two passes total.
      expect(calls.length).toBe(2);
      expect(totals.moved).toBe(40); // pass 1
      expect(totals.alreadyThere).toBe(40); // pass 2's repair walk
      expect(totals.vectorFailures).toBe(0);
    });

    it("keeps repairing across multiple passes while outstanding failures strictly decrease", async () => {
      const runMoveLoop = loadRunMoveLoop();
      const { post, calls, passIndex } = fakeWorkerWithRepair(40, 40, [10, 5, 2, 0]);

      const totals = await runMoveLoop("notion", post);

      expect(passIndex()).toBe(3); // four passes, 0-indexed
      expect(calls.length).toBe(4);
      expect(totals.vectorFailures).toBe(0);
    });

    it("does not attempt a repair pass at all when the first pass has zero vector failures", async () => {
      const runMoveLoop = loadRunMoveLoop();
      const { post, calls } = fakeWorker(150, 40); // no vectorFailures field at all

      const totals = await runMoveLoop("notion", post);

      expect(calls.length).toBe(4); // unchanged from the no-repair baseline test above
      expect(totals.vectorFailures ?? 0).toBe(0);
    });

    it("stops after a pass that makes no progress, rather than retrying a genuinely broken index forever, and reports the true outstanding count", async () => {
      const runMoveLoop = loadRunMoveLoop();
      let calls = 0;
      let pass = -1;
      const post = async (cursor?: string) => {
        calls++;
        if (!cursor) pass++;
        // A THIRD pass would mean the no-progress condition failed to stop
        // the drain — fail the test immediately rather than let it spin.
        if (pass > 1) throw new Error("runMoveLoop attempted a pass beyond the one that made no progress");
        const isRepairPass = pass > 0;
        return {
          moved: isRepairPass ? 0 : 10,
          alreadyThere: isRepairPass ? 10 : 0,
          missing: 0, refused: 0,
          vectorFailures: 5, // identical every pass — Vectorize is genuinely down, never improves
          remaining: 0, cursor: null,
        };
      };

      const totals = await runMoveLoop("notion", post);

      expect(pass).toBe(1); // the initial pass, plus exactly one repair attempt
      // The truth, not a silent zero: whatever stays broken must be visible
      // to whatever reads this return value (the UI's consequence copy).
      expect(totals.vectorFailures).toBe(5);
    });
  });

  // ─── `errored` reaching the totals (#347, fourth round on this defect) ───
  //
  // The server has always computed `errored` (src/routes/integrations.ts) —
  // a per-item moveEntry throw, non-fatal to the batch. runMoveLoop's totals
  // object never included it, so it was accumulated nowhere and displayed
  // nowhere: a D1 problem that makes every moveEntry throw returns
  // moved:0, errored:10 per page, forever advancing, and the drain finishes
  // having "succeeded" with nothing to show for it.

  describe("errored survives the drain into totals", () => {
    it("accumulates `errored` across pages the same way moved/missing/refused already do", async () => {
      const runMoveLoop = loadRunMoveLoop();
      let call = 0;
      const post = async () => {
        call++;
        const done = call >= 3;
        return {
          moved: 0, alreadyThere: 0, missing: 0, refused: 0, errored: 10,
          remaining: done ? 0 : 10, cursor: done ? null : String(call * 10),
        };
      };

      const totals = await runMoveLoop("notion", post);

      expect(totals.errored).toBe(30); // 10 per page, 3 pages — not dropped, not just the last page's value
    });
  });

  // ─── Repair passes must not double-count what the user sees ─────────────
  //
  // A repair pass re-walks the WHOLE item map from the beginning to give
  // moveEntry's no_change branch a chance to fix stale Vectorize stamps. The
  // same 5 dead itemMap pointers are therefore "missing" again on every
  // pass, and the same real entries are "alreadyThere" again once they've
  // already moved — real per-CALL facts, but not new information for the
  // person reading the total: the item map has 5 stale pointers, not 10 or
  // 15, no matter how many repair passes it took to settle Vectorize.

  describe("repair passes report the item map once, not once per pass", () => {
    it("does not add a repair pass's missing/refused counts on top of the first pass's", async () => {
      const runMoveLoop = loadRunMoveLoop();
      let pass = -1;
      const post = async (cursor?: string) => {
        if (!cursor) pass++;
        const isRepairPass = pass > 0;
        return {
          moved: isRepairPass ? 0 : 15,
          alreadyThere: isRepairPass ? 15 : 0,
          missing: 5, // the same 5 dead pointers, every single pass
          refused: 0,
          vectorFailures: isRepairPass ? 0 : 5, // repaired on the second pass
          remaining: 0, cursor: null,
        };
      };

      const totals = await runMoveLoop("notion", post);

      expect(pass).toBe(1); // confirms a repair pass actually ran
      expect(totals.missing).toBe(5); // not 10
    });

    it("does not inflate the progress denominator across repair passes — a 150-item map reports out of 150, not 300", async () => {
      const runMoveLoop = loadRunMoveLoop();
      const seen: { done: number; total: number }[] = [];
      let pass = -1;
      const post = async (cursor?: string) => {
        if (!cursor) pass++;
        const isRepairPass = pass > 0;
        return {
          moved: isRepairPass ? 0 : 150,
          alreadyThere: isRepairPass ? 150 : 0,
          missing: 0, refused: 0,
          vectorFailures: isRepairPass ? 0 : 10,
          remaining: 0, cursor: null,
        };
      };

      await runMoveLoop("notion", post, (progress: any) => seen.push(progress));

      expect(pass).toBe(1);
      // Every progress event reported must describe the 150-item map, not a
      // repair-inflated 300.
      for (const { done, total } of seen) {
        expect(done).toBeLessThanOrEqual(150);
        expect(total).toBeLessThanOrEqual(150);
      }
    });
  });
});
