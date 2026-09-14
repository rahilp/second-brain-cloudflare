/**
 * Ending a conversation without ending the screen.
 *
 * `clearRecall` wiped the container's innerHTML, which was safe for as long as
 * the container held nothing but bubbles. Home, the brief and the board moved
 * in with them, and the wipe took all three, permanently, because the desktop
 * app runs this page in a window with no address bar and no reload.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

/** A container holding home, the board, the brief, the hero, and one exchange after them. */
function load() {
  const children = [
    { id: "home", style: { display: "none" } },
    { id: "board-tiles", style: {} },
    { id: "board", style: {} },
    { id: "brief", style: {} },
    { id: "recall-welcome", style: {} },
    { id: "", style: {} }, // the question bubble
    { id: "", style: {} }, // the answer
  ];
  const els = new Map<string, any>([
    ["recall-messages", {
      get children() { return children; },
      remove: () => {},
    }],
    ["recall-clear-btn", { style: { display: "flex" } }],
  ]);
  for (const c of children as any[]) {
    c.remove = () => {
      const i = children.indexOf(c);
      if (i >= 0) children.splice(i, 1);
    };
  }
  const ctx: any = {
    console,
    children,
    returnedHome: false,
    document: {
      getElementById: (id: string) => els.get(id) ?? null,
      createElement: () => ({ className: "", innerHTML: "", querySelector: () => ({}), appendChild() {} }),
      addEventListener() {},
    },
  };
  ctx.returnHome = () => { ctx.returnedHome = true; };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/js/ui-chat.js"), "utf8"), ctx);
  return ctx;
}

describe("clearing the conversation", () => {
  it("removes the exchange", () => {
    const ctx = load();
    ctx.clearRecall();
    expect(ctx.children.filter((c: any) => !c.id)).toHaveLength(0);
  });

  it("keeps home, the board, the brief and the hero", () => {
    const ctx = load();
    ctx.clearRecall();
    expect(ctx.children.map((c: any) => c.id)).toEqual(["home", "board-tiles", "board", "brief", "recall-welcome"]);
  });

  it("returns to home rather than to an empty column", () => {
    const ctx = load();
    ctx.clearRecall();
    expect(ctx.returnedHome).toBe(true);
  });

  it("hides its own button, having nothing left to clear", () => {
    const ctx = load();
    ctx.clearRecall();
    expect(ctx.document.getElementById("recall-clear-btn").style.display).toBe("none");
  });
});
