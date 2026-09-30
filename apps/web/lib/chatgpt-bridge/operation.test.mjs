import assert from "node:assert/strict";
import test from "node:test";
import { getChatGptOperationActivity, setChatGptActionLockDisabled } from "./operation.ts";

test("operation activity includes the server-authoritative Diagnostics override state", async () => {
  const calls = [];
  const supabase = {
    async rpc(name, args) {
      calls.push([name, args]);
      return { data: { ok: true, busy: true, lock_disabled: true, display_title: "Import job listings" }, error: null };
    },
  };

  assert.deepEqual(await getChatGptOperationActivity(supabase), {
    busy: true,
    lock_disabled: true,
    display_title: "Import job listings",
  });
  assert.equal(calls[0][0], "manage_chatgpt_user_operation");
  assert.equal(calls[0][1].p_action, "status");
});

test("setting the Diagnostics override uses the existing owner-scoped operation RPC", async () => {
  const calls = [];
  const supabase = {
    async rpc(name, args) {
      calls.push([name, args]);
      return { data: { ok: true, busy: false, lock_disabled: true }, error: null };
    },
  };

  const result = await setChatGptActionLockDisabled(supabase, true);
  assert.equal(result.lock_disabled, true);
  assert.deepEqual(calls, [["manage_chatgpt_user_operation", {
    p_operation_id: null,
    p_action: "set_action_lock_disabled",
    p_display_title: "true",
    p_dispatch_ids: [],
  }]]);
});
