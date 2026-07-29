/**
 * #245 completeness guard.
 *
 * Threading a seam is easy to do partially: swap three of four usages, leave
 * the fourth reading module scope, and every behavioural test still passes
 * because the default and the override happen to agree in the fixture. That
 * failure is invisible until a user actually changes the setting.
 *
 * So this asserts the structural property directly — inside the seam files, a
 * tunable may be *declared*, but it may not be *read* from module scope. Reads
 * must go through the resolved config.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { DEFAULTS } from "../../src/config";

const ROOT = resolve(import.meta.dirname, "../..");

// Every file listed in the issue's "seams to thread" table, plus the recall
// entry point that consumes several of them.
const SEAM_FILES = [
  "src/recall/math.ts",
  "src/recall/search.ts",
  "src/recall/snippet.ts",
  "src/capture/duplicate.ts",
  "src/graph/traverse.ts",
  "src/compression/eligibility.ts",
  "src/lib/ai.ts",
];

/**
 * Walks all of src/. Checking only the seam files was not enough: LLM_MODEL is
 * a tunable, and threading it through duplicate.ts still left six other call
 * sites reading the compiled-in constant. A user changing the model would have
 * seen it honoured on one path and ignored on the rest.
 */
function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allSourceFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const TUNABLES = Object.keys(DEFAULTS);

function offendingReads(source: string): string[] {
  // Import statements are stripped wholesale — including multi-line ones —
  // rather than skipped line by line, so a continuation like `  LLM_MODEL,`
  // is not mistaken for a read.
  const withoutImports = source.replace(/^import\s[\s\S]*?from\s+["'][^"']+["'];?$/gm, "");

  const offenders: string[] = [];
  for (const name of TUNABLES) {
    for (const raw of withoutImports.split("\n")) {
      const line = raw.trim();
      if (!new RegExp(`\\b${name}\\b`).test(line)) continue;
      // Declaring or re-exporting the shipped constant is fine — the parity
      // test depends on those still existing.
      if (/^export (const|type)\b/.test(line)) continue;
      if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
      // Any property access is a qualified read; a bare identifier is not.
      if (new RegExp(`[\\w)]\\s*\\.\\s*${name}\\b`).test(line)) continue;
      offenders.push(`${name}: ${line.slice(0, 90)}`);
    }
  }
  return offenders;
}

describe("config threading is complete", () => {
  for (const file of SEAM_FILES) {
    it(`${file} reads every tunable through config`, () => {
      const source = readFileSync(resolve(ROOT, file), "utf8");
      expect(offendingReads(source)).toEqual([]);
    });
  }

  it("no file anywhere in src/ reads a tunable from module scope", () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles(resolve(ROOT, "src"))) {
      if (file.endsWith("config.ts")) continue;
      for (const o of offendingReads(readFileSync(file, "utf8"))) {
        offenders.push(`${relative(ROOT, file)} — ${o}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("covers every seam named in the issue", () => {
    // Guards against a seam being added to the codebase but not to this list.
    for (const f of [
      "src/recall/math.ts",
      "src/capture/duplicate.ts",
      "src/graph/traverse.ts",
      "src/recall/snippet.ts",
      "src/compression/eligibility.ts",
      "src/lib/ai.ts",
    ]) {
      expect(SEAM_FILES).toContain(f);
    }
  });
});
