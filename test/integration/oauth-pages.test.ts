import { describe, it, expect } from "vitest";
import worker from "../../src/index";
import { makeTestEnv } from "../helpers/make-env";
import { loginHtml, authorizeErrorHtml } from "../../src/oauth/pages";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => { } } as any;

const PAYLOAD = "<img src=x onerror=alert(1)>";
const ESCAPED = "&lt;img src=x onerror=alert(1)&gt;";

describe("OAuth pages escaping", () => {
  // No request can carry text into these slots (every served value is a
  // constant), so the builders are asserted on directly.
  it("escapes the sign-in page error text", () => {
    const html = loginHtml(PAYLOAD);
    expect(html).toContain(ESCAPED);
    expect(html).not.toContain(PAYLOAD);
  });

  it("escapes the error page hint", () => {
    const html = authorizeErrorHtml(PAYLOAD);
    expect(html).toContain(ESCAPED);
    expect(html).not.toContain(PAYLOAD);
  });

  it("escapes the error page detail", () => {
    const html = authorizeErrorHtml("hint", PAYLOAD);
    expect(html).toContain(ESCAPED);
    expect(html).not.toContain(PAYLOAD);
  });

  it("never renders a client_id payload raw in the served body", async () => {
    const env: Env = makeTestEnv();
    const url = "http://localhost/oauth/authorize?client_id=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E";
    const res = await worker.fetch(new Request(url), env, ctx);
    const html = await res.text();
    expect(html).not.toContain(PAYLOAD);
    expect(html).not.toContain("onerror");
  });
});
