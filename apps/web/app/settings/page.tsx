import { AppShell } from "@/components/app-shell";
import { AutomationOperationsPanel } from "@/components/automation-operations-panel";
import { AutomationSettings } from "@/components/automation-settings";
import { BrowserHelperSettings } from "@/components/browser-helper-settings";
import { ChatGptBridgeSettings } from "@/components/chatgpt-bridge-settings";
import { DiagnosticsVisibilityToggle } from "@/components/diagnostics-visibility-toggle";
import { JobPoolSheetSettings } from "@/components/job-pool-sheet-settings";
import { LaunchQualification } from "@/components/launch-qualification";

export default function SettingsPage() {
  return <AppShell>
    <div className="pageHeader settingsPageHeader">
      <div><h1 className="title">Settings</h1></div>
    </div>
    <div className="settingsSections simpleSettingsSections">
      <JobPoolSheetSettings />
      <AutomationSettings />
      <details className="onboardingAdvancedDetails settingsAdvancedGroup">
        <summary>ChatGPT connection</summary>
        <ChatGptBridgeSettings />
      </details>
      <details className="onboardingAdvancedDetails settingsAdvancedGroup">
        <summary>Advanced tools</summary>
        <BrowserHelperSettings />
        <AutomationOperationsPanel />
        <LaunchQualification />
        <DiagnosticsVisibilityToggle />
      </details>
    </div>
  </AppShell>;
}
