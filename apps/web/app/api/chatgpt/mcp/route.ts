import {
  callMcpTool,
  corsHeaders,
  getBearerToken,
  jsonRpcError,
  jsonRpcResult,
  toolListResult,
  unauthorizedMcpResponse,
} from "@/lib/chatgpt/mcp";
import { MCP_PROTOCOL_VERSION, MCP_TOOLS } from "@/lib/chatgpt/mcp-tools";

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function requestId(body: RpcRequest) {
  return typeof body.id === "string" || typeof body.id === "number" || body.id === null ? body.id ?? null : null;
}

function isNotification(body: RpcRequest) {
  return !Object.prototype.hasOwnProperty.call(body, "id");
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function GET() {
  return new Response(JSON.stringify({ error: "MCP Streamable HTTP GET is not used for this server." }), {
    status: 405,
    headers: corsHeaders({ "Allow": "POST, OPTIONS", "Content-Type": "application/json" }),
  });
}

export async function POST(request: Request) {
  const accessToken = getBearerToken(request);
  if (!accessToken) return unauthorizedMcpResponse(request);

  let body: RpcRequest;
  try {
    body = await request.json() as RpcRequest;
  } catch {
    return jsonRpcError(null, -32700, "Invalid JSON.");
  }

  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return jsonRpcError(requestId(body), -32600, "Invalid JSON-RPC request.");
  }

  if (body.method === "notifications/initialized" || body.method === "notifications/cancelled") {
    return new Response(null, { status: 202, headers: corsHeaders() });
  }

  if (body.method === "initialize") {
    return jsonRpcResult(requestId(body), {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "job-hunt-console", version: "19.0.0" },
      instructions: "Use only the authenticated user's data. Never approve Gate 1 or Gate 2 and never submit an employer form.",
    });
  }

  if (body.method === "tools/list") {
    return jsonRpcResult(requestId(body), toolListResult());
  }

  if (body.method !== "tools/call") {
    return jsonRpcError(requestId(body), -32601, "Method not found.");
  }

  const params = body.params || {};
  const name = typeof params.name === "string" ? params.name : "";
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return jsonRpcError(requestId(body), -32602, "Unknown MCP tool.");
  const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};

  try {
    const result = await callMcpTool(accessToken, name, args);
    if (isNotification(body)) return new Response(null, { status: 202, headers: corsHeaders() });
    return jsonRpcResult(requestId(body), {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "MCP tool failed.";
    if (/bearer|oauth|membership|authentication|scope/i.test(message)) {
      return new Response(JSON.stringify({ error: message }), {
        status: 401,
        headers: corsHeaders({
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer",
        }),
      });
    }
    return jsonRpcError(requestId(body), -32000, message);
  }
}
