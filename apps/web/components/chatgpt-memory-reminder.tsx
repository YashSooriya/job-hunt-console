"use client";

import { useEffect, useState } from "react";

type MemoryState = {
  confirmed: boolean;
  reminderRequired: boolean;
  usePreviousKnowledge: boolean;
};

export function ChatGptMemoryReminder() {
  const [memory, setMemory] = useState<MemoryState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem("job-hunt-memory-reminder-snoozed") === "1") return;
    } catch {
      // Session storage can be unavailable in privacy-restricted browsers.
    }
    fetch("/api/chatgpt/memory", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "Unable to read memory status.");
        setMemory(data.memory);
        setOpen(Boolean(data.memory?.reminderRequired));
      })
      .catch(() => {
        // Local snapshot mode and pre-migration deployments do not show a broken modal.
      });
  }, []);

  function snooze() {
    try { window.sessionStorage.setItem("job-hunt-memory-reminder-snoozed", "1"); } catch {}
    setOpen(false);
  }

  async function confirmEnabled() {
    setBusy(true);
    try {
      const response = await fetch("/api/chatgpt/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "confirm_enabled" }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Unable to save memory confirmation.");
      setMemory(data.memory);
      snooze();
    } catch {
      // Keep the reminder open if the confirmation cannot be saved.
    } finally {
      setBusy(false);
    }
  }

  if (!memory || !open || memory.confirmed) return null;

  return (
    <div className="memoryOverlay" role="presentation">
      <section className="memoryReminder" role="dialog" aria-modal="true" aria-labelledby="memory-reminder-title">
        <div className="eyebrow">One-time ChatGPT setup</div>
        <h2 id="memory-reminder-title">Turn on ChatGPT Memory</h2>
        <p>Memory lets ChatGPT carry useful context from previous conversations into future JobHuntAI work. Open ChatGPT settings, enable Memory under Personalization, then confirm here.</p>
        <p className="memoryReminderHint">If Memory is already on, simply confirm it. Relevant previous knowledge will be used as context when available; the verified JobHuntAI profile remains the factual source of truth.</p>
        <div className="buttonRow">
          <a className="secondaryButton" href="https://chatgpt.com/" target="_blank" rel="noreferrer">Open ChatGPT settings</a>
          <button className="primaryButton" type="button" disabled={busy} onClick={() => void confirmEnabled()}>{busy ? "Saving…" : "I've enabled Memory"}</button>
          <button className="textLink memoryLater" type="button" onClick={snooze}>Remind me later</button>
        </div>
      </section>
    </div>
  );
}
