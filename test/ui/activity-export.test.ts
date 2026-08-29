/**
 * The activity CSV export.
 *
 * The document is built in the browser — see the brief in
 * .superpowers/sdd/2026-08-28-team-hardening-phase-4 — but the DATA is not:
 * the export re-reads the same GET /team/activity the view reads, page by
 * page, so there is exactly one implementation of what an activity row is and
 * the file can never disagree with the screen about it.
 *
 * Axes: content (the exact bytes, including the BOM and the untranslated
 * header), ordering (columns as declared, rows as the server sent them),
 * completeness (every page followed; the loop terminates on a short page, on
 * an empty page, on the cap and on an error) and the leak (one
 * revokeObjectURL per click, for the url createObjectURL actually returned).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

const SRC = ["public/utils.js", "public/js/i18n.js", "public/js/state.js", "public/js/activity.js"]
  .map((rel) => readFileSync(resolve(ROOT, rel), "utf8"))
  .join("\n");

function makeEl() {
  const el: any = {
    id: "",
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    value: "",
    textContent: "",
    innerHTML: "",
    href: "",
    download: "",
    clicks: 0,
    hidden: false,
    disabled: false,
    click() {
      el.clicks++;
    },
    setAttribute() {},
    getAttribute: () => null,
    hasAttribute: () => false,
    appendChild() {},
    remove() {},
    focus() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    dataset: {},
  };
  return el;
}

function setup(
  fetchImpl: (url: string, init?: any) => Promise<any>,
  { locale = "en" }: { locale?: "en" | "it" } = {},
) {
  const elements = new Map<string, any>();
  for (const id of ["team-activity", "activity-list", "activity-more", "activity-export"]) {
    const el = makeEl();
    el.id = id;
    elements.set(id, el);
  }
  elements.get("activity-export").textContent = "Export CSV";

  const calls: string[] = [];
  const anchors: any[] = [];
  const createdFrom: any[] = [];
  const revoked: string[] = [];
  const toasts: string[] = [];
  const doc = {
    documentElement: { lang: "en" },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: (id?: string) => elements.get(id ?? "") ?? null,
    createElement: () => {
      const a = makeEl();
      anchors.push(a);
      return a;
    },
    addEventListener() {},
    removeEventListener() {},
    body: { style: {}, appendChild() {} },
  };
  const ctx: any = {
    console,
    document: doc,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: locale === "it" ? "it-IT" : "en-US" },
    Blob: (globalThis as any).Blob,
    URL: {
      createObjectURL: (b: any) => {
        createdFrom.push(b);
        return `blob:${createdFrom.length}`;
      },
      revokeObjectURL: (u: string) => revoked.push(u),
    },
    showToast: (m: string) => toasts.push(m),
    fetch: (url: string, init?: any) => {
      calls.push(url);
      return fetchImpl(url, init);
    },
    setTimeout,
    clearTimeout,
    module: undefined,
    exports: undefined,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  vm.runInContext(`WORKER_URL = "http://localhost"; AUTH_TOKEN = "tok"; var TEAM_MODE = true`, ctx);
  ctx.initI18n(locale);
  return { ctx, els: elements, calls, anchors, createdFrom, revoked, toasts };
}

function ok(events: any[]) {
  return { ok: true, status: 200, json: async () => ({ ok: true, events }) };
}

function row(i: number, over: Record<string, unknown> = {}) {
  return {
    at: "2026-08-20T09:00:00.000Z",
    event: "member_created",
    actor: `Ada ${i}`,
    subject: `Bob ${i}`,
    kind: "member",
    title: null,
    entryId: null,
    detail: { role: "member" },
    ...over,
  };
}

const page = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => row(offset + i));

const HEADER = '"when","event","actor","subject","memory_id","memory","detail"';

/**
 * The blob's bytes, BOM and all.
 *
 * NOT `blob.text()`: that decodes UTF-8 with ignoreBOM false, which silently
 * eats the very byte order mark these tests exist to pin. Excel's behaviour
 * depends on it being on the wire, so the wire is what gets read here.
 */
async function rawText(blob: any): Promise<string> {
  const buf = await blob.arrayBuffer();
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(buf);
}

