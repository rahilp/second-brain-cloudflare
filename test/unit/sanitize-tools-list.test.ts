import { describe, it, expect } from "vitest";
import {
  isMcpToolsListRequest,
  removeToolExecutionMetadata,
  sanitizeToolsListResponse,
} from "../../src/index";

const toolsListPayload = (tools: unknown[]) => ({
  jsonrpc: "2.0",
  id: 1,
  result: { tools },
});

const TOOL_WITH_EXECUTION = {
  name: "remember",
  description: "Store a memory",
  inputSchema: { type: "object" },
  execution: { taskSupport: "optional" },
};

describe("isMcpToolsListRequest()", () => {
  const post = (body: string) =>
    new Request("https://example.com/mcp", { method: "POST", body });

  it("detects a JSON-RPC tools/list POST", async () => {
    expect(await isMcpToolsListRequest(post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })))).toBe(true);
  });

  it("rejects other methods, non-POSTs, and unparseable bodies", async () => {
    expect(await isMcpToolsListRequest(post(JSON.stringify({ method: "tools/call" })))).toBe(false);
    expect(await isMcpToolsListRequest(new Request("https://example.com/mcp", { method: "GET" }))).toBe(false);
    expect(await isMcpToolsListRequest(post("not json")).catch(() => false)).toBe(false);
    expect(await isMcpToolsListRequest(post(JSON.stringify(["tools/list"])))).toBe(false);
  });

  it("leaves the request body readable for the downstream handler", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const request = post(body);
    await isMcpToolsListRequest(request);
    expect(await request.text()).toBe(body);
  });
});

describe("removeToolExecutionMetadata()", () => {
  it("strips execution from each tool and preserves everything else", () => {
    const out = removeToolExecutionMetadata(toolsListPayload([TOOL_WITH_EXECUTION])) as any;
    expect(out.result.tools[0]).toEqual({
      name: "remember",
      description: "Store a memory",
      inputSchema: { type: "object" },
    });
    expect(out.jsonrpc).toBe("2.0");
    expect(out.id).toBe(1);
  });

  it("leaves tools without an execution field untouched", () => {
    const tool = { name: "recall", inputSchema: { type: "object" } };
    const out = removeToolExecutionMetadata(toolsListPayload([tool])) as any;
    expect(out.result.tools[0]).toEqual(tool);
  });

  it("returns non-tools/list payloads unchanged", () => {
    const error = { jsonrpc: "2.0", id: 1, error: { code: -32600 } };
    expect(removeToolExecutionMetadata(error)).toBe(error);
    expect(removeToolExecutionMetadata(null)).toBe(null);
    expect(removeToolExecutionMetadata("text")).toBe("text");
  });
});

describe("sanitizeToolsListResponse()", () => {
  it("sanitizes a plain JSON response and drops content-length", async () => {
    const body = JSON.stringify(toolsListPayload([TOOL_WITH_EXECUTION]));
    const response = new Response(body, {
      headers: { "content-type": "application/json", "content-length": String(body.length), "mcp-session-id": "abc" },
    });

    const sanitized = await sanitizeToolsListResponse(response);
    const payload = await sanitized.json() as any;

    expect(payload.result.tools[0].execution).toBeUndefined();
    expect(payload.result.tools[0].name).toBe("remember");
    expect(sanitized.headers.get("content-length")).toBeNull();
    expect(sanitized.headers.get("mcp-session-id")).toBe("abc");
  });

  it("sanitizes data: lines in an SSE response and preserves other lines", async () => {
    const sse = [
      "event: message",
      `data: ${JSON.stringify(toolsListPayload([TOOL_WITH_EXECUTION]))}`,
      "",
    ].join("\n");
    const response = new Response(sse, { headers: { "content-type": "text/event-stream" } });

    const sanitized = await sanitizeToolsListResponse(response);
    const lines = (await sanitized.text()).split("\n");

    expect(lines[0]).toBe("event: message");
    const payload = JSON.parse(lines[1].slice("data: ".length));
    expect(payload.result.tools[0].execution).toBeUndefined();
    expect(payload.result.tools[0].name).toBe("remember");
  });

  it("passes through non-JSON/SSE responses and unparseable bodies unchanged", async () => {
    const html = new Response("<html></html>", { headers: { "content-type": "text/html" } });
    expect(await sanitizeToolsListResponse(html)).toBe(html);

    const broken = new Response("not json", { headers: { "content-type": "application/json" } });
    const out = await sanitizeToolsListResponse(broken);
    expect(out).toBe(broken);
  });
});
