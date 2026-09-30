"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatGptOperation } from "@/components/chatgpt-operation-provider";
import { useDispatchStatus } from "@/lib/chatgpt-bridge/use-dispatch-status";
import { createChatGptDispatch, readBridgeApiJson } from "@/lib/chatgpt-bridge/client";
import { isWaitingForChatGpt } from "@/lib/chatgpt-bridge/activity";
import { applyChatGptTestingMode } from "@/lib/chatgpt/testing-mode";
import styles from "./job-pool-sheet-settings.module.css";

type SheetStatus = {
  configured?: boolean;
  spreadsheetUrl?: string | null;
  spreadsheetTitle?: string | null;
  sourceRevision?: number;
  publishedRevision?: number | null;
  rowCount?: number | null;
  lastSyncedAt?: string | null;
  lastSyncStatus?: string;
  lastSyncError?: string | null;
  driveVerifiedAt?: string | null;
  driveCheckActive?: boolean;
  current?: boolean;
  applicationRows?: number;
  applicationSyncedAt?: string | null;
  applicationSyncError?: string | null;
};

type SheetApiResponse = { ok?: boolean; sheet?: SheetStatus; synced?: boolean; error?: string; code?: string; googleConnection?: "connected" | "not_connected" | "unavailable" };
type AccessTest = { dispatchId: string; leaseId: string; publicationId: string; state?: string };

const TERMINAL = new Set(["completed", "failed", "user_required", "expired", "cancelled"]);

function formatDate(value?: string | null) {
  if (!value) return "Not synced yet";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("en-GB");
}

