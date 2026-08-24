"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function PrepareCvButton({ applicationId, hasVersion }: { applicationId: string; hasVersion: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function prepare() {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/applications/${applicationId}/cv/prepare`, { method: "POST" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Unable to prepare CV.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to prepare CV.");
      setBusy(false);
    }
  }
  return <div><button className="primaryButton" type="button" onClick={prepare} disabled={busy}>{busy ? "Preparing CV…" : hasVersion ? "Create new CV version" : "Prepare evidence-backed CV"}</button>{error ? <p className="formError">{error}</p> : null}</div>;
}
