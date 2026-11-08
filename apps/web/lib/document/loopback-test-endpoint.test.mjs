import assert from "node:assert/strict";
import test from "node:test";
import { loopbackTestOrigin, loopbackTestUrl } from "../loopback-test-endpoint.ts";

test("test provider endpoints require explicit development test-auth mode and loopback HTTP", () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    testAuth: process.env.JOBHUNT_TEST_AUTH,
    origin: process.env.JOBHUNT_DOCUMENT_DRIVE_TEST_ORIGIN,
    oauth: process.env.JOBHUNT_GOOGLE_OAUTH_TEST_URL,
  };
  try {
    delete process.env.JOBHUNT_DOCUMENT_DRIVE_TEST_ORIGIN;
    delete process.env.JOBHUNT_GOOGLE_OAUTH_TEST_URL;
    assert.equal(loopbackTestOrigin("JOBHUNT_DOCUMENT_DRIVE_TEST_ORIGIN"), null);
    assert.equal(loopbackTestUrl("JOBHUNT_GOOGLE_OAUTH_TEST_URL"), null);

    process.env.JOBHUNT_DOCUMENT_DRIVE_TEST_ORIGIN = "http://127.0.0.1:43127";
    process.env.JOBHUNT_GOOGLE_OAUTH_TEST_URL = "http://localhost:43127/oauth/token";
    process.env.NODE_ENV = "production";
    process.env.JOBHUNT_TEST_AUTH = "true";
    assert.throws(() => loopbackTestUrl("JOBHUNT_GOOGLE_OAUTH_TEST_URL"), /explicit local test-auth/);

    process.env.NODE_ENV = "development";
    process.env.JOBHUNT_TEST_AUTH = "false";
    assert.throws(() => loopbackTestOrigin("JOBHUNT_DOCUMENT_DRIVE_TEST_ORIGIN"), /explicit local test-auth/);

    process.env.JOBHUNT_TEST_AUTH = "true";
    assert.equal(loopbackTestOrigin("JOBHUNT_DOCUMENT_DRIVE_TEST_ORIGIN"), "http://127.0.0.1:43127");
    assert.equal(loopbackTestUrl("JOBHUNT_GOOGLE_OAUTH_TEST_URL"), "http://localhost:43127/oauth/token");
    assert.throws(() => loopbackTestOrigin("JOBHUNT_GOOGLE_OAUTH_TEST_URL"), /origin without a path/);

    process.env.JOBHUNT_DOCUMENT_DRIVE_TEST_ORIGIN = "http://example.com";
    assert.throws(() => loopbackTestOrigin("JOBHUNT_DOCUMENT_DRIVE_TEST_ORIGIN"), /loopback HTTP/);
    process.env.JOBHUNT_DOCUMENT_DRIVE_TEST_ORIGIN = "https://127.0.0.1:43127";
    assert.throws(() => loopbackTestOrigin("JOBHUNT_DOCUMENT_DRIVE_TEST_ORIGIN"), /loopback HTTP/);
    process.env.JOBHUNT_DOCUMENT_DRIVE_TEST_ORIGIN = "http://127.0.0.1:43127/path";
    assert.throws(() => loopbackTestOrigin("JOBHUNT_DOCUMENT_DRIVE_TEST_ORIGIN"), /origin without a path/);
  } finally {
    for (const [name, value] of Object.entries({
      NODE_ENV: previous.nodeEnv,
      JOBHUNT_TEST_AUTH: previous.testAuth,
      JOBHUNT_DOCUMENT_DRIVE_TEST_ORIGIN: previous.origin,
      JOBHUNT_GOOGLE_OAUTH_TEST_URL: previous.oauth,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
