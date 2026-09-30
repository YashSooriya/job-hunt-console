"use client";

import { useEffect, useState } from "react";

type AutomationSettings = {
  email_monitoring_enabled?: boolean;
  email_monitoring_cadence?: string;
  next_email_review_at?: string | null;
  spreadsheet_sync_enabled?: boolean;
};

function formatDate(value?: string | null) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Not scheduled" : date.toLocaleString("en-GB");
}

export function AutomationSettings() {
  const [settings, setSettings] = useState<AutomationSettings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/automation", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Email settings could not be loaded.");
        if (!cancelled) setSettings(data.settings || {});
      })
      .catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : "Email settings could not be loaded."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/settings/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          emailMonitoringEnabled: settings.email_monitoring_enabled !== false,
          emailMonitoringCadence: settings.email_monitoring_cadence || "daily",
          spreadsheetSyncEnabled: settings.spreadsheet_sync_enabled === true,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Email settings could not be saved.");
      setSettings(data.settings || settings);
      setMessage("Saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Email settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return <section className="card settingsCard settingsAutomationCard">
    <div className="cardHeader"><div><h2>Email updates</h2><p>Check Gmail for application updates and reminders.</p></div></div>
    <div className="settingsCardBody">
      {loading ? <p className="formHelp">Loading…</p> : <>
        <div className="settingsFormGrid">
          <label className="settingsField"><span>Email monitoring</span><select className="input" value={settings.email_monitoring_enabled === false ? "off" : "on"} onChange={(event) => setSettings((current) => ({ ...current, email_monitoring_enabled: event.target.value === "on" }))}><option value="on">On</option><option value="off">Off</option></select></label>
          <label className="settingsField"><span>Check frequency</span><select className="input" value={settings.email_monitoring_cadence || "daily"} onChange={(event) => setSettings((current) => ({ ...current, email_monitoring_cadence: event.target.value }))}><option value="hourly">Hourly</option><option value="every_4_hours">Every 4 hours</option><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="manual">Manual</option></select></label>
        </div>
        <p className="formHelp">Next check: {settings.email_monitoring_enabled === false || settings.email_monitoring_cadence === "manual" ? "Manual" : formatDate(settings.next_email_review_at)}</p>
        <div className="rowActions settingsActions"><button className="secondaryButton" type="button" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save email settings"}</button>{message ? <span className="formHelp" role="status">{message}</span> : null}</div>
      </>}
    </div>
  </section>;
}
