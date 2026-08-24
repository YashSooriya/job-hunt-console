"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function ProgressionPrepareButton({ kind, workflowId, hasPreparation }: { kind: "assessment" | "interview"; workflowId: string; hasPreparation: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/progression/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, workflowId }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Preparation failed");
      router.refresh();
    } catch (e: any) { setError(e?.message || "Preparation failed"); }
    finally { setBusy(false); }
  }
  return <div className="applicationAction"><button className="secondaryButton" disabled={busy} onClick={run}>{busy ? "Preparing…" : hasPreparation ? "Regenerate prep" : "Prepare workspace"}</button>{error ? <small>{error}</small> : null}</div>;
}
