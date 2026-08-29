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

/** `missing` names ids that this page simply does not have. */
function load(missing: string[] = []) {
  const els = new Map<string, any>();
  const absent = new Set(missing);
  const ctx: any = {
    console,
    document: {
      getElementById: (id: string) => {
        if (absent.has(id)) return null;
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

/** A promise plus the handle to settle it, for holding an action in flight. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("whose sheet is this", () => {
  it("will not let a superseded caller close the question that replaced it", async () => {
    // Traced sequence: tap Disconnect on a slow integration, dismiss it via the
    // backdrop, tap Forget, and then the disconnect POST resolves. Its close
    // used to dismiss the FORGET sheet and fire the forget's onClose, throwing
    // away the id that was about to be deleted.
    const ctx = load();
    const slow = deferred();
    let firstToken: number | undefined;
    firstToken = ctx.openDangerConfirm({
      title: "Disconnect",
      body: "B",
      confirmLabel: "Go",
      onConfirm: async (_checked: boolean, done: () => void) => {
        await slow.promise;
        done();
      },
    });
    expect(typeof firstToken).toBe("number");
    const running = ctx.runConfirmAction();

    ctx.closeConfirm(); // the user dismisses it via the backdrop

    let secondClosed = 0;
    ctx.openDangerConfirm({
      title: "Forget this memory?",
      body: "B2",
      confirmLabel: "Forget",
      onConfirm: () => {},
      onClose: () => secondClosed++,
    });

    slow.resolve();
    await running;

    expect(ctx.__els.get("confirm-dialog").classList.contains("open")).toBe(true);
    expect(ctx.__els.get("confirm-title").textContent).toBe("Forget this memory?");
    expect(secondClosed).toBe(0);
  });

  it("still lets a caller close the sheet it actually opened", async () => {
    const ctx = load();
    let closed = 0;
    ctx.openDangerConfirm({
      title: "T",
      body: "B",
      confirmLabel: "Go",
      onConfirm: (_c: boolean, done: () => void) => done(),
      onClose: () => closed++,
    });
    await ctx.runConfirmAction();
    expect(ctx.__els.get("confirm-dialog").classList.contains("open")).toBe(false);
    expect(closed).toBe(1);
  });

  it("dismisses the caller it is replacing, so that caller's state still resets", () => {
    // Opening a second sheet over a first one used to drop the first's onClose
    // on the floor, leaving whatever it was going to reset set forever.
    const ctx = load();
    let firstClosed = 0;
    ctx.openDangerConfirm({ title: "T", body: "B", confirmLabel: "Go", onConfirm: () => {}, onClose: () => firstClosed++ });
    ctx.openDangerConfirm({ title: "T2", body: "B2", confirmLabel: "Go2", onConfirm: () => {} });
    expect(firstClosed).toBe(1);
    // And it is not run a second time when the replacement is dismissed.
    ctx.closeConfirm();
    expect(firstClosed).toBe(1);
  });
});

describe("double submit", () => {
  it("runs the action once however many times the accept button is tapped", async () => {
    // confirm() was modal and could not do this; a sheet can, so the guard has
    // to be here rather than remembered by every caller.
    const ctx = load();
    const slow = deferred();
    let runs = 0;
    ctx.openDangerConfirm({
      title: "T",
      body: "B",
      confirmLabel: "Go",
      onConfirm: async () => {
        runs++;
        await slow.promise;
      },
    });
    const first = ctx.runConfirmAction();
    await ctx.runConfirmAction();
    await ctx.runConfirmAction();
    expect(runs).toBe(1);
    slow.resolve();
    await first;
    expect(runs).toBe(1);
  });

  it("disables the accept button while the action is in flight", async () => {
    const ctx = load();
    const slow = deferred();
    ctx.openDangerConfirm({ title: "T", body: "B", confirmLabel: "Go", onConfirm: async () => void (await slow.promise) });
    const running = ctx.runConfirmAction();
    expect(ctx.__els.get("confirm-accept-btn").disabled).toBe(true);
    slow.resolve();
    await running;
  });

  it("gives the button back when the action fails, so the user can retry", async () => {
    const ctx = load();
    let runs = 0;
    ctx.openDangerConfirm({
      title: "T",
      body: "B",
      confirmLabel: "Go",
      onConfirm: async () => {
        runs++;
        throw new Error("server said no");
      },
    });
    await expect(ctx.runConfirmAction()).rejects.toThrow("server said no");
    expect(ctx.__els.get("confirm-accept-btn").disabled).toBe(false);
    // And the retry actually runs, rather than being swallowed by the guard.
    await expect(ctx.runConfirmAction()).rejects.toThrow("server said no");
    expect(runs).toBe(2);
  });

  it("leaves a caller free to set its own progress copy", async () => {
    // confirmForget writes "Forgetting…" onto this button; the sheet owns the
    // disabled state, the caller owns the words.
    const ctx = load();
    const slow = deferred();
    ctx.openDangerConfirm({
      title: "T",
      body: "B",
      confirmLabel: "Forget",
      onConfirm: async () => {
        ctx.document.getElementById("confirm-accept-btn").textContent = "Forgetting…";
        await slow.promise;
      },
    });
    const running = ctx.runConfirmAction();
    expect(ctx.__els.get("confirm-accept-btn").textContent).toBe("Forgetting…");
    slow.resolve();
    await running;
  });
});

describe("a page that does not have the sheet's markup", () => {
  it("does not throw when the checkbox is absent", async () => {
    // An older cached index.html, or a harness that only built part of the DOM.
    const ctx = load(["confirm-checkbox"]);
    const seen: unknown[] = [];
    ctx.openDangerConfirm({ title: "T", body: "B", confirmLabel: "Go", onConfirm: (c: boolean) => void seen.push(c) });
    await ctx.runConfirmAction();
    expect(seen).toEqual([false]);
  });
});

describe("opening a second question of the same kind", () => {
  it("keeps the NEW memory pending, not none of them", async () => {
    // openConfirm sets pendingForgetId and then opens. Since opening now
    // dismisses the sheet it replaces — and that dismissal is what nulls
    // pendingForgetId — an opener that sets its state first would have it
    // wiped out from under itself by its own predecessor.
    const ctx = load();
    ctx.openConfirm("m1", null);
    ctx.openConfirm("m2", null);
    expect(vm.runInContext("pendingForgetId", ctx)).toBe("m2");
    expect(ctx.__els.get("confirm-dialog").classList.contains("open")).toBe(true);
  });
});

/**
 * Two actions in flight at once.
 *
 * Reachable with correct callers: accept Forget, dismiss it via the backdrop,
 * open Disconnect, accept that too, and now two POSTs are outstanding against
 * one shared element. Anything the sheet remembers about "which action is
 * running" is ambient state that these orderings corrupt, so the sheet must
 * remember nothing — each invocation gets a handle closed over its own
 * generation, and identity comes out of lexical scope.
 */
describe("two actions in flight at once", () => {
  /** Opens a sheet whose action resolves only when its returned handle is released. */
  function slowSheet(ctx: any, title: string) {
    const gate = deferred();
    let closes = 0;
    ctx.openDangerConfirm({
      title,
      body: "B",
      confirmLabel: "Go",
      onConfirm: async (_c: boolean, done: () => void) => {
        await gate.promise;
        done();
      },
      onClose: () => closes++,
    });
    return { gate, running: ctx.runConfirmAction(), closed: () => closes };
  }

  it("leaves the sheet dismissable when the OUTER action finishes first", async () => {
    // The wedge. With a save/restore global, the second action restores a
    // generation the first captured, and every later unscoped close — Cancel
    // and the backdrop — compares against a stale value and returns early. The
    // user can then never dismiss anything again for the life of the page.
    const ctx = load();
    const first = slowSheet(ctx, "Forget");
    ctx.closeConfirm(); // backdrop, while the forget POST is still out
    const second = slowSheet(ctx, "Disconnect");

    first.gate.resolve();
    await first.running;
    second.gate.resolve();
    await second.running;

    // A fresh question, and Cancel must still work.
    ctx.openDangerConfirm({ title: "Third", body: "B", confirmLabel: "Go", onConfirm: () => {} });
    expect(ctx.__els.get("confirm-dialog").classList.contains("open")).toBe(true);
    ctx.closeConfirm();
    expect(ctx.__els.get("confirm-dialog").classList.contains("open")).toBe(false);
  });

  it("leaves it dismissable when the INNER action finishes first", async () => {
    const ctx = load();
    const first = slowSheet(ctx, "Forget");
    ctx.closeConfirm();
    const second = slowSheet(ctx, "Disconnect");

    second.gate.resolve();
    await second.running;
    first.gate.resolve();
    await first.running;

    ctx.openDangerConfirm({ title: "Third", body: "B", confirmLabel: "Go", onConfirm: () => {} });
    ctx.closeConfirm();
    expect(ctx.__els.get("confirm-dialog").classList.contains("open")).toBe(false);
  });

  it("never lets either stale action dismiss the third sheet or fire its onClose", async () => {
    const ctx = load();
    const first = slowSheet(ctx, "Forget");
    ctx.closeConfirm();
    const second = slowSheet(ctx, "Disconnect");
    ctx.closeConfirm();

    let thirdClosed = 0;
    ctx.openDangerConfirm({ title: "Third", body: "B", confirmLabel: "Go", onConfirm: () => {}, onClose: () => thirdClosed++ });

    first.gate.resolve();
    await first.running;
    second.gate.resolve();
    await second.running;

    expect(ctx.__els.get("confirm-dialog").classList.contains("open")).toBe(true);
    expect(ctx.__els.get("confirm-title").textContent).toBe("Third");
    expect(thirdClosed).toBe(0);
  });

  it("a handle held long after its sheet was superseded does nothing", async () => {
    // The guarantee stated in the contract note, on its own.
    const ctx = load();
    let handle: (() => void) | null = null;
    ctx.openDangerConfirm({
      title: "First",
      body: "B",
      confirmLabel: "Go",
      onConfirm: (_c: boolean, done: () => void) => {
        handle = done;
      },
    });
    await ctx.runConfirmAction();
    expect(typeof handle).toBe("function");

    let secondClosed = 0;
    ctx.openDangerConfirm({ title: "Second", body: "B", confirmLabel: "Go", onConfirm: () => {}, onClose: () => secondClosed++ });
    handle!();
    expect(ctx.__els.get("confirm-dialog").classList.contains("open")).toBe(true);
    expect(ctx.__els.get("confirm-title").textContent).toBe("Second");
    expect(secondClosed).toBe(0);
  });

  it("an action that throws mid-flight leaves the sheet dismissable", async () => {
    const ctx = load();
    ctx.openDangerConfirm({
      title: "First",
      body: "B",
      confirmLabel: "Go",
      onConfirm: async () => {
        throw new Error("server said no");
      },
    });
    await expect(ctx.runConfirmAction()).rejects.toThrow("server said no");
    ctx.closeConfirm();
    expect(ctx.__els.get("confirm-dialog").classList.contains("open")).toBe(false);
    ctx.openDangerConfirm({ title: "Second", body: "B", confirmLabel: "Go", onConfirm: () => {} });
    ctx.closeConfirm();
    expect(ctx.__els.get("confirm-dialog").classList.contains("open")).toBe(false);
  });
});
