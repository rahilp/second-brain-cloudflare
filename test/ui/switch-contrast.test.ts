/**
 * The on/off switch (.sb-switch), measured against the real stylesheet.
 *
 * Same parse-the-CSS approach as toast-contrast.test.ts, and here for the same
 * reason it exists there: this project shipped a black-on-black toast by
 * writing `var(--surface-elevated, #1e1e1e)` for a token that was never
 * defined, so the fallback was silently what applied. A knob token defined in
 * the light block and forgotten in the dark one fails the same way — the knob
 * simply does not paint — and nothing else in the suite would notice.
 *
 * Also pins the tap target at 32px on the BASE rule rather than inside the
 * max-width:767px block. A switch is thumb-sized wherever it is, and the
 * @media block is not the place to discover that.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

/** Fails when the token is missing, rather than papering over it. */
function variable(theme: "light" | "dark", name: string): number[] {
  const m = themeBlock(theme).match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i"));
  expect(m, `${name} not found in the ${theme} theme`).toBeTruthy();
  return parseHex(m![1]);
}

function ruleBody(selector: string): string {
  const re = new RegExp(selector.replace(/[.:+*]/g, "\\$&") + "\\s*\\{([^}]*)\\}");
  const m = CSS.match(re);
  expect(m, `${selector} rule not found`).toBeTruthy();
  return m![1];
}

describe(".sb-switch", () => {
  it.each(["light", "dark"] as const)(
    "%s theme: --switch-knob is actually defined, in this theme's own block",
    (theme) => {
      variable(theme, "--switch-knob");
    },
  );

  it("has no var() fallback hiding an undefined knob token", () => {
    expect(CSS).not.toMatch(/var\(--switch-knob\s*,/);
  });

  // NOT a knob-vs-track contrast assertion, and deliberately so. WCAG's 3:1
  // for non-text contrast is about a component's BOUNDARY against what is
  // adjacent to it, not about two parts of one component: a white knob on this
  // product's orange measures 2.46:1 and is entirely legible, and "fixing" that
  // number would mean moving the brand accent. What has to be pinned instead is
  // that the state is not carried by colour alone.
  it("signals its state by knob POSITION, not by colour alone", () => {
    expect(ruleBody(".sb-switch-input:checked + .sb-switch-track .sb-switch-knob")).toMatch(
      /transform:\s*translateX\(\d+px\)/,
    );
  });

  it("uses --accent as a fill and a boundary, never as ink", () => {
    // The whole switch, from its first rule to the rule after its last.
    const from = CSS.indexOf(".sb-switch {");
    const to = CSS.indexOf(".team-capture-label");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const block = CSS.slice(from, to);
    expect(block).toMatch(/background:\s*var\(--accent\)/);
    // `color:` is what makes a token ink. Nothing in this component sets one —
    // there is no text on a switch — so --accent cannot become ink here by
    // accident later.
    expect(block).not.toMatch(/(?<!-)\bcolor:/);
  });

  it("takes a 32px tap target from its base rule, not from a phone-only media query", () => {
    expect(ruleBody(".sb-switch")).toMatch(/min-height:\s*32px/);
  });

  it("is a real focusable input with a visible focus ring, not a div", () => {
    const html = readFileSync(resolve(import.meta.dirname, "../../public/index.html"), "utf8");
    expect(html).toMatch(/<input type="checkbox" class="sb-switch-input"/);
    // Transparent, NOT display:none — that would take it out of the tab order
    // along with the pixels, and the keyboard is the whole reason it is an
    // input in the first place.
    const input = ruleBody(".sb-switch-input");
    expect(input).toMatch(/opacity:\s*0\b/);
    expect(input).not.toMatch(/display:\s*none/);
    expect(input).not.toMatch(/visibility:\s*hidden/);
    expect(ruleBody(".sb-switch-input:focus-visible + .sb-switch-track")).toMatch(/outline:\s*2px solid/);
  });
});
