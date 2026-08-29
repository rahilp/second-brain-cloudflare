/**
 * Ruling on a backlog of patterns.
 *
 * Two cards on the home brief is a daily nudge. A brain that has been running
 * for months has a queue, and the old panel offered no way through it: it
 * fetched twenty rows, dropped the dismissed ones in the browser, and rendered
 * nothing once there were twenty dismissals — while real patterns waited behind
 * them. What is tested here is the selection: what "select all" means, what
 * leaves the list after an action, and that a failed request does not pretend
 * anything was resolved.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect, vi } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * `team` reaches `patternRow` through the TEAM_MODE global the review queue
 * reads, exactly as `checkVectorize` sets it in the page. Defaulted to false so
 * every assertion written before the layer chip existed sees the queue it was
 * written against.
 */
function load(pages: any[] = [], { team = false }: { team?: boolean } = {}) {
  const els = new Map<string, any>();
  const checks: any[] = [];
  const makeEl = () => ({
    hidden: false,
    disabled: false,
    checked: false,
    indeterminate: false,
    innerHTML: "",
    textContent: "",
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, contains: () => false },
    querySelectorAll: () => [],
  });
  const sent: any[] = [];
  let pageIndex = 0;
  const ctx: any = {
    console,
    sent,
    checks,
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
    TEAM_MODE: team,
    closeMenu: () => {},
    openMenu: () => {},
    refreshAll: () => {},
    setTimeout: (fn: () => void) => fn(),
    fetch: async (url: string, init?: any) => {
      if (init?.method === "POST") {
        sent.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ ok: true, resolved: JSON.parse(init.body).ids.length, ids: JSON.parse(init.body).ids, skipped: 0 }) };
      }
      const page = pages[Math.min(pageIndex++, pages.length - 1)] ?? { ok: true, patterns: [], total: 0 };
      return { ok: true, json: async () => page };
    },
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl());
        return els.get(id);
      },
      createElement: () => makeEl(),
      addEventListener() {},
      // The only selector the module uses, for ticking every visible box.
      querySelectorAll: (sel: string) => (sel === "#patterns-list .pattern-check" ? checks : []),
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of ["public/utils.js", "public/js/patterns.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  return ctx;
}

const page = (n: number, total = n, from = 0) => ({
  ok: true,
  total,
  patterns: Array.from({ length: n }, (_, i) => ({
    id: `p${from + i}`,
    content: `You tend to do thing ${from + i}`,
    created_at: Date.UTC(2026, 1, 8, 12),
  })),
});

describe("loading the queue", () => {
  it("renders every pattern it was given", async () => {
    const ctx = load([page(3)]);
    await ctx.loadPatternQueue();
    const html = ctx.__els.get("patterns-list").innerHTML;
    expect(html.match(/class="pattern-row"/g)).toHaveLength(3);
    expect(html).toContain("Feb 8, 2026");
  });

  it("offers the rest when the queue is longer than the page", async () => {
    const ctx = load([page(50, 214)]);
    await ctx.loadPatternQueue();
    expect(ctx.__els.get("patterns-more").hidden).toBe(false);
    expect(ctx.__els.get("patterns-more").textContent).toContain("164 more");
  });

  it("says nothing about more when the page is the whole queue", async () => {
    const ctx = load([page(4)]);
    await ctx.loadPatternQueue();
    expect(ctx.__els.get("patterns-more").hidden).toBe(true);
  });

  it("strips the pass's own provenance line and shows the shape instead", async () => {
    const ctx = load([
      {
        ok: true,
        total: 1,
        patterns: [
          {
            id: "p1",
            content:
              "You keep circling back to the same onboarding complaint.\n\n[Insight: throughline — drawn from 2 memories]",
            created_at: Date.UTC(2026, 1, 8, 12),
          },
        ],
      },
    ]);
    await ctx.loadPatternQueue();
    const html = ctx.__els.get("patterns-list").innerHTML;
    // The sentence a person should read, verbatim...
    expect(html).toContain("You keep circling back to the same onboarding complaint.");
    // ...not the bookkeeping the pass appended to it.
    expect(html).not.toContain("[Insight:");
    expect(html).not.toContain("drawn from 2 memories");
    // The shape is worth keeping, alongside the date it was noticed.
    expect(html).toContain("Throughline");
    expect(html).toContain("Feb 8, 2026");
  });

  it("appends the next page rather than replacing the current one", async () => {
    const ctx = load([page(50, 60), page(10, 60, 50)]);
    await ctx.loadPatternQueue();
    await ctx.loadPatternQueue({ append: true });
    expect(ctx.__els.get("patterns-list").innerHTML.match(/class="pattern-row"/g)).toHaveLength(60);
    expect(ctx.__els.get("patterns-more").hidden).toBe(true);
  });

  it("says so plainly when nothing is waiting", async () => {
    const ctx = load([{ ok: true, patterns: [], total: 0 }]);
    await ctx.loadPatternQueue();
    expect(ctx.__els.get("patterns-bulkbar").hidden).toBe(true);
    expect(ctx.__els.get("patterns-list").innerHTML).toContain("been ruled on");
  });

  it("shows the memories an insight was drawn from", async () => {
    const ctx = load([{
      ok: true, total: 1,
      patterns: [{
        id: "p0", content: "An insight", created_at: Date.UTC(2026, 1, 8),
        sources: [{ id: "m1", content: "The first source" }, { id: "m2", content: "The second source" }],
      }],
    }]);

    await ctx.loadPatternQueue();

    const html = ctx.__els.get("patterns-list").innerHTML;
    expect(html).toContain("The first source");
    expect(html).toContain("The second source");
  });

  it("says a source is gone rather than showing a blank", async () => {
    const ctx = load([{
      ok: true, total: 1,
      patterns: [{ id: "p0", content: "An insight", created_at: Date.UTC(2026, 1, 8), sources: [{ id: "m1", missing: true }] }],
    }]);

    await ctx.loadPatternQueue();

    expect(ctx.__els.get("patterns-list").innerHTML).toContain("no longer in your brain");
  });

  it("renders an insight with no sources unchanged", async () => {
    const ctx = load([{ ok: true, total: 1, patterns: [{ id: "p0", content: "An insight", created_at: Date.UTC(2026, 1, 8), sources: [] }] }]);

    await ctx.loadPatternQueue();

    expect(ctx.__els.get("patterns-list").innerHTML).toContain("An insight");
  });
});

