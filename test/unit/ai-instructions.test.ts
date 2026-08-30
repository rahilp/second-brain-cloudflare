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

const ALL_FILES = {
  CLAUDE: readInstructions("CLAUDE_INSTRUCTIONS.md"),
  CODEX: readInstructions("CODEX_INSTRUCTIONS.md"),
  CURSOR: readInstructions("CURSOR_INSTRUCTIONS.md"),
  CHATGPT: readInstructions("CHATGPT_INSTRUCTIONS.md"),
} as const;

const FULL_PROVIDERS = ["CLAUDE", "CODEX", "CURSOR"] as const;

/** Every MCP tool a team-aware client should know about. */
const MCP_TOOLS = [
  "remember",
  "recall",
  "get",
  "list_recent",
  "list_teams",
  "append",
  "update",
  "forget",
  "link",
  "unlink",
  "connections",
  "share",
  "set_status",
] as const;

describe("AI instruction files (#223 lazy MCP contract)", () => {
  for (const label of FULL_PROVIDERS) {
    const text = ALL_FILES[label];

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
      for (const label of FULL_PROVIDERS) {
        expect(ALL_FILES[label]).toMatch(rule);
      }
    }
  });
});

describe("AI instruction files — team workspace coverage", () => {
  for (const label of [...FULL_PROVIDERS, "CHATGPT"] as const) {
    describe(label, () => {
      const text = ALL_FILES[label];

      it("documents v3.0.0 single-team default", () => {
        expect(text).toMatch(/v3\.0\.0.*one shared team/i);
      });

      it("lists all MCP memory tools including list_teams", () => {
        for (const tool of MCP_TOOLS) {
          expect(text).toContain(tool);
        }
      });

      it("documents list_teams for discovering team names and ids", () => {
        expect(text).toMatch(/list_teams/i);
        expect(text).toMatch(/display name/i);
      });

      it("documents personal vs company workspace layers", () => {
        expect(text).toMatch(/personal/i);
        expect(text).toMatch(/company/i);
      });

      it("documents the team parameter and when to ask the user", () => {
        expect(text).toMatch(/`team`/);
        expect(text).toMatch(/more than one/i);
      });

      it("documents share for moving between layers", () => {
        expect(text).toMatch(/share/i);
      });
    });
  }

  for (const label of FULL_PROVIDERS) {
    it(`${label}: has a dedicated Team workspaces section`, () => {
      expect(ALL_FILES[label]).toMatch(/Team workspaces \(Team Edition\)/);
    });
  }

  it("keeps CLAUDE, CODEX, and CURSOR team guidance aligned on core rules", () => {
    const teamRules = [
      /v3\.0\.0.*one shared team/i,
      /Call \*\*list_teams\*\* before writing to company/i,
      /never the display name/i,
      /\[primary\]/i,
      /Author or admin only for un-sharing/i,
    ];
    for (const rule of teamRules) {
      for (const label of FULL_PROVIDERS) {
        expect(ALL_FILES[label]).toMatch(rule);
      }
    }
  });
});
