import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const html = readFileSync(resolve(ROOT, "public/index.html"), "utf8");
const css = readFileSync(resolve(ROOT, "public/css/main.css"), "utf8");

describe("dashboard fonts", () => {
  it("does not load Google Fonts", () => {
    expect(html).not.toMatch(/fonts\.googleapis\.com/);
    expect(html).not.toMatch(/Lora|Geist/);
  });
  it("self-hosts Sora and DM Sans with their licenses", () => {
    for (const f of ["sora.ttf", "dm-sans-400.ttf", "dm-sans-500.ttf", "dm-sans-600.ttf", "OFL.txt", "Sora-OFL.txt"]) {
      expect(existsSync(resolve(ROOT, "public/fonts", f)), f).toBe(true);
    }
    expect(css).toMatch(/@font-face\s*{[^}]*font-family:\s*'?Sora'?/);
    expect(css).toMatch(/@font-face\s*{[^}]*font-family:\s*'?DM Sans'?/);
  });
  it("points the font tokens at the new families", () => {
    expect(css).toMatch(/--font-serif:\s*'Sora'/);
    expect(css).toMatch(/--font-sans:\s*'DM Sans'/);
    expect(css).toMatch(/--font-display:\s*'Sora'/);
  });
});
