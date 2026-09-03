import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOOKS = resolve(import.meta.dirname, "../../integrations/claude-code-hooks");
const hasBash = process.platform !== "win32" && spawnSync("bash", ["--version"]).status === 0;

describe.skipIf(!hasBash)("integrations/claude-code-hooks/install.sh", () => {
  let home: string;
  let settings: string;
  let config: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sb-install-"));
    settings = join(home, ".claude", "settings.json");
    config = join(home, ".config", "second-brain", "config.json");
  });

  // stdin is closed so a missing-argument prompt can never hang the suite.
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [join(HOOKS, "install.sh"), ...args], {
      env: { PATH: process.env.PATH!, HOME: home, ...env } as unknown as NodeJS.ProcessEnv, // wrangler's types make AUTH_TOKEN required; the installer must not inherit it
      stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    });
  const read = () => JSON.parse(readFileSync(settings, "utf8"));

  it("writes both hooks with the timeout and matcher the CLI needs, and no token anywhere in settings.json", () => {
    const r = run(["https://w.example/", "tok"]);
    expect(r.status, r.stderr).toBe(0);
    const s = read();
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0].matcher).toBe("startup|clear|compact");
    expect(s.hooks.SessionStart[0].hooks[0].command).toMatch(/^node ".*\/claude-code-hooks\/session-start\.js"$/);
    expect(s.hooks.SessionEnd).toHaveLength(1);
    expect(s.hooks.SessionEnd[0].matcher).toBeUndefined();
    expect(s.hooks.SessionEnd[0].hooks[0].timeout).toBeGreaterThanOrEqual(20);
    expect(readFileSync(settings, "utf8")).not.toContain("tok");
    expect(s["second-brain-hooks"]).toBeUndefined();
    // Credentials live in the CLI's file, mode 600, trailing slash stripped.
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ workerUrl: "https://w.example", authToken: "tok" });
    expect(statSync(config).mode & 0o777).toBe(0o600);
  });

  it("is idempotent and upgrades a pre-PR-A install in place", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settings, JSON.stringify({
      permissions: { allow: ["Bash(npm test)"] },
      hooks: {
        SessionStart: [
          { matcher: ".*", hooks: [{ type: "command", command: `SECOND_BRAIN_URL=x SECOND_BRAIN_TOKEN=y node /old/checkout/integrations/claude-code-hooks/session-start.js` }] },
          { matcher: "startup", hooks: [{ type: "command", command: "echo someone-elses-hook" }] },
        ],
        SessionEnd: [{ matcher: ".*", hooks: [{ type: "command", command: `SECOND_BRAIN_URL=x SECOND_BRAIN_TOKEN=y node /old/checkout/integrations/claude-code-hooks/session-end.js` }] }],
      },
      "second-brain-hooks": true,
    }));
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    const s = read();
    expect(s.permissions).toEqual({ allow: ["Bash(npm test)"] });
    expect(s.hooks.SessionStart).toHaveLength(2);
    expect(s.hooks.SessionStart.filter((e: any) => e.hooks[0].command.includes("someone-elses-hook"))).toHaveLength(1);
    expect(s.hooks.SessionStart.filter((e: any) => e.hooks[0].command.includes("session-start.js"))).toHaveLength(1);
    expect(s.hooks.SessionEnd).toHaveLength(1);
    expect(s.hooks.SessionEnd[0].hooks[0].timeout).toBe(30);
    expect(s["second-brain-hooks"]).toBeUndefined();
  });

  it("refuses a malformed settings.json and leaves it untouched", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const broken = '{ "permissions": { "allow": ["Bash(npm test)"] }, }\n';
    writeFileSync(settings, broken);
    const r = run(["https://w.example", "tok"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not valid JSON");
    expect(readFileSync(settings, "utf8")).toBe(broken);
  });

  it("reuses an existing config file when called with no arguments", () => {
    mkdirSync(join(home, ".config", "second-brain"), { recursive: true });
    writeFileSync(config, JSON.stringify({ workerUrl: "https://w.example", authToken: "tok" }));
    const r = run([]);
    expect(r.status, r.stderr).toBe(0);
    expect(read().hooks.SessionEnd).toHaveLength(1);
  });

  it("exits 2 instead of prompting when there is no TTY and no credentials", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(existsSync(settings)).toBe(false);
  });

  it("--uninstall removes only our entries", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo keep-me" }] }] } }));
    expect(run(["https://w.example", "tok"]).status).toBe(0);
    expect(run(["--uninstall"]).status).toBe(0);
    const s = read();
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe("echo keep-me");
    expect(s.hooks.SessionEnd).toBeUndefined();
  });

  it("never touches the real home directory", () => {
    const real = join(process.env.HOME!, ".claude", "settings.json");
    const before = existsSync(real) ? statSync(real).mtimeMs : null;
    run(["https://w.example", "tok"]);
    expect(existsSync(real) ? statSync(real).mtimeMs : null).toBe(before);
  });
});
