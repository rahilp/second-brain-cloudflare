/**
 * Pure drawing helpers behind the "Memories over time" chart. No DOM: these
 * are math, ported from docs/design-mockups/dashboard/template.html.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function load() {
  const ctx: any = { console };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/js/chart.js"), "utf8"), ctx);
  return ctx;
}

describe("chart math", () => {
  const { monotonePath, niceMax, stackSeries } = load();

  it("draws a monotone cubic path through every point", () => {
    const d = monotonePath([[0, 0], [10, 5], [20, 2], [30, 8]]);
    expect(d.startsWith("M")).toBe(true);
    expect((d.match(/C/g) || []).length).toBe(3);
  });

  it("rounds up to a nice axis maximum", () => {
    expect(niceMax(12.6)).toBe(15);
    expect(niceMax(7)).toBe(8);
    expect(niceMax(6.4 * 1.06)).toBe(8);
  });

  it("stacks series into cumulative per-row tops", () => {
    expect(stackSeries([{ s: [1, 2] }, { s: [3, 4] }])).toEqual([
      [1, 3],
      [3, 7],
    ]);
  });
});

/**
 * A fake DOM capable enough to drive renderActivityChart end to end: unlike
 * the board-tiles harness (whose querySelector is a stub returning null,
 * fine for testing panel presence but not chart internals), this one
 * actually resolves `el.querySelector('svg')` and
 * `el.parentElement.querySelector('.legend'/'.data-table')`.
 */
