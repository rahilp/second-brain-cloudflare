/**
 * A revoked token ends the session with a reason.
 *
 * Phase 1 made the Worker answer every guarded route with `{ ok: false, error,
 * code }`; Phase 2 taught connect() to read it. connect() was the ONLY reader.
 * So a member suspended at 10am, whose window has been open since 9, watched
 * refreshAll()'s Promise.allSettled swallow four 401s, loadRecent() keep the
 * last good list on screen and updateStatus()'s bare `catch {}` keep yesterday's
 * count in the header — with no reload button in the desktop build. Nothing told
 * them anything, ever.
 *
 * The fix is one global fetch interceptor rather than 45 call sites, so these
 * tests exist to attack the interceptor itself: that it wraps once, disarms
 * itself after the first 401, is guarded four ways, and hands every caller back
 * the very Response object it would have received.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

/** i18n.js, utils.js, state.js and auth.js, in index.html's load order. */
const SRC = ["public/js/i18n.js", "public/utils.js", "public/js/state.js", "public/js/auth.js"]
  .map((rel) => readFileSync(resolve(ROOT, rel), "utf8"))
  .join("\n");

const IDS = ["app", "auth-overlay", "auth-url", "auth-token", "auth-error", "auth-connect"];

function makeEl() {
  return {
    id: "",
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
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
}

/**
 * #auth-error counts its own writes. Self-disarming is only observable as an
 * absence — the second 401 of a burst must produce no DOM write at all — and a
 * plain field cannot tell "written once" from "written twice with the same
 * text".
 */
function makeErrorEl() {
  const el: any = makeEl();
  let text = "";
  el.writes = 0;
  Object.defineProperty(el, "textContent", {
    get: () => text,
    set(v: string) {
      text = v;
      el.writes++;
    },
    configurable: true,
  });
  return el;
}

type Stub = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  clone: () => { status: number; json: () => Promise<unknown> };
};

/**
 * A Response stub carrying only what the interceptor and its callers touch —
 * including a body that can be read exactly once. That is the whole reason
 * clone() exists: a stub with a re-readable json() would go green over an
 * interceptor that consumed the caller's body, which is the one way this
 * wrapper could break all 45 call sites at once.
 */
function makeResponse(status: number, body: unknown, counters: { clones: number }): Stub {
  const readOnce = () => {
    let used = false;
    return async () => {
      if (used) throw new TypeError("Body has already been consumed.");
      used = true;
      return body;
    };
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    json: readOnce(),
    clone: () => {
      counters.clones++;
      return { status, json: readOnce() };
    },
  };
}

/**
 * @param missing ids whose getElementById answers null, the way a trimmed
 *   desktop shell or a half-rendered page would.
 */
function setup(locale: "en" | "it" = "en", missing: string[] = []) {
  const dropped = new Set(missing);
  const elements = new Map<string, any>();
  for (const id of IDS) {
    if (dropped.has(id)) continue;
    const el = id === "auth-error" ? makeErrorEl() : makeEl();
    el.id = id;
    elements.set(id, el);
  }

  const stored = new Map<string, string>([
    ["sb_url", "http://localhost"],
    ["sb_token", "a-real-looking-token"],
  ]);
  const removed: string[] = [];
  const counters = { clones: 0 };
  const requests: string[] = [];
  let nativeCalls = 0;
  /** Swapped per test; the interceptor captured the stub below, not this. */
  let responder: (input: string) => Stub = () => makeResponse(200, { ok: true }, counters);

  const ctx: any = {
    console,
    document: {
      documentElement: { lang: "en" },
      querySelector: () => makeEl(),
      querySelectorAll: () => [],
      getElementById: (id?: string) =>
        dropped.has(id ?? "") ? null : (elements.get(id ?? "") ?? makeEl()),
      createElement: () => makeEl(),
      addEventListener() {},
      removeEventListener() {},
      body: { style: {}, appendChild() {} },
    },
    localStorage: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => stored.set(k, v),
      removeItem: (k: string) => {
        removed.push(k);
        stored.delete(k);
      },
    },
    navigator: { language: "en-US" },
    fetch: async (input: any) => {
      nativeCalls++;
      const url = typeof input === "string" ? input : input?.url;
      requests.push(url);
      return responder(url);
    },
    setTimeout,
    clearTimeout,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  ctx.initI18n(locale);

  return {
    ctx,
    els: elements,
    stored,
    removed,
    counters,
    requests,
    nativeFetch: ctx.fetch,
    calls: () => nativeCalls,
    respondWith(fn: (input: string) => Stub) {
      responder = fn;
    },
    /** WORKER_URL / AUTH_TOKEN are `let` in state.js — lexical, not on globalThis. */
    signedIn(url = "http://localhost", token = "a-real-looking-token") {
      vm.runInContext(`WORKER_URL = ${JSON.stringify(url)}; AUTH_TOKEN = ${JSON.stringify(token)}`, ctx);
    },
    token: () => vm.runInContext("AUTH_TOKEN", ctx),
    workerUrl: () => vm.runInContext("WORKER_URL", ctx),
  };
}

