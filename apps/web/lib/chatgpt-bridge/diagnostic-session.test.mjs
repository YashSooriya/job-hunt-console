import assert from "node:assert/strict";
import test from "node:test";
import {
  clearMessageDiagnosticIdempotencyKey,
  clearSettingsDiagnosticIdempotencyKey,
  diagnosticStorageForAccount,
  getOrCreateMessageDiagnosticIdempotencyKey,
  getOrCreateSettingsDiagnosticIdempotencyKey,
  PENDING_MESSAGE_DIAGNOSTIC_KEY,
  PENDING_DIAGNOSTIC_IDEMPOTENCY_KEY,
  readRecentDiagnosticDispatchId,
  RECENT_DIAGNOSTIC_DISPATCH_KEY,
  rememberRecentDiagnosticDispatchId,
} from "./diagnostic-session.ts";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
  };
}

test("diagnostic UI restores only a valid dispatch id for the signed-in account", () => {
  const storage = diagnosticStorageForAccount("11111111-1111-4111-8111-111111111111", memoryStorage());
  const id = "50d2d9fb-495f-4c36-8e3d-d8919a3cc57c";
  rememberRecentDiagnosticDispatchId(id, storage);
  assert.equal(storage.getItem(RECENT_DIAGNOSTIC_DISPATCH_KEY), id);
  assert.equal(readRecentDiagnosticDispatchId(storage), id);
  storage.setItem(RECENT_DIAGNOSTIC_DISPATCH_KEY, "not-a-dispatch-id");
  assert.equal(readRecentDiagnosticDispatchId(storage), null);
});

test("Settings diagnostic retries reuse an account-scoped idempotency key until accepted", () => {
  const storage = diagnosticStorageForAccount("11111111-1111-4111-8111-111111111111", memoryStorage());
  let generated = 0;
  const createId = () => `00000000-0000-4000-8000-${String(++generated).padStart(12, "0")}`;
  const first = getOrCreateSettingsDiagnosticIdempotencyKey(storage, createId);
  assert.equal(storage.getItem(PENDING_DIAGNOSTIC_IDEMPOTENCY_KEY), first);
  assert.equal(getOrCreateSettingsDiagnosticIdempotencyKey(storage, createId), first);
  assert.equal(generated, 1);
  clearSettingsDiagnosticIdempotencyKey(storage);
  assert.equal(getOrCreateSettingsDiagnosticIdempotencyKey(storage, createId), "bridge.diagnostic.settings:00000000-0000-4000-8000-000000000002");
});

test("free-text retries reuse an account-scoped persistent key across tab-session loss without storing the prompt", async () => {
  const localStorage = memoryStorage();
  const storage = diagnosticStorageForAccount("11111111-1111-4111-8111-111111111111", localStorage);
  const sessionStorage = memoryStorage();
  let generated = 0;
  const createId = () => `00000000-0000-4000-8000-${String(++generated).padStart(12, "0")}`;
  const message = "Inspect this harmless diagnostic text.";
  const first = await getOrCreateMessageDiagnosticIdempotencyKey(message, storage, createId);
  const stored = storage.getItem(PENDING_MESSAGE_DIAGNOSTIC_KEY);
  assert.equal(JSON.parse(stored).key, first);
  assert.equal(stored.includes(message), false, "browser storage must not contain the diagnostic prompt");
  sessionStorage.clear();
  const restoredStorage = diagnosticStorageForAccount("11111111-1111-4111-8111-111111111111", localStorage);
  assert.equal(await getOrCreateMessageDiagnosticIdempotencyKey(message, restoredStorage, createId), first);
  await assert.rejects(
    getOrCreateMessageDiagnosticIdempotencyKey("A different diagnostic text.", restoredStorage, createId),
    /prior diagnostic is awaiting confirmation/i,
  );
  assert.equal(generated, 1, "a changed message must not overwrite an unresolved retry identity");
  assert.equal(clearMessageDiagnosticIdempotencyKey(restoredStorage), true);
  assert.equal(restoredStorage.getItem(PENDING_MESSAGE_DIAGNOSTIC_KEY), null);
  const second = await getOrCreateMessageDiagnosticIdempotencyKey(message, restoredStorage, createId);
  assert.notEqual(second, first, "a genuinely new action after acceptance receives a new identity");
  assert.equal(generated, 2);
});

test("account namespaces prevent retry identity or recent dispatch state crossing sign-ins", () => {
  const localStorage = memoryStorage();
  const firstAccount = diagnosticStorageForAccount("11111111-1111-4111-8111-111111111111", localStorage);
  const secondAccount = diagnosticStorageForAccount("22222222-2222-4222-8222-222222222222", localStorage);
  let generated = 0;
  const createId = () => `00000000-0000-4000-8000-${String(++generated).padStart(12, "0")}`;
  const first = getOrCreateSettingsDiagnosticIdempotencyKey(firstAccount, createId);
  assert.equal(getOrCreateSettingsDiagnosticIdempotencyKey(secondAccount, createId), "bridge.diagnostic.settings:00000000-0000-4000-8000-000000000002");
  assert.equal(getOrCreateSettingsDiagnosticIdempotencyKey(firstAccount, createId), first);
  const dispatchId = "50d2d9fb-495f-4c36-8e3d-d8919a3cc57c";
  assert.equal(rememberRecentDiagnosticDispatchId(dispatchId, firstAccount), true);
  assert.equal(readRecentDiagnosticDispatchId(firstAccount), dispatchId);
  assert.equal(readRecentDiagnosticDispatchId(secondAccount), null);
  assert.equal(generated, 2);
});

test("blocked browser storage refuses to create a diagnostic request identity", async () => {
  const storage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.throws(
    () => getOrCreateSettingsDiagnosticIdempotencyKey(storage, () => "00000000-0000-4000-8000-000000000001"),
    /cannot preserve a diagnostic retry identity/i,
  );
  await assert.rejects(
    getOrCreateMessageDiagnosticIdempotencyKey("No dispatch without storage.", storage, () => "00000000-0000-4000-8000-000000000002"),
    /cannot preserve a diagnostic retry identity/i,
  );
  assert.equal(clearSettingsDiagnosticIdempotencyKey(storage), false);
});

test("storage write or readback failure stops before a request identity is returned", async () => {
  const writeFailure = {
    getItem() { return null; },
    setItem() { throw new Error("quota exceeded"); },
    removeItem() {},
  };
  assert.throws(
    () => getOrCreateSettingsDiagnosticIdempotencyKey(writeFailure, () => "00000000-0000-4000-8000-000000000003"),
    /cannot preserve a diagnostic retry identity/i,
  );
  await assert.rejects(
    getOrCreateMessageDiagnosticIdempotencyKey("Do not dispatch without a durable key.", writeFailure, () => "00000000-0000-4000-8000-000000000004"),
    /cannot preserve a diagnostic retry identity/i,
  );
  const readbackFailure = { getItem() { return null; }, setItem() {}, removeItem() {} };
  assert.throws(
    () => getOrCreateSettingsDiagnosticIdempotencyKey(readbackFailure, () => "00000000-0000-4000-8000-000000000005"),
    /cannot preserve a diagnostic retry identity/i,
  );
  await assert.rejects(
    getOrCreateMessageDiagnosticIdempotencyKey("Stop when key readback fails.", readbackFailure, () => "00000000-0000-4000-8000-000000000006"),
    /cannot preserve a diagnostic retry identity/i,
  );
});

test("account storage rejects invalid account identifiers", () => {
  assert.equal(diagnosticStorageForAccount("not-an-account-id", memoryStorage()), null);
});
