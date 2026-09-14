import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "../../public/css/main.css"), "utf8");
const block = (sel: string) => {
  const i = css.indexOf(sel); const open = css.indexOf("{", i); let d = 0, j = open;
  for (; j < css.length; j++) { if (css[j] === "{") d++; else if (css[j] === "}" && --d === 0) break; }
  return css.slice(open, j);
};
const light = block(":root"), dark = block("html[data-theme='dark']");
const val = (b: string, t: string) => (b.match(new RegExp(`${t}:\\s*([^;]+);`)) || [])[1]?.trim();

describe("living-thread tokens", () => {
  it("light theme carries the site palette", () => {
    expect(val(light, "--bg")).toBe("#ffffff");
    expect(val(light, "--text-primary")).toBe("#202124");
    expect(val(light, "--text-secondary")).toBe("#61646c");
    expect(val(light, "--surface-muted")).toBe("#f3f4f6");
    expect(val(light, "--line")).toBe("#e2e4e8");
    expect(val(light, "--brand-orange")).toBe("#fd540a");
    expect(val(light, "--action")).toBe("#cc4109");
    expect(val(light, "--accent-ink")).toBe("#bd410e");
  });
  it("defines every new token in both themes", () => {
    for (const t of ["--brand-orange","--action","--action-hover","--line","--border-soft","--surface-muted","--charcoal","--data","--s1","--s2","--s3","--s4","--s5"]) {
      expect(val(light, t), `${t} light`).toBeTruthy();
      expect(val(dark, t), `${t} dark`).toBeTruthy();
    }
  });
  it("keeps every pre-existing token name", () => {
    for (const t of ["--bg","--bg-card","--bg-tag","--bg-secondary","--bg-confirm","--bg-tag-confirmed","--surface-2","--surface-3","--surface-elevated","--text-on-elevated","--accent-on-elevated","--switch-knob","--text-primary","--text-secondary","--text-tertiary","--text-tag","--text-tag-confirmed","--border","--border-card","--border-input","--line-soft","--accent","--accent-press","--accent-soft","--accent-ink","--good","--warn","--danger","--danger-soft","--on-accent","--font-serif","--font-sans","--radius-card","--radius-pill","--radius-tag","--radius-bubble","--shadow-card","--shadow-float","--shadow-sheet","--sb-mark","--ease","--ease-spring"]) {
      expect(val(light, t), t).toBeTruthy();
    }
  });
});
