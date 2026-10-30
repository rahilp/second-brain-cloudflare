import { describe, expect, it } from "vitest";
import type { Identity } from "../../src/lib/identity";
import { scopeWrite } from "../../src/lib/scope";

const member: Identity = {
  userId: "member",
  role: "member",
  personalWorkspaceId: "ws-personal",
  companyWorkspaceIds: ["ws-team-a", "ws-team-b"],
  defaultShare: "",
};

describe("scopeWrite", () => {
  it("rejects an explicitly named team that the caller cannot write to", () => {
    expect(() => scopeWrite(member, "company", "ws-foreign")).toThrow(/team/i);
    expect(() => scopeWrite(member, "company", "")).toThrow(/team/i);
    const noTeams = { ...member, companyWorkspaceIds: [] };
    expect(() => scopeWrite(noTeams, "company", "ws-foreign")).toThrow(/team/i);
  });

  it("keeps the explicit team and the existing defaults for valid writes", () => {
    expect(scopeWrite(member, "company", "ws-team-b")).toBe("ws-team-b");
    expect(scopeWrite(member, "company")).toBe("ws-team-a");
    expect(scopeWrite(member, "personal")).toBe("ws-personal");
    expect(scopeWrite(member)).toBe("ws-personal");
    expect(scopeWrite({ ...member, companyWorkspaceIds: [] }, "company")).toBe("ws-personal");
  });
});

const noTeams: Identity = { ...member, companyWorkspaceIds: [] };

async function loadScope() {
  return (await import("../../src/lib/scope")) as typeof import("../../src/lib/scope") & {
    ScopeWriteError?: new (status: number, message: string) => Error & { status: number };
  };
}

/** Run fn, return what it threw (undefined when nothing threw). */
function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

async function expectScopeWriteError(fn: (s: Awaited<ReturnType<typeof loadScope>>) => unknown) {
  const scope = await loadScope();
  const Err = scope.ScopeWriteError;
  expect(typeof Err, "ScopeWriteError must be exported from src/lib/scope").toBe("function");
  const e = caught(() => fn(scope)) as (Error & { status?: number }) | undefined;
  expect(e, "scopeWrite must throw").toBeInstanceOf(Err as Function);
  expect((e as Error).name).toBe("ScopeWriteError");
  expect(e!.status).toBe(400);
  return e as Error & { status: number };
}

describe("scopeWrite typed error", () => {
  it("[CP1-T01] throws a typed ScopeWriteError with status 400", async () => {
    const e = await expectScopeWriteError((s) => s.scopeWrite(member, "company", "ws-foreign"));
    expect(e).toBeInstanceOf(Error);
  });

  it("[CP1-T02] message points to list_teams and GET /team/workspaces", async () => {
    const e = await expectScopeWriteError((s) => s.scopeWrite(member, "company", "ws-foreign"));
    expect(e.message).toMatch(/team must be one of your teams/);
    expect(e.message).toContain("list_teams");
    expect(e.message).toContain("GET /team/workspaces");
  });

  it("[CP1-T03] follows the TeamAdminError shape", async () => {
    const e = await expectScopeWriteError((s) => s.scopeWrite(member, "company", "ws-foreign"));
    const { TeamAdminError } = await import("../../src/lib/team-admin");
    const ref = new TeamAdminError(400, "x");
    expect(ref).toBeInstanceOf(Error);
    expect(typeof ref.status).toBe("number");
    expect(typeof e.status).toBe("number");
    expect(typeof e.message).toBe("string");
    expect(e).toBeInstanceOf(Error);
  });

  it("[CP1-T04] a caller with no teams naming one is refused, not redirected", async () => {
    const e = await expectScopeWriteError((s) => s.scopeWrite(noTeams, "company", "ws-foreign"));
    expect(e.message).toContain("list_teams");
  });

  it("[CP1-T05] empty or blank team is refused, not redirected to the primary team", async () => {
    for (const blank of ["", "   "]) {
      const e = await expectScopeWriteError((s) => s.scopeWrite(member, "company", blank));
      expect(e.message).toContain("GET /team/workspaces");
    }
  });

  it("[CP1-T06] whitespace or case variants of a team id are not accepted", async () => {
    for (const variant of [" ws-team-a ", "WS-TEAM-A"]) {
      await expectScopeWriteError((s) => s.scopeWrite(member, "company", variant));
    }
  });

  it("[CP1-T07] personal write ignores the team and lands in personal", () => {
    expect(scopeWrite(member, "personal")).toBe("ws-personal");
    expect(scopeWrite(member)).toBe("ws-personal");
    expect(scopeWrite(member, "personal", "ws-foreign")).toBe("ws-personal");
  });

  it("[CP1-T08] company write with no team goes to the default team", () => {
    expect(scopeWrite(member, "company")).toBe("ws-team-a");
    expect(scopeWrite(noTeams, "company")).toBe("ws-personal");
  });

  it("[CP1-T09] company write naming an own team lands in that team", () => {
    expect(scopeWrite(member, "company", "ws-team-b")).toBe("ws-team-b");
    expect(scopeWrite(member, "company", "ws-team-a")).toBe("ws-team-a");
  });
});
