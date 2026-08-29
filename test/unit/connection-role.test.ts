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
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PROBE_TIMEOUT_MS,
  canRotatePassword,
  fetchRoleProbe,
  roleFromDetailsProbe,
  roleFromProbe,
  teamCardKeys,
  type ConnectionRole,
} from "../../installer/src/connection-role";

describe("deriving a role from what a connect could learn", () => {
  it("calls a solo brain its owner's, whatever else is true", () => {
    // One user, so there is nobody else it could belong to. This is the whole
    // of today's behaviour for a solo install and must not move.
    expect(roleFromProbe({ team: false, role: "member", owner: false })).toBe("owner");
    expect(roleFromProbe({ team: false, role: null, owner: false })).toBe("owner");
  });

  it("takes the brain's own word for who owns it", () => {
    // GET /team/me's `owner` flag, which is true only for the identity holding
    // the deployment's AUTH_TOKEN. Ahead of `role`, because that identity's row
    // says "admin" and so does a promoted colleague's.
    expect(roleFromProbe({ team: true, role: "admin", owner: true })).toBe("owner");
    expect(roleFromProbe({ team: true, role: "member", owner: true })).toBe("owner");
  });

  it("does not treat a Cloudflare sign-in anywhere as evidence of owning THIS brain", () => {
    // The regression this signature exists to make unrepresentable.
    //
    // `signedInToCloudflare()` was `accounts.length > 0` — a module global set
    // by any successful `connect_cloudflare` in the window and never cleared.
    // The app's own primary connect path walks a member straight into it:
    // connectExistingScreen offers "Sign in to Cloudflare" as the primary
    // button, discoverScreen fills `accounts` with the member's own unrelated
    // account, discovery finds nothing (the brain is in the OWNER's account),
    // manual entry takes the invite token — and the derivation then announced
    // "You're signed in as this brain's owner-admin" to a member.
    //
    // There is no `hasCloudflareSession` input any more, so passing one is
    // inert: what decides is the brain's answer, and it says member.
    expect(
      roleFromProbe({ team: true, role: "member", owner: false, hasCloudflareSession: true } as never),
    ).toBe("member");
  });

  it("reads an admin's token as admin", () => {
    expect(roleFromProbe({ team: true, role: "admin", owner: false })).toBe("admin");
  });

  it("reads a member's token as member", () => {
    expect(roleFromProbe({ team: true, role: "member", owner: false })).toBe("member");
  });

  it("falls to the least-privileged answer when /team/me cannot be read", () => {
    // The failure path. `null` is what a Worker too old to serve /team/me, a
    // non-2xx, unparseable JSON, a timeout or a dropped connection all reduce
    // to, and all of them must produce the card that claims the least.
    expect(roleFromProbe({ team: true, role: null, owner: false })).toBe("member");
    // Anything unrecognised is treated the same way, not optimistically.
    for (const junk of ["owner", "", "ADMIN", "administrator"]) {
      expect(roleFromProbe({ team: true, role: junk, owner: false })).toBe("member");
    }
  });

  it("takes only a real `true` as ownership, never a truthy body value", () => {
    // A 200 whose shape is not the one expected. `owner: "yes"` is truthy and
    // would promote a member on a `if (probe.owner)`.
    for (const junk of ["yes", 1, {}, "true"]) {
      expect(roleFromProbe({ team: true, role: "member", owner: junk as never })).toBe("member");
    }
  });
});

describe("asking the brain who is holding this token", () => {
  afterEach(() => vi.useRealTimers());

  const okBody = (body: unknown) =>
    vi.fn().mockResolvedValue({ ok: true, json: async () => body });

  it("reads the role and the owner flag out of the profile", async () => {
    const f = okBody({ ok: true, profile: { role: "admin", owner: true } });
    await expect(fetchRoleProbe(f as never, "https://b.example.com", "sbt_x")).resolves.toEqual({
      role: "admin",
      owner: true,
    });
    // Bearer auth on the brain's own /team/me, address normalised.
    expect(f.mock.calls[0][0]).toBe("https://b.example.com/team/me");
    expect((f.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer sbt_x",
    );
  });

  it("does not double the slash on an address the user typed with one", async () => {
    const f = okBody({ ok: true, profile: { role: "member", owner: false } });
    await fetchRoleProbe(f as never, "https://b.example.com/", "sbt_x");
    expect(f.mock.calls[0][0]).toBe("https://b.example.com/team/me");
  });

  it("reduces every way of not getting an answer to the least-privileged one", async () => {
    const NONE = { role: null, owner: false };
    const cases: Record<string, unknown> = {
      "non-2xx": vi.fn().mockResolvedValue({ ok: false, json: async () => ({ profile: { role: "admin", owner: true } }) }),
      "network error": vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
      "malformed JSON on a 200": vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError("Unexpected token"); } }),
      "200 with an empty object": okBody({}),
      "200 with a null body": okBody(null),
      "200 with no profile role": okBody({ ok: true, profile: {} }),
      "200 with a numeric role": okBody({ ok: true, profile: { role: 42 } }),
      "a Worker too old for the owner flag": okBody({ ok: true, profile: { role: "member" } }),
    };
    for (const [name, f] of Object.entries(cases)) {
      const probe = await fetchRoleProbe(f as never, "https://b.example.com", "t");
      if (name === "a Worker too old for the owner flag") {
        // role survives; ownership does not get assumed.
        expect(probe, name).toEqual({ role: "member", owner: false });
      } else if (name === "200 with a numeric role") {
        expect(probe, name).toEqual(NONE);
      } else {
        expect(probe, name).toEqual(NONE);
      }
      expect(roleFromProbe({ team: true, ...probe }), name).toBe("member");
    }
  });

  it("answers on its own after the timeout when the request never lands", async () => {
    // The failure the least-privileged default could not reach. A brain behind
    // a black-holed TCP connection or a captive portal never settles the
    // promise, and `existingTeamScreen` awaits it before the next screen — so
    // without this the user sits on "Checking…" with no route forward but
    // quitting the app, which is exactly when the safe answer matters most.
    vi.useFakeTimers();
    let aborted = false;
    const hangs = vi.fn((_url: string, init: { signal: AbortSignal }) => {
      init.signal.addEventListener("abort", () => { aborted = true; });
      return new Promise<never>(() => {});
    });
    const probe = fetchRoleProbe(hangs as never, "https://b.example.com", "t");
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    await expect(probe).resolves.toEqual({ role: null, owner: false });
    // And the request is asked to stop rather than left running behind the
    // screen it no longer belongs to.
    expect(aborted, "the probe must abort the request it gave up on").toBe(true);
  });

  it("does not give up early on a brain that is merely slow", async () => {
    vi.useFakeTimers();
    let settle: (v: unknown) => void = () => {};
    const slow = vi.fn(() => new Promise((res) => { settle = res; }));
    const probe = fetchRoleProbe(slow as never, "https://b.example.com", "t");
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    settle({ ok: true, json: async () => ({ profile: { role: "admin", owner: true } }) });
    await expect(probe).resolves.toEqual({ role: "admin", owner: true });
  });
});

