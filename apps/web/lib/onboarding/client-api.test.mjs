import assert from "node:assert/strict";
import test from "node:test";
import { readApiResponse } from "./client-api.ts";
import { PERSONAL_DETAILS_FORM_FIELDS, personalDetailsPatch } from "./profile-form.ts";

test("reads a successful onboarding JSON response", async () => {
  const response = new Response(JSON.stringify({ ok: true, memory: { decision: "allowed" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  await assert.doesNotReject(async () => {
    const result = await readApiResponse(response, "Request failed");
    assert.deepEqual(result.memory, { decision: "allowed" });
  });
});

test("turns an HTML Cloudflare error into a useful API error", async () => {
  const response = new Response("<!DOCTYPE html><html><body>Worker exceeded resource limits</body></html>", {
    status: 502,
    headers: { "cf-ray": "example-ray" },
  });

  await assert.rejects(
    () => readApiResponse(response, "ChatGPT Memory status is unavailable"),
    /ChatGPT Memory status is unavailable \(HTTP 502, Cloudflare Ray example-ray\)\./,
  );
});

test("preserves a structured API error instead of hiding it behind the status", async () => {
  const response = new Response(JSON.stringify({ ok: false, error: "Bridge is offline" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });

  await assert.rejects(
    () => readApiResponse(response, "Request failed"),
    /Bridge is offline/,
  );
});

test("personal-details correction payload contains only changed fields", () => {
  const baseline = {
    displayName: "",
    firstName: "Yashwanth",
    surname: "Sooriyakanthan",
    dateOfBirth: "1997-10-07",
    workAuthorisation: "British citizen",
    salaryExpectation: "40000",
    noticePeriod: "4 weeks",
    linkedinUrl: "https://www.linkedin.com/in/yashwanth-sooriyakanthan/",
  };
  const form = new FormData();
  for (const [fieldName, apiName] of PERSONAL_DETAILS_FORM_FIELDS) form.set(fieldName, String(baseline[apiName] ?? ""));
  form.set("salaryExpectation", "39999");
  form.set("noticePeriod", "1 month");

  assert.deepEqual(personalDetailsPatch(form, baseline), {
    salaryExpectation: "39999",
    noticePeriod: "1 month",
  });
});

test("personal-details correction payload preserves deliberate clears", () => {
  const baseline = { linkedinUrl: "https://www.linkedin.com/in/yashwanth-sooriyakanthan/" };
  const form = new FormData();
  for (const [fieldName] of PERSONAL_DETAILS_FORM_FIELDS) form.set(fieldName, "");
  form.set("linkedinUrl", "");

  assert.deepEqual(personalDetailsPatch(form, baseline), { linkedinUrl: "" });
});