describe("selecting", () => {
  it("enables the actions only once something is picked", async () => {
    const ctx = load([page(3)]);
    await ctx.loadPatternQueue();
    expect(ctx.__els.get("patterns-confirm-btn").disabled).toBe(true);

    ctx.togglePatternSelection("p0", true);
    expect(ctx.__els.get("patterns-confirm-btn").disabled).toBe(false);
    expect(ctx.__els.get("patterns-dismiss-btn").disabled).toBe(false);
  });

  it("counts the selection in the buttons, so the action is unambiguous", async () => {
    const ctx = load([page(5)]);
    await ctx.loadPatternQueue();
    ctx.togglePatternSelection("p0", true);
    expect(ctx.__els.get("patterns-dismiss-btn").textContent).toBe("Dismiss");

    ctx.togglePatternSelection("p1", true);
    ctx.togglePatternSelection("p2", true);
    expect(ctx.__els.get("patterns-dismiss-btn").textContent).toBe("Dismiss 3");
    expect(ctx.__els.get("patterns-selected-label").textContent).toBe("3 selected");
  });

  it("shows a partial selection as partial, not as all or nothing", async () => {
    const ctx = load([page(5)]);
    await ctx.loadPatternQueue();
    ctx.togglePatternSelection("p0", true);
    const all = ctx.__els.get("patterns-select-all");
    expect(all.checked).toBe(false);
    expect(all.indeterminate).toBe(true);

    for (const id of ["p1", "p2", "p3", "p4"]) ctx.togglePatternSelection(id, true);
    expect(all.checked).toBe(true);
    expect(all.indeterminate).toBe(false);
  });

  it("selects what is loaded, never what has not been seen", async () => {
    // Acting on rows the user has never read is a different gesture from the one
    // they made, and the Worker refuses more than a page of ids anyway.
    const ctx = load([page(50, 214)]);
    await ctx.loadPatternQueue();
    ctx.togglePatternSelectAll(true);
    expect(ctx.__els.get("patterns-selected-label").textContent).toBe("50 selected");
  });
});

