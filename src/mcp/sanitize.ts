// Newer @modelcontextprotocol/sdk releases attach an `execution` (task-support)
// field to each tool definition in tools/list responses. Strict MCP clients —
// OpenAI Codex at the time of writing — reject the entire tool list when they
// see the unknown field, which breaks the connection outright. Strip it so any
// client can connect; the server doesn't use MCP task execution, so nothing is
// lost. Remove this shim if we ever adopt task execution or once strict clients
// tolerate unknown fields.
//
// Bug discovered, and fix originally authored, in the
// guoyingwei6/second-brain-cloudflare fork (commit a3fa15f).

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function isMcpToolsListRequest(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  try {
    const payload = await request.clone().json();
    return isRecord(payload) && payload.method === "tools/list";
  } catch {
    return false;
  }
}

export function removeToolExecutionMetadata(payload: unknown): unknown {
  if (!isRecord(payload) || !isRecord(payload.result) || !Array.isArray(payload.result.tools)) {
    return payload;
  }

  const tools = payload.result.tools.map(tool => {
    if (!isRecord(tool) || !("execution" in tool)) return tool;
    const { execution: _execution, ...toolWithoutExecution } = tool;
    return toolWithoutExecution;
  });

  return {
    ...payload,
    result: {
      ...payload.result,
      tools,
    },
  };
}

export async function sanitizeToolsListResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json") && !contentType.includes("text/event-stream")) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");

  if (contentType.includes("text/event-stream")) {
    const body = await response.text();
    const sanitized = body.split("\n").map(line => {
      if (!line.startsWith("data: ")) return line;
      try {
        return `data: ${JSON.stringify(removeToolExecutionMetadata(JSON.parse(line.slice(6))))}`;
      } catch {
        return line;
      }
    }).join("\n");

    return new Response(sanitized, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  try {
    const payload = await response.json();
    return new Response(JSON.stringify(removeToolExecutionMetadata(payload)), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}
