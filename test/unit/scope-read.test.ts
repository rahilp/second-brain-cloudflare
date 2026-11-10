import { describe, expect, it } from "vitest";
import type { Identity } from "../../src/lib/identity";

const member: Identity = {
  userId: "member",
  role: "member",
  personalWorkspaceId: "ws-personal",
  companyWorkspaceIds: ["ws-team-a", "ws-team-b"],
  defaultShare: "",
};
const admin: Identity = { ...member, role: "admin" };
const noTeams: Identity = { ...member, companyWorkspaceIds: [] };

type Scope = typeof import("../../src/lib/scope") & {
  ScopeReadError?: new (status: number, message: string) => Error & { status: number };
};

async function loadScope(): Promise<Scope> {
  return (await import("../../src/lib/scope")) as Scope;
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

async function expectScopeReadError(fn: (s: Scope) => unknown) {
  const scope = await loadScope();
  const Err = scope.ScopeReadError;
  expect(typeof Err, "ScopeReadError must be exported from src/lib/scope").toBe("function");
  const e = caught(() => fn(scope)) as (Error & { status?: number }) | undefined;
  expect(e, "read helper must throw").toBeInstanceOf(Err as Function);
  expect((e as Error).name).toBe("ScopeReadError");
  expect(e!.status).toBe(400);
  return e as Error & { status: number };
}

describe("read scope refuses a foreign team", () => {
  it("[CP1-T01] scopeWhereForRead throws ScopeReadError (400) for a foreign team", async () => {
    await expectScopeReadError((s) => s.scopeWhereForRead(member, { teamId: "ws-foreign" }));
    await expectScopeReadError((s) => s.scopeWhereForRead(member, { layer: "company", teamId: "ws-foreign" }, "e.workspace_id"));
  });

  it("[CP1-T02] readScopeWorkspaces throws ScopeReadError (400) for a foreign team", async () => {
    await expectScopeReadError((s) => s.readScopeWorkspaces(member, { teamId: "ws-foreign" }));
    await expectScopeReadError((s) => s.readScopeWorkspaces(member, { layer: "company", teamId: "ws-foreign" }));
  });

  it("[CP1-T03] message is FOREIGN_TEAM_MESSAGE pointing to list_teams and GET /team/workspaces", async () => {
    const a = await expectScopeReadError((s) => s.scopeWhereForRead(member, { teamId: "ws-foreign" }));
    const b = await expectScopeReadError((s) => s.readScopeWorkspaces(member, { teamId: "ws-foreign" }));
    const { FOREIGN_TEAM_MESSAGE } = await loadScope();
    for (const e of [a, b]) {
      expect(e.message).toBe(FOREIGN_TEAM_MESSAGE);
      expect(e.message).toContain("list_teams");
      expect(e.message).toContain("GET /team/workspaces");
    }
  });

  it("[CP1-T04] a caller with no teams is refused when naming a team", async () => {
    await expectScopeReadError((s) => s.scopeWhereForRead(noTeams, { teamId: "ws-team-a" }));
    await expectScopeReadError((s) => s.readScopeWorkspaces(noTeams, { teamId: "ws-team-a" }));
    await expectScopeReadError((s) => s.readScopeWorkspaces(noTeams, { layer: "company", teamId: "ws-foreign" }));
  });

  it("[CP1-T05] near-miss ids are refused, including the caller's own personal id", async () => {
    for (const id of ["ws-team-a ", " ws-team-a", "WS-TEAM-A", "ws-team", "ws-team-a-x", "ws-personal"]) {
      await expectScopeReadError((s) => s.scopeWhereForRead(member, { teamId: id }));
      await expectScopeReadError((s) => s.readScopeWorkspaces(member, { teamId: id }));
    }
  });

  it("[CP1-T06] admin role and the company layer do not bypass the membership check", async () => {
    await expectScopeReadError((s) => s.scopeWhereForRead(admin, { teamId: "ws-foreign" }));
    await expectScopeReadError((s) => s.readScopeWorkspaces(admin, { teamId: "ws-foreign" }));
    await expectScopeReadError((s) => s.scopeWhereForRead(admin, { layer: "company", teamId: "ws-foreign" }));
    await expectScopeReadError((s) => s.readScopeWorkspaces(admin, { layer: "company", teamId: "ws-foreign" }));
  });
});

describe("valid reads are unchanged", () => {
  it("[CP1-T07] an own team returns exactly that team", async () => {
    const s = await loadScope();
    expect(s.readScopeWorkspaces(member, { teamId: "ws-team-b" })).toEqual(["ws-team-b"]);
    expect(s.readScopeWorkspaces(member, { layer: "company", teamId: "ws-team-a" })).toEqual(["ws-team-a"]);
    expect(s.scopeWhereForRead(member, { teamId: "ws-team-b" })).toEqual({
      clause: "workspace_id = ?",
      bindings: ["ws-team-b"],
    });
    expect(s.scopeWhereForRead(member, { layer: "company", teamId: "ws-team-a" }, "e.workspace_id")).toEqual({
      clause: "e.workspace_id = ?",
      bindings: ["ws-team-a"],
    });
  });

  it("[CP1-T08] no team named returns the same set as scopeWhere / readableWorkspaces", async () => {
    const s = await loadScope();
    for (const id of [member, admin, noTeams]) {
      expect(s.readScopeWorkspaces(id)).toEqual(s.readableWorkspaces(id));
      expect(s.readScopeWorkspaces(id, {})).toEqual(s.readableWorkspaces(id));
      expect(s.scopeWhereForRead(id)).toEqual(s.scopeWhere(id));
    }
    expect(s.readScopeWorkspaces(admin)).toEqual(["ws-personal", "ws-team-a", "ws-team-b", ""]);
    expect(s.scopeWhereForRead(admin)).toEqual({
      clause: "workspace_id IN (?, ?, ?, ?)",
      bindings: ["ws-personal", "ws-team-a", "ws-team-b", ""],
    });
  });

  it("[CP1-T09] personal and company layers are unchanged", async () => {
    const s = await loadScope();
    expect(s.readScopeWorkspaces(member, { layer: "personal" })).toEqual(["ws-personal"]);
    expect(s.readScopeWorkspaces(member, { layer: "company" })).toEqual(["ws-team-a", "ws-team-b"]);
    expect(s.readScopeWorkspaces(noTeams, { layer: "company" })).toEqual([]);
    expect(s.scopeWhereForRead(member, { layer: "personal" })).toEqual(s.scopeWhere(member, "personal"));
    expect(s.scopeWhereForRead(member, { layer: "company" })).toEqual(s.scopeWhere(member, "company"));
    expect(s.scopeWhereForRead(noTeams, { layer: "company" })).toEqual(s.scopeWhere(noTeams, "company"));
  });

  it("[CP1-T10] an empty teamId behaves as no team named", async () => {
    const s = await loadScope();
    expect(s.readScopeWorkspaces(member, { teamId: "" })).toEqual(s.readableWorkspaces(member));
    expect(s.readScopeWorkspaces(member, { layer: "company", teamId: "" })).toEqual(["ws-team-a", "ws-team-b"]);
    expect(s.scopeWhereForRead(member, { teamId: "" })).toEqual(s.scopeWhere(member));
    expect(s.scopeWhereForRead(admin, { layer: "personal", teamId: "" })).toEqual(s.scopeWhere(admin, "personal"));
  });
});
