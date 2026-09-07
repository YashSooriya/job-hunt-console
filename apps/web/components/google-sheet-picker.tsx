"use client";

import { useState } from "react";

type PickerDocument = {
  id?: string;
};

type PickerResponse = {
  action?: string;
  docs?: PickerDocument[];
};

type PickerView = {
  setIncludeFolders(includeFolders: boolean): PickerView;
};

type PickerBuilder = {
  setDeveloperKey(apiKey: string): PickerBuilder;
  setAppId(appId: string): PickerBuilder;
  setOAuthToken(accessToken: string): PickerBuilder;
  addView(view: PickerView): PickerBuilder;
  setCallback(callback: (data: PickerResponse) => void): PickerBuilder;
  build(): { setVisible(visible: boolean): void };
};

type PickerNamespace = {
  ViewId: { SPREADSHEETS: string };
  DocsView: new (viewId: string) => PickerView;
  PickerBuilder: new () => PickerBuilder;
};

declare global {
  interface Window {
    gapi?: { load: (name: string, options: { callback: () => void; onerror?: () => void }) => void };
    google?: { picker?: PickerNamespace };
  }
}

type ConnectedSheet = {
  spreadsheetId: string;
  spreadsheetUrl: string;
  title: string;
  tab: string;
  rows: number;
};

function loadScript(id: string, src: string) {
  const existing = document.getElementById(id);
  if (existing) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.id = id;
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google Picker could not be loaded."));
    document.head.appendChild(script);
  });
}

function loadPickerModule() {
  return new Promise<void>((resolve, reject) => {
    if (!window.gapi?.load) {
      reject(new Error("Google Picker could not be initialised."));
      return;
    }
    window.gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("Google Picker could not be initialised.")) });
  });
}

export function GoogleSheetPicker({
  tabName,
  disabled = false,
  onConnected,
}: {
  tabName: string;
  disabled?: boolean;
  onConnected: (sheet: ConnectedSheet) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function openPicker() {
    setBusy(true);
    setMessage("");
    try {
      const tokenResponse = await fetch("/api/settings/google-picker", { cache: "no-store" });
      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok) throw new Error(tokenData.error || "Unable to open Google Picker.");

      await loadScript("google-api-script", "https://apis.google.com/js/api.js");
      await loadPickerModule();
      const pickerApi = window.google?.picker;
      if (!pickerApi) throw new Error("Google Picker could not be initialised.");

      const view = new pickerApi.DocsView(pickerApi.ViewId.SPREADSHEETS);
      view.setIncludeFolders(false);
      const picker = new pickerApi.PickerBuilder()
        .setDeveloperKey(String(tokenData.apiKey))
        .setAppId(String(tokenData.appId))
        .setOAuthToken(String(tokenData.accessToken))
        .addView(view)
        .setCallback(async (data) => {
          if (data.action !== "picked") {
            if (data.action === "cancel") setBusy(false);
            return;
          }
          const spreadsheetId = data.docs?.[0]?.id;
          if (!spreadsheetId) {
            setMessage("Google Picker did not return a Sheet.");
            setBusy(false);
            return;
          }
          try {
            const response = await fetch("/api/settings/google-sheet", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "connect", spreadsheetId, tab: tabName || "JobHuntAI Applications" }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "Unable to connect the selected Sheet.");
            onConnected(result.sheet as ConnectedSheet);
            setMessage(`Connected and updated the “${result.sheet.tab}” tab.`);
          } catch (error) {
            setMessage(error instanceof Error ? error.message : "Unable to connect the selected Sheet.");
          } finally {
            setBusy(false);
          }
        })
        .build();
      picker.setVisible(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to open Google Picker.");
      setBusy(false);
    }
  }

  return (
    <div>
      <button className="secondaryButton" type="button" disabled={disabled || busy} onClick={() => void openPicker()}>
        {busy ? "Opening Google Picker…" : "Choose existing Google Sheet"}
      </button>
      {message ? <span className="formHelp" role="status">{message}</span> : null}
    </div>
  );
}
