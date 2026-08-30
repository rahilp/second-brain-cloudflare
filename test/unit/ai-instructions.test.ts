import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function readInstructions(name: string) {
  return readFileSync(resolve(ROOT, "AI_Instructions", name), "utf8");
}

function availabilitySection(text: string) {
  const start = text.indexOf("MCP availability");
  expect(start).toBeGreaterThan(-1);
  return text.slice(start);
}

describe("AI instruction files (#223 lazy MCP contract)", () => {
  const claude = readInstructions("CLAUDE_INSTRUCTIONS.md");
  const codex = readInstructions("CODEX_INSTRUCTIONS.md");
  const cursor = readInstructions("CURSOR_INSTRUCTIONS.md");

  for (const [label, text] of [
    ["CLAUDE", claude],
    ["CODEX", codex],
    ["CURSOR", cursor],
  ] as const) {
    describe(label, () => {
      const section = () => availabilitySection(text);

      it("documents lazy MCP tool loading", () => {
        expect(section()).toMatch(/lazy/i);
        expect(section()).toMatch(/tool list/i);
      });

      it("requires verifying with a real recall call before reporting unavailable", () => {
        expect(section()).toMatch(/actually calling recall/i);
        expect(section()).toMatch(/only report .* if a real tool call returns an error/i);
      });

      it("forbids inferring unavailable from the tool list alone", () => {
        expect(section()).toMatch(/Never conclude the tools are unavailable from the tool list alone/i);
      });

      it("does not use the old blanket unavailable rule", () => {
        expect(text).not.toMatch(
          /^If the second brain MCP tools are unavailable, tell me immediately\./m,
        );
      });
    });
  }

  it("keeps CLAUDE, CODEX, and CURSOR availability guidance aligned on core rules", () => {
    const coreRules = [
      /Never conclude the tools are unavailable from the tool list alone/i,
      /Verify by actually calling recall/i,
      /only report .* if a real tool call returns an error/i,
    ];
    for (const rule of coreRules) {
      expect(claude).toMatch(rule);
      expect(codex).toMatch(rule);
      expect(cursor).toMatch(rule);
    }
  });
});