describe("the role the Connection details window renders", () => {
  it("is member for a member, which is what the window used to hardcode as owner", async () => {
    // MAJOR-2's whole content. `details.ts` held `const connectionRole =
    // "owner"`, so every member opening the tray window read "You're signed in
    // as this brain's owner-admin" and was offered a password change that
    // dead-ends at ErrorWrongCfAccount.
    expect(roleFromDetailsProbe(true, { role: "member", owner: false })).toBe("member");
    expect(teamCardKeys(roleFromDetailsProbe(true, { role: "member", owner: false })).body).toBe(
      "details.teamCardBodyMember",
    );
    expect(canRotatePassword(roleFromDetailsProbe(true, { role: "member", owner: false }))).toBe(
      false,
    );
  });

  it("keeps the owner's window exactly as it was", async () => {
    expect(roleFromDetailsProbe(true, { role: "admin", owner: true })).toBe("owner");
    expect(canRotatePassword(roleFromDetailsProbe(true, { role: "admin", owner: true }))).toBe(true);
    // And a solo install, which never probes at all.
    expect(roleFromDetailsProbe(false, null)).toBe("owner");
    expect(canRotatePassword(roleFromDetailsProbe(false, null))).toBe(true);
  });

  it("resolves an unanswerable probe to member, not to the old constant", async () => {
    for (const junk of [null, undefined, {}, { role: 7 }, { owner: "yes" }, "nope", 0]) {
      expect(roleFromDetailsProbe(true, junk), JSON.stringify(junk) ?? "undefined").toBe("member");
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

describe("the details window asks rather than assumes", () => {
  // Read from source because `details.ts` boots a Tauri window at import time
  // — it resolves `#app` at module scope — and cannot be loaded here. The same
  // technique as test/ui/confirm-sheet-callers.test.ts.
  const source = readFileSync(
    resolve(import.meta.dirname, "../../installer/src/details.ts"),
    "utf8",
  );

  it("holds no hardcoded role", () => {
    // The whole of MAJOR-2. `const connectionRole: ConnectionRole = "owner"`
    // made the gate below evaluate a constant, so the window's rendered output
    // was byte-identical to the version that had no roles in it at all — while
    // the diff looked like the window had been fixed.
    expect(source).not.toMatch(/connectionRole(: ConnectionRole)? = "owner"/);
    expect(source, "the role must come from the brain, through the Rust core").toMatch(
      /invoke<unknown>\("connection_role"\)/,
    );
    expect(source, "the role must be narrowed by the shared rules").toMatch(
      /roleFromDetailsProbe\(/,
    );
  });

  it("makes no request on a solo install", () => {
    // `details.teamMode` comes from the keychain. Guarding the invoke on it is
    // what keeps a one-person brain paying nothing for any of this — and
    // `roleFromDetailsProbe(false, …)` answers "owner" without asking anyway,
    // so the owner's window is unchanged in both content and cost.
    expect(source).toMatch(
      /details\.teamMode \? await invoke<unknown>\("connection_role"\)\.catch\(\(\) => null\) : null/,
    );
  });

  it("cannot fail into a claim", () => {
    // The `.catch` is the least-privilege guarantee at this boundary: an
    // unregistered command, a locked keychain or an unreachable brain must all
    // reach `null`, which `roleFromDetailsProbe` reads as "member".
    expect(source).toMatch(/invoke<unknown>\("connection_role"\)\.catch/);
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
