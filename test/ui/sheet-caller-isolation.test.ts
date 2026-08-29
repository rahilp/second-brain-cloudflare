/**
 * Two modules, one sheet.
 *
 * `danger-sheet.test.ts` loads `memory-crud.js` and `team-panel.test.ts` loads
 * `team.js`, and neither can see the hazard the sheet exists to prevent: an
 * action that outlives its own question closing somebody else's. Both suites
 * assert outcomes — "the roster reloaded", "the memory went" — which is the
 * right style for a feature and exactly the wrong style for this, because the
 * damage here is to a question the acting module has never heard of.
 *
 * So this file loads `team.js` AND `memory-crud.js` into the same context, in
 * page order, over one real `confirm-sheet.js`, and asserts the negative: a
 * slow action completing must not take down whatever is on screen by then.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

/** Page order, from index.html: the sheet loads before either of its callers. */
const SRC = [
  "public/utils.js",
  "public/js/i18n.js",
  "public/js/state.js",
  "public/js/toast.js",
  "public/js/confirm-sheet.js",
  "public/js/recent.js",
  "public/js/memory-crud.js",
  "public/js/team.js",
];

function makeEl(id = "") {
  const classes = new Set<string>();
  const el: any = {
    id,
    tagName: "DIV",
    style: {} as Record<string, string>,
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      toggle: (c: string, on?: boolean) => void ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c)),
      contains: (c: string) => classes.has(c),
    },
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    checked: false,
    hidden: false,
    title: "",
    attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) {
      el.attrs[k] = v;
    },
    getAttribute: (k: string) => el.attrs[k] ?? null,
    hasAttribute: (k: string) => k in el.attrs,
    removeAttribute(k: string) {
      delete el.attrs[k];
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    remove() {},
    focus() {},
    scrollIntoView() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    dataset: {} as Record<string, string>,
  };
  return el;
}

/** A promise a test resolves by hand, so an action can be held mid-flight. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup(fetchImpl: (url: string, init?: any) => Promise<any>) {
  const els = new Map<string, any>();
  const get = (id: string) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  const ctx: any = {
    console,
    document: {
      documentElement: { lang: "en" },
      getElementById: (id: string) => get(id),
      querySelector: (sel: string) => (sel === "#confirm-dialog .btn-delete" ? get("confirm-accept-btn") : makeEl()),
      querySelectorAll: () => [],
      createElement: () => makeEl(),
      addEventListener() {},
      removeEventListener() {},
      body: { style: {}, appendChild() {} },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: "en-US", clipboard: { writeText() {} } },
    fetch: fetchImpl,
    // Neither module may reach for the browser dialog the sheet replaced.
    confirm: () => {
      throw new Error("confirm() must not be used");
    },
    alert: () => {},
    setTimeout,
    clearTimeout,
    refreshAll: () => {},
    module: undefined,
    exports: undefined,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.location = { href: "" };
  vm.createContext(ctx);
  for (const f of SRC) vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  vm.runInContext(`WORKER_URL = "http://localhost"; AUTH_TOKEN = "tok"; var TEAM_MODE = true`, ctx);
  ctx.initI18n("en");
  // Roster state, assigned in-context: `teamMembers` is a top-level `let`.
  vm.runInContext(
    `teamMembers = [
       { userId: "u1", name: "Ada", email: "ada@example.com", role: "admin", suspended: false, privateEntries: 12 },
       { userId: "u2", name: "Bob", email: "bob@example.com", role: "member", suspended: false, privateEntries: 3 }
     ]; teamYouId = "u1"`,
    ctx,
  );
  return { ctx, els, get };
}

const isOpen = (ctx: any) => ctx.document.getElementById("confirm-dialog").classList.contains("open");

describe("one sheet, two calling modules", () => {
  it("does not let a slow team rotation close the memory question that replaced it", async () => {
    const rotate = deferred<any>();
    const { ctx, get } = setup(async (url: string) => {
      if (url.endsWith("/team/members/token")) return rotate.promise;
      throw new Error(`unexpected fetch ${url}`);
    });
    // team.js reloads the roster after some actions; make that harmless.
    ctx.loadTeam = async () => {};

    // 1. An admin rotates Bob's token, and the POST hangs.
    await ctx.rotateTeamToken("u2");
    expect(isOpen(ctx)).toBe(true);
    const running = ctx.runConfirmAction();

    // 2. They give up waiting and tap the backdrop — app.js's ambient close.
    ctx.closeConfirm();
    expect(isOpen(ctx)).toBe(false);

    // 3. They go to Memories and ask to forget one.
    ctx.openConfirm("m1", null);
    expect(isOpen(ctx)).toBe(true);
    expect(get("confirm-title").textContent).toBe("Forget this memory?");

    // 4. The rotation finally lands.
    rotate.resolve({ ok: true, status: 200, json: async () => ({ ok: true, token: "sbt_new" }) });
    await running;

    // The forget question is still being asked, and still knows what it is for.
    expect(isOpen(ctx), "the rotation closed the forget sheet under the user").toBe(true);
    expect(get("confirm-title").textContent).toBe("Forget this memory?");
    expect(vm.runInContext("pendingForgetId", ctx)).toBe("m1");
  });

  it("does not let a slow rotation close the removal question raised after it", async () => {
    const rotate = deferred<any>();
    const { ctx, get } = setup(async (url: string) => {
      if (url.endsWith("/team/members/token")) return rotate.promise;
      throw new Error(`unexpected fetch ${url}`);
    });
    ctx.loadTeam = async () => {};

    await ctx.rotateTeamToken("u2");
    const running = ctx.runConfirmAction();
    ctx.closeConfirm();

    // Same screen, same admin, next action: remove Bob outright.
    await ctx.removeTeamMember("u2");
    const removeTitle = get("confirm-title").textContent;
    expect(removeTitle).toContain("Remove");

    rotate.resolve({ ok: true, status: 200, json: async () => ({ ok: true, token: "sbt_new" }) });
    await running;

    expect(isOpen(ctx), "the rotation closed the removal sheet under the user").toBe(true);
    expect(get("confirm-title").textContent).toBe(removeTitle);
  });

  it("still closes its own question when nothing has superseded it", async () => {
    const { ctx } = setup(async (url: string) => {
      if (url.endsWith("/team/members/token")) return { ok: true, status: 200, json: async () => ({ ok: true, token: "sbt_new" }) };
      throw new Error(`unexpected fetch ${url}`);
    });
    ctx.loadTeam = async () => {};

    await ctx.rotateTeamToken("u2");
    await ctx.runConfirmAction();
    expect(isOpen(ctx)).toBe(false);
  });
});
