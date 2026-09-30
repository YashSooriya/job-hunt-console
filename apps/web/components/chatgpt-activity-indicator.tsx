"use client";

import { useCallback, useEffect, useState } from "react";
import { useDispatchStatus } from "@/lib/chatgpt-bridge/use-dispatch-status";
import { isWaitingForChatGpt } from "@/lib/chatgpt-bridge/activity";

const STORAGE_KEY = "jobhunt:active-bridge-dispatches:v1";
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(["completed", "failed", "user_required", "expired", "cancelled"]);

type DispatchActivity = { id: string; state?: string; raw?: Record<string, unknown> };

function readIds() {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && ID_RE.test(id)))].slice(-24) : [];
  } catch {
    return [];
  }
}

function DispatchWatcher({ id, onUpdate }: { id: string; onUpdate: (id: string, activity: DispatchActivity | null) => void }) {
  const status = useDispatchStatus(id);
  const state = status.state || undefined;
  const raw = status.dispatch?.raw;

  useEffect(() => {
    if (state && TERMINAL.has(state)) onUpdate(id, null);
    else if (raw) onUpdate(id, { id, state, raw });
  }, [id, onUpdate, raw, state]);

  return null;
}

export function ChatGptActivityIndicator() {
  const [dispatchIds, setDispatchIds] = useState<string[]>([]);
  const [activities, setActivities] = useState<Record<string, DispatchActivity>>({});

  const remove = useCallback((id: string) => {
    setDispatchIds((current) => {
      const next = current.filter((value) => value !== id);
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* storage is optional */ }
      return next;
    });
  }, []);

  const receive = useCallback((id: string, activity: DispatchActivity | null) => {
    if (!activity) {
      remove(id);
      setActivities((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      return;
    }
    setActivities((current) => ({ ...current, [id]: activity }));
  }, [remove]);

  useEffect(() => {
    setDispatchIds(readIds());
    const onQueued = (event: Event) => {
      const id = (event as CustomEvent<{ requestId?: unknown }>).detail?.requestId;
      if (typeof id !== "string" || !ID_RE.test(id)) return;
      setDispatchIds((current) => current.includes(id) ? current : [...current, id].slice(-24));
    };
    window.addEventListener("jobhunt:dispatch-queued", onQueued);
    return () => window.removeEventListener("jobhunt:dispatch-queued", onQueued);
  }, []);

  const waitingCount = Object.values(activities).filter(isWaitingForChatGpt).length;

  return <>
    {dispatchIds.map((id) => <DispatchWatcher key={id} id={id} onUpdate={receive} />)}
    {waitingCount > 0 ? <div className="chatgptActivity" role="status" aria-live="polite">
      <span className="chatgptActivitySpinner" aria-hidden="true" />
      <span>ChatGPT is responding{waitingCount > 1 ? ` to ${waitingCount} requests` : ""}…</span>
    </div> : null}
  </>;
}
