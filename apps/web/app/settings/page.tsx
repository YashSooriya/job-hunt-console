import { AppShell } from "@/components/app-shell";
import { BrowserHelperSettings } from "@/components/browser-helper-settings";
import { LaunchQualification } from "@/components/launch-qualification";

export default function SettingsPage(){
  return <AppShell>
    <div className="pageHeader"><div><div className="eyebrow">System</div><h1 className="title">Settings</h1><p className="sub">Connected services and local commissioning. The browser helper is the only component that needs to run on your Mac.</p></div></div>
    <BrowserHelperSettings />
    <LaunchQualification />
  </AppShell>;
}
