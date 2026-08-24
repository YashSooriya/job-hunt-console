import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { MCP_PROTOCOL_VERSION, MCP_TOOLS } from "@/lib/chatgpt/mcp-tools";

export const MCP_RESOURCE_PATH = "/api/chatgpt/mcp";
export const MCP_SCOPES = ["profile:read", "work:write"] as const;

export function publicOrigin(request: Request) {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedHost && forwardedProto) return forwardedProto + "://" + forwardedHost;
  return url.origin;
}

export function mcpResourceUrl(request: Request) {
  return publicOrigin(request) + MCP_RESOURCE_PATH;
}

export function createMcpClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "X-Client-Info": "job-hunt-chatgpt-mcp" } },
  });
}

export function getBearerToken(request: Request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function corsHeaders(extra: HeadersInit = {}) {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Protocol-Version, Mcp-Session-Id",
    "Cache-Control": "no-store",
    "Mcp-Protocol-Version": MCP_PROTOCOL_VERSION,
    ...extra,
  });
}

export function jsonRpcResult(id: string | number | null, result: unknown, status = 200) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status,
    headers: corsHeaders({ "Content-Type": "application/json" }),
  });
}

export function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  status = 200,
) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status,
    headers: corsHeaders({ "Content-Type": "application/json" }),
  });
}

export function unauthorizedMcpResponse(request: Request) {
  return new Response(JSON.stringify({ error: "OAuth bearer token required." }), {
    status: 401,
    headers: corsHeaders({
      "Content-Type": "application/json",
      "WWW-Authenticate": "Bearer resource_metadata=\"" + publicOrigin(request) + "/.well-known/oauth-protected-resource\"",
    }),
  });
}

export async function callMcpTool(accessToken: string, name: string, args: Record<string, unknown>) {
  const supabase = createMcpClient();
  const { data, error } = await supabase.rpc("chatgpt_mcp_call", {
    p_access_token: accessToken,
    p_tool_name: name,
    p_arguments: args,
  });
  if (error) throw new Error(error.message || "ChatGPT MCP tool failed.");
  return data;
}

export async function getConnectionStatus() {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("chatgpt_connection_status");
  if (error) throw error;
  return data;
}

export function authorizationServerMetadata(request: Request) {
  const origin = publicOrigin(request);
  const resource = origin + MCP_RESOURCE_PATH;
  return {
    issuer: origin,
    authorization_endpoint: origin + "/api/chatgpt/oauth/authorize",
    token_endpoint: origin + "/api/chatgpt/oauth/token",
    revocation_endpoint: origin + "/api/chatgpt/oauth/revoke",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...MCP_SCOPES],
    client_id_metadata_document_supported: true,
    resource,
  };
}

export function protectedResourceMetadata(request: Request) {
  const origin = publicOrigin(request);
  return {
    resource: origin + MCP_RESOURCE_PATH,
    authorization_servers: [origin],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ["header"],
  };
}

export function toolListResult() {
  return { tools: MCP_TOOLS };
}
