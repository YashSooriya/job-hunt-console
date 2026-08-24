export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const EXTENSION_VERSION = "0.1.0" as const;

export type DispatchHint = {
  version: 1;
  type: "JOBHUNT_DISPATCH_HINT";
  request_id: string;
  correlation_id: string;
  nonce: string;
};

export type BridgeSettings = {
  extensionVersion?: string;
  backendUrl: string;
  deviceId: string | null;
  deviceToken: string | null;
  boundConversationUrl: string | null;
  boundProjectName: string | null;
  boundProjectVerified: boolean;
  automaticSendEnabled: boolean;
  activeRequestId?: string | null;
  activeLeaseToken?: string | null;
  activeLeaseExpiresAt?: string | null;
  lastError: string | null;
  lastDispatchId: string | null;
  lastDispatchAt: string | null;
};

export type PageToExtensionMessage =
  | { type: "JOBHUNT_BRIDGE_PROBE"; version: 1 }
  | DispatchHint;

export type ExtensionToPageMessage =
  | { type: "JOBHUNT_BRIDGE_READY"; version: 1 }
  | { type: "JOBHUNT_DISPATCH_ACCEPTED"; version: 1; request_id: string; nonce: string }
  | { type: "JOBHUNT_DISPATCH_REJECTED"; version: 1; request_id: string; nonce: string; reason: string };

export type RuntimeMessage =
  | { type: "PAGE_DISPATCH_HINT"; hint: DispatchHint }
  | { type: "CHATGPT_CONTENT_READY"; url: string }
  | { type: "PING_CHATGPT_CONTENT" }
  | { type: "EXECUTE_DISPATCH"; requestId: string; instruction: string; boundConversationUrl: string; boundProjectName: string }
  | { type: "BIND_CURRENT_CONVERSATION" }
  | { type: "GET_EXTENSION_STATUS" }
  | { type: "PAIR_EXTENSION"; backendUrl: string; pairingCode: string; displayName: string }
  | { type: "FORGET_LOCAL_PAIRING" }
  | { type: "SET_AUTOMATIC_SEND"; enabled: boolean }
  | { type: "OPEN_BOUND_CONVERSATION" }
  | { type: "RETRY_DISPATCH"; requestId: string };

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isNonEmptyString(value: unknown, maximum = 4000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

export function parsePageMessage(value: unknown): PageToExtensionMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.type === "JOBHUNT_BRIDGE_PROBE" && message.version === 1) return { type: "JOBHUNT_BRIDGE_PROBE", version: 1 };
  if (message.type !== "JOBHUNT_DISPATCH_HINT" || message.version !== 1) return null;
  if (!isUuid(message.request_id) || !isUuid(message.correlation_id) || !isNonEmptyString(message.nonce, 200)) return null;
  return { type: "JOBHUNT_DISPATCH_HINT", version: 1, request_id: message.request_id, correlation_id: message.correlation_id, nonce: message.nonce };
}

export function safeReason(value: unknown, fallback = "The bridge stopped safely.") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.replace(/[\r\n]+/g, " ").slice(0, 240);
}
