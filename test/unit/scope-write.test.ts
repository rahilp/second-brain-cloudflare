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
