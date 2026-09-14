/**
 * The connected-row mirror-layer control, issue #346.
 *
 * Before this, the layer select was rendered on the NOT-connected row only —
 * an admin who wanted to move an already-connected integration from personal
 * to company had to Disconnect and reconnect with the same token purely to get
 * the form back on screen. This adds the same two-option select to the
 * connected row, admin-only, preselected to the current `mirrorWorkspace`,
 * with a note that the change affects new syncs only (moving what is already
 * mirrored is #347, not this).
 *
 * Locked decisions this test enforces (see docs/superpowers/plans/2026-09-12-346-plan.md):
 *  - gated on `TEAM_MODE && integrationsAdmin`, matching the connected row's
 *    existing `integrationsAdmin` gate for its Sync/Disconnect buttons;
 *  - id `ws-${p}`, reused from the not-connected row (the two branches never
 *    coexist);
 *  - a real `onchange` handler name that resolves to an actual function, the
 *    same guarantee dashboard-modules.test.ts holds statically-declared inline
 *    handlers to;
 *  - the two pinned solo-brain fixtures in integration-provenance.test.ts stay
 *    byte-identical — this file does not touch them; if this new control's
 *    gating were wrong, those fixtures would be the ones to break, not these.
 *
 * Harness copied from integration-provenance.test.ts's load(), the standing
 * house pattern for this file (`vm` + a hand-rolled fake DOM, api.js not
 * loaded so TEAM_MODE/integrationsAdmin are bare vars the test pokes).
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

type Call = { url: string; init?: any };

function load(teamMode: boolean, admin: boolean, locale: "en" | "it" = "en") {
  const els = new Map<string, any>();
  const calls: Call[] = [];
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
    setTimeout: () => 0,
    clearTimeout: () => {},
    refreshAll: () => {},
    fetch: async (url: string, init?: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  installI18n(ctx, locale);
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
    `WORKER_URL = "https://example.test"; AUTH_TOKEN = "tok"; var TEAM_MODE = ${teamMode}; integrationsAdmin = ${admin}`,
    ctx,
  );
  ctx.__els = els;
  return ctx;
}

const BASE = {
  provider: "notion",
  name: "Notion",
  connected: true,
  workspaceName: "Acme Notion",
  itemCount: 5,
  lastSyncedAt: 1771999999000,
};

describe("connected-row mirror-layer control", () => {
  it("renders the select for a team admin, preselected to the current layer, with a new-syncs-only note", () => {
    const ctx = load(true, true);
    const html = ctx.renderIntegrationCard({ ...BASE, mirrorWorkspace: "company" });

    expect(html).toContain(`id="ws-notion"`);
    // Preselected to the record's own layer, not a default.
    expect(html).toMatch(/<option value="company"[^>]*selected[^>]*>/);
    expect(html).not.toMatch(/<option value="personal"[^>]*selected[^>]*>/);
    // The scope-boundary copy: this changes where FUTURE syncs land, not what
    // is already mirrored (#347). Naming the exact key here is deliberate —
    // the implementer must add it to both i18n catalogs, not invent a
    // different one.
    expect(html).toContain(ctx.t("integrations.mirrorLayerNewSyncsOnly"));
  });

  it("gives a member the read-only layer text but no select", () => {
    const ctx = load(true, false);
    const html = ctx.renderIntegrationCard({ ...BASE, mirrorWorkspace: "company" });
    expect(html).not.toContain("<select");
    expect(html).toContain("Synced memories land in the shared team layer");
  });

  it("shows no layer control at all on a solo brain", () => {
    const ctx = load(false, true);
    const html = ctx.renderIntegrationCard({ ...BASE, mirrorWorkspace: "personal" });
    expect(html).not.toContain("<select");
  });

  it("the onchange handler is a real function, not a typo'd name", () => {
    const ctx = load(true, true);
    const html = ctx.renderIntegrationCard({ ...BASE, mirrorWorkspace: "personal" });
    const m = html.match(/id="ws-notion"[^>]*onchange="([a-zA-Z_$][\w$]*)\(/);
    expect(m, "expected an onchange=\"someHandler(...)\" attribute on the connected-row select").not.toBeNull();
    const handlerName = (m as RegExpMatchArray)[1];
    expect(typeof ctx[handlerName]).toBe("function");
  });

  it("surfaces an error on a failed save without leaving the select showing a layer the server did not accept", async () => {
    const ctx = load(true, true);
    // The connected row's select must carry a data hook the failure handler can
    // use to restore the value — id `ws-${p}`, reused from the not-connected row.
    const wsEl = ctx.document.getElementById("ws-notion");
    wsEl.value = "company"; // the user's attempted change
    ctx.fetch = async (url: string) => {
      if (url.includes("/integrations/notion/layer")) {
        return { ok: false, status: 403, json: async () => ({ ok: false, error: "Forbidden" }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    await ctx.changeIntegrationLayer("notion", wsEl, "personal");
    // The select must not keep showing "company" — the server refused it.
    expect(wsEl.value).toBe("personal");
    const errEl = ctx.document.getElementById("err-notion");
    expect(errEl.textContent.length).toBeGreaterThan(0);
  });
});
