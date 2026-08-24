"use client";

import { useEffect, useState } from "react";
import { GoogleSheetPicker } from "@/components/google-sheet-picker";

type AutomationSettings = {
  email_monitoring_enabled?: boolean;
  email_monitoring_cadence?: string;
  next_email_review_at?: string | null;
  last_email_review_at?: string | null;
  last_email_review_status?: string | null;
  last_email_error?: string | null;
  spreadsheet_sync_enabled?: boolean;
  google_spreadsheet_id?: string | null;
  google_spreadsheet_url?: string | null;
  google_spreadsheet_title?: string | null;
  google_spreadsheet_tab?: string | null;
  last_sheet_sync_at?: string | null;
  last_sheet_sync_status?: string | null;
  last_sheet_sync_rows?: number;
  last_sheet_sync_error?: string | null;
};

function formatDate(value?: string | null) {
  if (!value) return "Not yet";
  try { return new Date(value).toLocaleString("en-GB"); } catch { return value; }
}

export function AutomationSettings() {
  const [settings, setSettings] = useState<AutomationSettings>({});
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [managedTab, setManagedTab] = useState("Job Hunt Applications");

  async function load() {
    setBusy(true);
    try {
      const response = await fetch("/api/settings/automation", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load settings.");
      setSettings(data.settings || {});
      if (data.settings?.google_spreadsheet_id && data.settings?.google_spreadsheet_tab) setManagedTab(data.settings.google_spreadsheet_tab);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load settings.");
    } finally { setBusy(false); }
  }

  useEffect(() => { void load(); }, []);

  async function save() {
    setSaving(true); setMessage("");
    try {
      const response = await fetch("/api/settings/automation", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          emailMonitoringEnabled: settings.email_monitoring_enabled !== false,
          emailMonitoringCadence: settings.email_monitoring_cadence || "daily",
          spreadsheetSyncEnabled: settings.spreadsheet_sync_enabled === true,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to save settings.");
      setSettings(data.settings || settings); setMessage("Automation settings saved.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to save settings."); }
    finally { setSaving(false); }
  }

  async function sheetAction(action: "create" | "sync") {
    setSheetBusy(true); setMessage("");
    try {
      const response = await fetch("/api/settings/google-sheet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Google Sheet operation failed.");
      if (data.sheet) {
        setSettings((current) => ({ ...current, spreadsheet_sync_enabled: true, google_spreadsheet_id: data.sheet.spreadsheetId, google_spreadsheet_url: data.sheet.spreadsheetUrl, google_spreadsheet_title: data.sheet.title, google_spreadsheet_tab: data.sheet.tab, last_sheet_sync_at: data.sheet.rows == null ? current.last_sheet_sync_at : new Date().toISOString(), last_sheet_sync_status: data.sheet.rows == null ? current.last_sheet_sync_status : "ok", last_sheet_sync_rows: data.sheet.rows == null ? current.last_sheet_sync_rows : data.sheet.rows, last_sheet_sync_error: null }));
        setManagedTab(data.sheet.tab || managedTab);
      }
      if (data.result) setSettings((current) => ({ ...current, last_sheet_sync_at: new Date().toISOString(), last_sheet_sync_status: data.result.status, last_sheet_sync_rows: data.result.rows }));
      setMessage(action === "create" ? "Tracker Sheet created and connected." : `Tracker Sheet updated with ${data.result?.rows ?? 0} applications.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Google Sheet operation failed."); }
    finally { setSheetBusy(false); }
  }

  if (busy) return <section className="card"><div className="cardHeader"><div><h2>Automation settings</h2><p>Loading your per-user schedule and tracker connection…</p></div></div></section>;

  return <section className="card">
    <div className="cardHeader"><div><div className="eyebrow">Per-user automation</div><h2>Email and tracker schedule</h2><p>The web app performs read-only Gmail sync when it is opened and due. Your ChatGPT Project task should use the same cadence for classification and Sheet updates.</p></div></div>
    <div className="formGrid two">
      <label><span>Email monitoring</span><select value={settings.email_monitoring_enabled === false ? "off" : "on"} onChange={(event) => setSettings((current) => ({ ...current, email_monitoring_enabled: event.target.value === "on" }))}><option value="on">Enabled</option><option value="off">Disabled</option></select></label>
      <label><span>Review cadence</span><select value={settings.email_monitoring_cadence || "daily"} onChange={(event) => setSettings((current) => ({ ...current, email_monitoring_cadence: event.target.value }))}><option value="hourly">Hourly</option><option value="every_4_hours">Every 4 hours</option><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="manual">Manual only</option></select></label>
      <label><span>Managed tracker Sheet</span><select value={settings.spreadsheet_sync_enabled ? "on" : "off"} onChange={(event) => setSettings((current) => ({ ...current, spreadsheet_sync_enabled: event.target.value === "on" }))}><option value="on">Keep it updated</option><option value="off">Do not sync</option></select></label>
    </div>
    <div className="notice">Next web-app review: {settings.email_monitoring_enabled === false || settings.email_monitoring_cadence === "manual" ? "Manual" : formatDate(settings.next_email_review_at)}. Gmail is read-only; the app never sends, labels, archives or deletes mail.</div>
    <div className="rowActions"><button className="primaryButton" type="button" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save automation settings"}</button>{message ? <span className="formHelp">{message}</span> : null}</div>
    <div className="cardHeader" style={{ marginTop: "1.4rem" }}><div><h2>Google Sheets application tracker</h2><p>Create a new tracker or choose an existing workbook. Job Hunt manages one named tab and leaves the other tabs alone.</p></div></div>
    {settings.google_spreadsheet_url ? <div className="notice"><strong>{settings.google_spreadsheet_title || "Job Application Tracker"}</strong> · {settings.google_spreadsheet_tab || "Applications"}<br /><a className="textLink" href={settings.google_spreadsheet_url} target="_blank" rel="noreferrer">Open managed Google Sheet</a><br /><small>Last sync: {formatDate(settings.last_sheet_sync_at)}{settings.last_sheet_sync_rows != null ? ` · ${settings.last_sheet_sync_rows} applications` : ""}</small></div> : <div className="notice">No managed Sheet is connected yet. Create one below, or choose an existing Sheet that you can edit.</div>}
    <div className="rowActions"><button className="secondaryButton" type="button" disabled={sheetBusy} onClick={() => void sheetAction(settings.google_spreadsheet_id ? "sync" : "create")}>{sheetBusy ? "Working…" : settings.google_spreadsheet_id ? "Sync tracker now" : "Create managed tracker Sheet"}</button>{settings.google_spreadsheet_id ? <span className="formHelp">The app and ChatGPT can update only the workbook and tab recorded here.</span> : <a className="textLink" href="/login?next=/settings">Reconnect Google permissions</a>}</div>
    <div className="existingSheetCard">
      <div className="cardHeader"><div><h3>Use an existing Google Sheet</h3><p>Google Picker lets you explicitly grant Job Hunt access to one workbook without broad Drive access.</p></div></div>
      <div className="existingSheetBody">
        <label className="automationField"><span>Managed tab name</span><input className="input" value={managedTab} maxLength={100} onChange={(event) => setManagedTab(event.target.value)} placeholder="Job Hunt Applications" /></label>
        <p className="formHelp">If this tab does not exist, Job Hunt creates it. A dedicated tab such as “Job Hunt Applications” protects your existing dashboard and history tabs. Selecting an existing tab explicitly tells Job Hunt that it may replace that tab’s A:M tracker contents.</p>
        <div className="rowActions"><GoogleSheetPicker tabName={managedTab.trim() || "Job Hunt Applications"} disabled={sheetBusy} onConnected={(sheet) => { setSettings((current) => ({ ...current, spreadsheet_sync_enabled: true, google_spreadsheet_id: sheet.spreadsheetId, google_spreadsheet_url: sheet.spreadsheetUrl, google_spreadsheet_title: sheet.title, google_spreadsheet_tab: sheet.tab, last_sheet_sync_at: new Date().toISOString(), last_sheet_sync_status: "ok", last_sheet_sync_rows: sheet.rows, last_sheet_sync_error: null })); setManagedTab(sheet.tab); setMessage(`Connected ${sheet.title} and updated ${sheet.tab}.`); }} /><span className="formHelp">Only the Sheet you choose in Google Picker is shared with Job Hunt.</span></div>
      </div>
    </div>
    {settings.last_email_error || settings.last_sheet_sync_error ? <div className="errorNotice">{settings.last_email_error || settings.last_sheet_sync_error}</div> : null}
  </section>;
}
