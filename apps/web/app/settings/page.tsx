import { AppShell } from "@/components/app-shell";
import { BrowserHelperSettings } from "@/components/browser-helper-settings";
import { LaunchQualification } from "@/components/launch-qualification";
import { AutomationOperationsPanel } from "@/components/automation-operations-panel";
import { AutomationSettings } from "@/components/automation-settings";

export default function SettingsPage(){
  return <AppShell>
    <div className="pageHeader"><div><div className="eyebrow">System</div><h1 className="title">Settings</h1><p className="sub">Control email review cadence, the optional managed Google Sheet and local commissioning. The browser helper is the only component that needs to run on your Mac.</p></div></div>
    <AutomationSettings />
    <BrowserHelperSettings />
    <AutomationOperationsPanel />
    <LaunchQualification />
  </AppShell>;
}
