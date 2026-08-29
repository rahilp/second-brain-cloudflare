/**
 * The settings sheet, after it stopped pretending to be settings.
 *
 * It held fourteen items in one undifferentiated stack — a stats panel, five
 * chore panels, a theme toggle, three data actions and an about block — of
 * which exactly one (the theme) was a setting. The Worker's behaviour is tuned
 * from the Tauri window, which is its only writer.
 *
 * Two things are worth pinning: a heading must never render over nothing, and
 * the compression queue must not read as a backlog.
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
    hidden: false,
    innerHTML: "",
    textContent: "",
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, contains: () => false },
    remove() { this.removed = true; },
    removed: false,
  });
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    vectorizeGraceMs: 300000,
    fetch: () => Promise.reject(new Error("no network here")),
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl());
        return els.get(id);
      },
      createElement: () => makeEl(),
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of ["public/utils.js", "public/js/settings.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  return ctx;
}

const CHORES = ["patterns-section", "digest-section", "vectorize-section", "classify-section", "restore-section"];

describe("the Upkeep heading", () => {
  it("disappears on a brain with no chores pending", () => {
    // A heading over nothing reads as a broken screen, and having nothing to do
    // is the normal case.
    const ctx = load();
    for (const id of CHORES) ctx.document.getElementById(id).style.display = "none";
    ctx.syncUpkeepGroup();
    expect(ctx.__els.get("upkeep-group").hidden).toBe(true);
  });

  it("appears as soon as any one panel has something to say", () => {
    const ctx = load();
    for (const id of CHORES) ctx.document.getElementById(id).style.display = "none";
    ctx.document.getElementById("vectorize-section").style.display = "";
    ctx.syncUpkeepGroup();
    expect(ctx.__els.get("upkeep-group").hidden).toBe(false);
  });

  it("comes back with a restore, which reveals its panel directly", () => {
    const ctx = load();
    for (const id of CHORES) ctx.document.getElementById(id).style.display = "none";
    ctx.syncUpkeepGroup();
    expect(ctx.__els.get("upkeep-group").hidden).toBe(true);

    ctx.renderRestoreProgress("Restoring…", 10, 100);
    expect(ctx.__els.get("upkeep-group").hidden).toBe(false);
  });
});

describe("the compression queue", () => {
  const candidates = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ tag: `tag${i}`, count: 50 - i }));

  it("hides itself when there is nothing to compress", () => {
    const ctx = load();
    ctx.renderDigestSection([]);
    expect(ctx.__els.get("digest-section").style.display).toBe("none");
  });

  it("shows a handful rather than the whole backlog", () => {
    // Nine identical rows read as a chore list someone is failing to keep up
    // with. Candidates arrive largest-first, so the tail is the least useful.
    const ctx = load();
    ctx.renderDigestSection(candidates(9));
    const html = ctx.__els.get("digest-section").innerHTML;
    const before = html.slice(0, html.indexOf('id="digest-rest"'));
    expect(before.match(/digest-candidate-row/g)).toHaveLength(4);
    expect(html).toContain("5 more");
  });

  it("keeps the rest one tap away rather than dropping them", () => {
    const ctx = load();
    ctx.renderDigestSection(candidates(9));
    const html = ctx.__els.get("digest-section").innerHTML;
    // Every candidate is still in the DOM; the tail is only hidden.
    expect(html.match(/digest-candidate-row/g)).toHaveLength(9);
    expect(html).toContain("tag8");

    ctx.showAllDigestCandidates();
    expect(ctx.__els.get("digest-rest").hidden).toBe(false);
    expect(ctx.__els.get("digest-more").removed).toBe(true);
  });

  it("says nothing about more when there is no more", () => {
    const ctx = load();
    ctx.renderDigestSection(candidates(3));
    expect(ctx.__els.get("digest-section").innerHTML).not.toContain("more");
  });
});

/**
 * The memories export, as the download mechanism moves out from under it.
 *
 * exportMemories has been building a Blob, an object URL and an `<a download>`
 * since long before the team edition. Extracting those five lines into
 * downloadTextFile (public/utils.js) so the activity CSV can share them is a
 * change to how the bytes reach the disk, and this group is the assertion that
 * nothing about WHICH bytes, or what they are called, moved with them.
 *
 * These tests were written and run green against the pre-extraction function,
 * and must stay green after it. The revokeObjectURL count is the axis an
 * identity check on the blob would not catch: a second copy of the sequence is
 * exactly how one of them ends up leaking an object URL per click.
 */
