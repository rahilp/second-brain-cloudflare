/**
 * The shared destructive-action sheet.
 *
 * There is one `#confirm-dialog` in the page and one API that drives it, so
 * that "are you sure?" looks and behaves the same wherever it is asked from.
 * Memory delete is the first caller rather than a private implementation —
 * that is what proves the API is general, and it is what stops the two from
 * diverging the first time either one is restyled.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

const SRC = [
  "public/utils.js",
  "public/js/state.js",
  "public/js/toast.js",
  "public/js/confirm-sheet.js",
  "public/js/memory-crud.js",
];

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
      toggle: (c: string, on?: boolean) => void (on ?? !classes.has(c) ? classes.add(c) : classes.delete(c)),
      contains: (c: string) => classes.has(c),
    },
    setAttribute() {},
    getAttribute: () => null,
    appendChild() {},
    remove() {},
    focus() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    dataset: {} as Record<string, string>,
  };
}

function load() {
  const els = new Map<string, any>();
  const ctx: any = {
    console,
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) {
          const el = makeEl();
          el.id = id;
          els.set(id, el);
        }
        return els.get(id);
      },
      querySelector: () => makeEl(),
      createElement: () => makeEl(),
      addEventListener() {},
      querySelectorAll: () => [],
      body: { style: {}, appendChild() {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    apiMcp: async () => "",
    refreshAll: () => {},
    setTimeout: (fn: () => void) => fn(),
    clearTimeout: () => {},
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of SRC) vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  // state.js declares these with `let`, so a sandbox property would not shadow them.
  vm.runInContext(`WORKER_URL = "https://example.test"; AUTH_TOKEN = "tok"`, ctx);
  ctx.__els = els;
  return ctx;
}

const el = (ctx: any, id: string) => ctx.document.getElementById(id);

describe("openDangerConfirm", () => {
  it("writes the caller's words into the one sheet and runs its action once", async () => {
    const ctx = load();
    const seen: unknown[] = [];
    ctx.openDangerConfirm({
      title: "T",
      body: "B",
      confirmLabel: "Go",
      onConfirm: (checked: boolean) => void seen.push(checked),
    });
    expect(el(ctx, "confirm-title").textContent).toBe("T");
    expect(el(ctx, "confirm-body").textContent).toBe("B");
    expect(el(ctx, "confirm-accept-btn").textContent).toBe("Go");
    expect(el(ctx, "confirm-dialog").classList.contains("open")).toBe(true);

    await ctx.runConfirmAction();
    expect(seen).toEqual([false]);

    ctx.closeConfirm();
    expect(el(ctx, "confirm-dialog").classList.contains("open")).toBe(false);
    await ctx.runConfirmAction();
    expect(seen).toEqual([false]); // the closed sheet has no action left to run
  });

  it("re-enables the accept button an earlier action had disabled", async () => {
    const ctx = load();
    el(ctx, "confirm-accept-btn").disabled = true;
    ctx.openDangerConfirm({ title: "T", body: "B", confirmLabel: "Go", onConfirm: () => {} });
    expect(el(ctx, "confirm-accept-btn").disabled).toBe(false);
  });

  it("calls onClose when the sheet is dismissed, and only then", () => {
    const ctx = load();
    let closes = 0;
    ctx.openDangerConfirm({ title: "T", body: "B", confirmLabel: "Go", onConfirm: () => {}, onClose: () => closes++ });
    expect(closes).toBe(0);
    ctx.closeConfirm();
    expect(closes).toBe(1);
    ctx.closeConfirm(); // the callback is dropped, not re-run
    expect(closes).toBe(1);
  });
});

describe("the modifier checkbox", () => {
  it("shows the row with the caller's label and hands its state to the action", async () => {
    const ctx = load();
    const seen: unknown[] = [];
    ctx.openDangerConfirm({
      title: "T",
      body: "B",
      confirmLabel: "Go",
      checkboxLabel: "Also purge",
      onConfirm: (checked: boolean) => void seen.push(checked),
    });
    expect(el(ctx, "confirm-check-row").style.display).toBe("");
    expect(el(ctx, "confirm-check-label").textContent).toBe("Also purge");
    expect(el(ctx, "confirm-checkbox").checked).toBe(false);

    el(ctx, "confirm-checkbox").checked = true;
    await ctx.runConfirmAction();
    expect(seen).toEqual([true]);
  });

  it("hides the row and reports false when the caller offers no modifier", async () => {
    const ctx = load();
    const seen: unknown[] = [];
    ctx.openDangerConfirm({ title: "T", body: "B", confirmLabel: "Go", onConfirm: (c: boolean) => void seen.push(c) });
    expect(el(ctx, "confirm-check-row").style.display).toBe("none");
    await ctx.runConfirmAction();
    expect(seen).toEqual([false]);
  });

  it("hides a row a previous opener left showing, and unchecks a left-over tick", async () => {
    // Both branches: the sheet is shared, so an opener that says nothing about
    // a checkbox must not inherit the last one's.
    const ctx = load();
    ctx.openDangerConfirm({ title: "T", body: "B", confirmLabel: "Go", checkboxLabel: "Also purge", onConfirm: () => {} });
    el(ctx, "confirm-checkbox").checked = true;
    expect(el(ctx, "confirm-check-row").style.display).toBe("");

    const seen: unknown[] = [];
    ctx.openDangerConfirm({ title: "T2", body: "B2", confirmLabel: "Go2", onConfirm: (c: boolean) => void seen.push(c) });
    expect(el(ctx, "confirm-check-row").style.display).toBe("none");
    await ctx.runConfirmAction();
    expect(seen).toEqual([false]);

    ctx.openDangerConfirm({ title: "T3", body: "B3", confirmLabel: "Go3", checkboxLabel: "Again", onConfirm: () => {} });
    expect(el(ctx, "confirm-checkbox").checked).toBe(false);
  });
});

describe("memory delete as the first caller", () => {
  it("fills the sheet with the forget copy instead of relying on the cold markup", () => {
    const ctx = load();
    ctx.openConfirm("m1", null);
    expect(el(ctx, "confirm-title").textContent).toBe("Forget this memory?");
    expect(el(ctx, "confirm-body").textContent).toContain("can't be undone");
    expect(el(ctx, "confirm-accept-btn").textContent).toBe("Forget");
    expect(el(ctx, "confirm-dialog").classList.contains("open")).toBe(true);
    expect(vm.runInContext("pendingForgetId", ctx)).toBe("m1");
  });

  it("clears the pending memory through the shared close, not a private one", () => {
    const ctx = load();
    const card = makeEl();
    card.classList.add("memory-card");
    ctx.openConfirm("m1", card);
    expect(vm.runInContext("pendingForgetCard", ctx)).not.toBe(null);
    ctx.closeConfirm();
    expect(el(ctx, "confirm-dialog").classList.contains("open")).toBe(false);
    expect(vm.runInContext("pendingForgetId", ctx)).toBe(null);
    expect(vm.runInContext("pendingForgetCard", ctx)).toBe(null);
  });

  it("speaks Italian when the page does", () => {
    const ctx = load();
    ctx.initI18n("it");
    ctx.openConfirm("m1", null);
    expect(el(ctx, "confirm-title").textContent).toBe("Dimenticare questo ricordo?");
  });
});