describe("acting on the selection", () => {
  it("sends one request for the whole selection", async () => {
    const ctx = load([page(12)]);
    await ctx.loadPatternQueue();
    ctx.togglePatternSelectAll(true);
    await ctx.resolveSelectedPatterns("dismiss", ctx.__els.get("patterns-dismiss-btn"));

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].action).toBe("dismiss");
    expect(ctx.sent[0].ids).toHaveLength(12);
  });

  it("takes the ruled-on rows out of the list and updates what is left", async () => {
    const ctx = load([page(50, 60)]);
    await ctx.loadPatternQueue();
    ctx.togglePatternSelection("p0", true);
    ctx.togglePatternSelection("p1", true);
    await ctx.resolveSelectedPatterns("confirm", ctx.__els.get("patterns-confirm-btn"));

    const html = ctx.__els.get("patterns-list").innerHTML;
    expect(html).not.toContain('value="p0"');
    expect(html).not.toContain('value="p1"');
    expect(html.match(/class="pattern-row"/g)).toHaveLength(48);
    // 60 total, 2 ruled on, 48 on screen → 10 still behind.
    expect(ctx.__els.get("patterns-more").textContent).toContain("10 more");
  });

  it("clears the selection so the next action cannot repeat the last one", async () => {
    const ctx = load([page(5)]);
    await ctx.loadPatternQueue();
    ctx.togglePatternSelectAll(true);
    await ctx.resolveSelectedPatterns("dismiss", ctx.__els.get("patterns-dismiss-btn"));
    expect(ctx.__els.get("patterns-confirm-btn").disabled).toBe(true);
    expect(ctx.__els.get("patterns-selected-label").textContent).toBe("Select all");
  });

  it("does nothing at all with an empty selection", async () => {
    const ctx = load([page(3)]);
    await ctx.loadPatternQueue();
    await ctx.resolveSelectedPatterns("dismiss", ctx.__els.get("patterns-dismiss-btn"));
    expect(ctx.sent).toHaveLength(0);
  });

  it("keeps the rows when the request fails", async () => {
    // Removing them optimistically and then failing would tell the user their
    // backlog shrank when it did not.
    const ctx = load([page(4)]);
    await ctx.loadPatternQueue();
    ctx.togglePatternSelectAll(true);
    ctx.fetch = async () => { throw new Error("offline"); };

    await ctx.resolveSelectedPatterns("dismiss", ctx.__els.get("patterns-dismiss-btn"));
    expect(ctx.__els.get("patterns-list").innerHTML.match(/class="pattern-row"/g)).toHaveLength(4);
  });
});

describe("the settings entry point", () => {
  it("is a count and a door, not the queue", () => {
    const ctx = load();
    ctx.renderPatternsSection(214);
    const html = ctx.__els.get("patterns-section").innerHTML;
    expect(html).toContain("214 insights are waiting");
    expect(html).toContain("Review all");
    expect(html).not.toContain("pattern-row");
  });

  it("reads naturally for a single pattern", () => {
    const ctx = load();
    ctx.renderPatternsSection(1);
    const html = ctx.__els.get("patterns-section").innerHTML;
    expect(html).toContain("1 insight is waiting");
    expect(html).toContain("Review it");
  });

  it("hides itself when the queue is empty", () => {
    const ctx = load();
    ctx.renderPatternsSection(0);
    expect(ctx.__els.get("patterns-section").style.display).toBe("none");
  });

  it("asks for one row, not the whole queue, just to show the number", async () => {
    const ctx = load([{ ok: true, patterns: [page(1).patterns[0]], total: 214 }]);
    const urls: string[] = [];
    const inner = ctx.fetch;
    ctx.fetch = (url: string, init: any) => { urls.push(url); return inner(url, init); };
    await ctx.loadPatternCount();
    expect(urls[0]).toContain("limit=1");
    expect(ctx.__els.get("patterns-section").innerHTML).toContain("214 insights");
  });
});

/**
 * The layer chip, on the review queue.
 *
 * A member opening the queue saw a list of sentences with a date and a shape,
 * and nothing told them whether the one they were about to confirm was drawn
 * from their own memories or from the team's. Dismissing your own half-formed
 * thought and dismissing something the whole team can read are different acts.
 *
 * It is the SAME function the memories card calls (`layerChipHtml`, in
 * `public/utils.js`), which is the requirement — not a second chip that looks
 * like the first.
 */
describe("the layer chip on a pattern row", () => {
  const shared = (over: Record<string, unknown> = {}) => ({
    ok: true,
    total: 1,
    patterns: [
      {
        id: "p1",
        content: "You keep circling back to the same onboarding complaint.",
        created_at: Date.UTC(2026, 1, 8, 12),
        workspace: "company",
        actor_name: "Second Brain",
        ...over,
      },
    ],
  });

  it("badges a shared pattern with its author on a team brain", async () => {
    const ctx = load([shared()], { team: true });
    await ctx.loadPatternQueue();
    const html = ctx.__els.get("patterns-list").innerHTML;
    expect(html).toContain("tag-chip--shared");
    expect(html).toContain("shared · Second Brain");
    // On the metadata line, where the date and the shape already are.
    expect(html.indexOf("tag-chip--shared")).toBeGreaterThan(html.indexOf("pattern-when"));
  });

  it("says nothing about a personal pattern", async () => {
    const ctx = load([shared({ workspace: "personal", actor_name: null })], { team: true });
    await ctx.loadPatternQueue();
    expect(ctx.__els.get("patterns-list").innerHTML).not.toContain("tag-chip--shared");
  });

  it("says nothing on a solo brain, even for a row that claims a company workspace", async () => {
    // The guard that is NOT the data guard. A solo brain's /patterns rows carry
    // workspace 'personal', so both guards agree in practice and either alone
    // would look sufficient — which is exactly why the team one is asserted
    // against a fixture the data guard would let through.
    const ctx = load([shared()], { team: false });
    await ctx.loadPatternQueue();
    expect(ctx.__els.get("patterns-list").innerHTML).not.toContain("tag-chip--shared");
  });
});
