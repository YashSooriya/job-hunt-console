import { AppShell } from "@/components/app-shell";
import { OnboardingWorkspace } from "@/components/onboarding-workspace";

export default function OnboardingPage() {
  return <AppShell>
    <div className="pageHeader onboardingPageHeader">
      <div>
        <div className="eyebrow">Profile setup</div>
        <h1 className="title">Build your profile</h1>
        <p className="sub">Add your information, let ChatGPT fill the gaps, then review the result.</p>
      </div>
    </div>
    <OnboardingWorkspace />
  </AppShell>;
}
