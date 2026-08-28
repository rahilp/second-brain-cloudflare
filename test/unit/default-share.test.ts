import { describe, expect, it } from "vitest";
import { makeSqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import { D1Mock } from "../helpers/d1-mock";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { effectiveWriteTarget, scopeWrite } from "../../src/lib/scope";
import { createMember, setMemberDefaultShare } from "../../src/lib/team-admin";
import { resolveIdentity } from "../../src/lib/identity";
import type { Env } from "../../src/env";
import type { Identity } from "../../src/lib/identity";

const identity = (overrides: Partial<Identity> = {}): Identity => ({
  userId: "u1",
  role: "member",
  personalWorkspaceId: "ws-p",
  companyWorkspaceIds: ["ws-c"],
  defaultShare: "",
  ...overrides,
});

describe("capture-visibility precedence", () => {
  it("explicit request > member override > org default > personal", () => {
    // 4. shipped default.
    expect(effectiveWriteTarget(identity(), undefined, undefined)).toBe("personal");
    // 3. org default says company.
    expect(effectiveWriteTarget(identity(), undefined, "company")).toBe("company");
    // 2. member override beats the org default — including back to personal.
    expect(effectiveWriteTarget(identity({ defaultShare: "personal" }), undefined, "company")).toBe("personal");
    expect(effectiveWriteTarget(identity({ defaultShare: "company" }), undefined, "personal")).toBe("company");
    // 1. an explicit request value beats everything, in both directions.
    expect(effectiveWriteTarget(identity({ defaultShare: "company" }), "personal", "company")).toBe("personal");
    // A typo'd or hostile explicit value falls through the chain rather than
    // being honoured.
    expect(effectiveWriteTarget(identity(), "Company", "personal")).toBe("personal");
    expect(effectiveWriteTarget(identity(), "ws-c", "personal")).toBe("personal");
  });

  it("resolves to workspace ids the caller actually belongs to", () => {
    const id = identity();
    expect(scopeWrite(id, effectiveWriteTarget(id, undefined, "company"))).toBe("ws-c");
    expect(scopeWrite(id, effectiveWriteTarget(id, undefined, undefined))).toBe("ws-p");
  });

  it("member override round-trips: set on the user, carried by identity, honoured at write", async () => {
    const d1 = makeSqliteD1();
    const env = { ...makeTestEnv(d1.db as unknown as D1Mock), AUTH_TOKEN: "owner-token" } as unknown as Env;
    resetDatabaseInit();
    await initializeDatabase(env);
    await ensureTenantBootstrap(env);
    const { member, token } = await createMember(env, { name: "Ada" });

    // Default: inherit (''), so the org default decides — personal.
    expect(member.defaultShare).toBe("");
    const request = new Request("https://x/", { headers: { Authorization: `Bearer ${token}` } });
    expect((await resolveIdentity(request, env))?.defaultShare).toBe("");

    // Admin pins Ada to company; identity carries it; scope honours it.
    await setMemberDefaultShare(env, member.userId, "company");
    const resolved = await resolveIdentity(request, env);
    expect(resolved?.defaultShare).toBe("company");
    expect(scopeWrite(resolved!, effectiveWriteTarget(resolved!, undefined, "personal"))).toBe(resolved!.companyWorkspaceIds[0]);

    // "inherit" clears the override back to ''.
    await setMemberDefaultShare(env, member.userId, "inherit");
    expect((await resolveIdentity(request, env))?.defaultShare).toBe("");
  });
});
