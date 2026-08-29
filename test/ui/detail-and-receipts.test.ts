/**
 * Tier 2's two rendering decisions: how a memory's verdicts are put into
 * words, and what a capture tells you it did.
 *
 * Both translate pipeline state into sentences, which is exactly where a
 * wrong mapping is invisible in a screenshot — `volatility:state` rendering
 * as "Durable" would look perfectly fine and be a lie.
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
    title: "",
    value: "",
    textContent: "",
    innerHTML: "",
    className: "",
    onclick: null as any,
    style: {} as Record<string, string>,
    attrs: {} as Record<string, string>,
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      toggle(c: string, on?: boolean) {
        if (on ?? !classes.has(c)) classes.add(c);
        else classes.delete(c);
      },
      contains: (c: string) => classes.has(c),
    },
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    },
    getAttribute(name: string) {
      return this.attrs[name] ?? null;
    },
    appendChild() {},
    remove() {},
    focus() {},
    closest: () => null,
    dataset: {} as any,
    querySelectorAll: () => [] as any[],
    querySelector: () => null as any,
  };
}

function load(fetchImpl?: (url: string, init?: any) => Promise<any>): any {
  const els = new Map<string, any>();
  const calls: Array<{ url: string; init?: any }> = [];
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
    // Nothing in the detail sheet may reach a browser dialog.
    confirm: () => {
      throw new Error("confirm() must not be used");
    },
    alert: () => {
      throw new Error("alert() must not be used");
    },
    setTimeout: (fn: () => void) => fn(),
    clearTimeout: () => {},
    refreshAll: () => {},
    fetch: (url: string, init?: any) => {
      calls.push({ url, init });
      if (fetchImpl) return fetchImpl(url, init);
      return Promise.reject(new Error("no network in this test"));
    },
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of [
    "public/utils.js",
    "public/js/toast.js",
    "public/js/confirm-sheet.js",
    "public/js/memory-crud.js",
    "public/js/remember.js",
  ]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  return ctx;
}

describe("memory detail — what the brain knows", () => {
  it("puts each verdict into words rather than showing the tag", () => {
    const ctx = load();
    ctx.renderViewBrain({
      tags: ["work", "kind:semantic", "status:canonical", "volatility:state"],
      importance_score: 4,
      recall_count: 7,
    });
    const html = ctx.__els.get("view-brain").innerHTML;
    expect(html).toContain("Fact");        // kind:semantic
    expect(html).toContain("Trusted");     // status:canonical
    expect(html).toContain("Current");     // volatility:state
    expect(html).toContain("verify");      // the gloss, not the raw value
    expect(html).toContain("7 times");
    expect(html).not.toContain("kind:");   // never the storage syntax
  });

  it("draws importance as dots so a number out of five means something", () => {
    const ctx = load();
    ctx.renderViewBrain({ tags: [], importance_score: 3 });
    const html = ctx.__els.get("view-brain").innerHTML;
    expect(html).toContain("●●●○○");
  });

  it("stays silent about contradictions that never happened", () => {
    const ctx = load();
    ctx.renderViewBrain({ tags: [], importance_score: 2, contradiction_losses: 0 });
    expect(ctx.__els.get("view-brain").innerHTML).not.toContain("disagreed");

    ctx.renderViewBrain({ tags: [], importance_score: 2, contradiction_losses: 2 });
    expect(ctx.__els.get("view-brain").innerHTML).toContain("disagreed with this 2 times");
  });

  it("warns when recall cannot see the memory at all", () => {
    const ctx = load();
    ctx.renderViewBrain({ tags: [], indexed: false });
    expect(ctx.__els.get("view-brain").innerHTML).toContain("Not indexed");
  });

  it("keeps the facts together and the caveats after them", () => {
    const ctx = load();
    ctx.renderViewBrain({
      tags: ["volatility:state"],
      importance_score: 3,
      recall_count: 5,
      contradiction_losses: 1,
    });
    const html = ctx.__els.get("view-brain").innerHTML;
    // A sentence between two rows breaks the list it is explaining.
    expect(html.indexOf("Recalled")).toBeLessThan(html.indexOf("verify"));
    expect(html.indexOf("verify")).toBeLessThan(html.indexOf("disagreed"));
  });

  it("hides itself entirely when there is nothing to report", () => {
    const ctx = load();
    ctx.renderViewBrain({ tags: [] });
    expect(ctx.__els.get("view-brain").style.display).toBe("none");
  });
});

describe("citation chips", () => {
  function render(text: string) {
    const ctx: any = {
      console,
      document: { documentElement: { lang: "en" }, querySelectorAll: () => [] },
      escAttr: (s: string) => String(s).replace(/"/g, "&quot;"),
      escHtml: (s: string) => String(s),
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    installI18n(ctx, "en");
    vm.runInContext(readFileSync(resolve(ROOT, "public/js/ui-chat.js"), "utf8"), ctx);
    return ctx.renderAnswerMarkdown(text) as string;
  }

  it("turns a bracketed number into a chip carrying its source index", () => {
    const html = render("On Aug 6 you shipped 2.2.3 [1], then fixed import [3].");
    expect(html).toContain('data-cite="1"');
    expect(html).toContain('data-cite="3"');
  });

  it("leaves prose untouched when there is nothing to cite", () => {
    expect(render("No citations here.")).not.toContain("cite");
  });

  it("renders every bullet marker a model actually emits", () => {
    // Observed live: the answer used "+" and the list rendered as literal
    // "+ Achieve nearly 40% of the annual target" paragraphs.
    for (const marker of ["*", "-", "+", "•"]) {
      const html = render(`Goals:\n${marker} First\n${marker} Second`);
      expect(html, marker).toContain("<ul>");
      expect(html, marker).toContain("<li>First</li>");
    }
  });
});

describe("dates handed to the model", () => {
  it("names the month, because 8/2/2026 is two different days", () => {
    // The answer prompt asks for dated claims. With a numeric date the model
    // read an August memory as "8 February 2026" and said so to the user.
    const formatted = new Date(Date.UTC(2026, 7, 2, 12)).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    expect(formatted).toBe("Aug 2, 2026");
    expect(formatted).not.toMatch(/^\d+\/\d+/);
  });

  it("leaves no locale-dependent date anywhere a model or reader will see it", () => {
    // Every one of these ends up in text an assistant reads back: recall
    // blocks, staleness qualifiers, link provenance, and the "[Update <date>]"
    // separator written into stored content.
    for (const f of [
      "src/recall/render.ts",
      "src/memory/stale.ts",
      "src/mcp/server.ts",
      "src/capture/store.ts",
      "public/js/recall.js",
      "public/js/memory-crud.js",
    ]) {
      expect(readFileSync(resolve(ROOT, f), "utf8"), f).not.toMatch(/toLocaleDateString\(\)/);
    }
  });

  it("is the format the client serializer actually uses", () => {
    const src = readFileSync(resolve(ROOT, "public/js/recall.js"), "utf8");
    // The line that builds the /chat payload must not fall back to the
    // locale-dependent default.
    expect(src).toMatch(/toLocaleDateString\('en-US', \{ year: 'numeric', month: 'short', day: 'numeric' \}\)/);
    expect(src).not.toMatch(/toLocaleDateString\(\)/);
  });
});

describe("capture receipts", () => {
  const headline = (result: any, typed: string[] = []) => {
    const ctx = load();
    return ctx.captureReceipt(result, typed).innerHTML as string;
  };

  it("reports the plain case as stored, with what it was filed under", () => {
    const html = headline({ ok: true, id: "x", tags: ["work", "pricing", "kind:episodic"] });
    expect(html).toContain("stored to brain");
    expect(html).toContain("work");
    expect(html).toContain("pricing");
    // System tags are the brain's bookkeeping, not something to report back.
    expect(html).not.toContain("kind:episodic");
  });

  it("shows tags the pipeline found in the content, not just the ones typed", () => {
    const html = headline({ ok: true, id: "x", tags: ["from-content"] }, ["typed"]);
    expect(html).toContain("from-content");
  });

  it("names each outcome the capture pipeline can reach", () => {
    expect(headline({ action: "merged" })).toContain("merged into an existing memory");
    expect(headline({ action: "replaced" })).toContain("replaced an outdated memory");
    expect(headline({ resolved_conflict: "abc" })).toContain("something older now disagrees");
    expect(headline({ kept_canonical: "abc" })).toContain("stored as a draft");
    expect(headline({ warning: "similar" })).toContain("close to something you already had");
  });

  it("explains an outcome rather than only labelling it", () => {
    expect(headline({ action: "merged" })).toContain("You had written about this before");
    expect(headline({ kept_canonical: "abc" })).toContain("kept unconfirmed");
  });
});

/**
 * Removing a link between two memories.
 *
 * Irreversible enough to be worth asking about, and it used to ask with a
 * browser confirm() — untranslatable past the browser's own UI language and
 * visually unrelated to everything around it. It now goes through the one
 * shared destructive-action sheet.
 */
