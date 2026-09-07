"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { inspectionStatusLabel, type JobUrlInspectionStatus } from "@/lib/job-url-inspection";
import { useDispatchStatus } from "@/lib/chatgpt-bridge/use-dispatch-status";
import { notifyBridgeHint } from "@/lib/chatgpt-bridge/notify";
import { dispatchStateLabel } from "@/lib/chatgpt-bridge/client";

type Inspection = {
  id: string;
  source_url: string;
  status: JobUrlInspectionStatus;
  error_json?: { message?: string } | null;
  job_id?: string | null;
  execution?: "openai_responses" | "chatgpt_browser_bridge" | "manual_chatgpt";
};

export function JobUrlInspectionForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [dispatchId, setDispatchId] = useState<string | null>(null);
  const [mcpFallbackInstruction, setMcpFallbackInstruction] = useState<string | null>(null);
  const [bridgeResponse, setBridgeResponse] = useState<string | null>(null);
  const [dispatchState, setDispatchState] = useState<string | null>(null);
  const [bridgeAcknowledged, setBridgeAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  const liveDispatch = useDispatchStatus(dispatchId);
  const retryAllowed = liveDispatch.dispatch?.raw?.retry_allowed === true;
  const manualReviewRequired = liveDispatch.dispatch?.raw?.manual_review_required === true;

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
    let cancelled = false;
    let timer: number | undefined;
    let failures = 0;
    const poll = async () => {
      try {
        const response = await fetch(`/api/jobs/inspect?id=${encodeURIComponent(inspection.id)}`, { cache: "no-store" });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || "Unable to read inspection status.");
        const next = result.inspection as Inspection;
        failures = 0;
        if (cancelled) return;
        setInspection({ ...next, execution: inspection.execution });
        if (next.status === "completed" && next.job_id) {
          router.push(`/jobs/${next.job_id}`);
          router.refresh();
        } else if (["queued", "processing"].includes(next.status)) {
          timer = window.setTimeout(() => void poll(), 2500);
        }
      } catch (pollError) {
        failures += 1;
        if (!cancelled) {
          setError(pollError instanceof Error ? pollError.message : "Unable to read inspection status.");
          timer = window.setTimeout(() => void poll(), Math.min(12000, 2500 * (2 ** Math.min(failures, 3))));
        }
      }
    };
    timer = window.setTimeout(() => void poll(), 2500);
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
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
      setMcpFallbackInstruction(typeof result.dispatch?.mcp_fallback_instruction === "string" ? result.dispatch.mcp_fallback_instruction : null);
      setBridgeResponse(null);
      setDispatchState(typeof result.dispatch?.state === "string" ? result.dispatch.state : null);
      notifyBridgeHint(result.bridge_hint);
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
      notifyBridgeHint(result.bridge_hint);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "Unable to retry the dispatch.");
    } finally { setBusy(false); }
  }

  async function copyInstruction() {
    if (!mcpFallbackInstruction) return;
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard) throw new Error("Clipboard access is unavailable; select and copy the instruction manually.");
      await clipboard.writeText(mcpFallbackInstruction);
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
      <p className="formHint">This sends a plain-language request through the visible ChatGPT website bridge. The response is returned here for the next action-specific handler. MCP remains an explicit fallback if the bridge cannot complete the request. It never signs in, applies, or submits an employer form.</p>
      {inspection ? <div className="urlInspectionStatus">
        <span className={`badge ${inspection.status === "completed" ? "review" : inspection.status === "failed" || inspection.status === "user_required" ? "danger" : "action"}`}>{inspectionStatusLabel(inspection.status)}</span>
        <span>{(liveDispatch.response || bridgeResponse) ? "The Website Bridge returned a response; review it below." : inspection.status === "queued" ? bridgeAcknowledged ? "The ChatGPT bridge is waking up and will open the bound JobHuntAI conversation." : "The bridge was not detected. Install/open it, then use the optional fallback below." : inspection.status === "processing" ? inspection.execution === "openai_responses" ? "The immediate ChatGPT model inspection is running now." : "ChatGPT has claimed the URL and is extracting the listing." : inspection.status === "completed" ? "Opening the imported vacancy…" : inspection.error_json?.message || "Review the listing URL and try again."}</span>
      </div> : null}
      {(liveDispatch.response || bridgeResponse) ? <div className="manualFallback"><strong>Website Bridge response</strong><small className="formHint">Bridge state: {liveDispatch.state ? dispatchStateLabel(liveDispatch.state, liveDispatch.dispatch?.raw) : dispatchState || "completed"}</small><pre className="commandBlock">{liveDispatch.response || bridgeResponse}</pre></div> : null}
      {liveDispatch.error ? <p className="formHint">{liveDispatch.error} Retrying dispatch status…</p> : null}
      {inspection && mcpFallbackInstruction && inspection.status !== "completed" ? <div className="manualFallback"><strong>Optional MCP fallback</strong><p>{manualReviewRequired ? "The Website Bridge cannot safely retry this delivery. Review the bound ChatGPT conversation first, then use this authenticated fallback only if you explicitly choose it." : "Use this only if you explicitly choose the authenticated MCP recovery path. It is not part of normal Website Bridge delivery."}</p><pre className="commandBlock">{mcpFallbackInstruction}</pre><div className="buttonRow"><button className="secondaryButton" type="button" onClick={() => void copyInstruction()}>{copied ? "Copied" : "Copy MCP fallback"}</button>{dispatchId && ["failed", "user_required"].includes(inspection.status) && retryAllowed ? <button className="secondaryButton" disabled={busy} type="button" onClick={() => void retryDispatch()}>Retry with bridge</button> : null}</div></div> : null}
      {error ? <div className="formError">{error}</div> : null}
    </div>
  );
}
