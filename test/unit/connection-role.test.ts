/**
 * Who the desktop app thinks is holding the token it was set up with.
 *
 * A team member's invite token already works end to end in the installer — it
 * connects, it reaches the keychain, it reaches the CLI's config file. What was
 * wrong was everything the app then said: on any team brain it told whoever
 * connected "You're signed in as this brain's owner-admin", and pointed them at
 * a dashboard panel that would 403 them.
 *
 * The rules that decide which of the three things to say live in
 * `installer/src/connection-role.ts`, which imports nothing, and are therefore
 * reachable from here — the same arrangement `test/unit/rotation-screens.test.ts`
 * uses, and for the same reason: `main.ts` resolves `#app` at module scope and
 * cannot be imported outside a webview.
 *
 * The assertion that matters most is the least-privileged one. A Worker too old
 * to answer `/team/me`, or a request that simply fails, yields `null`, and
 * `null` must land on "member". Over-claiming produces the false sentence this
 * module exists to delete; under-claiming produces a hidden button for an admin
 * who can open the dashboard anyway.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  canRotatePassword,
  roleFromProbe,
  teamCardKeys,
  type ConnectionRole,
} from "../../installer/src/connection-role";

describe("deriving a role from what a connect could learn", () => {
  it("calls a solo brain its owner's, whatever else is true", () => {
    // One user, so there is nobody else it could belong to. This is the whole
    // of today's behaviour for a solo install and must not move.
    expect(roleFromProbe({ team: false, role: "member", hasCloudflareSession: false })).toBe(
      "owner",
    );
    expect(roleFromProbe({ team: false, role: null, hasCloudflareSession: false })).toBe("owner");
  });

  it("lets a Cloudflare session outrank the team role", () => {
    // A session for the account the Worker lives in is the only evidence this
    // app can have that the person in front of it controls the deployment.
    expect(roleFromProbe({ team: true, role: "member", hasCloudflareSession: true })).toBe("owner");
  });

  it("reads an admin's token as admin", () => {
    expect(roleFromProbe({ team: true, role: "admin", hasCloudflareSession: false })).toBe("admin");
  });

  it("reads a member's token as member", () => {
    expect(roleFromProbe({ team: true, role: "member", hasCloudflareSession: false })).toBe(
      "member",
    );
  });

  it("falls to the least-privileged answer when /team/me cannot be read", () => {
    // The failure path. `null` is what a Worker too old to serve /team/me, a
    // non-2xx, unparseable JSON or a dropped connection all reduce to, and all
    // four must produce the card that claims the least.
    expect(roleFromProbe({ team: true, role: null, hasCloudflareSession: false })).toBe("member");
    // Anything unrecognised is treated the same way, not optimistically.
    for (const junk of ["owner", "", "ADMIN", "administrator"]) {
      expect(roleFromProbe({ team: true, role: junk, hasCloudflareSession: false })).toBe("member");
    }
  });
});

describe("which team-card copy each role gets", () => {
  it("leaves the owner on today's key", () => {
    expect(teamCardKeys("owner")).toEqual({
      label: "details.teamCardLabel",
      body: "details.teamCardBody",
    });
  });

  it("gives each role a different body, all under the same label", () => {
    const roles: ConnectionRole[] = ["owner", "admin", "member"];
    const bodies = roles.map((role) => teamCardKeys(role).body);
    // Distinctness, not values: the point is that no two roles are told the
    // same thing, and the strings themselves are the catalogs' business.
    expect(new Set(bodies).size).toBe(3);
    expect(new Set(roles.map((role) => teamCardKeys(role).label)).size).toBe(1);
    for (const body of bodies) expect(body.startsWith("details.")).toBe(true);
  });
});

describe("who may be offered a password change", () => {
  it("is the owner and nobody else", () => {
    // An admin holds a member token with the admin role: they can invite people
    // from the dashboard, but AUTH_TOKEN lives in Cloudflare and they have no
    // account there. Offering them the flow would dead-end at a sign-in.
    expect(canRotatePassword("owner")).toBe(true);
    expect(canRotatePassword("admin")).toBe(false);
    expect(canRotatePassword("member")).toBe(false);
  });
});

describe("the entry point is absent, not disabled", () => {
  it("gates the password card on canRotatePassword and renders nothing when it is false", () => {
    // `canRotatePassword` returning false has to remove the card, not grey it
    // out: `passwordCard`'s blocked branch already renders a disabled-looking
    // card with an escape hatch, and reusing that shape here would tell a
    // member their password change is temporarily unavailable rather than not
    // theirs to make. Read from source because `details.ts` boots a Tauri
    // window at import time and cannot be loaded here.
    const source = readFileSync(
      resolve(import.meta.dirname, "../../installer/src/details.ts"),
      "utf8",
    );
    const gate = source.match(/\.\.\.\(canRotatePassword\([^)]*\) \? \[passwordCard\([^)]*\)\] : \[\]\)/);
    expect(gate, "passwordCard must be conditionally rendered, not conditionally disabled").not.toBe(
      null,
    );
    // And there must be no second, ungated call anywhere (the declaration is
    // excluded, so this counts call sites only).
    expect(source.match(/(?<!function )passwordCard\(/g)?.length).toBe(1);
  });
});