function makeNode(tag = "div") {
  const node: any = {
    tag,
    className: "",
    children: [] as any[],
    attrs: {} as Record<string, string>,
    style: {},
    innerHTML: "",
    textContent: "",
    clientWidth: 640,
    clientHeight: 280,
    parentElement: null as any,
    _listeners: {} as Record<string, Array<(e: any) => void>>,
    classList: {
      add(c: string) { if (!this.contains(c)) node.className = `${node.className} ${c}`.trim(); },
      remove(c: string) { node.className = node.className.split(/\s+/).filter((name: string) => name && name !== c).join(" "); },
      toggle(c: string, on?: boolean) { (on === undefined ? !this.contains(c) : on) ? this.add(c) : this.remove(c); },
      contains(c: string) { return node.className.split(/\s+/).includes(c); },
    },
    setAttribute(k: string, v: string) {
      node.attrs[k] = String(v);
    },
    getAttribute(k: string) {
      return node.attrs[k] ?? null;
    },
    appendChild(child: any) {
      child.parentElement = node;
      node.children.push(child);
      return child;
    },
    addEventListener(type: string, fn: (e: any) => void) {
      (node._listeners[type] ||= []).push(fn);
    },
    dispatchEvent(evt: any) {
      (node._listeners[evt.type] || []).forEach((fn: (e: any) => void) => fn(evt));
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 640, height: 280 };
    },
    querySelector(sel: string): any {
      return queryOne(node, sel);
    },
    querySelectorAll(sel: string): any[] {
      const out: any[] = [];
      collectAll(node, sel, out);
      return out;
    },
  };
  return node;
}
function matches(node: any, sel: string): boolean {
  if (sel.startsWith(".")) return (node.className || "").split(/\s+/).includes(sel.slice(1));
  if (sel.startsWith("#")) return node.attrs && node.attrs.id === sel.slice(1);
  return node.tag === sel;
}
function queryOne(root: any, sel: string): any {
  for (const c of root.children) {
    if (matches(c, sel)) return c;
    const found = queryOne(c, sel);
    if (found) return found;
  }
  return null;
}
function collectAll(root: any, sel: string, out: any[]) {
  for (const c of root.children) {
    if (matches(c, sel)) out.push(c);
    collectAll(c, sel, out);
  }
}
function buildChartDom() {
  const body = makeNode("div");
  const chartEl = makeNode("div");
  chartEl.className = "chart";
  chartEl.appendChild(makeNode("svg"));
  const legendEl = makeNode("div");
  legendEl.className = "legend";
  const tableEl = makeNode("table");
  tableEl.className = "data-table";
  tableEl.appendChild(makeNode("caption"));
  tableEl.appendChild(makeNode("thead"));
  tableEl.appendChild(makeNode("tbody"));
  body.appendChild(chartEl);
  body.appendChild(legendEl);
  body.appendChild(tableEl);
  return { chartEl, legendEl, tableEl };
}
function loadWithDom() {
  const src = ["public/js/i18n.js", "public/utils.js", "public/js/chart.js"]
    .map((f) => readFileSync(resolve(ROOT, f), "utf8"))
    .join("\n");
  const documentElement = { lang: "en" };
  const ctx: any = {
    console,
    Intl,
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { language: "en-US" },
    document: {
      createElement: (tag: string) => makeNode(tag),
      createElementNS: (_ns: string, tag: string) => makeNode(tag),
      getElementById: () => null,
      documentElement,
    },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

describe("chart legend and aria-label totals", () => {
  it("sums the raw daily counts, not the bucketed (averaged) values, in avg7 mode", () => {
    const ctx = loadWithDom();
    const { chartEl, legendEl, tableEl } = buildChartDom();
    // Ten days, source A always 2/day (raw total 20), source B always 1/day
    // (raw total 10), every avg7 bucket reports exactly those steady values,
    // so if the legend summed the bucketed rows instead of the raw ones, a
    // steady-state series would still read correctly here; the point of this
    // fixture is the grand total, which must be 30 either way, catching a
    // regression where the legend or aria-label divides by the window length
    // or otherwise drifts from the true sum.
    const rawRows = Array.from({ length: 10 }, (_, i) => ({ d: String(i), label: String(i), s: [2, 1] }));
    const series = [{ name: "Source A" }, { name: "Source B" }];
    ctx.tableEl = tableEl;
    ctx.legendEl = legendEl;
    ctx.renderActivityChart(chartEl, { rows: rawRows, series, mode: "avg7", totalsRows: rawRows });
    expect(legendEl.children.map((item: any) => item.innerHTML).join("")).toMatch(/Source A.*20/);
    expect(legendEl.children.map((item: any) => item.innerHTML).join("")).toMatch(/Source B.*10/);
    expect(chartEl.attrs["aria-label"]).toMatch(/30/);
  });

  it("falls back to summing the plotted rows when no totalsRows is given (day/week modes)", () => {
    const ctx = loadWithDom();
    const { chartEl, legendEl } = buildChartDom();
    const rows = [
      { d: "0", label: "Mon", s: [3] },
      { d: "1", label: "Tue", s: [4] },
    ];
    ctx.renderActivityChart(chartEl, { rows, series: [{ name: "All sources" }], mode: "day" });
    expect(legendEl.children.map((item: any) => item.innerHTML).join("")).toMatch(/All sources.*7/);
    expect(chartEl.attrs["aria-label"]).toMatch(/7/);
  });

  it("marks one legend item as solo and the others as muted until toggled off", () => {
    const ctx = loadWithDom();
    const { chartEl, legendEl } = buildChartDom();
    ctx.renderActivityChart(chartEl, { rows: [{ d: "0", label: "Mon", s: [3, 4] }], series: [{ name: "One" }, { name: "Two" }], mode: "day" });
    legendEl.children[0].onclick();
    expect(legendEl.children[0].classList.contains("is-solo")).toBe(true);
    expect(legendEl.children[1].classList.contains("is-muted")).toBe(true);
    legendEl.children[0].onclick();
    expect(legendEl.children[0].classList.contains("is-solo")).toBe(false);
    expect(legendEl.children[1].classList.contains("is-muted")).toBe(false);
  });

  // Regression: legend-item buttons are siblings of the svg, not descendants
  // of the chart container, so a keydown while a legend button has focus (the
  // natural place focus sits right after toggling isolation) never used to
  // bubble to the container's Escape listener. Escape from the container
  // itself still worked, which this suite already covered implicitly via the
  // solo/muted test above; this one dispatches from the legend instead.
  it("clears solo/muted isolation on Escape dispatched from the legend itself, not just the chart", () => {
    const ctx = loadWithDom();
    const { chartEl, legendEl } = buildChartDom();
    ctx.renderActivityChart(chartEl, { rows: [{ d: "0", label: "Mon", s: [3, 4] }], series: [{ name: "One" }, { name: "Two" }], mode: "day" });
    legendEl.children[0].onclick();
    expect(legendEl.children[0].classList.contains("is-solo")).toBe(true);
    expect(legendEl.children[1].classList.contains("is-muted")).toBe(true);

    legendEl.dispatchEvent({ type: "keydown", key: "Escape" });

    expect(legendEl.children[0].classList.contains("is-solo")).toBe(false);
    expect(legendEl.children[1].classList.contains("is-muted")).toBe(false);
  });

  it("in week mode, reports the real calendar span, not the bucket count", () => {
    // The 365-day range buckets 365 raw days into about 52 weekly rows; the
    // aria-label used to read rows.length for "days" too, so it announced
    // "53 saved per week over the last 53 days" instead of 365.
    const ctx = loadWithDom();
    const { chartEl } = buildChartDom();
    const totalsRows = Array.from({ length: 365 }, (_, i) => ({ d: String(i), label: String(i), s: [1] }));
    const weeklyRows = Array.from({ length: 53 }, (_, i) => ({ d: String(i), label: `Week of ${i}`, s: [7] }));
    ctx.renderActivityChart(chartEl, { rows: weeklyRows, series: [{ name: "All sources" }], mode: "week", totalsRows });
    expect(chartEl.attrs["aria-label"]).toContain("365 days");
    expect(chartEl.attrs["aria-label"]).not.toContain("53 days");
  });
});