describe("removing a link", () => {
  /** A stand-in for the #view-related container, with one connection row. */
  function relatedContainer() {
    const open = { onclick: null as any };
    const unlink = { onclick: null as any };
    const row = {
      dataset: { id: "c1", type: "relates_to" },
      querySelector: (sel: string) => (sel === ".related-open" ? open : unlink),
    };
    return {
      style: {} as Record<string, string>,
      innerHTML: "",
      querySelectorAll: () => [row],
      __unlink: unlink,
    };
  }

  const CONNECTIONS = {
    ok: true,
    connections: [{ id: "c1", type: "relates_to", label: "Relates to", provenance: "explicit", content: "The other memory", linkedAt: 1 }],
  };

  async function openedSheet() {
    const ctx = load(async (url: string) => {
      if (url.includes("/connections")) return { ok: true, json: async () => CONNECTIONS };
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const el = relatedContainer();
    await ctx.loadRelated("m1", el);
    return { ctx, el };
  }

  it("asks in the app's own sheet rather than a browser dialog", async () => {
    const { ctx, el } = await openedSheet();
    await el.__unlink.onclick();
    expect(ctx.__els.get("confirm-dialog").classList.contains("open")).toBe(true);
    expect(ctx.__els.get("confirm-title").textContent).toBe("Remove this link?");
    expect(ctx.__els.get("confirm-body").textContent).toContain("only the connection is deleted");
    expect(ctx.__els.get("confirm-accept-btn").textContent).toBe("Remove link");
    // No checkbox here — there is nothing to modify about removing a link.
    expect(ctx.__els.get("confirm-check-row").style.display).toBe("none");
    // The question has been asked, not answered.
    expect((ctx.calls as any[]).some((c) => c.url.includes("/unlink"))).toBe(false);
  });

  it("only unlinks once the sheet is accepted, and then re-reads the list", async () => {
    const { ctx, el } = await openedSheet();
    await el.__unlink.onclick();
    await ctx.runConfirmAction();
    const unlink = (ctx.calls as any[]).filter((c) => c.url.includes("/unlink"));
    expect(unlink.length).toBe(1);
    expect(JSON.parse(unlink[0].init.body)).toEqual({ source_id: "m1", target_id: "c1", type: "relates_to" });
    expect(ctx.__els.get("confirm-dialog").classList.contains("open")).toBe(false);
    // The panel is refreshed so the removed row cannot linger.
    expect((ctx.calls as any[]).filter((c) => c.url.includes("/connections")).length).toBe(2);
  });

  it("leaves the link alone when the sheet is dismissed", async () => {
    const { ctx, el } = await openedSheet();
    await el.__unlink.onclick();
    ctx.closeConfirm();
    await ctx.runConfirmAction();
    expect((ctx.calls as any[]).some((c) => c.url.includes("/unlink"))).toBe(false);
  });
});