describe("the activity CSV export", () => {
  it("follows every page, names the file for today and writes a BOM'd header", async () => {
    const { ctx, els, calls, anchors, createdFrom } = setup(async (url) => {
      if (url.includes("offset=0")) return ok(page(50, 0));
      if (url.includes("offset=50")) return ok(page(50, 50));
      return ok(page(7, 100));
    });
    await ctx.exportActivityCsv(els.get("activity-export"));

    expect(calls).toEqual([
      "http://localhost/team/activity?limit=50&offset=0",
      "http://localhost/team/activity?limit=50&offset=50",
      "http://localhost/team/activity?limit=50&offset=100",
    ]);

    const today = new Date().toISOString().slice(0, 10);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].download).toBe(`second-brain-activity-${today}.csv`);
    expect(anchors[0].clicks).toBe(1);

    expect(createdFrom[0].type).toBe("text/csv;charset=utf-8");
    const text: string = await rawText(createdFrom[0]);
    // Excel reads a BOM-less UTF-8 CSV as the system codepage, and this file
    // carries member names and Italian memory titles.
    expect(text.startsWith("﻿")).toBe(true);
    expect(text.slice(1).startsWith(HEADER)).toBe(true);

    const lines = text.slice(1).split("\r\n");
    expect(lines).toHaveLength(108);
    // Server order, first row to last — not a count, which a reversal passes.
    expect(lines[1]).toContain('"Ada 0","Bob 0"');
    expect(lines[107]).toContain('"Ada 106","Bob 106"');
  });

  it("writes the columns in the declared order, with an ISO timestamp", async () => {
    const { ctx, els, createdFrom } = setup(async () =>
      ok([
        row(0, {
          at: "2026-08-20T09:00:00.000Z",
          event: "shared",
          actor: "Ada",
          subject: "the team",
          kind: "entry",
          entryId: "e-1",
          title: "Quarterly plan",
          detail: { workspace: "company" },
        }),
      ]),
    );
    await ctx.exportActivityCsv(els.get("activity-export"));
    const text: string = await rawText(createdFrom[0]);
    const lines = text.slice(1).split("\r\n");
    expect(lines[0]).toBe(HEADER);
    expect(lines[1]).toBe(
      '"2026-08-20T09:00:00.000Z","shared","Ada","the team","e-1","Quarterly plan","{""workspace"":""company""}"',
    );
  });

  it("defuses a memory title that is a spreadsheet formula", async () => {
    const { ctx, els, createdFrom } = setup(async () =>
      ok([row(0, { kind: "entry", title: "=cmd|' /C calc'!A0", actor: "Ada", subject: null })]),
    );
    await ctx.exportActivityCsv(els.get("activity-export"));
    const text: string = await rawText(createdFrom[0]);
    expect(text).toContain("\"'=cmd|' /C calc'!A0\"");
    expect(text).not.toContain('"=cmd');
  });

  it("terminates when an exactly-full page is followed by an empty one", async () => {
    let n = 0;
    const { ctx, els, calls, createdFrom } = setup(async () => ok(n++ === 0 ? page(50) : []));
    await ctx.exportActivityCsv(els.get("activity-export"));
    expect(calls).toHaveLength(2);
    const text: string = await rawText(createdFrom[0]);
    expect(text.slice(1).split("\r\n")).toHaveLength(51);
  });

  it("stops at the stated ceiling rather than spending unbounded round trips", async () => {
    const { ctx, els, calls, createdFrom } = setup(async () => ok(page(50)));
    await ctx.exportActivityCsv(els.get("activity-export"));
    // Read out of the context: top-level `const`s are lexical bindings, not
    // properties of the sandbox, so the cap is asserted where it is declared.
    const max = vm.runInContext("ACTIVITY_EXPORT_MAX", ctx);
    const per = vm.runInContext("ACTIVITY_PAGE", ctx);
    expect(max).toBe(1000);
    expect(calls).toHaveLength(max / per);
    const text: string = await rawText(createdFrom[0]);
    expect(text.slice(1).split("\r\n")).toHaveLength(1001);
  });

  it("says so and downloads nothing when a page fails, and gives the button back", async () => {
    let n = 0;
    const { ctx, els, createdFrom, revoked, toasts } = setup(async () => {
      if (n++ === 0) return ok(page(50));
      throw new Error("offline");
    });
    const btn = els.get("activity-export");
    await ctx.exportActivityCsv(btn);
    expect(toasts).toEqual(["Could not export the activity log."]);
    // A half-written file is worse than none: nothing is handed to the browser.
    expect(createdFrom).toHaveLength(0);
    expect(revoked).toHaveLength(0);
    // The `finally`.
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Export CSV");
  });

  it("says so on a non-2xx page too", async () => {
    const { ctx, els, toasts, createdFrom } = setup(async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    }));
    await ctx.exportActivityCsv(els.get("activity-export"));
    expect(toasts).toEqual(["Could not export the activity log."]);
    expect(createdFrom).toHaveLength(0);
  });

  it("releases exactly one object url per click, and the one it was given", async () => {
    const { ctx, els, revoked, anchors } = setup(async () => ok(page(3)));
    const btn = els.get("activity-export");
    await ctx.exportActivityCsv(btn);
    expect(revoked).toEqual(["blob:1"]);
    expect(anchors[0].href).toBe("blob:1");
    await ctx.exportActivityCsv(btn);
    expect(revoked).toEqual(["blob:1", "blob:2"]);
    expect(anchors[1].href).toBe("blob:2");
  });

  it("disables the button while it works and restores its label after", async () => {
    let labelDuring = "";
    const { ctx, els } = setup(async () => {
      labelDuring = els.get("activity-export").textContent;
      return ok([]);
    });
    const btn = els.get("activity-export");
    await ctx.exportActivityCsv(btn);
    expect(labelDuring).toBe("Loading…");
    expect(btn.textContent).toBe("Export CSV");
    expect(btn.disabled).toBe(false);
  });

  it("survives being called with no button at all", async () => {
    const { ctx, createdFrom } = setup(async () => ok(page(1)));
    await ctx.exportActivityCsv(undefined);
    expect(createdFrom).toHaveLength(1);
  });

  it("speaks Italian in the toast and English in the file", async () => {
    const failing = setup(
      async () => {
        throw new Error("offline");
      },
      { locale: "it" },
    );
    await failing.ctx.exportActivityCsv(failing.els.get("activity-export"));
    expect(failing.toasts).toEqual(["Impossibile esportare il registro attività."]);
    expect(failing.els.get("activity-export").textContent).toBe("Esporta CSV");

    // The header row and the timestamps are DELIBERATELY untranslated. A CSV is
    // read by a compliance tool and by a spreadsheet formula someone wrote last
    // quarter; a header that changes with the operator's browser language is a
    // file format that changes with the operator's browser language.
    const good = setup(async () => ok([row(0, { at: "2026-08-20T09:00:00.000Z" })]), { locale: "it" });
    await good.ctx.exportActivityCsv(good.els.get("activity-export"));
    const text: string = await rawText(good.createdFrom[0]);
    const lines = text.slice(1).split("\r\n");
    expect(lines[0]).toBe(HEADER);
    expect(lines[1].startsWith('"2026-08-20T09:00:00.000Z"')).toBe(true);
  });

  it("is wired into index.html", () => {
    const html = readFileSync(resolve(ROOT, "public/index.html"), "utf8");
    expect(html).toContain('id="activity-export"');
    expect(html).toContain("exportActivityCsv(this)");
  });

  it("leaves exactly one place in public/ that turns a string into a download", () => {
    // The structural half of the anti-duplication requirement. Two code paths
    // producing matching output have NOT met it: one of them is where the
    // missing revokeObjectURL goes to live.
    const files = ["public/utils.js", "public/js/activity.js", "public/js/settings.js"];
    const owners = files.filter((f) =>
      /URL\.createObjectURL\(/.test(readFileSync(resolve(ROOT, f), "utf8")),
    );
    expect(owners).toEqual(["public/utils.js"]);
    for (const f of ["public/js/activity.js", "public/js/settings.js"]) {
      expect(readFileSync(resolve(ROOT, f), "utf8")).toContain("downloadTextFile(");
    }
  });
});
