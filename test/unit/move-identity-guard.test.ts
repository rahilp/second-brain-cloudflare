/**
 * #347 review item 14: locked decision 1 says the move handler must run
 * `moveEntry` with the CALLER's own identity (already confirmed to be the
 * owner by that point), never a freshly-resolved "owner identity" object —
 * `mirrorWriteContext`'s acting-as pattern is deliberately narrow (only for
 * the sync's OWN writes) and #347 must not widen it. Every fixture elsewhere
 * in this suite has the caller and the tenant owner be the same person, so no
 * behavioural test can tell "ran as the caller" apart from "ran as a
 * freshly-resolved owner identity that happens to be the same person" — both
 * produce identical output. The drift this guards against only shows up in
 * the SOURCE, not in any response a black-box test can observe, which is why
 * the plan and the review both point at a structural check instead — the
 * same kind test/ui/confirm-sheet-callers.test.ts already uses to enumerate
 * `closeConfirm`'s callers.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function moveActionBlock(): string {
  const src = readFileSync(resolve(ROOT, "src/routes/integrations.ts"), "utf8");
  const start = src.indexOf('if (action === "move")');
  expect(start, 'expected an `if (action === "move")` block in src/routes/integrations.ts').toBeGreaterThan(-1);
  // Up to the next sibling action branch (or, failing that, a generous slice)
  // — this file's own move handler is a few dozen lines, so 4000 chars is
  // comfortably past its end without running into the next route.
  const end = src.indexOf('\n    // disconnect', start);
  return src.slice(start, end > start ? end : start + 4000);
}

describe("#347 moveEntry runs with the caller's own identity, never a freshly-resolved owner identity", () => {
  it("the move action's moveEntry call is passed the route's own `auth`, not `owner`/a resolved identity", () => {
    const block = moveActionBlock();
    const call = block.match(/moveEntry\(([^)]*)\)/);
    expect(call, "expected a moveEntry(...) call inside the move action").not.toBeNull();
    const args = (call as RegExpMatchArray)[1];
    expect(args).toMatch(/\bauth\b/);
    expect(args).not.toMatch(/\bowner\b/i);
  });

  it("the move action never resolves a separate identity the way mirrorWriteContext does — no acting-as pattern here", () => {
    const block = moveActionBlock();
    // mirrorWriteContext/resolveIdentityByUserId are the ONLY acting-as
    // precedent in this codebase (per the data contract's own §3), and are
    // deliberately narrow to the sync's own writes. The move handler is
    // allowed to call ensureTenantBootstrap (it already does, to check
    // `auth.userId !== roots.ownerUserId`) but must never turn that into a
    // substitute Identity object handed to moveEntry.
    expect(block).not.toMatch(/resolveIdentityByUserId/);
    expect(block).not.toMatch(/mirrorWriteContext/);
  });
});
