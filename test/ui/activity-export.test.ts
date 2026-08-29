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
import { readdirSync, readFileSync } from "node:fs";
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

/**
 * A row in the shape GET /team/activity really sends: `at` in EPOCH
 * MILLISECONDS (`Number(r.created_at) || 0`, src/routes/admin.ts) and `kind`
 * one of 'admin' / 'entry'. AT_ISO is the same instant spelled the way the CSV
 * has to render it, so the assertions below still read as dates.
 */
const AT_ISO = "2026-08-20T09:00:00.000Z";
const AT_MS = Date.parse(AT_ISO);

function row(i: number, over: Record<string, unknown> = {}) {
  return {
    at: AT_MS,
    event: "member_created",
    actor: `Ada ${i}`,
    subject: `Bob ${i}`,
    kind: "admin",
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
          at: AT_MS,
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
    const good = setup(async () => ok([row(0, { at: AT_MS })]), { locale: "it" });
    await good.ctx.exportActivityCsv(good.els.get("activity-export"));
    const text: string = await rawText(good.createdFrom[0]);
    const lines = text.slice(1).split("\r\n");
    expect(lines[0]).toBe(HEADER);
    expect(lines[1].startsWith('"2026-08-20T09:00:00.000Z"')).toBe(true);
  });

  it("exports the rest of the trail when one row's timestamp is unusable", async () => {
    // The whole point: a single bad row must not cost the admin the file. The
    // `when` cell is empty for that row — every other column in this document
    // already renders an absent value as an empty cell, and a made-up token in
    // an ISO-8601 column would give the column two grammars. Inventing a date
    // is the one answer that is never acceptable in an audit export.
    const { ctx, els, createdFrom, toasts } = setup(async () =>
      ok([
        row(0, { at: undefined, actor: "No clock" }),
        row(1, { at: AT_MS, actor: "Good row" }),
        row(2, { at: null, actor: "Null clock" }),
        row(3, { at: "not a date at all", actor: "Junk clock" }),
        // ZERO, which is not a curiosity: the route spells the field
        // `Number(r.created_at) || 0`, so 0 is the literal value the wire
        // carries for a row with no clock. The view pins it (test/ui/
        // team-activity.test.ts drives `at: 0` through the when-cell); without
        // it here, `activityIsoAt` could start re-admitting zero and write
        // 1970-01-01T00:00:00.000Z into a compliance CSV with the suite green.
        row(4, { at: 0, actor: "Zero clock" }),
        row(5, { at: 1755680400000, actor: "Epoch row" }),
      ]),
    );
    await ctx.exportActivityCsv(els.get("activity-export"));
    expect(toasts).toEqual([]);
    expect(createdFrom).toHaveLength(1);
    const lines = (await rawText(createdFrom[0])).slice(1).split("\r\n");
    expect(lines).toHaveLength(7);
    expect(lines[1].startsWith('"",')).toBe(true);
    expect(lines[1]).toContain('"No clock"');
    expect(lines[2].startsWith('"2026-08-20T09:00:00.000Z",')).toBe(true);
    // `new Date(null)` is epoch 0: without an explicit check this row would
    // claim, in a compliance record, that it happened in 1970.
    expect(lines[3].startsWith('"",')).toBe(true);
    expect(lines[3]).not.toContain("1970");
    expect(lines[4].startsWith('"",')).toBe(true);
    // The wire's own "no clock": empty, and no 1970 anywhere in the row. Read
    // as the CELL as well as the row, because an ISO column has no timezone to
    // hide 1969 in the way the view's local rendering does.
    expect(lines[5].startsWith('"",')).toBe(true);
    expect(lines[5]).toContain('"Zero clock"');
    expect(lines[5]).not.toContain("1970");
    // Epoch milliseconds are what the endpoint actually sends, and they work.
    expect(lines[6].startsWith('"2025-08-20T09:00:00.000Z",')).toBe(true);
  });

  it("says so rather than downloading an empty log when the body is not a feed", async () => {
    // An empty audit log is a CLAIM that nothing happened. A 200 whose body is
    // the wrong shape must never be able to make that claim — which is what a
    // header-only CSV with no toast is.
    for (const body of [{ ok: false }, { ok: true, activity: [] }, { ok: true, events: null }, {}]) {
      const { ctx, els, createdFrom, toasts } = setup(async () => ({
        ok: true,
        status: 200,
        json: async () => body,
      }));
      await ctx.exportActivityCsv(els.get("activity-export"));
      expect(createdFrom, JSON.stringify(body)).toHaveLength(0);
      expect(toasts, JSON.stringify(body)).toEqual(["Could not export the activity log."]);
    }
  });

  it("reads the same body the view reads, through the same check", async () => {
    // loadTeamActivity and exportActivityCsv disagreeing about one response is
    // exactly how a cross-worktree field-name change becomes a silent empty
    // file on one path and a stated failure on the other. One check, one answer.
    const src = readFileSync(resolve(ROOT, "public/js/activity.js"), "utf8");
    const callers = src.match(/activityEventsFrom\(/g) ?? [];
    // The declaration plus both call sites.
    expect(callers).toHaveLength(3);
    expect(src).not.toMatch(/Array\.isArray\(data\.events\) \? data\.events : \[\]/);
  });

  it("pages on the page size, never on a count the feed does not send", async () => {
    // GET /team/activity answers { ok, events, limit, offset } — there is no
    // `total`, and reading one would be reading undefined. A body that grows a
    // total later must not be able to truncate the export either.
    const { ctx, els, calls, createdFrom } = setup(async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        limit: 50,
        offset: 0,
        total: 1,
        events: url.includes("offset=0") ? page(50, 0) : page(3, 50),
      }),
    }));
    await ctx.exportActivityCsv(els.get("activity-export"));
    expect(calls).toHaveLength(2);
    const lines = (await rawText(createdFrom[0])).slice(1).split("\r\n");
    expect(lines).toHaveLength(54);
  });

  it("writes the raw event name for a kind it has never heard of", async () => {
    // Any AdminEventName added later reaches this endpoint with no route
    // change. An unrecognised name must still produce a row, with something
    // honest and non-empty in the event column — a dropped row in a compliance
    // export is a silent claim that nothing happened.
    const { ctx, els, createdFrom } = setup(async () =>
      ok([row(0, { event: "member_teleported", actor: "Ada" })]),
    );
    await ctx.exportActivityCsv(els.get("activity-export"));
    const lines = (await rawText(createdFrom[0])).slice(1).split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"member_teleported"');
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
    //
    // This walks ALL of public/, not a hand-listed few, and matches every
    // mechanism a browser will save a file with — not just the one this tree
    // happens to use today. A test that names the current three files pins the
    // files; the invariant is "one place in public/", and a second downloader
    // added anywhere, by any means, is what this has to fail on.
    const MECHANISMS =
      /URL\.createObjectURL\(|webkitURL\.createObjectURL\(|createObjectURL\s*=|msSaveBlob|msSaveOrOpenBlob|showSaveFilePicker|toDataURL\(|\.download\s*=|download\s*=\s*["'][^"']|href\s*=\s*["'`]?\s*data:/;
    const owners: string[] = [];
    let scanned = 0;
    const walk = (dir: string) => {
      for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.(js|html|htm|css|json)$/.test(e.name)) {
          scanned++;
          if (MECHANISMS.test(readFileSync(resolve(ROOT, rel), "utf8"))) owners.push(rel);
        }
      }
    };
    walk("public");
    expect(owners).toEqual(["public/utils.js"]);

    // …and it really is the shared one, reached by both callers by name.
    for (const f of ["public/js/activity.js", "public/js/settings.js"]) {
      expect(readFileSync(resolve(ROOT, f), "utf8")).toContain("downloadTextFile(");
    }
    // A guard on the guard: the walk must actually have read the tree, not
    // silently matched nothing because the extension filter drifted.
    expect(scanned).toBeGreaterThan(15);
  });
});
