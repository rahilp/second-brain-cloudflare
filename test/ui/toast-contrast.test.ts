/**
 * The toast surface (.app-toast) is deliberately dark in both themes — it is
 * an overlay, not a page surface, and reads best as a dark chip regardless of
 * whether the page around it is light or dark.
 *
 * That surface used to come from `var(--surface-elevated, #1e1e1e)` — a
 * fallback for a token that was never defined anywhere in the codebase, so
 * the fallback was unconditionally what applied, in both themes. Its ink,
 * `.app-toast-msg`, used `var(--text-primary)`, which IS theme-aware:
 * #161616 in light, #f2efec in dark. A theme-flipping ink on a theme-fixed
 * surface is exactly backwards, and in light mode it produced #161616 text
 * on #1e1e1e — ~1.05:1, functionally invisible.
 *
 * The fix defines `--surface-elevated` and `--text-on-elevated` explicitly in
 * both theme blocks (no fallback — an undefined token must now fail loudly,
 * not paint a silent default) and points the toast's ink at the fixed
 * `--text-on-elevated` instead of the theme-flipping `--text-primary`.
 *
 * This follows the same parse-the-real-CSS approach as
 * card-stale-contrast.test.ts: no second mechanism, no new dependency. Where
 * that file resolves named tokens directly, the first test below goes one
 * step further and resolves the *actual declarations* on .app-toast /
 * .app-toast-msg the way a browser would — including the var() fallback —
 * so it reproduces the reported bug's exact number rather than a proxy for it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Comments stripped up front, same reasoning as card-stale-contrast.test.ts: they
// contain no braces, so a comment sitting above a rule would otherwise be captured
// as part of that rule's selector.
const CSS = readFileSync(resolve(import.meta.dirname, "../../public/css/main.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const srgb = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]: number[]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const parseHex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

function themeBlock(theme: "light" | "dark"): string {
  const start = theme === "dark" ? CSS.indexOf("html[data-theme='dark'] {") : CSS.indexOf(":root {");
  expect(start).toBeGreaterThan(-1);
  return CSS.slice(start, CSS.indexOf("}", start));
}

/** Looks a variable up strictly within its own theme block. Returns null, rather
 *  than throwing, when the token is not defined there — callers decide whether
 *  that is fatal (a named-token assertion) or expected (resolving a var() that
 *  may legitimately fall back). */
function lookupVar(theme: "light" | "dark", name: string): number[] | null {
  const m = themeBlock(theme).match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i"));
  return m ? parseHex(m[1]) : null;
}

/** Same lookup, but fails the test when the token is missing — for asserting a
 *  token is genuinely defined, not just that some fallback papers over it. */
function variable(theme: "light" | "dark", name: string): number[] {
  const v = lookupVar(theme, name);
  expect(v, `${name} not found in ${theme} theme`).toBeTruthy();
  return v!;
}

/** Resolves a CSS colour value the way a browser resolves a declaration:
 *  var(--x) looks --x up in the theme; var(--x, #fallback) falls back to the
 *  literal only if --x is undefined; a bare #hex is used as-is. */
function resolveValue(theme: "light" | "dark", value: string): number[] {
  const varMatch = value.match(/var\(\s*(--[\w-]+)\s*(?:,\s*(#[0-9a-f]{6})\s*)?\)/i);
  if (varMatch) {
    const [, name, fallback] = varMatch;
    const resolved = lookupVar(theme, name);
    if (resolved) return resolved;
    if (fallback) return parseHex(fallback);
    throw new Error(`${name} is undefined in the ${theme} theme and has no fallback`);
  }
  const hex = value.match(/#[0-9a-f]{6}/i);
  if (hex) return parseHex(hex[0]);
  throw new Error(`unparseable colour value: ${value}`);
}

function ruleBody(selector: string): string {
  const re = new RegExp(selector.replace(/[.]/g, "\\.") + "\\s*\\{([^}]*)\\}");
  const m = CSS.match(re);
  expect(m, `${selector} rule not found`).toBeTruthy();
  return m![1];
}

function declaration(body: string, prop: string): string {
  const m = body.match(new RegExp(`(?<!-)\\b${prop}\\s*:\\s*([^;]+);`));
  expect(m, `${prop} declaration not found`).toBeTruthy();
  return m![1].trim();
}

describe("toast surface and ink stay readable in both themes", () => {
  it.each(["light", "dark"] as const)(
    "%s theme: .app-toast's background and .app-toast-msg's ink, resolved exactly as a browser would, clear 4.5:1",
    (theme) => {
      const bg = resolveValue(theme, declaration(ruleBody(".app-toast"), "background"));
      const ink = resolveValue(theme, declaration(ruleBody(".app-toast-msg"), "color"));
      expect(contrast(bg, ink)).toBeGreaterThanOrEqual(4.5);
    }
  );

  it.each(["light", "dark"] as const)(
    "%s theme: --surface-elevated is actually defined (a var() fallback must not be the only definition)",
    (theme) => {
      variable(theme, "--surface-elevated");
    }
  );

  it("the fallback that let an undefined token hide in plain sight is gone", () => {
    expect(CSS).not.toMatch(/var\(--surface-elevated\s*,/);
  });

  it.each(["light", "dark"] as const)(
    "%s theme: --text-on-elevated on --surface-elevated clears WCAG AA (4.5:1)",
    (theme) => {
      const ink = variable(theme, "--text-on-elevated");
      const surface = variable(theme, "--surface-elevated");
      expect(contrast(ink, surface)).toBeGreaterThanOrEqual(4.5);
    }
  );

  /**
   * --accent itself cannot be reused for the toast action: it is tuned per
   * theme against that theme's own page surfaces, but --surface-elevated is
   * dark in BOTH themes, so an accent tuned for a light page (light theme's
   * --accent) or for --bg-card-like surfaces (dark theme's --accent, which
   * measures only 4.4529:1 here — just under AA) cannot simply be reused.
   * --accent-on-elevated is measured separately for this surface in each
   * theme: light restates --accent (still clears AA here), dark substitutes
   * --accent-ink (the theme's existing "orange for a dark surface" answer).
   */
  it.each(["light", "dark"] as const)(
    "%s theme: --accent-on-elevated on --surface-elevated clears WCAG AA (4.5:1)",
    (theme) => {
      const accent = variable(theme, "--accent-on-elevated");
      const surface = variable(theme, "--surface-elevated");
      expect(contrast(accent, surface)).toBeGreaterThanOrEqual(4.5);
    }
  );

  it("the toast action uses --accent-on-elevated, not the page-tuned --accent", () => {
    const body = ruleBody(".app-toast-action");
    expect(declaration(body, "color")).toBe("var(--accent-on-elevated)");
  });

  it("the toast message uses the fixed elevated ink, not the theme-flipping primary ink", () => {
    const body = ruleBody(".app-toast-msg");
    expect(declaration(body, "color")).toBe("var(--text-on-elevated)");
  });
});
