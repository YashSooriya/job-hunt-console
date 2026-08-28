import { AppShell } from "@/components/app-shell";
import { BrowserHelperSettings } from "@/components/browser-helper-settings";
import { LaunchQualification } from "@/components/launch-qualification";
import { AutomationOperationsPanel } from "@/components/automation-operations-panel";
import { AutomationSettings } from "@/components/automation-settings";
import { ChatGptBridgeSettings } from "@/components/chatgpt-bridge-settings";
import { DiagnosticsVisibilityToggle } from "@/components/diagnostics-visibility-toggle";

export default function SettingsPage(){
  return <AppShell>
    <div className="settingsPage">
      <div className="pageHeader settingsPageHeader">
        <div>
          <div className="eyebrow">System</div>
          <h1 className="title">Settings</h1>
          <p className="sub">Manage the services that power Job Hunt. Start with automation, then connect ChatGPT and the local browser helper when you are ready.</p>
        </div>
        <div className="settingsHeaderMeta">
          <span>Workspace controls</span>
          <strong>6 sections</strong>
        </div>
      </div>

      <div className="settingsLayout">
        <nav className="settingsNav" aria-label="Settings sections">
          <span className="settingsNavTitle">On this page</span>
          <a href="#automation"><strong>Automation</strong><small>Email and tracker</small></a>
          <a href="#chatgpt-bridge"><strong>ChatGPT bridge</strong><small>Workflow dispatch</small></a>
          <a href="#browser-helper"><strong>Browser helper</strong><small>Local form assistant</small></a>
          <a href="#operations"><strong>Operations</strong><small>Queue health</small></a>
          <a href="#qualification"><strong>Qualification</strong><small>Launch readiness</small></a>
          <a href="#diagnostics"><strong>Diagnostics</strong><small>Troubleshooting access</small></a>
        </nav>

        <div className="settingsSections">
          <section className="settingsSection" id="automation">
            <div className="settingsSectionLabel"><span>01</span><div><strong>Automation</strong><small>Email monitoring and the managed application tracker</small></div></div>
            <AutomationSettings />
          </section>
          <section className="settingsSection">
            <div className="settingsSectionLabel"><span>02</span><div><strong>ChatGPT bridge</strong><small>Visible website dispatch for workflow conversations</small></div></div>
            <ChatGptBridgeSettings />
          </section>
          <section className="settingsSection">
            <div className="settingsSectionLabel"><span>03</span><div><strong>Browser helper</strong><small>Optional local companion for employer forms</small></div></div>
            <BrowserHelperSettings />
          </section>
          <section className="settingsSection" id="operations">
            <div className="settingsSectionLabel"><span>04</span><div><strong>Operations</strong><small>Background work and service health</small></div></div>
            <AutomationOperationsPanel />
          </section>
          <section className="settingsSection" id="qualification">
            <div className="settingsSectionLabel"><span>05</span><div><strong>Qualification</strong><small>Production launch checklist</small></div></div>
            <LaunchQualification />
          </section>
          <section className="settingsSection" id="diagnostics">
            <div className="settingsSectionLabel"><span>06</span><div><strong>Diagnostics</strong><small>Optional troubleshooting workspace</small></div></div>
            <DiagnosticsVisibilityToggle />
          </section>
        </div>
      </div>
    </div>
  </AppShell>;
}
