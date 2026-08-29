"use client";

import { useCallback, useEffect, useState } from "react";
import { notifyBridgeHint } from "@/lib/chatgpt-bridge/notify";

type MemoryState = {
  confirmed: boolean;
  decision: "undecided" | "allowed" | "declined" | string;
  memorySyncEnabled: boolean;
  reminderRequired: boolean;
  importStatus: "not_requested" | "queued" | "in_progress" | "completed" | "failed" | "user_required" | string;
  importError?: string | null;
  responseCheckAvailable?: boolean;
  bridge?: {
    paired: boolean;
    online: boolean;
    automaticSendEnabled: boolean;
    extensionVersion: string | null;
    hasProfessionalBackgroundConversation: boolean;
    workflowConversationCount: number;
  } | null;
};

const activeImportStatuses = new Set(["queued", "in_progress"]);

export function ChatGptMemorySetup({
  onProfileChanged,
  onMemoryChanged,
}: {
  onProfileChanged?: () => void;
  onMemoryChanged?: (memory: MemoryState) => void;
}) {
  const [memory, setMemory] = useState<MemoryState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/onboarding/memory", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "ChatGPT Memory setup is unavailable.");
    const next = data.memory as MemoryState;
    setMemory(next);
    onMemoryChanged?.(next);
    if (next.importStatus === "completed") onProfileChanged?.();
    // A bridge timeout can leave a queued notice in the component even after
    // the server has safely stopped the request. Do not tell the user that a
    // request is still queued when the next action is review or a read-only
    // response check.
    if (next.importStatus === "user_required" || next.importStatus === "failed") setMessage(null);
    return next;
  }, [onMemoryChanged, onProfileChanged]);

  useEffect(() => {
    refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "ChatGPT Memory setup is unavailable."));
  }, [refresh]);

  useEffect(() => {
    if (!memory || !activeImportStatuses.has(memory.importStatus)) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await refresh();
        if (!cancelled && activeImportStatuses.has(next.importStatus)) timer = window.setTimeout(() => void poll(), 2500);
      } catch {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 4000);
      }
    };
    timer = window.setTimeout(() => void poll(), 1800);
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [memory?.importStatus, refresh]);

  async function choose(action: "allow_and_import" | "decline" | "reset" | "check_completed_response") {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/onboarding/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Unable to save the ChatGPT Memory choice.");
      notifyBridgeHint(data.bridge_hint);
      const nextMemory = data.memory as MemoryState;
      setMemory(nextMemory);
      onMemoryChanged?.(nextMemory);
      const requestStillActive = activeImportStatuses.has(nextMemory.importStatus);
      setMessage(action === "allow_and_import" && requestStillActive
        ? "The request is queued. ChatGPT will read the complete source bundle above, update its Memory, then create and return professional-profile.json through the Website Bridge; the values will appear in the editable fields below."
        : action === "check_completed_response"
          ? "Checking the bound ChatGPT conversation for an already completed professional-profile.json response. No new ChatGPT message will be sent."
          : action === "decline"
            ? "ChatGPT Memory will not be used. You can still build a complete profile from your details, CVs, LinkedIn and other information."
            : null);
      if (action === "reset") onProfileChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the ChatGPT Memory choice.");
    } finally {
      setBusy(false);
    }
  }

  if (!memory) return null;

  const undecided = memory.decision === "undecided";
  const allowed = memory.decision === "allowed" || memory.confirmed;
  const importing = activeImportStatuses.has(memory.importStatus);
  const completed = memory.importStatus === "completed";
  const responseCheckAvailable = memory.responseCheckAvailable === true;
  const bridgeMessage = !memory.bridge
    ? "The request is queued, but the Website Bridge status cannot be checked right now."
    : !memory.bridge.paired
      ? "The request is queued, but no ChatGPT Website Bridge is paired yet. Pair the extension; Automatic Send is enabled automatically."
      : !memory.bridge.hasProfessionalBackgroundConversation
        ? "The Professional background workflow chat is not set up on this bridge. Update or reload the latest extension and choose Set up missing workflow chats. Automatic Send is enabled automatically."
        : !memory.bridge.online
          ? "The workflow chat is ready, but the paired bridge is offline. Keep ChatGPT open with the extension enabled."
          : !memory.bridge.automaticSendEnabled
            ? "The workflow chat is ready while Automatic Send is being enabled. Keep the extension open for a moment and try again."
            : "The Website Bridge is ready. Keep ChatGPT open while the source Memory updates and profile import are processed.";

  return <section className="card memorySetupCard" aria-labelledby="memory-setup-title">
    <div className="cardHeader"><div><div className="eyebrow">Step 2 · Optional</div><h2 id="memory-setup-title">Use your ChatGPT Memory?</h2><p>Allow ChatGPT to fill the exact JobHuntAI onboarding fields with the professional information it already remembers.</p></div><span className={`badge ${allowed ? "review" : undecided ? "action" : "muted"}`}>{allowed ? "Allowed" : undecided ? "Not chosen" : "Not using"}</span></div>
    {undecided ? <>
      <p className="memorySetupCopy">ChatGPT will return only the fields used on this page, including your contact details, work authorisation, employment, education, skills, projects, publications, certifications and job-search preferences. The CVs, LinkedIn URL and additional information saved above will be sent together in one request. ChatGPT will update its Memory, create and download professional-profile.json, and return the same JSON for automatic import. You will check and edit the actual fields below before sending any additions or corrections back to Memory.</p>
      <div className="buttonRow memorySetupActions"><button className="primaryButton" type="button" disabled={busy} onClick={() => void choose("allow_and_import")}>{busy ? "Starting…" : "Yes, use ChatGPT Memory"}</button><button className="secondaryButton" type="button" disabled={busy} onClick={() => void choose("decline")}>No, I’ll fill it in myself</button></div>
    </> : allowed ? <>
      <p className="memorySetupCopy">ChatGPT Memory access is allowed. Add or update your CVs, LinkedIn URL and additional information in the source section above, then choose <strong>Save sources and build profile</strong>. One Website Bridge request will give ChatGPT the complete source bundle, update its Memory, and create/download professional-profile.json for automatic import. Imported values will be placed directly into the editable fields; empty fields are highlighted, and saving a correction or addition marks it for the single combined Memory update later.</p>
      <div className="buttonRow memorySetupActions">
        {importing ? <div className="memorySetupProgress"><span className="formHint">ChatGPT is updating Memory and creating your structured onboarding profile…</span><p>{bridgeMessage} <a href="/settings#chatgpt-bridge" className="textLink">Open Website Bridge settings</a>.</p></div>
          : completed ? <span className="formHint">Profile import complete. Review and edit the fields below.</span>
            : responseCheckAvailable ? <div className="memorySyncActions"><span className="formHint">ChatGPT may have finished after the bridge timed out.</span><button className="primaryButton" type="button" disabled={busy} onClick={() => void choose("check_completed_response")}>{busy ? "Checking…" : "Check for completed JSON"}</button></div>
              : <button className="primaryButton" type="button" disabled={busy} onClick={() => void choose("allow_and_import")}>{busy ? "Starting…" : "Get profile from ChatGPT again"}</button>}
        <button className="textLink" type="button" disabled={busy} onClick={() => void choose("reset")}>Change choice</button>
      </div>
    </> : <>
      <p className="memorySetupCopy">ChatGPT Memory is not being used. You can still build a complete JobHuntAI profile from the information you provide here.</p>
      <div className="buttonRow memorySetupActions"><button className="secondaryButton" type="button" disabled={busy} onClick={() => void choose("allow_and_import")}>{busy ? "Starting…" : "Allow and get profile from ChatGPT"}</button></div>
    </>}
    {message ? <div className="notice">{message}</div> : null}
    {memory.importError ? <div className="formError">{memory.importError}</div> : null}
    {error ? <div className="formError">{error}</div> : null}
  </section>;
}
