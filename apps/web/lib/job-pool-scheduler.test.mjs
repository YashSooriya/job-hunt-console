import test from "node:test";
import assert from "node:assert/strict";
import { runJobPoolDrivePreflight } from "./job-pool-scheduler.ts";

const env = {
  NEXT_PUBLIC_SUPABASE_URL: "https://sgarcjiqkvlhldmrlsqo.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  JOB_POOL_SCHEDULER_SECRET: "cron-secret",
};

const claim = {
  user_id: "25ee5122-c418-4f18-88f4-389194f86711",
  lease_id: "63d5a182-7be5-4fc2-b52f-fad259682f5e",
  spreadsheet_id: "sheet_id_123456789",
  expected_drive_file_version: "17",
  source_revision: 42,
  refresh_token: "google-refresh-secret",
};

function response(body, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

test("scheduled preflight compares the exact Drive version without exposing refresh tokens to ChatGPT payloads", async () => {
  const calls = [];
  const result = await runJobPoolDrivePreflight(env, async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/functions/v1/job-pool-scheduler")) {
      const request = JSON.parse(String(init.body));
      if (request.action === "claim") return response({ ok: true, checks: [claim] });
      assert.equal(request.action, "finish");
      assert.equal(request.results[0].observed_version, "9007199254740993123");
      assert.equal(request.results[0].error, null);
      assert.equal(JSON.stringify(request).includes("google-refresh-secret"), false);
      return response({ ok: true, outcomes: [{ ok: true }] });
    }
    if (url === "https://oauth2.googleapis.com/token") {
      assert.equal(new URLSearchParams(String(init.body)).get("refresh_token"), "google-refresh-secret");
      return response({ access_token: "short-lived-google-token" });
    }
    assert.match(url, /\/drive\/v3\/files\/sheet_id_123456789/);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer short-lived-google-token");
    return response('{"id":"sheet_id_123456789","mimeType":"application/vnd.google-apps.spreadsheet","version":9007199254740993123,"trashed":false}');
  });

  assert.deepEqual(result, { claimed: 1, verified: 1, mismatched: 0, unavailable: 0 });
  assert.equal(calls.length, 4);
  const claimCall = calls.find((call) => call.url.includes("/functions/v1/job-pool-scheduler"));
  assert.equal(new Headers(claimCall.init.headers).get("x-job-pool-scheduler-secret"), "cron-secret");
});

test("missing Google refresh credentials release the drive-check lease as a reconnect error", async () => {
  let finishPayload;
  const result = await runJobPoolDrivePreflight(env, async (input, init = {}) => {
    if (String(input).includes("/functions/v1/job-pool-scheduler")) {
      const body = JSON.parse(String(init.body));
      if (body.action === "claim") return response({ ok: true, checks: [{ ...claim, refresh_token: null }] });
      finishPayload = body;
      return response({ ok: true, outcomes: [{ ok: false, reason: "google_reconnect_required" }] });
    }
    assert.fail("Google APIs must not be called without a refresh token.");
  });

  assert.deepEqual(result, { claimed: 1, verified: 0, mismatched: 0, unavailable: 1 });
  assert.equal(finishPayload.results[0].error, "google_reconnect_required");
  assert.equal(finishPayload.results[0].observed_version, null);
  assert.equal("refresh_token" in finishPayload.results[0], false);
});

test("transient Drive failures fail closed and are normalized before being stored", async () => {
  let finishPayload;
  const result = await runJobPoolDrivePreflight(env, async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/functions/v1/job-pool-scheduler")) {
      const body = JSON.parse(String(init.body));
      if (body.action === "claim") return response({ ok: true, checks: [claim] });
      finishPayload = body;
      return response({ ok: true, outcomes: [{ ok: false, reason: "google_sheet_check_unavailable" }] });
    }
    if (url === "https://oauth2.googleapis.com/token") return response({ access_token: "short-lived-google-token" });
    return response({ error: { message: "sensitive provider detail" } }, 503);
  });

  assert.deepEqual(result, { claimed: 1, verified: 0, mismatched: 0, unavailable: 1 });
  assert.equal(finishPayload.results[0].error, "google_sheet_check_unavailable");
  assert.equal(JSON.stringify(finishPayload).includes("sensitive provider detail"), false);
});
