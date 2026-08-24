import { createMcpClient } from "@/lib/chatgpt/mcp";
import { oauthResponse, readOAuthBody } from "@/lib/chatgpt/oauth";

export async function POST(request: Request) {
  try {
    const body = await readOAuthBody(request);
    const token = body.token || body.access_token || body.refresh_token || "";
    if (!token) return oauthResponse({ error: "invalid_request" }, 400);
    const supabase = createMcpClient();
    await supabase.rpc("chatgpt_revoke_token", { p_token: token });
    return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    return oauthResponse({ error: "invalid_request" }, 400);
  }
}
