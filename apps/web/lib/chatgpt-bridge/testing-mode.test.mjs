import assert from "node:assert/strict";
import test from "node:test";
import {
  applyChatGptTestingMode,
  CHATGPT_TESTING_MODE_PREFIX,
  MAX_CHATGPT_BRIDGE_INSTRUCTION_CHARS,
  chatGptInstructionBodyLimit,
  readChatGptTestingMode,
  requireChatGptTestingMode,
} from "../chatgpt/testing-mode.ts";
import { writeJobSearchControlBoolean } from "../diagnostics/job-search-control-setting.ts";

test("testing mode starts each dispatched message with the explicit no-Memory test warning", () => {
  const prepared = applyChatGptTestingMode("Inspect this public listing read-only.", true);
  assert.ok(prepared.startsWith("TEST ONLY — The following message is a test."));
  assert.match(prepared, /Do not add, save, or update anything from it to ChatGPT Memory or long-term memory\./);
  assert.ok(prepared.endsWith("Inspect this public listing read-only."));
  assert.equal(applyChatGptTestingMode(prepared, true), prepared, "the warning should not be duplicated");
});

test("disabled testing mode leaves the ordinary dispatch message byte-for-byte unchanged", () => {
  const instruction = "Configure the recurring job search for weekdays.";
  assert.equal(applyChatGptTestingMode(instruction, false), instruction);
});

test("diagnostic dispatches fail closed unless Testing Mode is enabled", () => {
  assert.equal(requireChatGptTestingMode(true), undefined);
  assert.throws(() => requireChatGptTestingMode(false), /Turn on ChatGPT testing mode.*No diagnostic was queued/);
});

test("testing mode rejects instructions that would exceed the bridge limit instead of truncating either part", () => {
  const remaining = MAX_CHATGPT_BRIDGE_INSTRUCTION_CHARS - CHATGPT_TESTING_MODE_PREFIX.length - 2;
  assert.equal(chatGptInstructionBodyLimit(true), remaining);
  assert.equal(chatGptInstructionBodyLimit(false), MAX_CHATGPT_BRIDGE_INSTRUCTION_CHARS);
  assert.equal(applyChatGptTestingMode("x".repeat(remaining), true).length, MAX_CHATGPT_BRIDGE_INSTRUCTION_CHARS);
  assert.throws(() => applyChatGptTestingMode("x".repeat(remaining + 1), true), /Shorten the message/);
});

test("testing mode is read from the authenticated owner's control row", async () => {
  const calls = [];
  const supabase = {
    from(table) {
      calls.push(["from", table]);
      return {
        select(columns) { calls.push(["select", columns]); return this; },
        eq(column, value) { calls.push(["eq", column, value]); return this; },
        async maybeSingle() { return { data: { testing_mode_enabled: true }, error: null }; },
      };
    },
  };
  assert.equal(await readChatGptTestingMode(supabase, "owner-1"), true);
  assert.deepEqual(calls, [
    ["from", "job_search_controls"],
    ["select", "testing_mode_enabled"],
    ["eq", "user_id", "owner-1"],
  ]);
});

test("writing one diagnostics boolean updates only that column and never upserts over its sibling", async () => {
  let payload;
  const supabase = {
    from(table) {
      assert.equal(table, "job_search_controls");
      return {
        update(value) { payload = value; return this; },
        eq(column, value) { assert.equal(column, "user_id"); assert.equal(value, "owner-1"); return this; },
        select(column) { assert.equal(column, "testing_mode_enabled"); return this; },
        async maybeSingle() { return { data: { testing_mode_enabled: true }, error: null }; },
      };
    },
  };
  assert.equal(await writeJobSearchControlBoolean(supabase, "owner-1", "testing_mode_enabled", true), true);
  assert.deepEqual(Object.keys(payload).sort(), ["testing_mode_enabled", "updated_at"]);
  assert.equal(payload.testing_mode_enabled, true);
});
