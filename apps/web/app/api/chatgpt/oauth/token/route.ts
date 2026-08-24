import { createMcpClient } from "@/lib/chatgpt/mcp";
import { oauthResponse, readOAuthBody } from "@/lib/chatgpt/oauth";

function describeOAuthUrl(value: string) {
  if (!value) return { present: false, length: 0 };
  try {
    const url = new URL(value);
    return { present: true, length: value.length, path: url.origin + url.pathname };
  } catch {
    return { present: true, length: value.length, path: "invalid-url" };
  }
}

function logOAuthFailure(grantType: string, body: Record<string, string>, message: string) {
  console.error("chatgpt.oauth_token_exchange_failed", {
    grantType,
    clientId: describeOAuthUrl(body.client_id || ""),
    redirectUri: describeOAuthUrl(body.redirect_uri || ""),
    code: { present: Boolean(body.code), length: body.code?.length || 0 },
    codeVerifier: { present: Boolean(body.code_verifier), length: body.code_verifier?.length || 0 },
    refreshToken: { present: Boolean(body.refresh_token), length: body.refresh_token?.length || 0 },
    message,
  });
}

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
      if (error) {
        logOAuthFailure("authorization_code", body, error.message);
        return oauthResponse({ error: "invalid_grant", error_description: error.message }, 400);
      }
      return oauthResponse(data);
    }
    if (body.grant_type === "refresh_token") {
      const { data, error } = await supabase.rpc("chatgpt_refresh_access_token", {
        p_refresh_token: body.refresh_token || "",
        p_client_id: clientId,
      });
      if (error) {
        logOAuthFailure("refresh_token", body, error.message);
        return oauthResponse({ error: "invalid_grant", error_description: error.message }, 400);
      }
      return oauthResponse(data);
    }
    return oauthResponse({ error: "unsupported_grant_type" }, 400);
  } catch (error) {
    return oauthResponse({ error: "invalid_request", error_description: error instanceof Error ? error.message : "Invalid OAuth request." }, 400);
  }
}
