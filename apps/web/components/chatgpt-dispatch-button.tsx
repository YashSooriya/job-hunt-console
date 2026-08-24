"use client";

import { useState } from "react";
import { createChatGptDispatch } from "@/lib/chatgpt-bridge/client";

export function ChatGptDispatchButton({ actionType, applicationId, label }: { actionType: "documents.cv.create" | "documents.cover_letter.create"; applicationId: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function dispatch() {
    setBusy(true); setMessage(null);
    try {
      const result = await createChatGptDispatch({ actionType, subjectRefs: { application_ids: [applicationId] }, displayTitle: label, idempotencyKey: `${actionType}:${applicationId}:${Math.floor(Date.now() / 60000)}` });
      setMessage(typeof result.dispatch?.id === "string" ? `Dispatch ${result.dispatch.id} queued. The extension will deliver it when ready.` : "Dispatch queued.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to queue the ChatGPT draft."); }
    finally { setBusy(false); }
  }
  return <div><button className="secondaryButton" type="button" onClick={() => void dispatch()} disabled={busy}>{busy ? "Queueing…" : label}</button>{message ? <small className="formHint">{message}</small> : null}</div>;
}
