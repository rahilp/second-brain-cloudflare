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
  canUpdateWorker,
  fetchRoleProbe,
  legacyWorkerFromDetailsProbe,
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
      // The key was there and was read, so this is not a legacy Worker.
      legacyWorker: false,
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
    const NONE = { role: null, owner: false, legacyWorker: false };
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
        // role survives; ownership does not get assumed — and the ABSENCE of
        // the key is recorded, which is what distinguishes this brain from one
        // that could not be asked at all. It still derives to "member" below.
        expect(probe, name).toEqual({ role: "member", owner: false, legacyWorker: true });
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
    await expect(probe).resolves.toEqual({ role: null, owner: false, legacyWorker: false });
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
    await expect(probe).resolves.toEqual({ role: "admin", owner: true, legacyWorker: false });
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

describe("the setup flow's own derivation", () => {
  // `main.ts` resolves `#app` at module scope and cannot be imported here, so
  // these are read off the source — the technique `test/ui/dashboard-modules`
  // and `test/ui/confirm-sheet-callers` already use for exactly this reason.
  const source = readFileSync(
    resolve(import.meta.dirname, "../../installer/src/main.ts"),
    "utf8",
  );
  /**
   * One function's CODE, comments stripped.
   *
   * Stripped because these assertions are about what the derivation can
   * consult, and the comment explaining why it must not consult a Cloudflare
   * session names the thing it forbids — a scan over raw text would fail on its
   * own documentation, and the obvious fix for that is to delete the
   * explanation.
   */
  const bodyOf = (signature: string) => {
    const start = source.indexOf(signature);
    expect(start, `${signature} is not in main.ts any more`).toBeGreaterThan(-1);
    const end = source.indexOf("\n}", start);
    return source
      .slice(start, end)
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
  };

  it("passes the brain nothing local as evidence of ownership", () => {
    // MAJOR-1 at the call site rather than in the rule. `roleFromProbe` no
    // longer HAS a `hasCloudflareSession` input, so re-adding one would be
    // inert — but a future edit could reach for `signedInToCloudflare()` again,
    // and it is still in this file for the rotation screens, which is the only
    // place it means anything. What matters is that the role derivation cannot
    // see it.
    const derive = bodyOf("async function deriveConnectionRole(");
    expect(derive, "the role derivation must not consult a Cloudflare session").not.toMatch(
      /signedInToCloudflare|hasCloudflareSession|accounts\.length/,
    );
    // And it asks through the bounded helper rather than a bare fetch.
    expect(derive).toMatch(/fetchRoleProbe\(/);
    expect(derive, "no unbounded fetch on the connect path").not.toMatch(/fetch\(`/);
  });

  it("sets the mode on every branch that derives a role", () => {
    // The derivation on the already-recorded-team-brain branch was a dead
    // store: `detailsScreen` renders the team card only under
    // `teamMode ? [teamCard(connectionRole)] : []`, and that branch returned
    // before anything set `teamMode`. A returning member — the exact person the
    // branch exists for — reached the end of setup on the solo "all set" copy
    // with no card at all, so the corrected wording reached one path only.
    const screen = bodyOf("async function existingTeamScreen(");
    const derivations = [...screen.matchAll(/connectionRole = await deriveConnectionRole\(/g)];
    expect(derivations.length, "both team branches derive").toBe(2);
    for (const match of derivations) {
      const before = screen.slice(Math.max(0, match.index! - 400), match.index!);
      expect(
        before,
        "a derived role that no screen reads is a request paid for and thrown away",
      ).toMatch(/teamMode = true;\s*$/);
    }
  });

  it("bounds the other request on the same screen", () => {
    // /health had the same property as the probe and this screen awaits it too,
    // so a black-holed connection stalled here instead of falling through to
    // the audience question.
    const health = bodyOf("async function brainReportsMembers(");
    expect(health).toMatch(/AbortController/);
    expect(health).toMatch(/signal: controller\.signal/);
    expect(health).toMatch(/PROBE_TIMEOUT_MS/);
    expect(health, "the timer must be cleared on the answered path too").toMatch(/clearTimeout/);
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

  it("offers the Worker update as a button only to the owner", () => {
    // A member's app self-updates from GitHub Releases with no Cloudflare
    // involvement, so their BUNDLED Worker version races ahead of the team's
    // DEPLOYED one purely by staying current — and the update card then
    // offered them a button that dead-ends at ErrorWrongCfAccount. The card
    // stays: a member seeing features they do not have deserves the
    // explanation. The button does not.
    expect(source).toMatch(
      /updateCard\(update\.availableVersion, canUpdateWorker\(connectionRole, legacyWorker\), legacyWorker\)/,
    );
    // And the non-owner branch must render prose, not a disabled button.
    const card = source.slice(source.indexOf("function updateCard("));
    expect(card.slice(0, card.indexOf("\n}"))).toMatch(/details\.updateDescOther/);
  });

  it("cannot fail into a claim", () => {
    // The `.catch` is the least-privilege guarantee at this boundary: an
    // unregistered command, a locked keychain or an unreachable brain must all
    // reach `null`, which `roleFromDetailsProbe` reads as "member".
    expect(source).toMatch(/invoke<unknown>\("connection_role"\)\.catch/);
  });
});

describe("who may update the Worker", () => {
  it("is the owner and nobody else — not even a team admin", () => {
    // The update redeploys the Worker, which happens inside the Cloudflare
    // account it lives in. A promoted team admin has no more access to that
    // account than a member does, so `role === "admin"` must not unlock it:
    // `start_worker_update` resolves the account by matching the brain's
    // workers.dev subdomain and answers ErrorWrongCfAccount to anyone else.
    expect(canUpdateWorker("owner")).toBe(true);
    expect(canUpdateWorker("admin")).toBe(false);
    expect(canUpdateWorker("member")).toBe(false);
  });

  it("is the same answer as the password change, for the same reason", () => {
    // Both need a Cloudflare session for the account the Worker is deployed
    // into. If these two ever disagree, one of them is wrong.
    for (const role of ["owner", "admin", "member"] as ConnectionRole[]) {
      expect(canUpdateWorker(role)).toBe(canRotatePassword(role));
    }
  });
});

/**
 * The deadlock the gate above created, and the third state that breaks it.
 *
 * The desktop app self-updates from GitHub Releases with no Cloudflare
 * involvement, and the deployed Worker can only be updated FROM the app — so
 * the app is always ahead of the deployment and never behind it. On a brain
 * whose deployed Worker predates the `owner` key, that composed into a lock
 * with the key inside it: `/team/me` answers without `owner` → the role falls
 * to the least-privileged "member" → least privilege suppresses the
 * Worker-update route → and that route is the only thing that would deploy the
 * Worker that adds the key. The escape hatch was gated on a capability only the
 * version you escape TO reports.
 *
 * The fix is to stop collapsing two different facts into one answer. "Answered,
 * but carried no `owner` key" is a POSITIVELY IDENTIFIED legacy Worker. "Could
 * not be asked" is nothing at all. Only the first gets the allowance, only on
 * the update route, and it self-heals after exactly one successful update.
 *
 * This is not a weakening. `start_worker_update` resolves the hosting account
 * by matching the brain's workers.dev subdomain against the signed-in
 * Cloudflare session, so a member who tries it gets ErrorWrongCfAccount and
 * deploys nothing — the real gate was never the role.
 */
describe("a Worker deployed before /team/me carried `owner`", () => {
  const okBody = (body: unknown) =>
    vi.fn().mockResolvedValue({ ok: true, json: async () => body });
  /** The body src/routes/admin.ts sent before the owner flag existed. */
  const LEGACY = { ok: true, profile: { userId: "usr-1", role: "admin" } };
  const BRAIN = "https://b.example.com";

  it("lets whoever holds the token reach the update that is the only way out", async () => {
    // Both rows a legacy /team/me can return, because the app cannot tell them
    // apart and that is precisely the state being handled. The owner's own row
    // says "admin" — src/lib/tenancy.ts hashes AUTH_TOKEN into a users row with
    // role 'admin' — and a colleague's says "member". Without `owner`, neither
    // reaches "owner", and neither could reach the update.
    for (const [who, profile] of [
      ["the owner's own row", LEGACY.profile],
      ["a member's row", { userId: "usr-2", role: "member" }],
    ] as const) {
      const probe = await fetchRoleProbe(
        okBody({ ok: true, profile }) as never,
        BRAIN,
        "sbt_x",
      );
      // The ROLE is untouched and still claims no ownership. Nothing here
      // promotes anybody, and nothing is stored: this is re-derived on every
      // entry, so it stops being true the moment the Worker is updated.
      expect(roleFromProbe({ team: true, ...probe }), who).not.toBe("owner");
      // But the route out is reachable. Both of these were false before, and a
      // brain in this state could never be updated by the only thing that
      // updates it.
      expect(probe.legacyWorker, `${who}: an answer with no owner key is legacy`).toBe(true);
      expect(
        canUpdateWorker(roleFromProbe({ team: true, ...probe }), probe.legacyWorker),
        `${who}: a legacy Worker must be reachable by the update`,
      ).toBe(true);
    }
  });

  it("does not extend the allowance to a probe that got no usable answer", async () => {
    // State 3, unchanged and still least privilege. `owner: "yes"` is the one
    // that matters: the key IS there, it is simply not a boolean, so the Worker
    // is NOT positively identified as legacy and claims nothing.
    const cases: Record<string, unknown> = {
      "non-2xx": vi.fn().mockResolvedValue({ ok: false, json: async () => LEGACY }),
      "network error": vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
      "malformed JSON on a 200": vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }),
      "a 200 whose body is not an object": okBody("not json at all"),
      "a 200 with a null body": okBody(null),
      "a 200 with an empty object": okBody({}),
      "a profile with no role either": okBody({ ok: true, profile: {} }),
      "a profile whose role is not a string": okBody({ ok: true, profile: { role: 42 } }),
      "an owner key that is not a boolean": okBody({
        ok: true,
        profile: { role: "admin", owner: "yes" },
      }),
      "a profile that is not an object": okBody({ ok: true, profile: "admin" }),
    };
    for (const [name, f] of Object.entries(cases)) {
      const probe = await fetchRoleProbe(f as never, BRAIN, "t");
      expect(probe.legacyWorker, `${name} must not pass as a legacy Worker`).toBe(false);
      expect(
        canUpdateWorker(roleFromProbe({ team: true, ...probe }), probe.legacyWorker),
        `${name} must still suppress the update route`,
      ).toBe(false);
    }
  });

  it("leaves a Worker that does answer with `owner` deciding for itself", async () => {
    // State 1, unchanged: the brain is the authority whenever it can be.
    const owner = await fetchRoleProbe(
      okBody({ ok: true, profile: { role: "admin", owner: true } }) as never,
      BRAIN,
      "t",
    );
    expect(owner.legacyWorker).toBe(false);
    expect(canUpdateWorker(roleFromProbe({ team: true, ...owner }), owner.legacyWorker)).toBe(true);

    // And a member on a CURRENT Worker is still refused — the allowance is for
    // the absent key, not for `owner: false`.
    const member = await fetchRoleProbe(
      okBody({ ok: true, profile: { role: "member", owner: false } }) as never,
      BRAIN,
      "t",
    );
    expect(member.legacyWorker).toBe(false);
    expect(canUpdateWorker(roleFromProbe({ team: true, ...member }), member.legacyWorker)).toBe(
      false,
    );
  });

  it("does not hand back the password card with it", async () => {
    // THE ASYMMETRY, asserted rather than described. Only the escape hatch gets
    // the legacy allowance: there is no deadlock on rotation — nobody needs to
    // change a password to update a Worker — and one successful update restores
    // the card by making the brain answerable. A member on a legacy Worker is
    // indistinguishable from its owner here, so the card that CAN be withheld
    // safely is withheld.
    for (const profile of [LEGACY.profile, { userId: "usr-2", role: "member" }]) {
      const probe = await fetchRoleProbe(okBody({ ok: true, profile }) as never, BRAIN, "t");
      const role = roleFromProbe({ team: true, ...probe });
      expect(probe.legacyWorker).toBe(true);
      expect(canRotatePassword(role), "the legacy allowance must not reach rotation").toBe(false);
    }
    // Said structurally too: `canRotatePassword` takes a role and nothing else,
    // so there is no second argument for a later reader to thread through it
    // while "simplifying" the two rules into one.
    const rules = readFileSync(
      resolve(import.meta.dirname, "../../installer/src/connection-role.ts"),
      "utf8",
    );
    const rotate = rules.slice(rules.indexOf("export function canRotatePassword("));
    expect(
      rotate.slice(0, rotate.indexOf("\n}")),
      "canRotatePassword must not read the legacy flag",
    ).not.toMatch(/legacy/i);
  });

  it("costs a solo install nothing and asks it nothing", async () => {
    // Both branches. A one-person brain short-circuits before any request, and
    // the details window guards the invoke on the same fact.
    const f = vi.fn();
    expect(roleFromProbe({ team: false, role: null, owner: false })).toBe("owner");
    expect(canUpdateWorker(roleFromProbe({ team: false, role: null, owner: false }))).toBe(true);
    expect(legacyWorkerFromDetailsProbe(null)).toBe(false);
    expect(canUpdateWorker(roleFromDetailsProbe(false, null), legacyWorkerFromDetailsProbe(null))).toBe(
      true,
    );
    expect(f, "a solo install must make no request at all").not.toHaveBeenCalled();
  });

  it("survives the trip through the Rust core to the details window", () => {
    // The window has no token, so its probe is whatever `connection_role`
    // serialised. If the flag does not survive that hop the fix reaches the
    // setup flow and leaves the tray window — the surface an owner actually
    // opens to click Update — still deadlocked.
    expect(legacyWorkerFromDetailsProbe({ role: "admin", legacyWorker: true })).toBe(true);
    expect(legacyWorkerFromDetailsProbe({ role: "admin", owner: true })).toBe(false);
    expect(legacyWorkerFromDetailsProbe({ role: "member", owner: false })).toBe(false);
    // Anything unusable is state 3, exactly as a failed invoke is.
    for (const junk of [null, undefined, {}, "nope", 0, { legacyWorker: "yes" }, { legacyWorker: 1 }]) {
      expect(legacyWorkerFromDetailsProbe(junk), JSON.stringify(junk) ?? "undefined").toBe(false);
    }
    // And the role it comes back with claims no ownership either way: the
    // legacy flag opens one button, it does not promote anybody.
    expect(roleFromDetailsProbe(true, { role: "admin", legacyWorker: true })).toBe("admin");
    expect(roleFromDetailsProbe(true, { role: "member", legacyWorker: true })).toBe("member");

    const source = readFileSync(
      resolve(import.meta.dirname, "../../installer/src/details.ts"),
      "utf8",
    );
    expect(source, "the window must read the flag off the same probe it derives the role from")
      .toMatch(/legacyWorkerFromDetailsProbe\(/);
    expect(source, "and hand it to the update gate").toMatch(
      /canUpdateWorker\(connectionRole, legacyWorker\)/,
    );
    // One probe, not two: a second `connection_role` invoke would be a second
    // round trip and two chances to disagree with itself.
    expect(source.match(/invoke<unknown>\("connection_role"\)/g)?.length).toBe(1);
  });

  it("says why the button is there rather than claiming to know who is reading", () => {
    // The offer is honest or it is a guess printed as a fact. A legacy owner is
    // shown the button because the app CANNOT TELL who they are, and the owner's
    // own copy ("Update to get the latest improvements") would quietly assert
    // the opposite. The catalogs are checked in
    // test/unit/installer-i18n-parity.test.ts; what is checked here is that the
    // branch reaching for the honest string is the unconfirmed one.
    const source = readFileSync(
      resolve(import.meta.dirname, "../../installer/src/details.ts"),
      "utf8",
    );
    const card = source.slice(source.indexOf("function updateCard("));
    const body = card.slice(0, card.indexOf("\n}"));
    expect(body, "the legacy copy must be selected by the unconfirmed flag").toMatch(
      /ownerUnconfirmed \? "details\.updateDescLegacy" : "details\.updateDesc"/,
    );
    // And it is still a button, not prose: the whole point is that this person
    // can act. The third string stays where it was, for someone who cannot.
    expect(body).toMatch(/details\.updateDescOther/);
    expect(body).toMatch(/begin_worker_update/);
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
