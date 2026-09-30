import { bridgeVersionAtLeast, CURRENT_BRIDGE_EXTENSION_VERSION } from "./lifecycle.ts";

/**
 * The small, content-free bridge snapshot used before a server creates a
 * dispatch.  This deliberately does not include instructions, response text,
 * signed source URLs, or bridge credentials.
 */
export type BridgeReadiness = {
  paired: boolean;
  online: boolean;
  automaticSendEnabled: boolean;
  extensionVersion: string | null;
  extensionBuildId: string | null;
  backgroundFocusPolicyV2: boolean;
  resultCompletionV3: boolean;
  responseProvenanceV3: boolean;
  hasProfessionalBackgroundConversation: boolean;
  workflowConversationCount: number;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Read the user-owned bridge status without exposing private dispatch data. */
export async function readBridgeReadiness(supabase: any): Promise<BridgeReadiness | null> {
  try {
    const { data, error } = await supabase.rpc("get_chatgpt_bridge_status");
    if (error || !data || typeof data !== "object") return null;
    const payload = objectValue(data);
    const devices = Array.isArray(payload.devices)
      ? payload.devices.filter((candidate): candidate is Record<string, unknown> => Boolean(candidate && typeof candidate === "object" && !Array.isArray(candidate)))
      : [];
    // Dispatch creation is server-pinned to the preferred device. Selecting a
    // different online device here reports readiness for a device that will
    // never receive the request and makes the queue appear to hang.
    const device = devices.find((candidate) => candidate.preferred === true)
      || devices.find((candidate) => candidate.online === true)
      || devices[0]
      || null;
    const capabilities = objectValue(device?.capabilities);
    const serverCapabilities = objectValue(device?.server_capabilities || payload.server_capabilities);
    const conversations = Array.isArray(device?.conversations)
      ? device.conversations.filter((candidate): candidate is Record<string, unknown> => Boolean(candidate && typeof candidate === "object" && !Array.isArray(candidate)))
      : [];
    return {
      paired: devices.length > 0,
      online: device?.online === true,
      automaticSendEnabled: device?.automatic_send_enabled === true,
      extensionVersion: typeof device?.extension_version === "string" ? device.extension_version : null,
      extensionBuildId: typeof capabilities.build_id === "string" ? capabilities.build_id : null,
      backgroundFocusPolicyV2: capabilities.background_focus_policy_v2 === true,
      resultCompletionV3: capabilities.result_completion_v3 === true && serverCapabilities.result_completion_v3 === true,
      responseProvenanceV3: capabilities.response_provenance_v3 === true && serverCapabilities.response_provenance_v3 === true,
      hasProfessionalBackgroundConversation: conversations.some((conversation) => (
        conversation.workflow_key === "profile.background" && conversation.project_verified !== false
      )),
      workflowConversationCount: conversations.length,
    };
  } catch {
    return null;
  }
}

export function bridgeReadyForDispatch(bridge: BridgeReadiness | null) {
  return Boolean(
    bridge?.paired
      && bridge.online
      && bridge.automaticSendEnabled
      && bridge.hasProfessionalBackgroundConversation
      && bridge.backgroundFocusPolicyV2
      && bridge.resultCompletionV3
      && bridge.responseProvenanceV3
      && bridgeVersionAtLeast(bridge.extensionVersion),
  );
}

export function bridgeReadinessError(bridge: BridgeReadiness | null) {
  if (!bridge) return "The Website Bridge status could not be checked. Keep the latest extension open and try again.";
  if (!bridge.paired) return "Pair the latest Website Bridge before sending a ChatGPT Memory update.";
  if (!bridge.online) return "The paired Website Bridge is offline. Keep ChatGPT open with the latest extension before sending the update.";
  if (!bridgeVersionAtLeast(bridge.extensionVersion) || !bridge.backgroundFocusPolicyV2) {
    return `Update or reload the paired Website Bridge to version ${CURRENT_BRIDGE_EXTENSION_VERSION} before sending the Memory update.`;
  }
  if (!bridge.resultCompletionV3 || !bridge.responseProvenanceV3) {
    return "The Website Bridge and its free-tier backend are on different versions. Deploy the latest bridge backend, then reload the extension before sending the update.";
  }
  if (!bridge.hasProfessionalBackgroundConversation) return "The Professional background ChatGPT conversation is not ready. Set up the latest Website Bridge workflow chats first.";
  if (!bridge.automaticSendEnabled) return "Automatic Send is not enabled on the paired Website Bridge yet. Keep the extension open and try again.";
  return "The Website Bridge is not ready for a ChatGPT Memory update.";
}
