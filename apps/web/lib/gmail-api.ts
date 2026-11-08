import { loopbackTestUrl } from "@/lib/loopback-test-endpoint";

export type GmailMessage = {
  id: string;
  threadId: string | null;
  sender: string | null;
  subject: string | null;
  snippet: string | null;
  body: string | null;
  receivedAt: string | null;
};

// A sync reads each message from Gmail and then persists it with one Supabase
// RPC. Keep the batch bounded so the Worker invocation stays below the
// platform subrequest budget even when a provider token refresh is needed.
export const GMAIL_SYNC_MAX_MESSAGES = 15;

function decodeBase64Url(value?: string | null) {
  if (!value) return "";
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}
function stripHtml(value: string) {
  return value.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
function bodyFromPayload(payload: any): string {
  const parts: any[] = [];
  function walk(part: any) {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body?.data) parts.unshift({ kind: "plain", text: decodeBase64Url(part.body.data) });
    else if (part.mimeType === "text/html" && part.body?.data) parts.push({ kind: "html", text: stripHtml(decodeBase64Url(part.body.data)) });
    for (const child of part.parts || []) walk(child);
  }
  walk(payload);
  const plain = parts.find((x) => x.kind === "plain" && x.text.trim());
  return (plain?.text || parts.find((x) => x.text.trim())?.text || "").trim();
}
function header(payload: any, name: string) {
  return payload?.headers?.find((h: any) => String(h.name).toLowerCase() === name.toLowerCase())?.value || null;
}
export async function listGmailMessages(accessToken: string, query: string, maxResults = GMAIL_SYNC_MAX_MESSAGES): Promise<GmailMessage[]> {
  const base = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
  const boundedMaxResults = Math.max(1, Math.min(maxResults, GMAIL_SYNC_MAX_MESSAGES));
  const url = `${base}?maxResults=${boundedMaxResults}&q=${encodeURIComponent(query)}`;
  const list = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  if (list.status === 401 || list.status === 403) throw new Error("gmail_reconnect_required");
  if (!list.ok) throw new Error(`gmail_list_${list.status}`);
  const json = await list.json();
  const ids = (json.messages || []).map((m: any) => m.id).filter(Boolean);
  const messages: GmailMessage[] = [];
  for (const id of ids) {
    const res = await fetch(`${base}/${encodeURIComponent(id)}?format=full`, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
    if (res.status === 401 || res.status === 403) throw new Error("gmail_reconnect_required");
    if (!res.ok) continue;
    const m = await res.json();
    const internal = Number(m.internalDate);
    messages.push({
      id: m.id,
      threadId: m.threadId || null,
      sender: header(m.payload, "From"),
      subject: header(m.payload, "Subject"),
      snippet: m.snippet || null,
      body: bodyFromPayload(m.payload) || null,
      receivedAt: Number.isFinite(internal) ? new Date(internal).toISOString() : null,
    });
  }
  return messages;
}


export async function refreshGoogleAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("gmail_oauth_server_config_missing");

  const tokenEndpoint = loopbackTestUrl("JOBHUNT_GOOGLE_OAUTH_TEST_URL") || "https://oauth2.googleapis.com/token";
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Only Google's explicit invalid_grant means that this saved refresh grant
    // is terminal. Network failures and OAuth client/configuration errors are
    // surfaced distinctly and never cause the stored credential to be cleared.
    if (payload?.error === "invalid_grant") throw new Error("google_reconnect_required");
    if (payload?.error === "invalid_client") throw new Error("gmail_oauth_server_config_missing");
    if (response.status >= 500) throw new Error(`gmail_token_refresh_${response.status}`);
    throw new Error("gmail_token_refresh_rejected");
  }
  if (!payload?.access_token) throw new Error("gmail_token_refresh_missing_access_token");
  return String(payload.access_token);
}
