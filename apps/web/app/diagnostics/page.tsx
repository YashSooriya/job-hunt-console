import { AppShell } from "@/components/app-shell";
import { DiagnosticsJobSearchCooldownToggle } from "@/components/diagnostics-job-search-cooldown-toggle";
import { DiagnosticsChatGptActionLockToggle } from "@/components/diagnostics-chatgpt-action-lock-toggle";
import { DiagnosticsMessageForm } from "@/components/diagnostics-message-form";
import { DiagnosticsTestingModeToggle } from "@/components/diagnostics-testing-mode-toggle";

export default function DiagnosticsPage() {
  return <AppShell><DiagnosticsTestingModeToggle /><DiagnosticsChatGptActionLockToggle /><DiagnosticsMessageForm /><DiagnosticsJobSearchCooldownToggle /></AppShell>;
}
