"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isWaitingForChatGpt } from "@/lib/chatgpt-bridge/activity";

const STORAGE_KEY = "jobhunt:chatgpt-operation-optimistic:v1";
const REFRESH_INTERVAL_MS = 2000;
const LOCAL_CLAIM_TTL_MS = 10 * 60 * 1000;

type LocalClaim = { token: string; title: string; expiresAt: number };
type ServerActivity = {
  busy: boolean;
  lock_disabled?: boolean;
  display_title?: string;
  dispatch_state?: string;
  progress?: Record<string, unknown>;
};
type OperationContextValue = {
  blocked: boolean;
  busy: boolean;
  ready: boolean;
  message: string | null;
  beginLocalOperation: (title: string) => string | null;
  finishLocalOperation: (token: string) => void;
  refresh: () => Promise<void>;
};

const OperationContext = createContext<OperationContextValue>({
  blocked: false,
  busy: false,
  ready: true,
  message: null,
  beginLocalOperation: () => null,
  finishLocalOperation: () => undefined,
  refresh: async () => undefined,
});

function readLocalClaim(): LocalClaim | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Partial<LocalClaim>;
    if (typeof candidate.token !== "string" || typeof candidate.title !== "string" || typeof candidate.expiresAt !== "number") return null;
    return candidate.expiresAt > Date.now() ? candidate as LocalClaim : null;
  } catch {
    return null;
  }
}

function announceLocalClaim() {
  window.dispatchEvent(new Event("jobhunt:chatgpt-operation-changed"));
}

export function useChatGptOperation() {
  return useContext(OperationContext);
}

export function ChatGptOperationProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [serverActivity, setServerActivity] = useState<ServerActivity | null>(null);
  const [localClaim, setLocalClaim] = useState<LocalClaim | null>(null);
  const [ready, setReady] = useState(!enabled);
  const localClaimRef = useRef<LocalClaim | null>(null);
  const serverActivityRef = useRef<ServerActivity | null>(null);
  const readyRef = useRef(!enabled);

  const refresh = useCallback(async () => {
    if (!enabled) {
      readyRef.current = true;
      setReady(true);
      setServerActivity(null);
      serverActivityRef.current = null;
      return;
    }
    const response = await fetch("/api/chatgpt-bridge/activity", { cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as { ok?: boolean; activity?: ServerActivity; error?: string };
    if (!response.ok || payload.ok !== true || !payload.activity) throw new Error(payload.error || "ChatGPT activity is unavailable.");
    if (payload.activity.lock_disabled === true) {
      // Stale optimistic claims must not re-block actions after the diagnostic
      // override is later turned off; the server lock governs active work.
      try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* server coordination remains authoritative */ }
      localClaimRef.current = null;
      setLocalClaim(null);
    }
    readyRef.current = true;
    serverActivityRef.current = payload.activity;
    setReady(true);
    setServerActivity(payload.activity);
  }, [enabled]);

  useEffect(() => {
    localClaimRef.current = readLocalClaim();
    setLocalClaim(localClaimRef.current);
    const refreshLocalClaim = () => {
      localClaimRef.current = readLocalClaim();
      setLocalClaim(localClaimRef.current);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) refreshLocalClaim();
    };
    const onLocalChange = () => refreshLocalClaim();
    const onSettingChange = () => { void refresh().catch(() => undefined); };
    window.addEventListener("storage", onStorage);
    window.addEventListener("jobhunt:chatgpt-operation-changed", onLocalChange);
    window.addEventListener("jobhunt:chatgpt-operation-setting-changed", onSettingChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("jobhunt:chatgpt-operation-changed", onLocalChange);
      window.removeEventListener("jobhunt:chatgpt-operation-setting-changed", onSettingChange);
    };
  }, [refresh]);

  useEffect(() => {
    if (!enabled) {
      readyRef.current = true;
      setReady(true);
      setServerActivity(null);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    const refreshActivity = async () => {
      if (cancelled || document.visibilityState === "hidden") return;
      try {
        await refresh();
      } catch {
        // Keep the last known server lock. Before the first successful read,
        // initiating buttons remain disabled rather than guessing.
      } finally {
        if (!cancelled && document.visibilityState === "visible") timer = window.setTimeout(() => void refreshActivity(), REFRESH_INTERVAL_MS);
      }
    };
    const onVisibility = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (document.visibilityState !== "hidden") void refreshActivity();
    };
    void refreshActivity();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, refresh]);

  const beginLocalOperation = useCallback((title: string) => {
    if (enabled && serverActivityRef.current?.lock_disabled === true) {
      // The diagnostics override deliberately removes the browser-local
      // optimistic mutex too. The authenticated server still records each
      // independent operation and remains authoritative.
      return crypto.randomUUID();
    }
    const existing = readLocalClaim();
    const blocked = enabled && (!readyRef.current || serverActivityRef.current?.busy === true);
    if (blocked || existing) {
      if (existing) {
        localClaimRef.current = existing;
        setLocalClaim(existing);
      }
      return null;
    }
    const claim: LocalClaim = {
      token: crypto.randomUUID(),
      title: title.slice(0, 120),
      expiresAt: Date.now() + LOCAL_CLAIM_TTL_MS,
    };
    localClaimRef.current = claim;
    setLocalClaim(claim);
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(claim)); } catch { /* the server lock remains authoritative */ }
    announceLocalClaim();
    return claim.token;
  }, [enabled]);

  const finishLocalOperation = useCallback((token: string) => {
    const current = readLocalClaim();
    if (current?.token === token) {
      try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* optional cross-tab signal */ }
      localClaimRef.current = null;
      setLocalClaim(null);
      announceLocalClaim();
    }
    void refresh().catch(() => undefined);
  }, [refresh]);

  const serverBusy = serverActivity?.busy === true;
  const overrideEnabled = serverActivity?.lock_disabled === true;
  const localBusy = Boolean(localClaim) && !overrideEnabled;
  const busy = serverBusy || localBusy;
  const blocked = enabled && (!ready || (busy && !overrideEnabled));
  const waiting = serverActivity ? isWaitingForChatGpt({
    state: serverActivity.dispatch_state,
    raw: { progress: serverActivity.progress },
  }) : false;
  const message = !ready && enabled
    ? "Checking whether ChatGPT is already working…"
    : localBusy
      ? `${localClaim?.title || "Starting ChatGPT task"} is being queued. Other ChatGPT actions are temporarily disabled.`
      : serverBusy
        ? overrideEnabled
          ? `${serverActivity?.display_title || "A ChatGPT task"} is active. Diagnostics override allows additional actions; overlapping tasks may interleave${waiting ? " while ChatGPT responds" : " until it finishes"}.`
          : `${serverActivity?.display_title || "A ChatGPT task"} is active. Other ChatGPT actions are temporarily disabled${waiting ? " while ChatGPT responds" : " until it finishes"}.`
        : null;

  const value = useMemo<OperationContextValue>(() => ({
    blocked,
    busy,
    ready,
    message,
    beginLocalOperation,
    finishLocalOperation,
    refresh,
  }), [blocked, busy, ready, message, beginLocalOperation, finishLocalOperation, refresh]);

  return <OperationContext.Provider value={value}>
    {message ? <div className="chatgptGlobalActionLock" role="status" aria-live="polite">
      {waiting ? <span className="chatgptActivitySpinner" aria-hidden="true" /> : null}
      <span>{message}</span>
    </div> : null}
    {children}
  </OperationContext.Provider>;
}
