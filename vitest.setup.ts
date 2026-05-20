import { vi } from "vitest";

vi.mock("agents/mcp", () => ({
  createMcpHandler: vi.fn().mockReturnValue(() => new Response("mcp")),
}));
