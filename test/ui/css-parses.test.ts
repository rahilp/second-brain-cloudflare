import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CSS_DIR = resolve(ROOT, "public/css");

/**
 * A stylesheet that does not balance is a stylesheet the browser silently
 * truncates.
 *
 * This exists because of a real defect: a merge dropped the closing brace of
 * `.activity-when`, so every rule after it — the whole memories multi-select
 * bar, its count, the per-card tick and the selected-card highlight — was
 * swallowed into that one rule and never applied. The feature shipped visibly
 * unstyled on a phone.
 *
 * Nothing caught it. There is no build step, so no bundler parsed the file;
 * the UI tests run JS in a `vm` with a hand-rolled DOM and never load CSS at
 * all; and `node --check` covers JavaScript only. The suite was green at 2988
 * tests with the stylesheet broken.
 *
 * The parse is deliberately dumb — count braces outside comments and strings —
 * because the property being defended is exactly that dumb: a browser stops
 * applying rules at the point the nesting stops making sense, and everything
 * after it is lost with no error anywhere.
 */
function depthAtEnd(css: string): { depth: number; wentNegative: boolean } {
  let depth = 0;
  let wentNegative = false;
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    // comments
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    // strings — a brace inside url("…{…") or content: "}" is not nesting
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < css.length && css[i] !== quote) {
        if (css[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) wentNegative = true;
    }
    i++;
  }
  return { depth, wentNegative };
}

const sheets = readdirSync(CSS_DIR).filter((f) => f.endsWith(".css"));

describe("every stylesheet parses", () => {
  it("finds the stylesheets to check", () => {
    // If this ever reads zero the checks below would pass vacuously.
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets).toContain("main.css");
  });

  for (const file of sheets) {
    it(`${file} balances its braces, so nothing after a rule is silently dropped`, () => {
      const css = readFileSync(resolve(CSS_DIR, file), "utf8");
      const { depth, wentNegative } = depthAtEnd(css);
      expect(wentNegative, `${file} closes a block that was never opened`).toBe(false);
      expect(depth, `${file} leaves ${depth} block(s) unclosed — every rule after the unclosed one is swallowed into it and never applies`).toBe(0);
    });
  }
});

/**
 * The rules the memories multi-select needs, pinned by name.
 *
 * Balance alone would not have localised the failure: the broken file was
 * unbalanced by exactly one brace, and the symptom was four specific rules
 * going missing. These are asserted to open at the top level — not nested
 * inside another rule — which is the state that makes them apply.
 */
describe("the multi-select rules are real top-level rules", () => {
  const css = readFileSync(resolve(CSS_DIR, "main.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  /** Depths at which each selector opens a block. */
  function openDepths(source: string): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    let depth = 0;
    let buf = "";
    for (const ch of source) {
      if (ch === "{") {
        const sel = buf.trim().split("\n").pop()?.trim();
        if (sel) (out[sel] ||= []).push(depth);
        depth++;
        buf = "";
      } else if (ch === "}") {
        depth--;
        buf = "";
      } else buf += ch;
    }
    return out;
  }

  const depths = openDepths(css);

  for (const sel of [".mem-bulk-bar", ".mem-bulk-count", ".card-select", ".memory-card--selected"]) {
    it(`${sel} is defined and not nested inside another rule`, () => {
      expect(depths[sel], `${sel} is not defined in main.css`).toBeDefined();
      // 0 is a top-level rule. 1 is legitimate only inside an @media block,
      // which these are not — they are base rules the phone query refines.
      expect(depths[sel]).toContain(0);
    });
  }
});
