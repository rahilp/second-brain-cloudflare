/**
 * Caller-count drift guards for the destructive-action sheet's two entry
 * points, held equal to what the architecture doc says.
 *
 * `docs/dashboard-architecture.md` enumerates the callers of both
 * `openDangerConfirm` and `closeConfirm` and makes a claim about each set:
 * that every `openDangerConfirm` caller closes with its own `done()`, and that
 * every `closeConfirm` caller is ambient. Those properties are the whole point
 * of the split between the two. The prose has gone stale three times because
 * someone added a caller and the count next to it did not move.
 *
 * Neither guard knows whether a NEW caller obeys the rule — that still needs a
 * human read against the doc — but both know how many callers there are, and
 * fail loudly the moment that number changes so the doc can't just be
 * forgotten.
 *
 * If one of these starts failing after you added a call: update the count in
 * `docs/dashboard-architecture.md` and `EXPECTED` below, and — the part a count
 * cannot check for you — confirm the new caller obeys the rule for that entry
 * point.
 *
 * WHY THE SCAN IS A DIRECTORY WALK AND NOT A LIST
 *
 * This started as a hardcoded six-file allowlist while its own failure message
 * claimed it covered `public/`. It did not: 20 of the 25 files in `public/js`
 * were never opened, including `coach.js`, which the phase that wrote the
 * allowlist added. An allowlist is the wrong shape for a drift guard, because
 * the drift it is least able to see is a call from a file nobody thought to
 * list — which is the same failure mode as having no guard at all. So it walks
 * the tree, and asserts below that the walk actually found the tree.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const PUBLIC = resolve(ROOT, "public");

/** Every shippable source file under `public/`, recursively. */
function listPublicSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...listPublicSources(full));
    else if (/\.(js|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const FILES = listPublicSources(PUBLIC).map((f) => relative(ROOT, f)).sort();

/** Strips comments naive-but-good-enough for this codebase's line/block style. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * Every line in `public/` that calls `name`, excluding its own definition.
 *
 * Comments are stripped from `.js` so the doc-comments that DISCUSS these
 * functions — `confirm-sheet.js` and `team.js` both explain when to use which
 * — are not counted as callers. `.html` is scanned raw: its calls live in
 * `onclick` attributes, and it carries no JS comments to confuse the count.
 */
function callersOf(name: string): string[] {
  const found: string[] = [];
  const wordRe = new RegExp(`\\b${name}\\b`);
  const defRe = new RegExp(`function\\s+${name}\\s*\\(`);
  for (const rel of FILES) {
    const raw = readFileSync(resolve(ROOT, rel), "utf8");
    const code = rel.endsWith(".html") ? raw : stripComments(raw);
    for (const line of code.split("\n")) {
      if (!wordRe.test(line)) continue;
      if (defRe.test(line)) continue; // the definition
      found.push(`${rel}: ${line.trim()}`);
    }
  }
  return found;
}

describe("destructive-action sheet caller counts match the architecture doc", () => {
  // A walk that silently found nothing would make every count below pass at
  // zero. These pin the two properties the allowlist version lacked: that the
  // scan reaches the whole tree, and that it reaches the specific file whose
  // absence proved the allowlist was not doing its job.
  it("actually scans public/", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(25);
    expect(FILES).toContain("public/index.html");
    expect(FILES).toContain("public/utils.js");
    expect(FILES).toContain("public/credits.js");
    // Added by the phase that wrote the six-file allowlist, and not in it.
    expect(FILES).toContain("public/js/coach.js");
    // Every file the old allowlist did list is still reached.
    for (const rel of [
      "public/js/app.js",
      "public/js/confirm-sheet.js",
      "public/js/memory-crud.js",
      "public/js/integrations.js",
      "public/js/team.js",
    ]) {
      expect(FILES).toContain(rel);
    }
  });

  /** Doc count, kept next to the code it counts so both move together. */
  const EXPECTED_CLOSE = 4;

  it(`closeConfirm has exactly ${EXPECTED_CLOSE} callers across public/`, () => {
    const callers = callersOf("closeConfirm");
    expect(
      callers.length,
      `closeConfirm caller count changed — update the enumeration in ` +
        `docs/dashboard-architecture.md (search "closeConfirm itself has") ` +
        `and EXPECTED_CLOSE here, and confirm the new caller is ambient and ` +
        `not reachable from inside an action. Found:\n${callers.join("\n")}`,
    ).toBe(EXPECTED_CLOSE);
  });

  /** Doc count, kept next to the code it counts so both move together. */
  const EXPECTED_OPEN = 6;

  // The companion guard, and the reason both live in one file: twelve tests
  // exercise the sheet's behaviour and not one of them counts who opens it, so
  // a seventh caller that closed ambiently — the exact bug the three `team.js`
  // callers once shipped — passed everything.
  it(`openDangerConfirm has exactly ${EXPECTED_OPEN} callers across public/`, () => {
    const callers = callersOf("openDangerConfirm");
    expect(
      callers.length,
      `openDangerConfirm caller count changed — update the enumeration in ` +
        `docs/dashboard-architecture.md (search "the sheet has six callers") ` +
        `and EXPECTED_OPEN here, and confirm the new caller closes with the ` +
        `done() it was handed rather than with closeConfirm(). ` +
        `Found:\n${callers.join("\n")}`,
    ).toBe(EXPECTED_OPEN);
  });
});