function loadForExport(payload: unknown, locale: "en" | "it" = "en") {
  const els = new Map<string, any>();
  const anchors: any[] = [];
  const createdFrom: any[] = [];
  const revoked: string[] = [];
  const toasts: string[] = [];
  const makeEl = () => {
    const el: any = {
      hidden: false,
      innerHTML: "",
      textContent: "",
      href: "",
      download: "",
      clicks: 0,
      style: {} as Record<string, string>,
      classList: { add() {}, remove() {}, contains: () => false },
      click() {
        el.clicks++;
      },
      remove() {},
    };
    return el;
  };
  const ctx: any = {
    console,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    Blob: (globalThis as any).Blob,
    URL: {
      createObjectURL: (b: any) => {
        createdFrom.push(b);
        return `blob:${createdFrom.length}`;
      },
      revokeObjectURL: (u: string) => revoked.push(u),
    },
    showToast: (m: string) => toasts.push(m),
    fetch: async () => ({ ok: true, status: 200, json: async () => payload }),
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl());
        return els.get(id);
      },
      createElement: () => {
        const a = makeEl();
        anchors.push(a);
        return a;
      },
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, locale);
  for (const f of ["public/utils.js", "public/js/settings.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  return { ctx, anchors, createdFrom, revoked, toasts };
}

/**
 * The blob's bytes, BOM and all. NOT `blob.text()`, which decodes UTF-8 with
 * ignoreBOM false and would silently eat the byte the "no BOM here" assertions
 * below exist to make.
 */
async function rawText(blob: any): Promise<string> {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(await blob.arrayBuffer());
}

const EXPORT_PAYLOAD = {
  entries: [
    { id: "e1", content: "First memory", tags: ["work"], source: "web", created_at: "2026-08-01T00:00:00.000Z" },
    { id: "e2", content: "Second memory", tags: [], source: null, created_at: "2026-08-02T00:00:00.000Z" },
  ],
  edges: [{ source_id: "e1", target_id: "e2", type: "relates", weight: 0.5 }],
};

describe("the memories export, through the shared downloader", () => {
  it("hands the browser the same JSON, under the same filename, with one revoke", async () => {
    const { ctx, anchors, createdFrom, revoked } = loadForExport(EXPORT_PAYLOAD);
    await ctx.exportMemories("json");

    expect(anchors).toHaveLength(1);
    expect(anchors[0].download).toMatch(/^second-brain-export-\d{4}-\d{2}-\d{2}\.json$/);
    expect(anchors[0].clicks).toBe(1);
    expect(anchors[0].href).toBe("blob:1");

    expect(createdFrom).toHaveLength(1);
    expect(createdFrom[0].type).toBe("application/json");
    const text = await rawText(createdFrom[0]);
    // No BOM: that branch is for text/csv only, and a BOM here would break
    // every JSON.parse that has ever been pointed at one of these files.
    expect(text.startsWith("﻿")).toBe(false);
    expect(JSON.parse(text)).toEqual(EXPORT_PAYLOAD);
    expect(text).toBe(JSON.stringify(EXPORT_PAYLOAD, null, 2));

    // The leak axis. One click, one url, released once — and the SAME url the
    // anchor was pointed at, which an identity check on the blob would miss.
    expect(revoked).toEqual(["blob:1"]);
  });

  it("hands the browser the same Markdown, under the same filename and mime", async () => {
    const { ctx, anchors, createdFrom, revoked } = loadForExport(EXPORT_PAYLOAD);
    await ctx.exportMemories("md");

    expect(anchors[0].download).toMatch(/^second-brain-export-\d{4}-\d{2}-\d{2}\.md$/);
    expect(createdFrom[0].type).toBe("text/markdown");
    const text = await rawText(createdFrom[0]);
    expect(text.startsWith("﻿")).toBe(false);
    expect(text).toContain("First memory");
    expect(text).toContain("Second memory");
    expect(text).toContain("[relates] First memory -> Second memory (0.5)");
    expect(revoked).toEqual(["blob:1"]);
  });

  it("still reports a failed export through the toast and downloads nothing", async () => {
    const { ctx, createdFrom, toasts } = loadForExport(EXPORT_PAYLOAD);
    ctx.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await ctx.exportMemories("json");
    expect(createdFrom).toHaveLength(0);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("503");
  });
});
