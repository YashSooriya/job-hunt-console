import { NextResponse } from "next/server";
import { getConnectionStatus } from "@/lib/chatgpt/mcp";

export async function GET(request: Request) {
  try {
    const status = await getConnectionStatus();
    const origin = new URL(request.url).origin;
    return NextResponse.json({
      ok: true,
      ...status,
      mcp_endpoint: origin + "/api/chatgpt/mcp",
      oauth_protected_resource: origin + "/.well-known/oauth-protected-resource",
      oauth_authorization_server: origin + "/.well-known/oauth-authorization-server",
      recurring_mode: "user_created_chatgpt_task",
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      connected: false,
      error: error instanceof Error ? error.message : "ChatGPT connection status is unavailable.",
    }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  }
}
