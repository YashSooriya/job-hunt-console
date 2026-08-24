"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { inspectionStatusLabel, type JobUrlInspectionStatus } from "@/lib/job-url-inspection";

type Inspection = {
  id: string;
  source_url: string;
  status: JobUrlInspectionStatus;
  error_json?: { message?: string } | null;
  job_id?: string | null;
  execution?: "openai_responses" | "chatgpt_browser_bridge" | "manual_chatgpt";
};

type BridgeHint = { version: 1; type: "JOBHUNT_DISPATCH_HINT"; request_id: string; correlation_id: string; nonce: string };

function notifyBridge(hint: BridgeHint | undefined) {
  if (typeof window === "undefined" || !hint) return;
  window.postMessage(hint, window.location.origin);
}

export function JobUrlInspectionForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [dispatchId, setDispatchId] = useState<string | null>(null);
  const [manualInstruction, setManualInstruction] = useState<string | null>(null);
  const [bridgeAcknowledged, setBridgeAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    function onBridgeMessage(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (event.data?.type === "JOBHUNT_BRIDGE_READY" || event.data?.type === "JOBHUNT_DISPATCH_ACCEPTED") setBridgeAcknowledged(true);
    }
    window.addEventListener("message", onBridgeMessage);
    window.postMessage({ type: "JOBHUNT_BRIDGE_PROBE", version: 1 }, window.location.origin);
    return () => window.removeEventListener("message", onBridgeMessage);
  }, []);

  useEffect(() => {
    if (!inspection || !["queued", "processing"].includes(inspection.status)) return;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/jobs/inspect?id=${encodeURIComponent(inspection.id)}`, { cache: "no-store" });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || "Unable to read inspection status.");
        const next = result.inspection as Inspection;
        setInspection({ ...next, execution: inspection.execution });
        if (next.status === "completed" && next.job_id) {
          router.push(`/jobs/${next.job_id}`);
          router.refresh();
        }
      } catch (pollError) {
        setError(pollError instanceof Error ? pollError.message : "Unable to read inspection status.");
      }
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [inspection, router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const response = await fetch("/api/jobs/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUrl: form.get("sourceUrl") }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Unable to start the listing inspection.");
      const next = { ...(result.inspection as Inspection), execution: result.execution as Inspection["execution"] };
      setInspection(next);
      setDispatchId(typeof result.dispatch?.id === "string" ? result.dispatch.id : null);
      setManualInstruction(typeof result.dispatch?.manual_instruction === "string" ? result.dispatch.manual_instruction : null);
      notifyBridge(result.bridge_hint);
      formElement.reset();
      if (next.status === "completed" && next.job_id) {
        router.push(`/jobs/${next.job_id}`);
        router.refresh();
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to start the listing inspection.");
    } finally {
      setBusy(false);
    }
  }

  async function retryDispatch() {
    if (!dispatchId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/chatgpt-bridge/dispatch/retry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: dispatchId }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Unable to retry the dispatch.");
      setInspection((current) => current ? { ...current, status: "queued", error_json: null } : current);
      notifyBridge(result.bridge_hint);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "Unable to retry the dispatch.");
    } finally { setBusy(false); }
  }

  async function copyInstruction() {
    if (!manualInstruction) return;
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard) throw new Error("Clipboard access is unavailable; select and copy the instruction manually.");
      await clipboard.writeText(manualInstruction);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (copyError) { setError(copyError instanceof Error ? copyError.message : "Unable to copy the instruction."); }
  }

  return (
    <div className="urlInspectionBody">
      <form className="urlInspectionForm" onSubmit={submit}>
        <label><span>Public job listing URL *</span><input className="input" name="sourceUrl" type="url" required placeholder="https://company.example/careers/role" /></label>
        <button className="primaryButton" disabled={busy || Boolean(inspection && ["queued", "processing"].includes(inspection.status))} type="submit">{busy ? "Starting ChatGPT…" : "Inspect with ChatGPT"}</button>
      </form>
      <p className="formHint">This uses the visible ChatGPT website bridge when it is installed and configured, and remains compatible with the recurring ChatGPT Task/MCP workflow. The server sends ChatGPT only an opaque dispatch id; the authenticated Job Hunt MCP app returns the real workflow. It never signs in, applies, or submits an employer form.</p>
      {inspection ? <div className="urlInspectionStatus">
        <span className={`badge ${inspection.status === "completed" ? "review" : inspection.status === "failed" || inspection.status === "user_required" ? "danger" : "action"}`}>{inspectionStatusLabel(inspection.status)}</span>
        <span>{inspection.status === "queued" ? bridgeAcknowledged ? "The ChatGPT bridge is waking up and will open the bound Job Hunt conversation." : "The bridge was not detected. Install/open it, then use the manual dispatch command below." : inspection.status === "processing" ? inspection.execution === "openai_responses" ? "The immediate ChatGPT model inspection is running now." : "ChatGPT has claimed the URL and is extracting the listing." : inspection.status === "completed" ? "Opening the imported vacancy…" : inspection.error_json?.message || "Review the listing URL and try again."}</span>
      </div> : null}
      {inspection && manualInstruction && inspection.status !== "completed" ? <div className="manualFallback"><strong>Manual ChatGPT fallback</strong><p>Open the bound ChatGPT Project conversation, verify the Job Hunt app is selected, and send this fixed server instruction if automatic delivery is unavailable.</p><pre className="commandBlock">{manualInstruction}</pre><div className="buttonRow"><button className="secondaryButton" type="button" onClick={() => void copyInstruction()}>{copied ? "Copied" : "Copy dispatch command"}</button>{dispatchId && ["failed", "user_required"].includes(inspection.status) ? <button className="secondaryButton" disabled={busy} type="button" onClick={() => void retryDispatch()}>Retry with bridge</button> : null}</div></div> : null}
      {error ? <div className="formError">{error}</div> : null}
    </div>
  );
}
