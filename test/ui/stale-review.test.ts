/**
 * The out-of-date review queue.
 *
 * The chip on home says "N may be out of date". Clicking it used to fire a
 * free-text recall for that phrase — a vector search which returns the flagged
 * entries only by coincidence, and on a real brain returned two memories that
 * merely contained the words while the one actually flagged never appeared.
 *
 * What is tested here is the thing that made the chip useless: that the queue
 * shows WHICH memory is flagged, in enough detail to rule on, and offers the
 * three actions that resolve it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function load(pages: any[] = []) {
  const els = new Map<string, any>();
  const makeEl = () => ({
    hidden: false,
    disabled: false,
    innerHTML: "",
    textContent: "",
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, contains: () => false },
    querySelectorAll: () => [],
  });
  let pageIndex = 0;
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    closeMenu: () => {},
    openMenu: () => {},
    refreshAll: () => {},
    setTimeout: (fn: () => void) => fn(),
    fetch: async () => {
      const page = pages[Math.min(pageIndex++, pages.length - 1)] ?? { ok: true, entries: [], total: 0 };
      if (page instanceof Error) throw page;
      return { ok: true, json: async () => page };
    },
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl());
        return els.get(id);
      },
      createElement: () => makeEl(),
      addEventListener() {},
      querySelectorAll: () => [],
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of ["public/utils.js", "public/js/stale.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  return ctx;
}

const page = (n: number, total = n) => ({
  ok: true,
  total,
  entries: Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    content: `Our deploy target is the staging cluster ${i}`,
    tags: ["work", "stale:as-of"],
    source: "claude-desktop",
    created_at: Date.UTC(2026, 1, 8, 12),
    last_updated: Date.UTC(2026, 1, 8, 12),
  })),
});

describe("the out-of-date queue", () => {
  it("shows which memory is flagged, not a search for the phrase", async () => {
    const ctx = load([page(2)]);

    await ctx.loadStaleQueue();

    const html = ctx.__els.get("stale-list").innerHTML;
    expect(html).toContain("Our deploy target is the staging cluster 0");
    expect(html).toContain("Our deploy target is the staging cluster 1");
  });

  it("offers edit, append and forget on each flagged memory", async () => {
    // The three actions the queue exists to make reachable. Without them it is a
    // list of problems with no way to resolve one.
    const ctx = load([page(1)]);

    await ctx.loadStaleQueue();

    const html = ctx.__els.get("stale-list").innerHTML;
    expect(html).toContain("openEdit(");
    expect(html).toContain("openAppend(");
    expect(html).toContain("openConfirm(");
    // Wired to the entry, not to the row index.
    expect(html).toContain("s0");
  });

  it("says when the entry was last confirmed", async () => {
    // "Out of date" is a claim about age. A reviewer cannot rule on it without
    // seeing how long it has been since anyone touched the memory.
    const ctx = load([page(1)]);

    await ctx.loadStaleQueue();

    expect(ctx.__els.get("stale-list").innerHTML).toContain("Feb 8, 2026");
  });

  it("says so plainly when nothing is flagged", async () => {
    const ctx = load([{ ok: true, entries: [], total: 0 }]);

    await ctx.loadStaleQueue();

    const html = ctx.__els.get("stale-list").innerHTML;
    expect(html).toContain("Nothing looks out of date");
  });

  it("does not claim an empty queue when the request failed", async () => {
    // An error rendered as "nothing is out of date" tells the user their brain
    // is healthy at exactly the moment it could not be checked.
    const ctx = load([new Error("offline")]);

    await ctx.loadStaleQueue();

    const html = ctx.__els.get("stale-list").innerHTML;
    expect(html).not.toContain("Nothing looks out of date");
    expect(html).toContain("Could not load");
  });

});

/**
 * What happens to a row after you act on it.
 *
 * All three actions take a memory out of this queue, and for two different
 * reasons: forget removes it from the brain, while edit and append clear the
 * staleness flag by themselves (tagsAfterWrite, tagsAfterAppend) because
 * touching a memory is what confirms it. Either way the row is answering a
 * question that has been answered.
 *
 * Loaded with the real memory-crud module rather than a stub of it. The queue
 * does not perform these actions, it only has to notice them, and a test that
 * stubs the thing doing the noticing proves nothing about whether the two are
 * connected — which is exactly the bug this covers: the row stayed on screen
 * after a successful forget.
 */
