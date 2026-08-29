/**
 * The editor: what it shows, and what it sends.
 *
 * This was the worst surface in the dashboard. It rendered the brain's private
 * bookkeeping as chips next to a hint about adding tags — so `kind:episodic`
 * looked like something the user had written and the chips looked like a
 * control neither of which was true — and it opened a two-thousand-character
 * memory scrolled into the middle of itself.
 *
 * The riskiest part is the payload: the sheet now sends a tag list that
 * replaces, and it must never send a tag it was hiding.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function load() {
  const els = new Map<string, any>();
  const makeEl = () => ({
    innerHTML: "",
    textContent: "",
    value: "",
    disabled: false,
    scrollTop: 99,
    style: {} as Record<string, string>,
    classList: {
      _s: new Set<string>(),
      add(c: string) { this._s.add(c); },
      remove(c: string) { this._s.delete(c); },
      contains(c: string) { return this._s.has(c); },
    },
    selection: null as null | [number, number],
    setSelectionRange(a: number, b: number) { this.selection = [a, b]; },
    focus() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const sent: any[] = [];
  const ctx: any = {
    console,
    sent,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    pendingEditId: null,
    setTimeout: (fn: () => void) => fn(),
    clearTimeout: () => {},
    refreshAll: () => {},
    apiMcp: async () => ({}),
    // A save failure now reports through the app's toast; a browser alert
    // would block the page and could not be translated.
    alert: () => {
      throw new Error("alert() must not be used");
    },
    fetch: async (_url: string, init: any) => {
      sent.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ ok: true }) };
    },
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl());
        return els.get(id);
      },
      createElement: () => makeEl(),
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { style: {}, appendChild(el: any) { if (el.id) els.set(el.id, el); } },
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of ["public/utils.js", "public/js/toast.js", "public/js/memory-crud.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  return ctx;
}

describe("opening the editor", () => {
  it("shows the user's tags and hides the brain's", () => {
    const ctx = load();
    ctx.openEdit("e1", "The pricing floor is $6k.", [
      "pricing", "kind:semantic", "volatility:state", "status:canonical", "work",
    ]);
    const html = ctx.__els.get("edit-existing-tags").innerHTML;
    expect(html).toContain("pricing");
    expect(html).toContain("work");
    expect(html).not.toContain("kind:semantic");
    expect(html).not.toContain("volatility:state");
    expect(html).not.toContain("status:canonical");
  });

  it("says which memory is being edited", () => {
    const ctx = load();
    ctx.openEdit("e1", "The pricing floor is $6k for new projects.\n\nAgreed with Vincenzo.", []);
    expect(ctx.__els.get("edit-sub").textContent).toContain("pricing floor");
  });

  it("starts at the top of a long memory", () => {
    // Focusing a textarea whose value was just set puts the caret at the end and
    // scrolls there — on a long memory the editor opened mid-text.
    const ctx = load();
    ctx.openEdit("e1", "x".repeat(2000), []);
    const ta = ctx.__els.get("edit-textarea");
    expect(ta.selection).toEqual([0, 0]);
    expect(ta.scrollTop).toBe(0);
  });

  it("does not size the textarea from JavaScript", () => {
    // The old code measured scrollHeight while the sheet was still display:none,
    // which reads 0, and capped the result at 200px — the three-line keyhole.
    const ctx = load();
    ctx.openEdit("e1", "x".repeat(2000), []);
    expect(ctx.__els.get("edit-textarea").style.height).toBeUndefined();
  });
});

describe("removing a tag", () => {
  it("drops it from the sheet without touching the entry", () => {
    const ctx = load();
    ctx.openEdit("e1", "Content", ["pricing", "work"]);
    ctx.removeEditTag(0);
    const html = ctx.__els.get("edit-existing-tags").innerHTML;
    expect(html).not.toContain("pricing");
    expect(html).toContain("work");
  });

  it("is forgotten if the user cancels", async () => {
    const ctx = load();
    ctx.openEdit("e1", "Content", ["pricing", "work"]);
    ctx.removeEditTag(0);
    ctx.closeEdit();

    // Reopening the same memory offers both again: nothing was saved.
    ctx.openEdit("e1", "Content", ["pricing", "work"]);
    expect(ctx.__els.get("edit-existing-tags").innerHTML).toContain("pricing");
  });
});

describe("saving", () => {
  it("sends only the tags the user could see", async () => {
    // The hidden ones are the Worker's; sending them back would be harmless, but
    // sending a *subset* that omits them is what makes replacement safe — the
    // Worker re-adds its own from the row (src/tags/system.ts).
    const ctx = load();
    ctx.openEdit("e1", "Content", ["pricing", "kind:semantic", "work"]);
    ctx.__els.get("edit-textarea").value = "Rewritten content"
    await ctx.saveEdit();
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toEqual({ id: "e1", content: "Rewritten content", tags: ["pricing", "work"] });
  });

  it("sends an empty list when the user removed every tag", async () => {
    const ctx = load();
    ctx.openEdit("e1", "Content", ["pricing"]);
    ctx.removeEditTag(0);
    ctx.__els.get("edit-textarea").value = "Rewritten content";
    await ctx.saveEdit();
    expect(ctx.sent[0].tags).toEqual([]);
  });

  it("refuses to save an emptied memory", async () => {
    const ctx = load();
    ctx.openEdit("e1", "Content", []);
    ctx.__els.get("edit-textarea").value = "   ";
    await ctx.saveEdit();
    expect(ctx.sent).toHaveLength(0);
  });

  it("leaves the sheet open and the text intact when the save fails", async () => {
    const ctx = load();
    ctx.fetch = async () => ({ ok: false, status: 500 });
    ctx.openEdit("e1", "Content", []);
    ctx.__els.get("edit-textarea").value = "Rewritten content";
    await ctx.saveEdit();
    // Reported in the app's own toast, naming the status the server sent.
    expect(ctx.__els.get("app-toast").innerHTML).toContain("Edit failed");
    expect(ctx.__els.get("app-toast").innerHTML).toContain("500");
    expect(ctx.__els.get("edit-sheet").classList.contains("open")).toBe(true);
    expect(ctx.__els.get("edit-textarea").value).toBe("Rewritten content");
  });
});
