"use client";

import { useState } from "react";
import { createChatGptDispatch, dispatchStateLabel } from "@/lib/chatgpt-bridge/client";
import { useDispatchStatus } from "@/lib/chatgpt-bridge/use-dispatch-status";
import { useChatGptOperation } from "@/components/chatgpt-operation-provider";
import { isWaitingForChatGpt } from "@/lib/chatgpt-bridge/activity";

export function ChatGptDispatchButton({ actionType, applicationId, label }: { actionType: "documents.cv.create" | "documents.cover_letter.create"; applicationId: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dispatchId, setDispatchId] = useState<string | null>(null);
  const dispatchStatus = useDispatchStatus(dispatchId);
  const chatgptOperation = useChatGptOperation();
  const waitingForChatGpt = isWaitingForChatGpt({ state: dispatchStatus.state || undefined, raw: dispatchStatus.dispatch?.raw });

  async function dispatch() {
    const operationToken = chatgptOperation.beginLocalOperation(label);
    if (!operationToken) { setMessage(chatgptOperation.message || "Another ChatGPT task is already active."); return; }
    setBusy(true); setMessage(null);
    try {
      const websiteInstruction = actionType === "documents.cover_letter.create"
        ? "Create a tailored cover letter for the selected job listing. Return the complete draft for review. Do not send it or submit an application."
        : "Create a tailored CV for the selected job listing. Return the complete draft for review. Do not send it or submit an application.";
      const result = await createChatGptDispatch({ actionType, subjectRefs: { application_ids: [applicationId] }, displayTitle: label, websiteInstruction, idempotencyKey: `${actionType}:${applicationId}:${Math.floor(Date.now() / 60000)}` });
      if (typeof result.dispatch?.id === "string") {
        setDispatchId(result.dispatch.id);
        setMessage(`Queued for the Website Bridge. Waiting for ChatGPT’s response…`);
      } else setMessage("Dispatch queued.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to queue the ChatGPT draft."); }
    finally { setBusy(false); chatgptOperation.finishLocalOperation(operationToken); }
  }
  const stateLabel = dispatchStatus.state ? dispatchStateLabel(dispatchStatus.state, dispatchStatus.dispatch?.raw) : null;
  return <div><button className="secondaryButton" type="button" onClick={() => void dispatch()} disabled={busy || chatgptOperation.blocked}>{waitingForChatGpt ? <><span className="chatgptActivitySpinner" aria-hidden="true" /> Waiting for ChatGPT…</> : busy ? "Queueing…" : label}</button>{message ? <small className="formHint">{message}</small> : null}{dispatchStatus.dispatch ? <small className="formHint">Bridge state: {stateLabel || dispatchStatus.state}{dispatchStatus.response ? <pre className="commandBlock">{dispatchStatus.response}</pre> : null}</small> : null}{dispatchStatus.error ? <small className="formHint">{dispatchStatus.error}</small> : null}</div>;
}
