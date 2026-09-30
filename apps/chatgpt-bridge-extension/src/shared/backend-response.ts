/**
 * Read a bridge response without assuming that a proxy, Worker error page, or
 * older deployment returned JSON. In particular, never turn an HTML 401/5xx
 * page into a credential reset: only an explicit, machine-readable terminal
 * authentication code is allowed to invalidate local pairing.
 */

export type BridgeResponseBody = Record<string, any>;

const MAX_RESPONSE_CHARS = 120_000;

export const TERMINAL_BRIDGE_AUTH_CODES = new Set([
  "device_credentials_invalid",
  "device_revoked",
  "membership_revoked",
]);

function responseDescription(response: Response) {
  return `Bridge returned HTTP ${response.status}${response.statusText ? ` (${response.statusText})` : ""}.`;
}

export async function readBridgeResponse(response: Response): Promise<BridgeResponseBody> {
  const contentType = response.headers.get("content-type") || "";
  const text = (await response.text().catch(() => "")).slice(0, MAX_RESPONSE_CHARS);
  if (!text.trim()) return { error: responseDescription(response), code: "bridge_transport_error" };
  const looksLikeJson = /^\s*[\[{]/.test(text);
  if (!/\bapplication\/json\b/i.test(contentType) && !looksLikeJson) {
    return { error: responseDescription(response), code: "bridge_transport_error" };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as BridgeResponseBody;
  } catch {
    // The response body is untrusted. Return a bounded transport error rather
    // than exposing a proxy's HTML or throwing a JSON parse exception.
  }
  return { error: responseDescription(response), code: "bridge_transport_error" };
}

export function isTerminalBridgeAuthCode(value: unknown): boolean {
  return typeof value === "string" && TERMINAL_BRIDGE_AUTH_CODES.has(value);
}