function loadWithCrud(entries: any[]) {
  const els = new Map<string, any>();
  const makeEl = () => ({
    hidden: false,
    disabled: false,
    value: "text",
    innerHTML: "",
    textContent: "",
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, contains: () => false },
    closest: () => null,
    querySelectorAll: () => [],
    remove() {},
    focus() {},
    setSelectionRange() {},
  });
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    allEntries: [],
    closeMenu: () => {},
    openMenu: () => {},
    refreshAll: () => {},
    alert: () => {},
    setTimeout: (fn: () => void) => fn(),
    apiMcp: async () => ({ ok: true }),
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, entries, total: entries.length }) }),
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl());
        return els.get(id);
      },
      querySelector: () => makeEl(),
      createElement: () => makeEl(),
      addEventListener() {},
      querySelectorAll: () => [],
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  // confirm-sheet.js drives the one `#confirm-dialog` the whole page shares;
  // memory-crud.js is a caller of it, so the page's script list is what this
  // has to mirror. Assertions below are unchanged — only the module list is.
  for (const f of ["public/utils.js", "public/js/confirm-sheet.js", "public/js/memory-crud.js", "public/js/stale.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  return ctx;
}

const twoEntries = [
  { id: "s0", content: "First flagged claim", tags: ["work", "stale:as-of"], source: "claude-desktop", created_at: 1, last_updated: 1 },
  { id: "s1", content: "Second flagged claim", tags: ["work", "stale:as-of"], source: "claude-desktop", created_at: 2, last_updated: 2 },
];

describe("acting on a row", () => {
  it("takes a forgotten memory off the queue", async () => {
    const ctx = loadWithCrud(twoEntries);
    await ctx.loadStaleQueue();

    ctx.openConfirm("s0", null);
    await ctx.confirmForget();

    const html = ctx.__els.get("stale-list").innerHTML;
    expect(html).not.toContain("First flagged claim");
    expect(html).toContain("Second flagged claim");
  });

  it("takes an edited memory off the queue", async () => {
    // The write clears stale:as-of, so the memory is no longer out of date and
    // has no business still being listed as such.
    const ctx = loadWithCrud(twoEntries);
    await ctx.loadStaleQueue();

    ctx.openEdit("s0", "First flagged claim", ["work"]);
    await ctx.saveEdit();

    expect(ctx.__els.get("stale-list").innerHTML).not.toContain("First flagged claim");
  });

  it("takes an appended-to memory off the queue", async () => {
    const ctx = loadWithCrud(twoEntries);
    await ctx.loadStaleQueue();

    ctx.openAppend("s1", "Second");
    // openAppend blanks the textarea; saveAppend bails on an empty addition. The
    // user types here, so the test does too.
    ctx.__els.get("append-textarea").value = "Still true as of today.";
    await ctx.saveAppend();

    expect(ctx.__els.get("stale-list").innerHTML).not.toContain("Second flagged claim");
  });

  it("shows the empty state once the last row is resolved", async () => {
    const ctx = loadWithCrud([twoEntries[0]]);
    await ctx.loadStaleQueue();

    ctx.openConfirm("s0", null);
    await ctx.confirmForget();

    expect(ctx.__els.get("stale-list").innerHTML).toContain("Nothing looks out of date");
  });

  it("leaves the queue alone for a memory it is not showing", async () => {
    // Acting on a memory from the Memories screen must not renumber this queue.
    const ctx = loadWithCrud(twoEntries);
    await ctx.loadStaleQueue();

    ctx.openConfirm("someone-else", null);
    await ctx.confirmForget();

    const html = ctx.__els.get("stale-list").innerHTML;
    expect(html).toContain("First flagged claim");
    expect(html).toContain("Second flagged claim");
  });
});
