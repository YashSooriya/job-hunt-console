import { NextResponse } from "next/server";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import { readVerifiedProfessionalBackground } from "@/lib/chatgpt/verified-professional-background";
import { queueProfessionalBackgroundInstructions } from "@/lib/chatgpt/professional-background-dispatch";
import { bridgeReadinessError, bridgeReadyForDispatch, readBridgeReadiness } from "@/lib/chatgpt-bridge/readiness";
import { beginChatGptOperation, releaseChatGptOperation, trackChatGptOperation } from "@/lib/chatgpt-bridge/operation";

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message;
    if (typeof record.details === "string" && record.details.trim()) return record.details;
    if (typeof record.hint === "string" && record.hint.trim()) return record.hint;
  }
  return "Unable to complete activation.";
}

export async function POST() {
  let operationClient: any = null;
  let operationId: string | null = null;
  let operationTracked = false;
  try {
    const { supabase, profile } = await requireProfile();
    operationClient = supabase;
    const { data: readiness, error: readinessError } = await supabase.rpc("get_onboarding_readiness");
    if (readinessError) throw readinessError;
    if (readiness?.activation_ready !== true) {
      throw new Error("Complete the editable profile and job-search preferences before activation.");
    }
    const bridge = await readBridgeReadiness(supabase);
    if (!bridgeReadyForDispatch(bridge)) throw new Error(bridgeReadinessError(bridge));
    const input = await readVerifiedProfessionalBackground(supabase, profile, {
      includeImported: true,
      allowMemoryUpdate: true,
    });
    operationId = await beginChatGptOperation(supabase, "Complete onboarding profile with ChatGPT");
    const dispatches = await queueProfessionalBackgroundInstructions({
      supabase,
      userId: profile.user_id,
      input,
      displayTitle: "Update ChatGPT Memory from completed profile",
      idempotencyKeyPrefix: "profile.activation.memory:v2",
      priority: 55,
    });
    const requestIds = dispatches
      .map((item) => typeof item?.id === "string" ? item.id : null)
      .filter((id): id is string => Boolean(id));
    if (requestIds.length) {
      await trackChatGptOperation(supabase, operationId, requestIds);
      operationTracked = true;
    }
    let recovery = null;
    if (requestIds.length) {
      const { data, error } = await supabase.rpc("resume_professional_background_activation", { p_request_ids: requestIds });
      if (error) throw error;
      recovery = data;
    }
    const dispatch = dispatches[0] || null;
    const bridgeHints = dispatches.map((item) => ({
      version: 1 as const,
      type: "JOBHUNT_DISPATCH_HINT" as const,
      request_id: item.id,
      correlation_id: item.correlation_id || item.id,
      nonce: crypto.randomUUID(),
    }));

    const { data: completedReadiness, error: completionError } = await supabase.rpc("complete_candidate_onboarding");
    if (completionError) throw completionError;

    return NextResponse.json({
      ok: true,
      readiness: completedReadiness,
      dispatch,
      dispatches,
      recovery,
      bridge_hint: bridgeHints[0],
      bridge_hints: bridgeHints,
    }, { status: 202 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: errorMessage(error),
    }, { status: statusCode(error) });
  } finally {
    if (operationClient && operationId && !operationTracked) {
      try { await releaseChatGptOperation(operationClient, operationId); } catch { /* fail closed via the active dispatch query */ }
    }
  }
}
