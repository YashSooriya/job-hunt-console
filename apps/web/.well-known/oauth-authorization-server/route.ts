import { authorizationServerMetadata, corsHeaders } from "@/lib/chatgpt/mcp";

export async function GET(request: Request) {
  return new Response(JSON.stringify(authorizationServerMetadata(request)), {
    headers: corsHeaders({ "Content-Type": "application/json" }),
  });
}
