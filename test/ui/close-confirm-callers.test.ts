/**
 * `closeConfirm` caller count, held equal to what the architecture doc says.
 *
 * `docs/dashboard-architecture.md` names every `closeConfirm` caller and
 * asserts they are all ambient — that property is the whole point of the
 * split between `closeConfirm` (ambient) and a per-question `done()` (action
 * scoped). The prose has gone stale three times in this phase because
 * someone added a caller and the count next to it did not move. This test
 * does not know whether a new caller is ambient or not — that still needs a
 * human read against the rule in the doc — but it does know how many callers
 * there are, and fails loudly the moment that number changes so the doc
 * can't just be forgotten.
 *
 * If this test starts failing after you added a `closeConfirm` call: update
 * both the count in `docs/dashboard-architecture.md` and `EXPECTED` below,
 * and — this is the part the count can't check for you — confirm the new
 * caller really is ambient and not reachable from inside an action.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

/** Every file `closeConfirm` could plausibly be called from. */
const FILES = [
  "public/index.html",
  "public/js/app.js",
  "public/js/confirm-sheet.js",
  "public/js/memory-crud.js",
  "public/js/integrations.js",
  "public/js/team.js",
];

/** Doc count, kept next to the code it counts so both move together. */
const EXPECTED = 4;

/** Strips comments naive-but-good-enough for this codebase's line/block style. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("closeConfirm caller count matches the architecture doc", () => {
  it(`has exactly ${EXPECTED} callers across public/`, () => {
    const callers: string[] = [];
    for (const rel of FILES) {
      const raw = readFileSync(resolve(ROOT, rel), "utf8");
      const code = rel.endsWith(".html") ? raw : stripComments(raw);
      for (const line of code.split("\n")) {
        if (!/\bcloseConfirm\b/.test(line)) continue;
        if (/function\s+closeConfirm\s*\(/.test(line)) continue; // the definition
        callers.push(`${rel}: ${line.trim()}`);
      }
    }

    expect(
      callers.length,
      `closeConfirm caller count changed — update the enumeration in ` +
        `docs/dashboard-architecture.md (search "closeConfirm itself has") ` +
        `and EXPECTED here. Found:\n${callers.join("\n")}`,
    ).toBe(EXPECTED);
  });
});