const unauthorized = (code: string | undefined, counters: { clones: number }) =>
  makeResponse(401, code ? { ok: false, error: "x", code } : { ok: false, error: "x" }, counters);

/**
 * A Response whose body is still in flight, and a handle to land it later.
 *
 * Every earlier test in this file hands the interceptor a body that is already
 * resolved, so `await res.clone().json()` costs one microtask and the caller
 * never notices it happened. That is precisely why three reviews read the
 * wrapper as timing-neutral. Native `fetch` resolves when the HEADERS arrive;
 * a body that has not finished streaming is normal, not pathological, and a
 * wrapper that awaits it changes when all 45 call sites resume.
 */
function makeStalledResponse(status: number, counters: { clones: number }) {
  let land: (body: unknown) => void = () => {};
  const body = new Promise<unknown>((resolve) => {
    land = resolve;
  });
  const stub: Stub = {
    ok: status >= 200 && status < 300,
    status,
    json: () => body,
    clone: () => {
      counters.clones++;
      return { status, json: () => body };
    },
  };
  return { stub, land: (value: unknown) => land(value) };
}

/** Resolves after the macrotask queue turns, so any pending `.then` has run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a revoked token ends the session", () => {
  it("drops a suspended member back to the overlay, keeping only the address", async () => {
    const h = setup();
    h.signedIn();
    h.ctx.installAuthWatch(h.ctx);
    h.respondWith(() => unauthorized("suspended", h.counters));

    await h.ctx.fetch("http://localhost/list?n=50");

    expect(h.els.get("app").style.display).toBe("none");
    expect(h.els.get("auth-overlay").style.display).toBe("flex");
    expect(h.els.get("auth-error").textContent).toBe(
      "Your account is suspended. Ask a team admin to restore it.",
    );
    expect(h.token()).toBe("");
    expect(h.removed).toContain("sb_token");
    expect(h.removed).not.toContain("sb_url");
    // The address stays prefilled: the member is not being told to go and find
    // their team's Worker again, only to present a token that still works.
    expect(h.els.get("auth-url").value).toBe("http://localhost");
    expect(h.els.get("auth-token").value).toBe("");
  });

  it("tells a removed member they were removed", async () => {
    const h = setup();
    h.signedIn();
    h.ctx.installAuthWatch(h.ctx);
    h.respondWith(() => unauthorized("removed", h.counters));

    await h.ctx.fetch("http://localhost/list?n=50");

    expect(h.els.get("auth-error").textContent).toBe("Your account has been removed from this team.");
  });

  it("tells a rotated token it is stale, not that it was mistyped", async () => {
    const h = setup();
    h.signedIn();
    h.ctx.installAuthWatch(h.ctx);
    h.respondWith(() => unauthorized("invalid_token", h.counters));

    await h.ctx.fetch("http://localhost/list?n=50");

    // Mid-session, invalid_token means a rotation, not a typo — "Invalid token"
    // would send someone off to re-copy a token that no longer exists. The
    // wording is also deliberately team-free: a solo owner who rotates
    // AUTH_TOKEN and redeploys sees this same string.
    expect(h.els.get("auth-error").textContent).toBe(
      "Your access token is no longer valid. Sign in again with a current token.",
    );
    expect(h.els.get("auth-error").textContent).not.toMatch(/admin|team/i);
  });

  it("localises the rotated-token message", async () => {
    const h = setup("it");
    h.signedIn();
    h.ctx.installAuthWatch(h.ctx);
    h.respondWith(() => unauthorized("invalid_token", h.counters));

    await h.ctx.fetch("http://localhost/list?n=50");

    expect(h.els.get("auth-error").textContent).toBe(
      "Il tuo token di accesso non è più valido. Accedi di nuovo con un token aggiornato.",
    );
  });

  it("hands the caller back the very Response it would have received", async () => {
    const h = setup();
    h.signedIn();
    h.ctx.installAuthWatch(h.ctx);
    const body = { ok: false, error: "x", code: "suspended" };
    const original = makeResponse(401, body, h.counters);
    h.respondWith(() => original);

    const res = await h.ctx.fetch("http://localhost/list?n=50");

    // The regression case for all 45 call sites: the interceptor read the body
    // through clone(), so the caller's own json() is still unconsumed.
    expect(res).toBe(original);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(body);
    expect(h.counters.clones).toBe(1);
  });

  it("leaves a successful response and the session alone", async () => {
    const h = setup();
    h.signedIn();
    h.ctx.installAuthWatch(h.ctx);
    const body = { ok: true, entries: [] };
    h.respondWith(() => makeResponse(200, body, h.counters));

    const res = await h.ctx.fetch("http://localhost/list?n=50");

    expect(await res.json()).toEqual(body);
    expect(h.els.get("auth-error").writes).toBe(0);
    expect(h.token()).toBe("a-real-looking-token");
    expect(h.counters.clones).toBe(0);
  });

  it("ignores a 401 from somewhere that is not this Worker", async () => {
    const h = setup();
    h.signedIn("http://localhost:8788");
    h.ctx.installAuthWatch(h.ctx);
    h.respondWith(() => unauthorized("suspended", h.counters));

    await h.ctx.fetch("https://elsewhere.example/x");
    // A prefix test is not an origin test. `http://localhost:8788.evil.test` and
    // `http://localhost:8788-staging.evil.test` both START WITH the Worker's
    // address while being wholly different hosts, so a lookalike a future
    // integration happens to call could end a perfectly valid session. The
    // boundary has to be the path separator: the address itself, or the address
    // followed by `/`. connect() strips the trailing slash from what it stores
    // and all 45 call sites build `${WORKER_URL}/…`, so nothing real is excluded.
    await h.ctx.fetch("http://localhost:8788.evil.test/list?n=50");
    await h.ctx.fetch("http://localhost:8788-staging.evil.test/list?n=50");

    expect(h.els.get("auth-error").writes).toBe(0);
    expect(h.token()).toBe("a-real-looking-token");
    expect(h.els.get("app").style.display).toBeUndefined();
    expect(h.counters.clones).toBe(0);
  });

  it("still ends the session for the Worker's own root and paths", async () => {
    const h = setup();
    h.signedIn("http://localhost:8788");
    h.ctx.installAuthWatch(h.ctx);
    h.respondWith(() => unauthorized("suspended", h.counters));

    // The tightened boundary must not exclude the two shapes that are real: the
    // bare address, and the address plus a path.
    await h.ctx.fetch("http://localhost:8788");

    expect(h.token()).toBe("");
    expect(h.els.get("auth-error").writes).toBe(1);

    const p = setup();
    p.signedIn("http://localhost:8788");
    p.ctx.installAuthWatch(p.ctx);
    p.respondWith(() => unauthorized("suspended", p.counters));

    await p.ctx.fetch("http://localhost:8788/list?n=50");

    expect(p.token()).toBe("");
    expect(p.els.get("auth-error").writes).toBe(1);
  });

  it("ignores a 401 from a Worker too old to send a code", async () => {
    const h = setup();
    h.signedIn();
    h.ctx.installAuthWatch(h.ctx);
    h.respondWith(() => unauthorized(undefined, h.counters));

    await h.ctx.fetch("http://localhost/list?n=50");

    // A mixed-version deployment must not log people out.
    expect(h.token()).toBe("a-real-looking-token");
    expect(h.els.get("auth-error").writes).toBe(0);
  });

  it("survives a 401 whose body is not JSON at all", async () => {
    const h = setup();
    h.signedIn();
    h.ctx.installAuthWatch(h.ctx);
    const notJson = async () => {
      throw new SyntaxError("Unexpected token < in JSON at position 0");
    };
    const original: Stub = {
      ok: false,
      status: 401,
      json: notJson,
      clone: () => {
        h.counters.clones++;
        return { status: 401, json: notJson };
      },
    };
    h.respondWith(() => original);

    // An edge or proxy's HTML error page is likelier than a revocation here, and
    // either way an unparseable body names no reason — so the session stands and
    // the caller gets its Response rather than a rejection out of the wrapper.
    const res = await h.ctx.fetch("http://localhost/list?n=50");

    expect(res).toBe(original);
    expect(h.token()).toBe("a-real-looking-token");
    expect(h.els.get("auth-error").writes).toBe(0);
  });

  it("stays inert while nobody is signed in", async () => {
    const h = setup();
    h.ctx.installAuthWatch(h.ctx);
    h.respondWith(() => unauthorized("invalid_token", h.counters));

    // connect()'s pre-auth probe: no token held and no worker URL known yet, so
    // a 401 here is the sign-in form's business and not the watcher's.
    await h.ctx.fetch("http://localhost/list?n=1");

    expect(h.els.get("auth-error").writes).toBe(0);
    expect(h.token()).toBe("");
    expect(h.counters.clones).toBe(0);
  });

  it("ignores every 401 while no Worker address is known", async () => {
    const h = setup();
    h.signedIn("", "a-real-looking-token");
    h.ctx.installAuthWatch(h.ctx);
    h.respondWith(() => unauthorized("suspended", h.counters));

    // A root-relative request is the one shape the same-Worker check below
    // cannot rule out when WORKER_URL is empty — `'/list'.startsWith('/')` is
    // perfectly true — so this guard is what stops a 401 being attributed to a
    // Worker whose address nobody knows yet. (Before the same-Worker check was
    // tightened to a path boundary it also had to catch `startsWith('')`, which
    // matched every URL in existence; that trap is gone, this case is not.)
    await h.ctx.fetch("/list?n=50");
    await h.ctx.fetch("https://elsewhere.example/x");

    expect(h.els.get("auth-error").writes).toBe(0);
    expect(h.token()).toBe("a-real-looking-token");
    expect(h.counters.clones).toBe(0);
  });

  it("writes the overlay once for a burst of 401s", async () => {
    const h = setup();
    h.signedIn();
    h.ctx.installAuthWatch(h.ctx);
    h.respondWith(() => unauthorized("suspended", h.counters));

    // refreshAll() fires four requests at once; every one of them comes back 401.
    await h.ctx.fetch("http://localhost/list?n=50");
    await h.ctx.fetch("http://localhost/stats");

    expect(h.els.get("auth-error").writes).toBe(1);
    // The second 401 does not even reach clone(): AUTH_TOKEN is already gone.
    expect(h.counters.clones).toBe(1);
    expect(h.calls()).toBe(2);
  });

  it("writes the overlay once for four TRULY concurrent 401s", async () => {
    const h = setup();
    h.signedIn();
    h.ctx.installAuthWatch(h.ctx);
    h.respondWith(() => unauthorized("suspended", h.counters));

    // refreshAll() does not await its four requests one at a time. All four get
    // past the wrapper's AUTH_TOKEN guard before any of them has cleared it, so
    // what holds the line here is sessionEnded's OWN `if (!AUTH_TOKEN) return` —
    // a second layer the sequential burst above never reaches.
    await Promise.all([
      h.ctx.fetch("http://localhost/list?n=50"),
      h.ctx.fetch("http://localhost/stats"),
      h.ctx.fetch("http://localhost/health"),
      h.ctx.fetch("http://localhost/team/members"),
    ]);

    expect(h.calls()).toBe(4);
    // All four DID read a body — that is the point of the second layer.
    expect(h.counters.clones).toBe(4);
    expect(h.els.get("auth-error").writes).toBe(1);
    expect(h.removed.filter((k) => k === "sb_token")).toHaveLength(1);
  });

  it("signs the member out even when part of the overlay is missing", async () => {
    const h = setup("en", ["app"]);
    h.signedIn();
    h.ctx.installAuthWatch(h.ctx);
    h.respondWith(() => unauthorized("suspended", h.counters));

    await h.ctx.fetch("http://localhost/list?n=50");

    // A missing element used to throw part-way through sessionEnded, INSIDE the
    // interceptor's catch — which swallowed it, leaving the member with a dead
    // token, no overlay and no message. That is the exact failure this task
    // exists to end, so every element is guarded the same way.
    expect(h.els.get("auth-overlay").style.display).toBe("flex");
    expect(h.els.get("auth-error").textContent).toBe(
      "Your account is suspended. Ask a team admin to restore it.",
    );
    expect(h.token()).toBe("");
    expect(h.removed).toContain("sb_token");
  });

  it("resolves the caller at the headers, not at the end of the body", async () => {
    const h = setup();
    h.signedIn();
    h.ctx.installAuthWatch(h.ctx);
    const stalled = makeStalledResponse(401, h.counters);
    h.respondWith(() => stalled.stub);

    // The wrapper must hand the Response back the moment the native fetch does.
    // A body that never lands is the honest stand-in for one that lands slowly:
    // if the caller's `await fetch(...)` is chained to the body at all, this
    // race is won by the timer and every one of the 45 call sites inherits a
    // hang the native API would never have given them.
    const TIMED_OUT = Symbol("still unresolved");
    const winner = await Promise.race([
      h.ctx.fetch("http://localhost/list?n=50"),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 150)),
    ]);

    expect(winner, "fetch() did not resolve until the body did").toBe(stalled.stub);
  });

  it("still ends the session when the stalled body finally arrives", async () => {
    const h = setup();
    h.signedIn();
    h.ctx.installAuthWatch(h.ctx);
    const stalled = makeStalledResponse(401, h.counters);
    h.respondWith(() => stalled.stub);

    // The other half of the trade: returning early must not mean giving up on
    // the reason. Detaching the read moves the sign-out later, not away.
    const TIMED_OUT = Symbol("still unresolved");
    const winner = await Promise.race([
      h.ctx.fetch("http://localhost/list?n=50"),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 150)),
    ]);
    expect(winner).toBe(stalled.stub);
    // Nothing has been read yet, so nothing has been decided yet.
    expect(h.els.get("auth-error").writes).toBe(0);
    expect(h.token()).toBe("a-real-looking-token");

    stalled.land({ ok: false, error: "x", code: "suspended" });
    await settle();

    expect(h.els.get("auth-error").textContent).toBe(
      "Your account is suspended. Ask a team admin to restore it.",
    );
    expect(h.els.get("auth-error").writes).toBe(1);
    expect(h.token()).toBe("");
    expect(h.removed).toContain("sb_token");
  });

  it("does not reject the caller when a detached body read blows up later", async () => {
    const h = setup();
    h.signedIn();
    h.ctx.installAuthWatch(h.ctx);
    let reject: (e: unknown) => void = () => {};
    const body = new Promise<unknown>((_, r) => {
      reject = r;
    });
    const original: Stub = {
      ok: false,
      status: 401,
      json: () => body,
      clone: () => {
        h.counters.clones++;
        return { status: 401, json: () => body };
      },
    };
    h.respondWith(() => original);

    // Once the read is detached it is no longer inside the caller's await, so
    // its rejection can only surface as an unhandled rejection. The `.catch`
    // on the chain is what keeps a truncated body from becoming a console
    // error with no owner.
    const res = await h.ctx.fetch("http://localhost/list?n=50");
    expect(res).toBe(original);

    reject(new TypeError("network error while reading body"));
    await settle();

    expect(h.token()).toBe("a-real-looking-token");
    expect(h.els.get("auth-error").writes).toBe(0);
  });

  it("wraps the global fetch once however many times it is installed", async () => {
    const h = setup();
    h.signedIn();
    h.ctx.installAuthWatch(h.ctx);
    const wrapped = h.ctx.fetch;
    h.ctx.installAuthWatch(h.ctx);

    expect(h.ctx.__sbAuthWatch).toBe(true);
    // Identity is the load-bearing assertion: a second wrapper would still call
    // through to one native fetch, so a call counter alone cannot see it.
    expect(h.ctx.fetch).toBe(wrapped);
    expect(h.ctx.fetch).not.toBe(h.nativeFetch);

    h.respondWith(() => unauthorized("suspended", h.counters));
    await h.ctx.fetch("http://localhost/list?n=50");

    expect(h.calls()).toBe(1);
    expect(h.counters.clones).toBe(1);
    expect(h.els.get("auth-error").writes).toBe(1);
  });
});
