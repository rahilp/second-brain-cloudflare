/**
 * The stale-card modifier must not reduce text contrast on the card.
 *
 * This file used to open by recording that --text-tertiary was BELOW WCAG AA on
 * --bg-card in both themes — 4.4987 dark, 3.0457 light — and reasoned from there
 * that no tint could help, since lightening pushed dark further down and
 * darkening pushed light down instead. It pinned those two numbers precisely and
 * said: "if a theme change ever buys headroom, this test fails and the tint ban
 * can be reconsidered."
 *
 * A theme change bought the headroom. The ink ramp moved so all three steps clear
 * AA on every surface they are set on, and these assertions are now the other way
 * round: both baselines PASS, and the test's job is to stop them regressing.
 *
 * The tint ban stays, on its first reason rather than its second: card--stale
 * signals with a dashed border because that is how the other card modifiers work
 * — card--synthesized varies border colour, card--rolled-up varies opacity,
 * neither touches the background.
 *
 * This encodes the rule rather than the current declaration, so a re-added tint is
 * caught by the number that matters — including via background-color, background-image,
 * or a theme-scoped override, which a check keyed on the literal `background:` missed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Comments stripped up front: they contain no braces, so a comment sitting above a rule
// would otherwise be captured as part of that rule's selector, and a comment mentioning
// card--stale would register as a phantom rule.
const CSS = readFileSync(resolve(import.meta.dirname, "../../public/css/main.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const srgb = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]: number[]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const parseHex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const composite = (fg: number[], alpha: number, bg: number[]) => fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]);

function themeBlock(theme: "light" | "dark"): string {
  const start = theme === "dark" ? CSS.indexOf("html[data-theme='dark'] {") : CSS.indexOf(":root {");
  expect(start).toBeGreaterThan(-1);
  return CSS.slice(start, CSS.indexOf("}", start));
}

function variable(theme: "light" | "dark", name: string): number[] {
  const m = themeBlock(theme).match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i"));
  expect(m, `${name} not found in ${theme} theme`).toBeTruthy();
  return parseHex(m![1]);
}

/**
 * EVERY rule whose selector mentions card--stale — matchAll, not match, so a later or
 * theme-scoped override (`html[data-theme='dark'] .memory-card.card--stale { … }`) is
 * seen rather than shadowed by the first hit.
 */
function staleRules(): { selector: string; body: string }[] {
  return [...CSS.matchAll(/([^{}]*\.card--stale[^{}]*)\{([^}]*)\}/g)]
    .map(m => ({ selector: m[1].trim(), body: m[2] }));
}

/** Any background declaration — shorthand, -color, or -image. */
function backgroundDeclarations(): { selector: string; value: string }[] {
  const out: { selector: string; value: string }[] = [];
  for (const rule of staleRules()) {
    for (const m of rule.body.matchAll(/\bbackground(?:-color|-image)?\s*:\s*([^;]+);?/g)) {
      out.push({ selector: rule.selector, value: m[1].trim() });
    }
  }
  return out;
}

/** Resolves a colour value to RGB composited over the card, or null if not a flat colour. */
function resolveOver(value: string, card: number[]): number[] | null {
  const rgba = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/);
  if (rgba) return composite([+rgba[1], +rgba[2], +rgba[3]], rgba[4] === undefined ? 1 : +rgba[4], card);
  const hex = value.match(/#[0-9a-f]{6}\b/i);
  if (hex) return parseHex(hex[0]);
  return null;
}

describe("card--stale does not reduce text contrast", () => {
  it.each(["light", "dark"] as const)("%s theme: the modifier declares no background at all", (theme) => {
    // Stated as an absolute because neither direction of tint is safe in both themes.
    const declared = backgroundDeclarations();
    expect(declared, `card--stale must not set a background (found: ${JSON.stringify(declared)})`).toEqual([]);
    // Belt and braces: if one is ever added, it must at minimum not degrade the baseline.
    const card = variable(theme, "--bg-card");
    const tertiary = variable(theme, "--text-tertiary");
    for (const d of declared) {
      const tinted = resolveOver(d.value, card);
      expect(tinted, `unparseable background: ${d.value}`).toBeTruthy();
      expect(contrast(tertiary, tinted!)).toBeGreaterThanOrEqual(contrast(tertiary, card));
    }
  });

  it("records the baseline contrast the modifier must not worsen", () => {
    // Asserted precisely, for the same reason the failing numbers were: a loose
    // tolerance cannot tell 4.4987 from 4.54, and that gap is the whole point.
    expect(contrast(variable("dark", "--text-tertiary"), variable("dark", "--bg-card"))).toBeCloseTo(5.9568, 3);
    expect(contrast(variable("light", "--text-tertiary"), variable("light", "--bg-card"))).toBeCloseTo(5.5668, 3);
  });

  it("both baselines now clear AA, and must keep clearing it", () => {
    // The inversion of what this once asserted. --text-tertiary is the smallest
    // text in the app — timestamps, sources, section labels, card meta, mostly
    // 10-12px — so it is the ink that decides whether the interface is readable.
    for (const theme of ["light", "dark"] as const) {
      expect(contrast(variable(theme, "--text-tertiary"), variable(theme, "--bg-card"))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the ink ramp still has visible steps between its three levels", () => {
    // Three inks that all pass AA live in a narrower band than two passing and one
    // failing, so the ramp had to be re-spaced rather than just darkened. Pinned
    // because the failure mode of fixing contrast is a hierarchy that collapses:
    // secondary and tertiary rendering as the same grey.
    for (const theme of ["light", "dark"] as const) {
      const primary = variable(theme, "--text-primary");
      const secondary = variable(theme, "--text-secondary");
      const tertiary = variable(theme, "--text-tertiary");
      expect(contrast(primary, secondary)).toBeGreaterThan(1.3);
      expect(contrast(secondary, tertiary)).toBeGreaterThan(1.3);
    }
  });

  it("signals staleness with a border, like the other card modifiers", () => {
    expect(staleRules()).toHaveLength(1);
    expect(staleRules()[0].body).toMatch(/border-left:\s*3px\s+dashed\s+var\(--warn\)/);
  });

  it("the warn border clears the 3:1 floor for non-text elements in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      expect(contrast(variable(theme, "--warn"), variable(theme, "--bg-card"))).toBeGreaterThanOrEqual(3);
    }
  });
});
