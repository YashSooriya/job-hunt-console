"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function AssessmentStatusButton({ assessmentId, status }: { assessmentId: string; status: "in_progress" | "completed" }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function run() {
    setBusy(true);
    try {
      const response = await fetch("/api/assessments/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assessmentId, status }) });
      if (!response.ok) throw new Error("Could not update assessment status");
      router.refresh();
    } finally { setBusy(false); }
  }
  return <button className={status === "completed" ? "primaryButton" : "secondaryButton"} disabled={busy} onClick={run}>{busy ? "Updating…" : status === "completed" ? "Mark completed" : "Mark started"}</button>;
}
