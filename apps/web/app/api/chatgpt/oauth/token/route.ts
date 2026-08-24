import { createMcpClient } from "@/lib/chatgpt/mcp";
import { oauthResponse, readOAuthBody } from "@/lib/chatgpt/oauth";

export async function POST(request: Request) {
  try {
    const body = await readOAuthBody(request);
    const clientId = body.client_id || "";
    const supabase = createMcpClient();
    if (body.grant_type === "authorization_code") {
      const { data, error } = await supabase.rpc("chatgpt_exchange_authorization_code", {
        p_code: body.code || "",
        p_client_id: clientId,
        p_redirect_uri: body.redirect_uri || "",
        p_code_verifier: body.code_verifier || "",
      });
      if (error) return oauthResponse({ error: "invalid_grant", error_description: error.message }, 400);
      return oauthResponse(data);
    }
    if (body.grant_type === "refresh_token") {
      const { data, error } = await supabase.rpc("chatgpt_refresh_access_token", {
        p_refresh_token: body.refresh_token || "",
        p_client_id: clientId,
      });
      if (error) return oauthResponse({ error: "invalid_grant", error_description: error.message }, 400);
      return oauthResponse(data);
    }
    return oauthResponse({ error: "unsupported_grant_type" }, 400);
  } catch (error) {
    return oauthResponse({ error: "invalid_request", error_description: error instanceof Error ? error.message : "Invalid OAuth request." }, 400);
  }
}
