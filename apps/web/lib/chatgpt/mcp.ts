import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { MCP_PROTOCOL_VERSION, MCP_TOOLS, READ_TOOLS } from "@/lib/chatgpt/mcp-tools";
import { syncTrackerSpreadsheetForChatGPT } from "@/lib/google-sheets";

export const MCP_RESOURCE_PATH = "/api/chatgpt/mcp";
export const MCP_SCOPES = ["profile:read", "work:write"] as const;
export const CHATGPT_PROJECT_NAME = "Job Hunt";

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
  const rate = name === "propose_browser_reasoning"
    ? { bucket: "browser_reasoning", limit: 20 }
    : ["ensure_search_run", "save_discovered_job", "save_job_url_inspection", "fail_job_url_inspection", "save_job_analysis", "save_application_package"].includes(name)
      ? { bucket: "search_run", limit: 100 }
      : READ_TOOLS.has(name)
        ? { bucket: "mcp_read", limit: 120 }
        : { bucket: "mcp_write", limit: 60 };
  const { data: rateData, error: rateError } = await supabase.rpc("chatgpt_consume_rate_limit", {
    p_access_token: accessToken,
    p_bucket: rate.bucket,
    p_limit: rate.limit,
    p_window_seconds: 3600,
  });
  if (rateError) throw new Error(rateError.message || "Automation rate-limit check failed.");
  if (!rateData?.allowed) throw new Error(`RATE_LIMIT_EXCEEDED: ${rate.bucket}; retry after ${rateData?.reset_at || "the current window"}.`);
  if (name === "sync_application_tracker") {
    return syncTrackerSpreadsheetForChatGPT(accessToken, args.create_if_missing === true);
  }
  const rpcNames: Record<string, string> = {
    get_detailed_candidate_profile: "chatgpt_get_detailed_candidate_profile",
    get_search_context: "chatgpt_get_search_context",
    get_pending_job_url_inspections: "chatgpt_get_pending_job_url_inspections",
    get_automation_settings: "chatgpt_get_automation_settings",
    get_pending_email_classifications: "chatgpt_get_pending_email_classifications",
    classify_email: "chatgpt_classify_email",
    ensure_search_run: "chatgpt_ensure_search_run",
    get_application_preparation_status: "chatgpt_get_application_preparation_status",
    get_pending_work: "chatgpt_get_pending_work_context",
    recover_stale_work: "chatgpt_recover_stale_work",
    save_application_package: "chatgpt_prepare_application",
    get_browser_agent_question_context: "chatgpt_get_browser_question_context",
    propose_browser_reasoning: "chatgpt_propose_browser_reasoning",
    save_job_url_inspection: "chatgpt_save_job_url_inspection",
    fail_job_url_inspection: "chatgpt_fail_job_url_inspection",
  };
  const rpcName = rpcNames[name] || "chatgpt_mcp_call";
  let rpcArgs: Record<string, unknown>;
  if (name === "get_detailed_candidate_profile") rpcArgs = { p_access_token: accessToken };
  else if (name === "get_search_context") rpcArgs = { p_access_token: accessToken, p_limit: typeof args.limit === "number" ? args.limit : 50 };
  else if (name === "get_pending_job_url_inspections") rpcArgs = { p_access_token: accessToken, p_limit: typeof args.limit === "number" ? args.limit : 5 };
  else if (name === "get_automation_settings") rpcArgs = { p_access_token: accessToken };
  else if (name === "get_pending_email_classifications") rpcArgs = { p_access_token: accessToken, p_limit: typeof args.limit === "number" ? args.limit : 20 };
  else if (name === "classify_email") rpcArgs = {
    p_access_token: accessToken,
    p_email_id: String(args.email_id || ""),
    p_application_id: args.application_id ? String(args.application_id) : null,
    p_classification: String(args.classification || "uncertain"),
    p_classification_confidence: typeof args.classification_confidence === "number" ? args.classification_confidence : 0,
    p_classification_reason: String(args.classification_reason || ""),
    p_match_confidence: typeof args.match_confidence === "number" ? args.match_confidence : null,
    p_match_method: args.match_method ? String(args.match_method) : null,
    p_match_reason: args.match_reason ? String(args.match_reason) : null,
    p_model: args.model ? String(args.model) : "chatgpt",
    p_metadata: args.metadata && typeof args.metadata === "object" ? args.metadata : {},
  };
  else if (name === "ensure_search_run") rpcArgs = { p_access_token: accessToken, p_force: false };
  else if (name === "get_application_preparation_status") rpcArgs = { p_access_token: accessToken, p_application_id: String(args.application_id || "") };
  else if (name === "get_pending_work") rpcArgs = { p_access_token: accessToken, p_limit: typeof args.limit === "number" ? args.limit : 20 };
  else if (name === "recover_stale_work") rpcArgs = { p_access_token: accessToken, p_limit: typeof args.limit === "number" ? args.limit : 20 };
  else if (name === "save_application_package") rpcArgs = { p_access_token: accessToken, p_job_id: String(args.job_id || ""), p_package: args };
  else if (name === "get_browser_agent_question_context") rpcArgs = { p_access_token: accessToken, p_limit: typeof args.limit === "number" ? args.limit : 20 };
  else if (name === "propose_browser_reasoning") rpcArgs = { p_access_token: accessToken, p_session_id: String(args.session_id || ""), p_proposal: args.proposal || {} };
  else if (name === "save_job_url_inspection") rpcArgs = { p_access_token: accessToken, p_request_id: String(args.request_id || ""), p_extraction: args };
  else if (name === "fail_job_url_inspection") rpcArgs = { p_access_token: accessToken, p_request_id: String(args.request_id || ""), p_message: String(args.message || ""), p_user_required: args.user_required !== false };
  else rpcArgs = { p_access_token: accessToken, p_tool_name: name, p_arguments: args };
  const { data, error } = await supabase.rpc(rpcName, rpcArgs);
  if (error) throw new Error(error.message || "ChatGPT MCP tool failed.");
  if (name === "get_detailed_candidate_profile" && data && typeof data === "object" && !Array.isArray(data)) {
    return {
      ...(data as Record<string, unknown>),
      memory_guidance: {
        use_previous_chatgpt_memory_when_available: true,
        verified_job_hunt_profile_is_authoritative: true,
        unverified_memory_must_not_be_promoted_to_profile_facts: true,
      },
    };
  }
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
