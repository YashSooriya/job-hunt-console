import test from "node:test";
import assert from "node:assert/strict";
import { isLocalTestAuthEnabled } from "./config.ts";

const original = {
  nodeEnv: process.env.NODE_ENV,
  testAuth: process.env.JOBHUNT_TEST_AUTH,
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
};

function restore() {
  for (const [key, value] of [
    ["NODE_ENV", original.nodeEnv],
    ["JOBHUNT_TEST_AUTH", original.testAuth],
    ["NEXT_PUBLIC_SUPABASE_URL", original.supabaseUrl],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("local test auth requires an explicit development flag and loopback HTTP URL", () => {
  try {
    process.env.NODE_ENV = "development";
    process.env.JOBHUNT_TEST_AUTH = "true";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:56321";
    assert.equal(isLocalTestAuthEnabled(), true);

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    assert.equal(isLocalTestAuthEnabled(), false);

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://localhost:56321";
    assert.equal(isLocalTestAuthEnabled(), false);

    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:56321";
    process.env.NODE_ENV = "production";
    assert.equal(isLocalTestAuthEnabled(), false);

    process.env.NODE_ENV = "development";
    process.env.JOBHUNT_TEST_AUTH = "false";
    assert.equal(isLocalTestAuthEnabled(), false);
  } finally {
    restore();
  }
});
