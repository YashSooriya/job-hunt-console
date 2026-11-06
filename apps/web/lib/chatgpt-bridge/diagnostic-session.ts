const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_RE = /^bridge\.diagnostic\.settings:[A-Za-z0-9_.:-]{1,160}$/;
const MESSAGE_IDEMPOTENCY_KEY_RE = /^bridge\.diagnostic\.message:[A-Za-z0-9_.:-]{1,160}$/;

export const RECENT_DIAGNOSTIC_DISPATCH_KEY = "jobhunt:recent-bridge-diagnostic:v1";
export const PENDING_DIAGNOSTIC_IDEMPOTENCY_KEY = "jobhunt:pending-bridge-diagnostic-key:v1";
export const PENDING_MESSAGE_DIAGNOSTIC_KEY = "jobhunt:pending-bridge-message:v1";

export type DiagnosticStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const STORAGE_ERROR = "This browser cannot preserve a diagnostic retry identity. Allow browser storage and retry; no diagnostic was sent.";

function browserLocalStorage(): DiagnosticStorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Scope persisted retry state to the authenticated account. This lets a retry
 * survive a tab/session restart without carrying one user's dispatch identity
 * into another user's session in the same browser profile.
 */
export function diagnosticStorageForAccount(
  accountId: string,
  storage: DiagnosticStorageLike | null = browserLocalStorage(),
): DiagnosticStorageLike | null {
  if (!storage || !UUID_RE.test(accountId)) return null;
  const prefix = `jobhunt:diagnostic:${accountId.toLowerCase()}:`;
  return {
    getItem(key) { return storage.getItem(`${prefix}${key}`); },
    setItem(key, value) { storage.setItem(`${prefix}${key}`, value); },
    removeItem(key) { storage.removeItem(`${prefix}${key}`); },
  };
}

export function readRecentDiagnosticDispatchId(storage: DiagnosticStorageLike | null): string | null {
  if (!storage) return null;
  try {
    const id = storage.getItem(RECENT_DIAGNOSTIC_DISPATCH_KEY);
    return id && UUID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function rememberRecentDiagnosticDispatchId(id: string, storage: DiagnosticStorageLike | null) {
  if (!storage || !UUID_RE.test(id)) return false;
  try {
    storage.setItem(RECENT_DIAGNOSTIC_DISPATCH_KEY, id);
    return storage.getItem(RECENT_DIAGNOSTIC_DISPATCH_KEY) === id;
  } catch {
    return false;
  }
}

export function getOrCreateSettingsDiagnosticIdempotencyKey(
  storage: DiagnosticStorageLike | null,
  createId: () => string = () => globalThis.crypto.randomUUID(),
) {
  if (!storage) throw new Error(STORAGE_ERROR);
  let existing: string | null;
  try {
    existing = storage.getItem(PENDING_DIAGNOSTIC_IDEMPOTENCY_KEY);
  } catch {
    throw new Error(STORAGE_ERROR);
  }
  if (existing && IDEMPOTENCY_KEY_RE.test(existing)) return existing;
  const key = `bridge.diagnostic.settings:${createId()}`;
  if (!IDEMPOTENCY_KEY_RE.test(key)) throw new Error("A safe diagnostic retry identity could not be created. No diagnostic was sent.");
  try {
    storage.setItem(PENDING_DIAGNOSTIC_IDEMPOTENCY_KEY, key);
    if (storage.getItem(PENDING_DIAGNOSTIC_IDEMPOTENCY_KEY) !== key) throw new Error("Storage readback failed.");
  } catch {
    throw new Error(STORAGE_ERROR);
  }
  return key;
}

export function clearSettingsDiagnosticIdempotencyKey(storage: DiagnosticStorageLike | null) {
  if (!storage) return false;
  try {
    storage.removeItem(PENDING_DIAGNOSTIC_IDEMPOTENCY_KEY);
    return storage.getItem(PENDING_DIAGNOSTIC_IDEMPOTENCY_KEY) === null;
  } catch {
    return false;
  }
}

async function diagnosticMessageFingerprint(message: string) {
  const cryptoProvider = globalThis.crypto;
  if (!cryptoProvider?.subtle) return null;
  try {
    const digest = await cryptoProvider.subtle.digest("SHA-256", new TextEncoder().encode(message));
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

export async function getOrCreateMessageDiagnosticIdempotencyKey(
  message: string,
  storage: DiagnosticStorageLike | null,
  createId: () => string = () => globalThis.crypto.randomUUID(),
) {
  if (!storage) throw new Error(STORAGE_ERROR);
  const fingerprint = await diagnosticMessageFingerprint(message);
  if (!fingerprint) throw new Error("Secure diagnostic retry identity is unavailable. No diagnostic was sent.");
  let pending: Record<string, unknown> | null;
  try {
    pending = JSON.parse(storage.getItem(PENDING_MESSAGE_DIAGNOSTIC_KEY) || "null") as Record<string, unknown> | null;
  } catch {
    throw new Error(STORAGE_ERROR);
  }
  if (pending && typeof pending.key === "string" && MESSAGE_IDEMPOTENCY_KEY_RE.test(pending.key)) {
    if (pending.fingerprint === fingerprint) return pending.key;
    throw new Error("A prior diagnostic is awaiting confirmation. Retry its exact message before starting another diagnostic.");
  }

  const key = `bridge.diagnostic.message:${createId()}`;
  if (!MESSAGE_IDEMPOTENCY_KEY_RE.test(key)) throw new Error("A safe diagnostic retry identity could not be created. No diagnostic was sent.");
  try {
    // Keep only a content fingerprint and opaque retry key; never persist the diagnostic text.
    const value = JSON.stringify({ fingerprint, key });
    storage.setItem(PENDING_MESSAGE_DIAGNOSTIC_KEY, value);
    if (storage.getItem(PENDING_MESSAGE_DIAGNOSTIC_KEY) !== value) throw new Error("Storage readback failed.");
  } catch {
    throw new Error(STORAGE_ERROR);
  }
  return key;
}

export function clearMessageDiagnosticIdempotencyKey(storage: DiagnosticStorageLike | null) {
  if (!storage) return false;
  try {
    storage.removeItem(PENDING_MESSAGE_DIAGNOSTIC_KEY);
    return storage.getItem(PENDING_MESSAGE_DIAGNOSTIC_KEY) === null;
  } catch {
    return false;
  }
}
