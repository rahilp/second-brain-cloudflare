/**
 * Disconnecting an integration.
 *
 * This used to ask twice: "disconnect?" and then, if anything had been synced,
 * "also delete them?". Two stacked browser confirms for one action is the
 * shape that teaches people to click through without reading, and the second
 * question is not a second decision — it is a modifier on the first. A
 * modifier is a checkbox, so there is now one sheet carrying both.
 *
 * `confirm` and `alert` throw in this sandbox, so a surviving call to either
 * fails the test rather than passing quietly.
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

function load(integrations: any[], postReply?: () => Promise<any>) {
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
    confirm: () => {
      throw new Error("confirm() must not be used");
    },
    alert: () => {
      throw new Error("alert() must not be used");
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    refreshAll: () => {},
    fetch: async (url: string, init?: any) => {
      calls.push({ url, init });
      if (url.includes("/disconnect")) {
        if (postReply) return postReply();
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      // The refresh that follows a successful disconnect.
      return { ok: true, status: 200, json: async () => ({ ok: true, integrations: [] }) };
    },
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
  // `integrationsInfo`, `WORKER_URL` and `AUTH_TOKEN` are top-level `let`
  // bindings in state.js; a sandbox property would not shadow them.
  vm.runInContext(`WORKER_URL = "https://example.test"; AUTH_TOKEN = "tok"`, ctx);
  ctx.__setIntegrations = (list: any[]) => {
    ctx.__list = list;
    vm.runInContext("integrationsInfo = globalThis.__list", ctx);
  };
  ctx.__setIntegrations(integrations);
  ctx.__els = els;
  return ctx;
}

const disconnectBodies = (ctx: any) =>
  (ctx.calls as Call[]).filter((c) => c.url.includes("/disconnect")).map((c) => JSON.parse(c.init.body));

describe("disconnecting an integration", () => {
  const gmail = [{ provider: "gmail", name: "Gmail", itemCount: 3 }];

  it("asks once, with the purge offered as a modifier rather than a second question", async () => {
    const ctx = load(gmail);
    const btn = makeEl();
    await ctx.disconnectIntegration("gmail", btn);

    expect(ctx.__els.get("confirm-dialog").classList.contains("open")).toBe(true);
    expect(ctx.__els.get("confirm-title").textContent).toBe("Disconnect this integration?");
    expect(ctx.__els.get("confirm-body").textContent).toContain("Gmail");
    expect(ctx.__els.get("confirm-check-row").style.display).toBe("");
    expect(ctx.__els.get("confirm-check-label").textContent).toContain("3");
    // Nothing has happened yet — the sheet is the question, not the answer.
    expect(ctx.calls.length).toBe(0);
  });

  it("keeps the synced memories when the modifier is left unticked", async () => {
    const ctx = load(gmail);
    await ctx.disconnectIntegration("gmail", makeEl());
    await ctx.runConfirmAction();
    expect(disconnectBodies(ctx)).toEqual([{ purge: false }]);
    expect(ctx.__els.get("confirm-dialog").classList.contains("open")).toBe(false);
  });

  it("deletes them when it is ticked", async () => {
    const ctx = load(gmail);
    await ctx.disconnectIntegration("gmail", makeEl());
    ctx.__els.get("confirm-checkbox").checked = true;
    await ctx.runConfirmAction();
    expect(disconnectBodies(ctx)).toEqual([{ purge: true }]);
  });

  it("offers no modifier when the integration has synced nothing", async () => {
    // Both branches: a hidden checkbox reports false, so purge still defaults off.
    const ctx = load([{ provider: "gmail", name: "Gmail", itemCount: 0 }]);
    await ctx.disconnectIntegration("gmail", makeEl());
    expect(ctx.__els.get("confirm-check-row").style.display).toBe("none");
    await ctx.runConfirmAction();
    expect(disconnectBodies(ctx)).toEqual([{ purge: false }]);
  });

  it("reports a refusal in the toast and puts the button back", async () => {
    const ctx = load(gmail, async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: "still syncing" }) }));
    const btn = makeEl();
    await ctx.disconnectIntegration("gmail", btn);
    await ctx.runConfirmAction();
    expect(ctx.__els.get("app-toast").innerHTML).toContain("still syncing");
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Disconnect");
  });

  it("speaks Italian, which a browser dialog could not have done", async () => {
    const ctx = load(gmail);
    ctx.initI18n("it");
    await ctx.disconnectIntegration("gmail", makeEl());
    expect(ctx.__els.get("confirm-title").textContent).toBe("Disconnettere questa integrazione?");
  });
});
