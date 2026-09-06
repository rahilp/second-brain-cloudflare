import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const readme = readFileSync(resolve(import.meta.dirname, "../../README.md"), "utf8");

describe("README MCP troubleshooting (#223)", () => {
  it("points readers to the wiki troubleshooting section", () => {
    expect(readme).toMatch(/Connect to AI Clients.*Troubleshooting/i);
    expect(readme).toMatch(/wiki\/Connect-to-AI-Clients#troubleshooting/i);
  });

  it("names the common failure modes covered there", () => {
    expect(readme).toMatch(/Opera warnings/i);
    expect(readme).toMatch(/Cursor OAuth/i);
    expect(readme).toMatch(/Claude Code tool visibility/i);
  });
});
