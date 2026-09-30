export type ChatGptOperationActivity = {
  busy: boolean;
  lock_disabled: boolean;
  display_title?: string;
  dispatch_state?: string;
  progress?: Record<string, unknown>;
};

export class ChatGptOperationBusyError extends Error {
  constructor(message = "A ChatGPT task is already in progress. Wait for its response before starting another ChatGPT action.") {
    super(message);
    this.name = "ChatGptOperationBusyError";
  }
}

type OperationAction = "begin" | "track" | "release" | "status" | "set_action_lock_disabled";

async function manageChatGptOperation(
  supabase: any,
  action: OperationAction,
  operationId: string | null = null,
  displayTitle: string | null = null,
  dispatchIds: string[] = [],
) {
  const { data, error } = await supabase.rpc("manage_chatgpt_user_operation", {
    p_operation_id: operationId,
    p_action: action,
    p_display_title: displayTitle,
    p_dispatch_ids: dispatchIds,
  });
  if (error) throw error;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The ChatGPT activity service returned an invalid response.");
  return data as Record<string, unknown>;
}

export async function beginChatGptOperation(supabase: any, displayTitle: string) {
  const operationId = crypto.randomUUID();
  const result = await manageChatGptOperation(supabase, "begin", operationId, displayTitle);
  if (result.ok !== true) {
    throw new ChatGptOperationBusyError(typeof result.error === "string" ? result.error : undefined);
  }
  return operationId;
}

export async function trackChatGptOperation(supabase: any, operationId: string, dispatchIds: string[]) {
  const uniqueIds = [...new Set(dispatchIds.filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)))];
  if (!uniqueIds.length) throw new Error("A ChatGPT operation cannot be tracked without its dispatch request ids.");
  await manageChatGptOperation(supabase, "track", operationId, null, uniqueIds);
}

export async function releaseChatGptOperation(supabase: any, operationId: string) {
  await manageChatGptOperation(supabase, "release", operationId);
}

export async function getChatGptOperationActivity(supabase: any): Promise<ChatGptOperationActivity> {
  const result = await manageChatGptOperation(supabase, "status");
  return {
    busy: result.busy === true,
    lock_disabled: result.lock_disabled === true,
    ...(typeof result.display_title === "string" ? { display_title: result.display_title } : {}),
    ...(typeof result.dispatch_state === "string" ? { dispatch_state: result.dispatch_state } : {}),
    ...(result.progress && typeof result.progress === "object" && !Array.isArray(result.progress)
      ? { progress: result.progress as Record<string, unknown> }
      : {}),
  };
}

export async function setChatGptActionLockDisabled(supabase: any, disabled: boolean) {
  return manageChatGptOperation(supabase, "set_action_lock_disabled", null, disabled ? "true" : "false");
}
