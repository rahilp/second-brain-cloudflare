/**
 * What the brief chooses to say, and — more importantly — when it says nothing.
 *
 * A home surface that manufactures activity to justify its own existence is
 * worse than an empty one, so the restraint is the feature being tested here.
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
    style: {} as Record<string, string>,
    innerHTML: "",
    className: "",
    classList: { add() {}, remove() {} },
    querySelectorAll: () => [],
    closest: () => null,
  });
  const ctx: any = {
    console,
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) els.set(id, makeEl());
        return els.get(id);
      },
      createElement: () => makeEl(),
      addEventListener() {},
      querySelectorAll: () => [],
    },
    fetch: () => Promise.reject(new Error("no network here")),
    WORKER_URL: "https://example.test",
    AUTH_TOKEN: "t",
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  for (const f of ["public/utils.js", "public/js/brief.js"]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  ctx.__els = els;
  return ctx;
}

const empty = {
  ok: true,
  window_hours: 48,
  captured: 0,
  sources: [],
  patterns: [],
  resurface: null,
  activity: [],
  topics: [],
  total: 0,
  attention: { unindexed: 0, stale: 0, patterns: 0 },
};

describe("the daily brief", () => {
  it("renders nothing at all on a quiet day", () => {
    const ctx = load();
    ctx.renderBrief(empty);
    expect(ctx.__els.get("brief").style.display).not.toBe("");
    expect(ctx.__els.get("brief").innerHTML).toBe("");
    // …and leaves the welcome hero in place rather than replacing it with a
    // panel announcing that nothing happened.
    expect(ctx.__els.get("recall-welcome").style.display).not.toBe("none");
  });

  it("leaves the headline count to the greeting and shows the panels", () => {
    const ctx = load();
    ctx.renderBrief({
      ...empty,
      captured: 12,
      sources: [{ source: "claude-desktop", count: 9 }, { source: "email-gmail", count: 3 }],
    });
    const html = ctx.__els.get("brief").innerHTML;
    // The home greeting carries "N memories · N this week"; a second count
    // here was the same fact twice.
    expect(html).toContain("Where from");
    expect(html).toContain("Your brain, lately");
    expect(ctx.__els.get("recall-welcome").style.display).toBe("none");
  });

  it("puts pending patterns where they can actually be decided", () => {
    const ctx = load();
    ctx.renderBrief({
      ...empty,
      patterns: [
        { id: "p1", content: "You keep deferring the pricing decision." },
        { id: "p2", content: "You review PRs in the evening." },
        { id: "p3", content: "A third that should not crowd the screen." },
      ],
    });
    const html = ctx.__els.get("brief").innerHTML;
    expect(html).toContain("Insight noticed");
    expect(html).toContain("Confirm");
    expect(html).toContain("Dismiss");
    // Two is a brief; three is a queue.
    expect(html.match(/Insight noticed/g)).toHaveLength(2);
    // A third one is pending behind the two shown, so there has to be a way to
    // it — the "⋯" menu's Upkeep group is invisible unless a chore happens to
    // be waiting, which is not a door most people find.
    expect(html).toContain("openPatternsSheet()");
  });

  it("renders the whole insight, not a title-length clip of it", () => {
    const ctx = load();
    // One sentence, deliberately past the old 140-char title budget — this is
    // an ordinary length for what the weekly pass writes, not an edge case.
    const sentence =
      "That same workflow now automatically captures the release PR you merge, which is exactly the kind of duplication you spent March complaining about and then quietly automated away in April.";
    expect(sentence.length).toBeGreaterThan(140);
    ctx.renderBrief({
      ...empty,
      patterns: [{ id: "p1", content: `${sentence}\n\n[Insight: throughline — drawn from 2 memories]` }],
    });
    const html = ctx.__els.get("brief").innerHTML;
    // The whole sentence, verbatim. Confirm/Dismiss ask for a decision on
    // text a person can actually finish reading.
    expect(html).toContain(sentence);
    expect(html).not.toContain("…");
    // The provenance line is bookkeeping for the pass, not something to read
    // back to the person who has to rule on this.
    expect(html).not.toContain("[Insight:");
    expect(html).not.toContain("drawn from 2 memories");
    // ...but the shape of the observation is genuinely informative, so it is
    // surfaced deliberately rather than thrown away with the rest of the line.
    expect(html).toContain("Throughline");
  });

  it("offers a way to the rest of the queue only when there is a rest", () => {
    const ctx = load();
    ctx.renderBrief({
      ...empty,
      patterns: [
        { id: "p1", content: "You keep deferring the pricing decision." },
        { id: "p2", content: "You review PRs in the evening." },
      ],
    });
    // Exactly two pending, exactly two shown — nothing waits behind them.
    expect(ctx.__els.get("brief").innerHTML).not.toContain("openPatternsSheet()");
  });

  it("reads generically until the real count is known, then says exactly how many", () => {
    const ctx = load();
    const threePending = {
      ...empty,
      patterns: [
        { id: "p1", content: "You keep deferring the pricing decision." },
        { id: "p2", content: "You review PRs in the evening." },
        { id: "p3", content: "A third that should not crowd the screen." },
      ],
    };
    ctx.renderBrief(threePending);
    expect(ctx.__els.get("brief").innerHTML).toContain("More insights are waiting");

    ctx.renderBrief({ ...threePending, patternsTotal: 214 });
    // 214 total, 2 already on screen as cards — 212 are genuinely elsewhere.
    expect(ctx.__els.get("brief").innerHTML).toContain("212 more insights waiting");
  });

  it("asks for the real total only once the brief already knows there is more", async () => {
    const ctx = load();
    const calls: string[] = [];
    ctx.fetch = async (url: string) => {
      calls.push(url);
      if (url.includes("/patterns")) return { ok: true, json: async () => ({ ok: true, total: 214 }) };
      return {
        ok: true,
        json: async () => ({
          ...empty,
          patterns: [
            { id: "p1", content: "You keep deferring the pricing decision." },
            { id: "p2", content: "You review PRs in the evening." },
            { id: "p3", content: "A third that should not crowd the screen." },
          ],
        }),
      };
    };
    await ctx.loadBrief();
    expect(calls.some((u) => u.includes("/patterns?limit=1"))).toBe(true);
    expect(ctx.__els.get("brief").innerHTML).toContain("212 more insights waiting");
  });

  it("does not pay for a count nobody needs when nothing is waiting behind the brief", async () => {
    const ctx = load();
    const calls: string[] = [];
    ctx.fetch = async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ ...empty, patterns: [{ id: "p1", content: "The only one pending." }] }) };
    };
    await ctx.loadBrief();
    // Just the one /brief call — no seventh query for a number the resting
    // state of the app does not need.
    expect(calls).toHaveLength(1);
  });

  it("dates the resurfaced memory by name, not 8/2/2026", () => {
    const ctx = load();
    ctx.renderBrief({
      ...empty,
      resurface: { id: "r", content: "The pricing floor is $6k.", created_at: Date.UTC(2026, 1, 8, 12) },
    });
    const html = ctx.__els.get("brief").innerHTML;
    expect(html).toContain("Worth re-reading");
    expect(html).toContain("Feb 8, 2026");
  });

  it("leaves topics to the home input rather than repeating them", () => {
    const ctx = load();
    ctx.renderBrief({ ...empty, topics: [{ tag: "signpath", count: 7 }], attention: { unindexed: 1, stale: 0, patterns: 0 } });
    // The chips under the greeting already offer these as questions; a second
    // copy in a panel is the same thing twice on one screen.
    expect(ctx.__els.get("brief").innerHTML).not.toContain("Lately about");
  });

  it("keeps the days nothing happened in the activity strip", () => {
    const ctx = load();
    ctx.renderBrief({
      ...empty,
      activity: [
        { day: 1, count: 0 },
        { day: 2, count: 8 },
        { day: 3, count: 0 },
      ],
    });
    const html = ctx.__els.get("brief").innerHTML;
    // Dropping empty days would turn a quiet fortnight into a busy-looking one.
    // Counting elements, not the substring: "spark-bar" also appears inside
    // "spark-bar--empty".
    expect(html.match(/<span class="spark-bar/g)).toHaveLength(3);
    expect(html.match(/spark-bar--empty/g)).toHaveLength(2);
  });

  it("shows where memories came from in proportion", () => {
    const ctx = load();
    ctx.renderBrief({
      ...empty,
      captured: 10,
      sources: [{ source: "claude-desktop", count: 8 }, { source: "cli", count: 2 }],
    });
    const html = ctx.__els.get("brief").innerHTML;
    expect(html).toContain("Where from");
    expect(html).toContain("ti-message-2");   // Claude's badge
    expect(html).toContain("ti-terminal-2");  // and the CLI is a terminal
    expect(html).toContain("width:80%");
  });

  it("asks for attention only when something actually needs it", () => {
    const ctx = load();
    ctx.renderBrief({ ...empty, captured: 3, attention: { unindexed: 0, stale: 0, patterns: 0 } });
    expect(ctx.__els.get("brief").innerHTML).not.toContain("class=\"attn\"");

    // Reason enough to render on its own: a brain whose only news is
    // "2 not searchable" still has to say so, with no panels to carry it.
    ctx.renderBrief({ ...empty, attention: { unindexed: 2, stale: 5, patterns: 0 } });
    const html = ctx.__els.get("brief").innerHTML;
    expect(html).toContain("2 not searchable");
    expect(html).toContain("5 may be out of date");
  });

  // The count comes from an exact tag predicate, so the entries behind it are
  // knowable exactly. This chip used to fire a free-text recall for the phrase
  // "What might be out of date?" — a vector search that returns the flagged
  // entries only by coincidence. On a real brain it answered with two memories
  // that merely contained the words, and said outright that it could not tell
  // what was out of date. It opens the queue now.
  it("opens the review queue from the out-of-date chip rather than searching for the phrase", () => {
    const ctx = load();
    ctx.renderBrief({ ...empty, attention: { unindexed: 0, stale: 1, patterns: 0 } });

    const html = ctx.__els.get("brief").innerHTML;
    expect(html).toContain("1 may be out of date");
    expect(html).toContain("openStaleSheet()");
    expect(html).not.toContain("sendSuggestion");
  });

  // Regression: loadBrief() used to call renderBrief(briefData) directly and
  // then, on the first load, also call returnHome(), which itself renders
  // the brief again. Two un-awaited renderBoard() runs raced, doubling every
  // tile and panel. Spies on renderBoard (via renderBrief's own dispatch) to
  // count how many render passes the first load actually triggers.
  it("the first load renders the board exactly once, even though returnHome also renders", async () => {
    const ctx = load();
    let renderBoardCalls = 0;
    ctx.renderBoard = () => { renderBoardCalls += 1; };
    // Stands in for home.js's real returnHome, which re-renders the cached
    // brief itself. Defined inside the vm context (rather than as a plain host
    // function assigned to ctx.returnHome) so it closes over brief.js's own
    // module-scoped `briefData`, exactly as the real returnHome does.
    vm.runInContext("function returnHome() { renderBrief(briefData); }", ctx);
    ctx.fetch = async () => ({ ok: true, json: async () => ({ ...empty }) });
    await ctx.loadBrief();
    expect(renderBoardCalls).toBe(1);
  });
});
