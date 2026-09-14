/**
 * #347's connected-row "move already-synced memories" action: DOM-level
 * gating and drain behaviour, in the vm harness integration-layer-control.test.ts
 * already established for this file.
 *
 * Contract pinned here for the implementer (the plan does not name these —
 * see the test-author's final report for the complete list of choices):
 *   - GET /integrations gains a top-level `owner: boolean` field, mirroring
 *     the existing `admin` field, answering "is the caller the tenant owner".
 *     `loadIntegrations()` is expected to set a module-level `integrationsOwner`
 *     from it, the same way it already sets `integrationsAdmin` from `admin`.
 *   - The move control is gated on `TEAM_MODE && integrationsAdmin && integrationsOwner`
 *     — strictly narrower than the #346 layer control's `TEAM_MODE && integrationsAdmin`,
 *     because only the owner may run a move (locked decision 1). This is why
 *     it must render nothing extra on the two solo-brain fixtures pinned in
 *     integration-provenance.test.ts: those already run with TEAM_MODE false.
 *   - Button id `move-${p}`, calling `confirmMoveIntegrationMemories(provider, btn)`
 *     — NOT `moveIntegrationMemories` directly. This was corrected after the
 *     first round shipped the operation with no confirmation gate at all
 *     (one click moved every synced memory into the shared team layer): the
 *     button's onclick must go through a confirmation step first, per locked
 *     decision 11 (`openDangerConfirm` is the gate) and the `confirmBulkLayerMove`
 *     precedent in public/js/recent.js, which gates the same action at
 *     smaller scale the same way.
 *   - `confirmMoveIntegrationMemories(provider, btn)` reads the connection's
 *     `itemCount` and `mirrorWorkspace` off `integrationsInfo` (the same
 *     module-level array `disconnectIntegration` already reads), opens
 *     `openDangerConfirm` with a body stating the count, the target layer, and
 *     that the team will be able to read the memories there once shared, and
 *     only on confirm calls `moveIntegrationMemories(provider, btn)` — the
 *     gate and the operation are two functions, per locked decision 11
 *     ("openDangerConfirm is the confirmation gate only, not the operation's
 *     home"), so the drain can keep running after the sheet closes, the same
 *     way `confirmBulkLayerMove`'s own drain outlives its sheet.
 *   - A dedicated progress/result element `id="move-note-${p}"`, distinct from
 *     the #346/sync `note-${p}` element (trap 11 in the UI contract: two
 *     drains writing the same node would fight over it).
 *   - `moveIntegrationMemories` (the operation, unchanged by the confirmation
 *     fix — still callable directly, which is how this file's drain and
 *     partial-failure tests exercise it) drives `runMoveLoop` (see
 *     move-loop.test.ts) and, on a mid-drain failure, writes the
 *     `upkeep.restore*`-style "stopped partway, safe to resume" copy into
 *     `move-note-${p}` rather than the plain "failed" `syncIntegration` shows
 *     today, and never leaves the button in a success-styled state when the
 *     drain did not finish.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function makeEl() {
  const classes = new Set<string>();
  return {
    id: "",
    checked: false,
    disabled: false,
    value: "",
    textContent: "",
    innerHTML: "",
    style: {} as Record<string, string>,
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
    setAttribute() {},
    appendChild() {},
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    dataset: {} as Record<string, string>,
  };
}

function load(teamMode: boolean, admin: boolean, owner: boolean, fetchImpl?: (url: string, init?: any) => Promise<any>) {
  const els = new Map<string, any>();
  const calls: { url: string; init?: any }[] = [];
  const ctx: any = {
    console,
    calls,
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) {
          const el = makeEl();
          el.id = id;
          els.set(id, el);
        }
        return els.get(id);
      },
      createElement: () => makeEl(),
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { style: {}, appendChild(el: any) { if (el.id) els.set(el.id, el); } },
    },
    confirm: () => { throw new Error("confirm() must not be used"); },
    alert: () => { throw new Error("alert() must not be used"); },
    setTimeout: (fn: () => void) => { fn(); return 0; },
    clearTimeout: () => {},
    refreshAll: () => {},
    fetch: fetchImpl ?? (async (url: string, init?: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }),
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of [
    "public/utils.js",
    "public/js/state.js",
    "public/js/toast.js",
    "public/js/confirm-sheet.js",
    "public/js/integrations.js",
  ]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  vm.runInContext(
    `WORKER_URL = "https://example.test"; AUTH_TOKEN = "tok"; var TEAM_MODE = ${teamMode}; integrationsAdmin = ${admin}; integrationsOwner = ${owner};`,
    ctx,
  );
  // `integrationsInfo` is the same module-level array disconnectIntegration
  // already reads its `info` from (test/ui/disconnect-sheet.test.ts's own
  // harness) — confirmMoveIntegrationMemories needs it for the confirmation
  // body's facts (item count, target layer).
  ctx.__setIntegrations = (list: any[]) => {
    ctx.__list = list;
    vm.runInContext("integrationsInfo = globalThis.__list", ctx);
  };
  ctx.__els = els;
  return ctx;
}

const BASE = {
  provider: "notion",
  name: "Notion",
  connected: true,
  workspaceName: "Acme Notion",
  itemCount: 12,
  lastSyncedAt: 1771999999000,
};

describe("connected-row move-already-synced action", () => {
  // One test, not four: gating "off" is trivially true before the control
  // exists at all, so a standalone absence-only test would pass today for no
  // reason connected to the feature. Asserting the positive case FIRST is
  // what makes this fail now for the right reason (no control rendered
  // anywhere yet); the negative cases alongside it are the regression guard
  // that stays meaningful once the control exists.
  it("renders the move control only for the owner admin on a team brain, and nowhere else", () => {
    const ownerOnTeam = load(true, true, true);
    expect(ownerOnTeam.renderIntegrationCard({ ...BASE, mirrorWorkspace: "company" })).toContain(`id="move-notion"`);

    const nonOwnerAdmin = load(true, true, false);
    expect(nonOwnerAdmin.renderIntegrationCard({ ...BASE, mirrorWorkspace: "company" })).not.toContain(`id="move-notion"`);

    const plainMember = load(true, false, true);
    expect(plainMember.renderIntegrationCard({ ...BASE, mirrorWorkspace: "company" })).not.toContain(`id="move-notion"`);

    // Matches the pinned solo-brain fixtures in integration-provenance.test.ts.
    const soloBrain = load(false, true, true);
    expect(soloBrain.renderIntegrationCard({ ...BASE, mirrorWorkspace: "personal" })).not.toContain(`id="move-notion"`);
  });

  it("the move control's handler is a real function that gates on confirmation, not the operation itself", () => {
    const ctx = load(true, true, true, async (url: string) => {
      // If clicking the button reaches the network at all before a
      // confirmation, that is exactly the defect this test exists to catch —
      // record it as a call rather than answering it, so the assertion below
      // can tell a bypassed gate apart from a slow one.
      ctx.calls.push({ url });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    ctx.__setIntegrations([{ provider: "notion", name: "Notion", itemCount: 12, mirrorWorkspace: "company" }]);
    const html = ctx.renderIntegrationCard({ ...BASE, mirrorWorkspace: "company" });
    const m = html.match(/id="move-notion"[^>]*onclick="([a-zA-Z_$][\w$]*)\(/);
    expect(m, 'expected an onclick="someHandler(...)" attribute on the move control').not.toBeNull();
    const handlerName = (m as RegExpMatchArray)[1];
    expect(typeof ctx[handlerName]).toBe("function");
    // The pinned name itself: the button must not point straight at the
    // operation. See this file's header comment for why.
    expect(handlerName).toBe("confirmMoveIntegrationMemories");

    const btn = ctx.document.getElementById("move-notion");
    ctx[handlerName]("notion", btn);
    expect(ctx.calls.length, "the handler made a request before the user confirmed anything").toBe(0);
  });

  describe("confirmation gate (locked decision 11)", () => {
    function loadWithInfo(fetchImpl?: (url: string, init?: any) => Promise<any>, itemCount = 12, mirrorWorkspace: "company" | "personal" = "company") {
      const ctx = load(true, true, true, fetchImpl);
      ctx.__setIntegrations([{ provider: "notion", name: "Notion", itemCount, mirrorWorkspace }]);
      return ctx;
    }

    it("asks before moving anything, stating how many memories, which layer, and that the team will be able to read them", () => {
      const ctx = loadWithInfo();
      const btn = ctx.document.getElementById("move-notion");

      ctx.confirmMoveIntegrationMemories("notion", btn);

      expect(ctx.__els.get("confirm-dialog").classList.contains("open")).toBe(true);
      const body = ctx.__els.get("confirm-body").textContent as string;
      // The facts, not the wording: how many, which layer, and that sharing
      // means the team can read them — the exact confusion a silent one-click
      // move would cause.
      expect(body).toMatch(/12/);
      expect(body).toMatch(/company|shared team layer/i);
      expect(body).toMatch(/team|everyone|colleague/i);
      expect(body).toMatch(/read|see|access|visible/i);
      // Nothing has happened yet — the sheet is the question, not the answer.
      expect(ctx.calls.length).toBe(0);
    });

    it("names the personal layer when that is the connection's current target, not a hardcoded 'company'", () => {
      const ctx = loadWithInfo(undefined, 5, "personal");
      const btn = ctx.document.getElementById("move-notion");

      ctx.confirmMoveIntegrationMemories("notion", btn);

      const body = ctx.__els.get("confirm-body").textContent as string;
      expect(body).toMatch(/5/);
      expect(body).toMatch(/personal/i);
    });

    it("makes no request at all if the confirmation is dismissed", () => {
      const ctx = loadWithInfo();
      const btn = ctx.document.getElementById("move-notion");

      ctx.confirmMoveIntegrationMemories("notion", btn);
      expect(ctx.__els.get("confirm-dialog").classList.contains("open")).toBe(true);
      ctx.closeConfirm();

      expect(ctx.__els.get("confirm-dialog").classList.contains("open")).toBe(false);
      expect(ctx.calls.length).toBe(0);
    });

    it("runs the drain once the user confirms", async () => {
      const ctx = loadWithInfo(async (url: string, init?: any) => {
        ctx.calls.push({ url, init });
        if (url.includes("/integrations/notion/move")) {
          return { ok: true, status: 200, json: async () => ({ ok: true, moved: 12, alreadyThere: 0, missing: 0, refused: 0, remaining: 0, cursor: null }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
      });
      const btn = ctx.document.getElementById("move-notion");

      ctx.confirmMoveIntegrationMemories("notion", btn);
      expect(ctx.calls.length).toBe(0); // still just the question
      await ctx.runConfirmAction();

      expect(ctx.calls.some((c: any) => c.url.includes("/integrations/notion/move"))).toBe(true);
    });
  });

  it("drains a multi-page move to completion and shows a completed, non-partial result", async () => {
    let call = 0;
    const ctx = load(true, true, true, async (url: string) => {
      if (url.includes("/integrations/notion/move")) {
        call++;
        if (call === 1) return { ok: true, status: 200, json: async () => ({ ok: true, moved: 10, alreadyThere: 0, missing: 0, refused: 0, remaining: 2, cursor: "10" }) };
        return { ok: true, status: 200, json: async () => ({ ok: true, moved: 2, alreadyThere: 0, missing: 0, refused: 0, remaining: 0, cursor: null }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
    });
    const btn = ctx.document.getElementById("move-notion");

    await ctx.moveIntegrationMemories("notion", btn);

    expect(call).toBe(2);
    const note = ctx.document.getElementById("move-note-notion");
    // Must not still read a "stopped partway" message once fully drained.
    expect(note.textContent.toLowerCase()).not.toContain("partway");
  });

  it("says plainly that it stopped partway and that resuming is safe, on a mid-drain failure — not a bare 'failed'", async () => {
    let call = 0;
    const ctx = load(true, true, true, async (url: string) => {
      if (url.includes("/integrations/notion/move")) {
        call++;
        if (call === 1) return { ok: true, status: 200, json: async () => ({ ok: true, moved: 10, alreadyThere: 0, missing: 0, refused: 0, remaining: 5, cursor: "10" }) };
        return { ok: false, status: 500, json: async () => ({ ok: false, error: "boom" }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
    });
    const btn = ctx.document.getElementById("move-notion");

    await ctx.moveIntegrationMemories("notion", btn);

    const note = ctx.document.getElementById("move-note-notion");
    // The honesty requirement (locked decision 10): say it stopped partway
    // and that resuming is safe, following upkeep.restore*'s convention —
    // not syncIntegration's bare "Sync failed" with no count and no
    // reassurance.
    expect(note.textContent).toMatch(/partway|stopped/i);
    expect(note.textContent).toMatch(/resum|safe|try again/i);
    // 10 already moved must not be silently dropped from the message.
    expect(note.textContent).toMatch(/10/);
    // And the button must not end in the success-styled state — this is the
    // exact silent-success trap syncIntegration and runVectorize both fall
    // into today (UI contract §2, §5, §9 trap 10).
    expect(btn.innerHTML).not.toMatch(/ti-check/);
  });

  it("does not claim completion when the drain fails on the very first call", async () => {
    const ctx = load(true, true, true, async (url: string) => {
      if (url.includes("/integrations/notion/move")) {
        return { ok: false, status: 403, json: async () => ({ ok: false, error: "Only the owner may move these memories" }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
    });
    const btn = ctx.document.getElementById("move-notion");

    await ctx.moveIntegrationMemories("notion", btn);

    expect(btn.innerHTML).not.toMatch(/ti-check/);
    const note = ctx.document.getElementById("move-note-notion");
    expect(note.textContent.length).toBeGreaterThan(0);
  });

  // ─── Adversarial-review findings ────────────────────────────────────────

  it("a 403 refusal is surfaced with its reason and is NOT presented as something safe to retry — retrying can never fix a permission refusal", async () => {
    const ctx = load(true, true, true, async (url: string) => {
      if (url.includes("/integrations/notion/move")) {
        return { ok: false, status: 403, json: async () => ({ ok: false, error: "Only the brain's owner can move these memories" }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
    });
    const btn = ctx.document.getElementById("move-notion");

    await ctx.moveIntegrationMemories("notion", btn);

    const note = ctx.document.getElementById("move-note-notion");
    expect(note.textContent).toMatch(/owner/i); // the real reason, not a generic failure
    expect(note.textContent).not.toMatch(/safe to try again|resum/i);
  });

  it("a 403 partway through a drain (some pages already moved) still does not offer 'safe to try again' — the reason is a refusal, not a transient failure", async () => {
    let call = 0;
    const ctx = load(true, true, true, async (url: string) => {
      if (url.includes("/integrations/notion/move")) {
        call++;
        if (call === 1) return { ok: true, status: 200, json: async () => ({ ok: true, moved: 10, alreadyThere: 0, missing: 0, refused: 0, remaining: 5, cursor: "10" }) };
        return { ok: false, status: 403, json: async () => ({ ok: false, error: "The connection's layer changed — only the owner may resume this move" }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
    });
    const btn = ctx.document.getElementById("move-notion");

    await ctx.moveIntegrationMemories("notion", btn);

    const note = ctx.document.getElementById("move-note-notion");
    expect(note.textContent).not.toMatch(/safe to try again|resum/i);
  });

  it("presentation: does not render success when moved is 0 and missing is greater than 0", async () => {
    const ctx = load(true, true, true, async (url: string) => {
      if (url.includes("/integrations/notion/move")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, moved: 0, alreadyThere: 0, missing: 8, refused: 0, remaining: 0, cursor: null }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
    });
    const btn = ctx.document.getElementById("move-notion");

    await ctx.moveIntegrationMemories("notion", btn);

    expect(btn.innerHTML, "0 moved with 8 stale pointers must not read as a checkmarked success").not.toMatch(/ti-check/);
  });

  it("presentation: the in-progress count reflects actual moves, not missing pointers counted as if they moved", async () => {
    // Snapshot the note's text right as page 2 is requested — that is
    // exactly between page 1's onProgress write and the drain's completion
    // summary overwriting it, the only window this figure is observable in.
    let midDrainNote = "";
    let call = 0;
    const ctx = load(true, true, true, async (url: string) => {
      if (url.includes("/integrations/notion/move")) {
        call++;
        if (call === 2) midDrainNote = ctx.document.getElementById("move-note-notion").textContent;
        if (call === 1) {
          // Page 1: 2 really moved, 8 merely missing (stale pointers). The
          // onProgress figure must read "2", not "10".
          return { ok: true, status: 200, json: async () => ({ ok: true, moved: 2, alreadyThere: 0, missing: 8, refused: 0, remaining: 2, cursor: "10" }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, moved: 2, alreadyThere: 0, missing: 0, refused: 0, remaining: 0, cursor: null }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
    });
    const btn = ctx.document.getElementById("move-notion");

    await ctx.moveIntegrationMemories("notion", btn);

    expect(midDrainNote).not.toMatch(/\b10\b/);
    expect(midDrainNote).toMatch(/\b2\b/);
  });

  describe("the confirmed layer binds the drain (locked decision on server truth, #347 review item 4)", () => {
    it("sends the layer confirmed at dialog-open time on every page of the drain, not a value re-read live per page", async () => {
      const seenBodies: any[] = [];
      const ctx = loadWithInfoHelper(async (url: string, init?: any) => {
        if (url.includes("/integrations/notion/move")) {
          seenBodies.push(JSON.parse(init.body));
          const n = seenBodies.length;
          if (n === 1) return { ok: true, status: 200, json: async () => ({ ok: true, moved: 10, alreadyThere: 0, missing: 0, refused: 0, remaining: 2, cursor: "10" }) };
          return { ok: true, status: 200, json: async () => ({ ok: true, moved: 2, alreadyThere: 0, missing: 0, refused: 0, remaining: 0, cursor: null }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
      }, 12, "company");
      const btn = ctx.document.getElementById("move-notion");

      ctx.confirmMoveIntegrationMemories("notion", btn);
      await ctx.runConfirmAction();

      expect(seenBodies.length).toBe(2);
      // Pinned request field (see this file's report): the client threads the
      // layer it showed the user at confirm time on every page.
      for (const body of seenBodies) expect(body.expectedTarget).toBe("company");
    });

    it("treats a 409 (the server's layer changed since confirmation) as a hard stop requiring re-confirmation, not a resumable failure", async () => {
      let call = 0;
      const ctx = loadWithInfoHelper(async (url: string) => {
        if (url.includes("/integrations/notion/move")) {
          call++;
          if (call === 1) return { ok: true, status: 200, json: async () => ({ ok: true, moved: 10, alreadyThere: 0, missing: 0, refused: 0, remaining: 2, cursor: "10" }) };
          return { ok: false, status: 409, json: async () => ({ ok: false, error: "The layer changed since you confirmed this move — reload and try again." }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
      }, 12, "company");
      const btn = ctx.document.getElementById("move-notion");

      ctx.confirmMoveIntegrationMemories("notion", btn);
      await ctx.runConfirmAction();

      const note = ctx.document.getElementById("move-note-notion");
      expect(note.textContent).toMatch(/layer/i);
      // Distinct from the ordinary "stopped partway, safe to resume" copy:
      // blindly resuming here would move into a layer the user never agreed
      // to, so the honest copy asks for a fresh confirmation instead.
      expect(note.textContent).not.toMatch(/safe to try again|safe to resume/i);
    });
  });

  // ─── vectorFailures reaches a human (#347, third round on this defect) ───
  //
  // The server has always computed vectorFailures; nothing on the client
  // reads it. An operator who sees "10 moved" has no reason to run anything
  // again, so the entries repair-eligible via moveEntry's no_change branch
  // never actually get repaired, and stay unfindable by the team in their
  // new layer indefinitely.

  describe("vectorFailures reaches the operator", () => {
    it("when the drain finishes but a genuinely broken index leaves entries unrepaired, states the consequence in plain terms — not a raw count", async () => {
      // vectorFailures never decreases across passes (5, then 5 again) — the
      // no-progress condition pinned in move-loop.test.ts stops the drain
      // rather than retrying forever, and the leftover count must reach the
      // operator honestly.
      let call = 0;
      const ctx = load(true, true, true, async (url: string) => {
        if (url.includes("/integrations/notion/move")) {
          call++;
          const isRepairPass = call > 1;
          return {
            ok: true, status: 200,
            json: async () => ({
              ok: true,
              moved: isRepairPass ? 0 : 10,
              alreadyThere: isRepairPass ? 10 : 0,
              missing: 0, refused: 0,
              vectorFailures: 5,
              remaining: 0, cursor: null,
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
      });
      const btn = ctx.document.getElementById("move-notion");

      await ctx.moveIntegrationMemories("notion", btn);

      const note = ctx.document.getElementById("move-note-notion");
      const text = note.textContent as string;
      // The facts a person can act on, not the field name:
      expect(text, "must not just print the jargon count").not.toMatch(/vector ?fail/i);
      expect(text, "how many are affected").toMatch(/\b5\b/);
      expect(text, "reassures the move itself happened").toMatch(/moved/i);
      expect(text, "states they cannot be found/searched yet in the new spot").toMatch(/search|find/i);
      expect(text, "gives an action to take").toMatch(/try again|run.*again|retry|move again/i);
      // Not the success checkmark — something is still genuinely wrong.
      expect(btn.innerHTML).not.toMatch(/ti-check/);
    });

    it("says nothing extra about vector failures when the repair pass fully succeeds", async () => {
      let call = 0;
      const ctx = load(true, true, true, async (url: string) => {
        if (url.includes("/integrations/notion/move")) {
          call++;
          const isRepairPass = call > 1;
          return {
            ok: true, status: 200,
            json: async () => ({
              ok: true,
              moved: isRepairPass ? 0 : 10,
              alreadyThere: isRepairPass ? 10 : 0,
              missing: 0, refused: 0,
              vectorFailures: isRepairPass ? 0 : 3, // repaired on the second pass
              remaining: 0, cursor: null,
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
      });
      const btn = ctx.document.getElementById("move-notion");

      await ctx.moveIntegrationMemories("notion", btn);

      expect(call, "expected a repair pass to run automatically").toBe(2);
      const note = ctx.document.getElementById("move-note-notion");
      expect(note.textContent).not.toMatch(/search|find|try again/i); // nothing left to warn about
      expect(btn.innerHTML).toMatch(/ti-check/); // a clean, fully-repaired success
    });
  });

  // ─── `errored` reaching the operator (#347, the fourth round) ────────────
  //
  // src/routes/integrations.ts computes and returns `errored` (a per-item
  // moveEntry throw, non-fatal to the batch); runMoveLoop's totals object
  // never carried it. Concrete failure mode: a D1 problem makes every
  // moveEntry throw, the server reports moved:0 errored:10 per page and
  // keeps advancing (remaining eventually hits 0), and today's dashboard
  // renders the plain success branch — green check, "0 moved", note reads
  // "Nothing left to move." Everything failed and the UI says all clear.

  describe("errored reaches the operator", () => {
    it("a drain where every item errored does NOT render as success — green check or 'nothing left to move'", async () => {
      const ctx = load(true, true, true, async (url: string) => {
        if (url.includes("/integrations/notion/move")) {
          return { ok: true, status: 200, json: async () => ({ ok: true, moved: 0, alreadyThere: 0, missing: 0, refused: 0, errored: 10, vectorFailures: 0, remaining: 0, cursor: null }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
      });
      const btn = ctx.document.getElementById("move-notion");

      await ctx.moveIntegrationMemories("notion", btn);

      expect(btn.innerHTML, "10 failures rendered as a green checkmark is exactly the defect this test exists to catch").not.toMatch(/ti-check/);
      const note = ctx.document.getElementById("move-note-notion");
      const text = note.textContent as string;
      expect(text, "must not read as the ordinary empty-map message").not.toBe(ctx.t("integrations.moveResultNone"));
      expect(text, "how many were affected").toMatch(/\b10\b/);
      expect(text, "states the memories could not be moved").toMatch(/could not|failed to move|were not moved|couldn.t/i);
      expect(text, "gives an action to take").toMatch(/try again|contact|check|retry/i);
    });

    // The same claim generalized: the rule must be "nothing productive
    // happened" (moved + alreadyThere === 0 while something was processed),
    // not "the missing counter specifically is nonzero" — a mix of failure
    // reasons must trip the same guard, or a future counter that means
    // failure (like `errored` was, until this round) will slip through the
    // same way `errored` just did.
    it("a mix of failure reasons with nothing productive moved is still not rendered as success, not just a single hardcoded counter", async () => {
      // Deliberately WITHOUT `missing` (the one counter the previous round
      // already special-cased): refused + errored alone, zero moved, zero
      // alreadyThere. If the guard is "moved===0 && missing>0" rather than
      // "nothing productive happened", this fixture sails past it exactly
      // the way plain `errored` did.
      const ctx = load(true, true, true, async (url: string) => {
        if (url.includes("/integrations/notion/move")) {
          return { ok: true, status: 200, json: async () => ({ ok: true, moved: 0, alreadyThere: 0, missing: 0, refused: 2, errored: 8, vectorFailures: 0, remaining: 0, cursor: null }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
      });
      const btn = ctx.document.getElementById("move-notion");

      await ctx.moveIntegrationMemories("notion", btn);

      expect(btn.innerHTML).not.toMatch(/ti-check/);
    });
  });

  // ─── Repair passes must not double-count what the user sees (#347) ──────

  describe("repair passes report the item map once, not once per pass", () => {
    it("the final missing/refused counts shown are the item map's real counts, not multiplied by the number of repair passes", async () => {
      let call = 0;
      const ctx = load(true, true, true, async (url: string) => {
        if (url.includes("/integrations/notion/move")) {
          call++;
          const isRepairPass = call > 1;
          return {
            ok: true, status: 200,
            json: async () => ({
              ok: true,
              moved: isRepairPass ? 0 : 15,
              alreadyThere: isRepairPass ? 15 : 0,
              missing: 5, // the same 5 dead pointers, re-encountered every pass
              refused: 0,
              vectorFailures: isRepairPass ? 0 : 5,
              remaining: 0, cursor: null,
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
      });
      const btn = ctx.document.getElementById("move-notion");

      await ctx.moveIntegrationMemories("notion", btn);

      expect(call, "expected exactly one automatic repair pass").toBe(2);
      const note = ctx.document.getElementById("move-note-notion");
      // 5 dead pointers, not 10 — the repair pass re-walking the map must not
      // double the number the user is told about.
      expect(note.textContent).toMatch(/\b5\b/);
      expect(note.textContent).not.toMatch(/\b10\b/);
    });

    it("the in-progress figure does not inflate across repair passes — a 150-item connection reads out of 150, never 300", async () => {
      let call = 0;
      const ctx = load(true, true, true, async (url: string) => {
        if (url.includes("/integrations/notion/move")) {
          call++;
          const isRepairPass = call > 1;
          return {
            ok: true, status: 200,
            json: async () => ({
              ok: true,
              moved: isRepairPass ? 0 : 150,
              alreadyThere: isRepairPass ? 150 : 0,
              missing: 0, refused: 0,
              vectorFailures: isRepairPass ? 0 : 10,
              remaining: 0, cursor: null,
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [], admin: true, owner: true }) };
      });
      const btn = ctx.document.getElementById("move-notion");

      // Every write to the note element, including the one made by the
      // SECOND (repair) pass's own onProgress call — the exact moment the
      // reported bug shows up, and one no "snapshot before the next fetch"
      // trick can see, because there is no third call to snapshot before.
      const noteEl = ctx.document.getElementById("move-note-notion");
      const writes: string[] = [];
      let raw = "";
      Object.defineProperty(noteEl, "textContent", {
        get: () => raw,
        set: (v: string) => { raw = v; writes.push(v); },
      });

      await ctx.moveIntegrationMemories("notion", btn);

      expect(call).toBe(2);
      // Nothing the operator was shown, at any point, may claim a 300-item
      // connection — this brain only ever had 150 items.
      for (const write of writes) expect(write).not.toMatch(/300/);
    });
  });
});

function loadWithInfoHelper(
  fetchImpl: (url: string, init?: any) => Promise<any>,
  itemCount = 12,
  mirrorWorkspace: "company" | "personal" = "company",
) {
  const ctx = load(true, true, true, fetchImpl);
  ctx.__setIntegrations([{ provider: "notion", name: "Notion", itemCount, mirrorWorkspace }]);
  return ctx;
}
