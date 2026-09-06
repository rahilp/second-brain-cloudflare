/**
 * The destructive-action sheet, from a keyboard.
 *
 * Native `confirm()` was dismissable with Escape and announced as a dialog
 * without anyone having to arrange it. This phase replaced it for six
 * destructive actions — three of them somebody else's account — with a `div`
 * that had neither. A keyboard user could reach "Remove this member?" and have
 * no way out of it but the mouse.
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

function makeEl(id = "") {
  const classes = new Set<string>();
  const el: any = {
    id,
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
    title: "",
    attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) {
      el.attrs[k] = v;
    },
    getAttribute: (k: string) => el.attrs[k] ?? null,
    appendChild() {},
    remove() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    dataset: {} as Record<string, string>,
  };
  return el;
}

function load() {
  const els = new Map<string, any>();
  const keydown: Array<(e: any) => void> = [];
  const doc: any = {
    activeElement: null as any,
    getElementById: (id: string) => {
      if (!els.has(id)) {
        const el = makeEl(id);
        // Focus is what the trap moves around, so the fake DOM has to model
        // where it currently is rather than swallow the call.
        el.focus = () => {
          doc.activeElement = el;
        };
        els.set(id, el);
      }
      return els.get(id);
    },
    querySelector: () => makeEl(),
    createElement: () => makeEl(),
    addEventListener: (type: string, fn: (e: any) => void) => {
      if (type === "keydown") keydown.push(fn);
    },
    querySelectorAll: () => [],
    body: { style: {}, appendChild() {} },
  };
  const ctx: any = {
    console,
    document: doc,
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
  vm.runInContext(`WORKER_URL = "https://example.test"; AUTH_TOKEN = "tok"`, ctx);
  // The checkbox row ships hidden, exactly as in index.html.
  doc.getElementById("confirm-check-row").style.display = "none";
  const press = (key: string, shiftKey = false) => {
    let defaultPrevented = false;
    const e = { key, shiftKey, preventDefault: () => void (defaultPrevented = true) };
    for (const fn of keydown) fn(e);
    return defaultPrevented;
  };
  return { ctx, doc, press, el: (id: string) => doc.getElementById(id) };
}

const isOpen = (ctx: any) => ctx.document.getElementById("confirm-dialog").classList.contains("open");

describe("confirm sheet markup", () => {
  const html = readFileSync(resolve(ROOT, "public/index.html"), "utf8");
  const tag = html.match(/<div id="confirm-dialog"[^>]*>/)?.[0] ?? "";

  it("is announced as a modal dialog named and described by its own copy", () => {
    expect(tag).toContain('role="dialog"');
    expect(tag).toContain('aria-modal="true"');
    expect(tag).toContain('aria-labelledby="confirm-title"');
    expect(tag).toContain('aria-describedby="confirm-body"');
    // Without this the sheet cannot take focus, so nothing above gets read.
    expect(tag).toContain('tabindex="-1"');
    // The two ids the labels point at have to be the ones in the sheet.
    expect(html).toContain('id="confirm-title"');
    expect(html).toContain('id="confirm-body"');
  });
});

describe("confirm sheet keyboard", () => {
  it("closes on Escape, the same way Cancel does", () => {
    const { ctx, press } = load();
    let closed = 0;
    ctx.openDangerConfirm({ title: "T", body: "B", confirmLabel: "Go", onConfirm: () => {}, onClose: () => closed++ });
    expect(isOpen(ctx)).toBe(true);
    expect(press("Escape")).toBe(true);
    expect(isOpen(ctx)).toBe(false);
    // The ambient path, so the caller's state reset runs exactly as on Cancel.
    expect(closed).toBe(1);
  });

  it("ignores Escape when no question is on screen", () => {
    const { ctx, press } = load();
    let closed = 0;
    ctx.openDangerConfirm({ title: "T", body: "B", confirmLabel: "Go", onConfirm: () => {}, onClose: () => closed++ });
    ctx.closeConfirm();
    expect(closed).toBe(1);
    expect(press("Escape")).toBe(false);
    expect(closed).toBe(1);
  });

  it("gives the keyboard back to whatever invoked it", () => {
    const { ctx, doc, el } = load();
    const invoker = el("some-forget-button");
    doc.activeElement = invoker;
    ctx.openDangerConfirm({ title: "T", body: "B", confirmLabel: "Go", onConfirm: () => {} });
    // Focus is on the sheet while the question is up, which is what gets the
    // title and body announced.
    expect(doc.activeElement).toBe(el("confirm-dialog"));
    ctx.closeConfirm();
    expect(doc.activeElement, "focus was left on a hidden sheet").toBe(invoker);
  });

  it("keeps the original invoker when one question replaces another", () => {
    const { ctx, doc, el } = load();
    const invoker = el("some-forget-button");
    doc.activeElement = invoker;
    ctx.openDangerConfirm({ title: "T", body: "B", confirmLabel: "Go", onConfirm: () => {} });
    ctx.openDangerConfirm({ title: "T2", body: "B2", confirmLabel: "Go2", onConfirm: () => {} });
    ctx.closeConfirm();
    // Not the sheet itself, which is what a second capture would have recorded.
    expect(doc.activeElement).toBe(invoker);
  });

  it("cycles Tab inside the sheet instead of letting it walk into the page", () => {
    const { ctx, doc, press, el } = load();
    ctx.openDangerConfirm({ title: "T", body: "B", confirmLabel: "Go", onConfirm: () => {} });
    const cancel = el("confirm-cancel-btn");
    const accept = el("confirm-accept-btn");

    expect(press("Tab")).toBe(true);
    expect(doc.activeElement).toBe(cancel);
    press("Tab");
    expect(doc.activeElement).toBe(accept);
    // The end of the sheet wraps to its start rather than the page behind it.
    press("Tab");
    expect(doc.activeElement).toBe(cancel);
    press("Tab", true);
    expect(doc.activeElement).toBe(accept);
  });

  it("includes the modifier tick in the cycle only when the sheet shows one", () => {
    const { ctx, doc, press, el } = load();
    ctx.openDangerConfirm({ title: "T", body: "B", confirmLabel: "Go", checkboxLabel: "Also purge", onConfirm: () => {} });
    press("Tab");
    expect(doc.activeElement).toBe(el("confirm-checkbox"));

    ctx.openDangerConfirm({ title: "T2", body: "B2", confirmLabel: "Go2", onConfirm: () => {} });
    press("Tab");
    expect(doc.activeElement).toBe(el("confirm-cancel-btn"));
  });

  it("does not park focus on the accept button while its action is in flight", async () => {
    const { ctx, doc, press, el } = load();
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    ctx.openDangerConfirm({ title: "T", body: "B", confirmLabel: "Go", onConfirm: async () => void (await slow) });
    const running = ctx.runConfirmAction();
    expect(el("confirm-accept-btn").disabled).toBe(true);

    press("Tab");
    expect(doc.activeElement).toBe(el("confirm-cancel-btn"));
    press("Tab");
    expect(doc.activeElement, "Tab landed on the held-down accept button").toBe(el("confirm-cancel-btn"));

    release();
    await running;
  });
});
