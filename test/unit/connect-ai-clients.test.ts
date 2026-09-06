import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  START_MARKER,
  END_MARKER,
  SENTINEL_PHRASE,
  applyInstructionBlock,
  writeInstructionBlock,
} from "../../scripts/instruction-block.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

function readScript(rel: string) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

function readInstructions(name: string) {
  return readFileSync(resolve(ROOT, "AI_Instructions", name), "utf8");
}

function countOccurrences(text: string, needle: string) {
  return text.split(needle).length - 1;
}

describe("instruction-block apply logic", () => {
  const newBody = readInstructions("CLAUDE_INSTRUCTIONS.md");

  it("appends a marked block to an empty file", () => {
    const { content, action } = applyInstructionBlock("", newBody);
    expect(action).toBe("appended");
    expect(content).toContain(START_MARKER);
    expect(content).toContain(END_MARKER);
    expect(content).toContain("MCP availability");
    expect(countOccurrences(content, START_MARKER)).toBe(1);
  });

  it("replaces an existing marked block with new content", () => {
    const oldBody = "OLD RULE: tell me immediately if unavailable";
    const existing = [
      "# My notes",
      "",
      START_MARKER,
      oldBody,
      END_MARKER,
      "",
    ].join("\n");

    const { content, action } = applyInstructionBlock(existing, newBody);
    expect(action).toBe("updated");
    expect(content).toContain("MCP availability");
    expect(content).not.toContain(oldBody);
    expect(countOccurrences(content, START_MARKER)).toBe(1);
    expect(countOccurrences(content, END_MARKER)).toBe(1);
    expect(content.startsWith("# My notes")).toBe(true);
  });

  it("replaces an existing marked block with CRLF line endings", () => {
    const oldBody = "OLD RULE: tell me immediately if unavailable";
    const existing = [
      "# My notes",
      "",
      START_MARKER,
      oldBody,
      END_MARKER,
      "",
      "Notes after the block",
    ].join("\r\n");

    const { content, action } = applyInstructionBlock(existing, newBody);
    expect(action).toBe("updated");
    expect(content).toContain("MCP availability");
    expect(content).not.toContain(oldBody);
    expect(content).toContain("Notes after the block");
    expect(countOccurrences(content, START_MARKER)).toBe(1);
  });

  it("replaces legacy sentinel-only installs while preserving trailing user content", () => {
    const existing = [
      "# Claude",
      "",
      SENTINEL_PHRASE,
      "If the second brain MCP tools are unavailable, tell me immediately.",
      "",
      "More personal notes after the old block",
    ].join("\n");

    const { content, action } = applyInstructionBlock(existing, newBody);
    expect(action).toBe("updated-legacy");
    expect(content).toContain("MCP availability");
    expect(content).not.toContain("tell me immediately");
    expect(content).toContain("More personal notes after the old block");
    expect(countOccurrences(content, START_MARKER)).toBe(1);
    expect(content.startsWith("# Claude")).toBe(true);
  });

  it("replaces a wrapped legacy Second Brain section without truncating personal preferences", () => {
    const existing = [
      "# My global instructions",
      "## Second Brain — mandatory rules",
      `1. ${SENTINEL_PHRASE} with a natural language query.`,
      "2. Store EVERYTHING important automatically.",
      "",
      "## My own preferences",
      "- Always use TypeScript strict mode",
      "- Never force-push to main",
    ].join("\n");

    const { content, action } = applyInstructionBlock(existing, newBody);
    expect(action).toBe("updated-legacy");
    expect(content).toContain("MCP availability");
    expect(content).toContain("## My own preferences");
    expect(content).toContain("Always use TypeScript strict mode");
    expect(content).toContain("Never force-push to main");
    expect(content).not.toContain("tell me immediately");
    expect(content.startsWith("# My global instructions")).toBe(true);
  });

  it("keeps notes written directly above the legacy block", () => {
    // The block is preceded by the user's own lines under a heading they share.
    // Reaching upward for a plausible start once absorbed anything within
    // twenty lines, which is exactly where a note about the block would sit.
    const existing = [
      "# My setup",
      "",
      "I work in Europe/Rome, so schedule things accordingly.",
      "Prefer pnpm over npm.",
      "",
      "You have access to a personal second brain via MCP tools.",
      "",
      `1. ${SENTINEL_PHRASE} with a natural language query.`,
      "12. If the second brain MCP tools are unavailable, tell me immediately.",
    ].join("\n");

    const { content, action } = applyInstructionBlock(existing, newBody);
    expect(action).toBe("updated-legacy");
    expect(content).toContain("I work in Europe/Rome, so schedule things accordingly.");
    expect(content).toContain("Prefer pnpm over npm.");
    expect(content).toContain("MCP availability");
  });

  it("appends rather than deleting when the legacy block has no recognisable end", () => {
    // An edited block whose tail matches nothing we know, with no heading after
    // it. Replacing here meant deleting to the end of the file — the original
    // defect. Leaving a stale copy is recoverable in a minute; this is not.
    const existing = [
      "# Second Brain",
      "",
      "You have access to a personal second brain via MCP tools.",
      "",
      `1. ${SENTINEL_PHRASE} with a natural language query.`,
      "2. Store EVERYTHING important automatically.",
      "",
      "My unrelated note at the bottom of the file.",
    ].join("\n");

    const { content, action } = applyInstructionBlock(existing, newBody);
    expect(action).toBe("appended-legacy-kept");
    expect(content).toContain("My unrelated note at the bottom of the file.");
    expect(content).toContain("2. Store EVERYTHING important automatically.");
    expect(content).toContain("MCP availability");
  });

  it("reports an unbounded legacy block distinctly, so the user is told to tidy it", () => {
    // Silently appending would leave the file saying two different things with
    // no explanation of why.
    const plainAppend = applyInstructionBlock("# Notes\n\nnothing to do with us\n", newBody);
    expect(plainAppend.action).toBe("appended");
  });

  it("writes a backup before legacy upgrades", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-instruction-block-"));
    const target = join(dir, "CLAUDE.md");
    const existing = [
      "# Claude",
      "",
      SENTINEL_PHRASE,
      "If the second brain MCP tools are unavailable, tell me immediately.",
    ].join("\n");
    writeFileSync(target, existing, "utf8");

    const { action, backupPath } = writeInstructionBlock(target, newBody);
    expect(action).toBe("updated-legacy");
    expect(backupPath).toBe(`${target}.bak`);
    expect(existsSync(backupPath!)).toBe(true);
    expect(readFileSync(backupPath!, "utf8")).toBe(existing);
    expect(readFileSync(target, "utf8")).toContain("MCP availability");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("connect-ai-clients scripts", () => {
  const sh = readScript("scripts/connect-ai-clients.sh");
  const ps1 = readScript("scripts/connect-ai-clients.ps1");

  for (const [label, text] of [
    ["bash", sh],
    ["powershell", ps1],
  ] as const) {
    it(`${label}: delegates instruction updates to instruction-block.mjs`, () => {
      expect(text).toContain("instruction-block.mjs");
      expect(text).not.toMatch(/Already configured.*skipping/i);
      expect(text).not.toMatch(/Looks like you already pasted these instructions/i);
    });

    it(`${label}: references CLAUDE_INSTRUCTIONS.md`, () => {
      expect(text).toContain("AI_Instructions/CLAUDE_INSTRUCTIONS.md");
    });

    it(`${label}: distinguishes legacy upgrade output with backup path`, () => {
      expect(text).toContain("updated-legacy");
      expect(text).toContain(".bak");
    });

    it(`${label}: reminds about Team Edition instruction sync`, () => {
      expect(text).toMatch(/Team Edition/i);
      expect(text).toContain("CHANGELOG.md");
      expect(text).toContain("AI_Instructions");
    });
  }

  it("powershell references CODEX_INSTRUCTIONS.md", () => {
    expect(ps1).toContain("AI_Instructions/CODEX_INSTRUCTIONS.md");
  });

  it("bash references CODEX_INSTRUCTIONS.md", () => {
    expect(sh).toContain("AI_Instructions/CODEX_INSTRUCTIONS.md");
  });
});
