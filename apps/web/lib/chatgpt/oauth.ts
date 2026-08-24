export const DEFAULT_OAUTH_SCOPE = "profile:read work:write";

export function isAllowedRedirectUri(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") {
      return url.hostname === "chatgpt.com"
        || url.hostname.endsWith(".chatgpt.com")
        || url.hostname === "chat.openai.com"
        || url.hostname.endsWith(".openai.com");
    }
    return process.env.NODE_ENV !== "production"
      && url.protocol === "http:"
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

export function isSupportedResource(value: string | null, request: Request) {
  if (!value) return true;
  const origin = new URL(request.url).origin;
  return value === origin + "/api/chatgpt/mcp";
}

export function requiredAuthorizationParams(url: URL) {
  const clientId = url.searchParams.get("client_id") || "";
  const redirectUri = url.searchParams.get("redirect_uri") || "";
  const responseType = url.searchParams.get("response_type") || "";
  const codeChallenge = url.searchParams.get("code_challenge") || "";
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "";
  const scope = url.searchParams.get("scope") || DEFAULT_OAUTH_SCOPE;
  if (!clientId || !redirectUri || responseType !== "code" || !codeChallenge || codeChallengeMethod !== "S256") {
    return { error: "OAuth authorization requires response_type=code and PKCE S256." } as const;
  }
  if (!isAllowedRedirectUri(redirectUri)) return { error: "OAuth redirect_uri is not an approved ChatGPT callback." } as const;
  if (!isSupportedResource(url.searchParams.get("resource"), new Request(url))) {
    return { error: "OAuth resource does not match the MCP endpoint." } as const;
  }
  return {
    clientId,
    redirectUri,
    responseType,
    codeChallenge,
    codeChallengeMethod,
    scope,
    state: url.searchParams.get("state") || "",
  } as const;
}

export function oauthResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  });
}

export async function readOAuthBody(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await request.json() as Record<string, unknown>;
    return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, typeof value === "string" ? value : String(value ?? "")]));
  }
  const form = await request.formData();
  return Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
}
