import assert from "node:assert/strict";
import test from "node:test";
import { refreshGoogleAccessToken } from "./gmail-api.ts";

async function refresh(payload, status = 400) {
  const originalFetch = globalThis.fetch;
  const originalClientId = process.env.GOOGLE_CLIENT_ID;
  const originalClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  process.env.GOOGLE_CLIENT_ID = "test-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  globalThis.fetch = async () => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  try {
    return await refreshGoogleAccessToken("test-refresh-token");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = originalClientSecret;
  }
}

test("only Google's explicit invalid_grant is treated as a terminal saved-grant failure", async () => {
  assert.equal(await refresh({ error: "invalid_grant" }), "google_reconnect_required");
  assert.equal(await refresh({ error: "invalid_request" }), "gmail_token_refresh_rejected");
});

test("OAuth server and network failures are distinct from a revoked user grant", async () => {
  assert.equal(await refresh({ error: "invalid_client" }), "gmail_oauth_server_config_missing");
  assert.equal(await refresh({ error: "temporarily_unavailable" }, 503), "gmail_token_refresh_503");
});

test("a successful refresh returns only the new access token", async () => {
  assert.equal(await refresh({ access_token: "short-lived-access-token" }, 200), "short-lived-access-token");
});