async function postSheetAction(payload: Record<string, unknown>) {
  const response = await fetch("/api/settings/job-pool-sheet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await readBridgeApiJson<SheetApiResponse & Record<string, unknown>>(response);
  if (!response.ok || body.ok !== true) throw new Error(body.error || "The Job Pool Sheet operation failed.");
  return body;
}

export function JobPoolSheetSettings() {
  const [sheet, setSheet] = useState<SheetStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [googleConnection, setGoogleConnection] = useState<SheetApiResponse["googleConnection"]>("unavailable");
  const [accessTest, setAccessTest] = useState<AccessTest | null>(null);
  const chatgptOperation = useChatGptOperation();
  const initialAccessStatus = useMemo(() => accessTest ? { state: accessTest.state } : undefined, [accessTest?.dispatchId, accessTest?.state]);
  const accessStatus = useDispatchStatus(accessTest?.dispatchId || null, initialAccessStatus);
  const verificationStarted = useRef<string | null>(null);
  const autoSetupStarted = useRef(false);
  const configured = sheet?.configured === true;
  const current = sheet?.current === true;

  const refresh = useCallback(async () => {
    const response = await fetch("/api/settings/job-pool-sheet", { cache: "no-store" });
    const body = await readBridgeApiJson<SheetApiResponse>(response);
    if (!response.ok || body.ok !== true) throw new Error(body.error || "Unable to load Job Pool Sheet status.");
    setSheet(body.sheet || null);
    setGoogleConnection(body.googleConnection || "unavailable");
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/settings/job-pool-sheet", { cache: "no-store" })
      .then(async (response) => {
        const body = await readBridgeApiJson<SheetApiResponse>(response);
        if (!response.ok || body.ok !== true) throw new Error(body.error || "Unable to load Job Pool Sheet status.");
        if (!cancelled) {
          setSheet(body.sheet || null);
          setGoogleConnection(body.googleConnection || "unavailable");
        }
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load Job Pool Sheet status."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("googleConnectionError");
    if (!code) return;
    const messages: Record<string, string> = {
      save_failed: "Google approved access, but JobHuntAI could not save the grant. Your existing data is unchanged; reconnect once or retry.",
      check_failed: "JobHuntAI could not confirm the saved Google connection. Retry the setup; no Google grant was removed.",
      missing_token: "Google returned to JobHuntAI without a reusable grant. Connect Google once more and finish the setup.",
      grant_expired: "The saved Google grant has expired. Reconnect Google once, then retry the spreadsheet setup.",
      temporary_error: "Google could not be checked just now. Your grant was kept; retry the spreadsheet setup in a moment.",
    };
    setError(messages[code] || "Google Sheets connection did not finish. Retry once; your existing data is unchanged.");
    url.searchParams.delete("googleConnectionError");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, []);

  useEffect(() => {
    if (loading) return;
    const timer = window.setInterval(() => { void refresh().catch(() => undefined); }, 20000);
    return () => window.clearInterval(timer);
  }, [loading, refresh]);

  const sync = useCallback(async (action: "create" | "sync") => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await postSheetAction({ action });
      setSheet(result.sheet || null);
      setGoogleConnection("connected");
      setMessage(action === "create" ? "Your JobHuntAI spreadsheet is ready." : "Your jobs and applications are up to date.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Job Pool Sheet could not be synchronized.");
      await refresh().catch(() => undefined);
    } finally { setBusy(false); }
  }, [refresh]);

  useEffect(() => {
    if (loading || autoSetupStarted.current) return;
    const pageUrl = new URL(window.location.href);
    if (pageUrl.searchParams.get("createManagedSheet") !== "1") return;
    if (googleConnection === "unavailable") return;
    autoSetupStarted.current = true;
    pageUrl.searchParams.delete("createManagedSheet");
    window.history.replaceState(null, "", pageUrl.pathname + pageUrl.search + pageUrl.hash);
    if (googleConnection === "connected") void sync(configured ? "sync" : "create");
    else setError("Google returned to JobHuntAI, but no usable saved grant was found. Connect Google once from this page to finish setup.");
  }, [configured, googleConnection, loading, sync]);

  async function releaseLease(leaseId: string) {
    await fetch("/api/settings/job-pool-sheet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "release-access-test", leaseId }),
    }).catch(() => undefined);
  }

  async function testChatGptAccess() {
    const operationToken = chatgptOperation.beginLocalOperation("Test Job Pool Sheet access");
    if (!operationToken) {
      setError(chatgptOperation.message || "Another ChatGPT task is already active.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    setAccessTest(null);
    verificationStarted.current = null;
    let leaseId = "";
    let dispatchQueued = false;
    try {
      const prepared = await postSheetAction({ action: "prepare-access-test" });
      leaseId = String(prepared.leaseId || "");
      const publicationId = String(prepared.publicationId || "");
      const websiteInstruction = typeof prepared.websiteInstruction === "string" ? prepared.websiteInstruction : "";
      if (!leaseId || !publicationId || !websiteInstruction) throw new Error("The Sheet access test could not prepare a verified publication.");
      const dispatchResult = await createChatGptDispatch({
        actionType: "bridge.diagnostic",
        displayTitle: "Test Job Pool Sheet access",
        idempotencyKey: `job-pool-sheet-access:${crypto.randomUUID()}`,
        websiteInstruction: applyChatGptTestingMode(websiteInstruction, true),
      });
      const dispatchId = typeof dispatchResult.dispatch?.id === "string" ? dispatchResult.dispatch.id : "";
      if (!dispatchId) throw new Error("ChatGPT did not return a request id for the access test.");
      dispatchQueued = true;
      setAccessTest({ dispatchId, leaseId, publicationId, state: String(dispatchResult.dispatch?.state || "queued") });
      setSheet((prepared.sheet as SheetStatus | undefined) || null);
      setMessage("The test is queued. JobHuntAI will confirm access from the exact captured ChatGPT turn.");
    } catch (cause) {
      if (leaseId && !dispatchQueued) await releaseLease(leaseId);
      setError(cause instanceof Error ? cause.message : "The ChatGPT Sheet access test could not be started.");
    } finally {
      setBusy(false);
      chatgptOperation.finishLocalOperation(operationToken);
    }
  }

  useEffect(() => {
    if (!accessTest || !accessStatus.state || !TERMINAL.has(accessStatus.state)) return;
    const dispatchId = accessTest.dispatchId;
    if (verificationStarted.current === dispatchId) return;
    verificationStarted.current = dispatchId;

    if (accessStatus.state !== "completed") {
      void releaseLease(accessTest.leaseId).finally(() => {
        setError(accessStatus.error || `The ChatGPT access test ended as ${accessStatus.state}.`);
        setAccessTest(null);
      });
      return;
    }

    void (async () => {
      try {
        const result = await postSheetAction({
          action: "verify-access",
          leaseId: accessTest.leaseId,
          publicationId: accessTest.publicationId,
          dispatchId,
        });
        setSheet((result.sheet as SheetStatus | undefined) || null);
        setMessage("Verified: ChatGPT read the current Job Pool Sheet manifest through its connected Google Drive access.");
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "ChatGPT could not verify the Job Pool Sheet.");
      } finally { setAccessTest(null); }
    })();
  }, [accessStatus.error, accessStatus.state, accessTest]);

  const waitingForChatGpt = isWaitingForChatGpt({ state: accessStatus.state || undefined, raw: accessStatus.dispatch?.raw });
  const accessTestActive = Boolean(accessTest);

  const connectUrl = "/login?intent=google-sheets&next=%2Fsettings%3FcreateManagedSheet%3D1";
  const reconnectNeeded = Boolean(error?.toLowerCase().includes("reconnect google") || sheet?.lastSyncError === "google_reconnect_required");
  return <section className={`card settingsCard ${styles.card}`}>
    <div className="cardHeader"><div><h2>Google Sheets</h2><p>Keep your jobs and applications together in one spreadsheet.</p></div><span className={`badge ${current ? "review" : configured ? "action" : "muted"}`}>{loading ? "Checking…" : current ? "Up to date" : configured ? "Sync needed" : "Not connected"}</span></div>
    <div className={`settingsCardBody ${styles.body}`}>
      {loading ? <p className="formHelp">Checking Google Sheets…</p> : configured ? <div className={`notice settingsNotice ${styles.status}`}>
        <strong>{sheet?.spreadsheetTitle || "JobHuntAI"}</strong>
        <span>{sheet?.rowCount ?? 0} jobs · {sheet?.applicationRows ?? 0} applications</span>
        <span>Last updated: {formatDate(sheet?.applicationSyncedAt || sheet?.lastSyncedAt)}</span>
        {sheet?.spreadsheetUrl ? <a className="textLink" href={sheet.spreadsheetUrl} target="_blank" rel="noreferrer">Open spreadsheet ↗</a> : null}
      </div> : <p className={`formHelp ${styles.status}`}>Your jobs and applications will appear in separate tabs of one spreadsheet.</p>}

      <div className={`rowActions settingsActions ${styles.actions}`}>
        {!configured && googleConnection !== "connected" ? <a className="primaryButton" href={connectUrl}>{googleConnection === "unavailable" ? "Connect Google Sheets" : "Connect Google Sheets"}</a> : null}
        {(configured || googleConnection === "connected") ? <button className="primaryButton" type="button" disabled={busy || loading || accessTestActive || sheet?.driveCheckActive === true} onClick={() => void sync(configured ? "sync" : "create")}>
          {busy ? "Updating…" : configured ? "Sync now" : "Create spreadsheet"}
        </button> : null}
        {reconnectNeeded && configured ? <a className="textLink" href={connectUrl}>Reconnect Google</a> : null}
      </div>

      {sheet?.lastSyncError || sheet?.applicationSyncError ? <p className={`formError ${styles.message}`} role="alert">{sheet.applicationSyncError || (reconnectNeeded ? "Google access needs to be reconnected." : "The spreadsheet needs attention. Retry sync; your database data is safe.")}</p> : null}
      {message ? <p className={`formHelp ${styles.message}`} role="status">{message}</p> : null}
      {error ? <p className={`formError ${styles.message}`} role="alert">{error}</p> : null}

      {configured ? <details className="settingsAdvancedDetails">
        <summary>ChatGPT spreadsheet access</summary>
        <p className="formHelp">Google Sheets access for JobHuntAI is separate from ChatGPT’s Google Drive connection. Connect Drive in ChatGPT only if you want ChatGPT to read this spreadsheet during job searches.</p>
        <button className="secondaryButton" type="button" disabled={busy || loading || !current || sheet?.driveCheckActive === true || accessTestActive || chatgptOperation.blocked || !chatgptOperation.ready} onClick={() => void testChatGptAccess()}>
          {waitingForChatGpt ? <><span className={`chatgptActivitySpinner ${styles.spinner}`} aria-hidden="true" /> Waiting for ChatGPT…</> : "Test ChatGPT access"}
        </button>
        {accessTest ? <div className="syncMessage" role="status" aria-live="polite">
          {waitingForChatGpt ? <><span className={`chatgptActivitySpinner ${styles.spinner}`} aria-hidden="true" /> ChatGPT is checking access…</> : `Access check ${accessStatus.state || "queued"}.`}
          {accessStatus.error ? <span> {accessStatus.error}</span> : null}
        </div> : null}
        {accessStatus.error && accessTest ? <p className="formHelp">The original request is retained; retrying this check does not resend it.</p> : null}
      </details> : null}
    </div>
  </section>;
}
