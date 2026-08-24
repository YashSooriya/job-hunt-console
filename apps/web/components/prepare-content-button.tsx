"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function PrepareContentButton({ applicationId, hasPackage }: { applicationId: string; hasPackage: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function prepare() {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/applications/${applicationId}/content/prepare`, { method: "POST" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Unable to prepare application content.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to prepare application content.");
      setBusy(false);
    }
  }
  return <div><button className="primaryButton" type="button" onClick={prepare} disabled={busy}>{busy ? "Preparing package…" : hasPackage ? "Regenerate content package" : "Prepare letter, questions & salary"}</button>{error ? <p className="formError">{error}</p> : null}</div>;
}
