"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ApplicationCreateButton({
  jobId,
  existingApplicationId,
  existingApplicationChosenAt,
  disabledReason,
  actionLabel,
}: {
  jobId: string;
  existingApplicationId?: string | null;
  existingApplicationChosenAt?: string | null;
  disabledReason?: string | null;
  actionLabel?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (existingApplicationId && existingApplicationChosenAt) {
    return <button className="primaryButton" type="button" onClick={() => router.push(`/applications/${existingApplicationId}`)}>Open application</button>;
  }

  async function chooseToApply() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/applications/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, origin: "manual" }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Unable to create application.");
      router.push(`/applications/${result.applicationId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create application.");
      setBusy(false);
    }
  }

  return (
    <div className="applicationAction">
      <button className="primaryButton" type="button" disabled={busy || Boolean(disabledReason)} onClick={chooseToApply}>
        {busy ? "Recording choice…" : actionLabel || "Choose to apply"}
      </button>
      {disabledReason ? <small>{disabledReason}</small> : null}
      {error ? <div className="formError">{error}</div> : null}
    </div>
  );
}
