import { AppShell, DataSourceBadge } from "@/components/app-shell";
import { EvidenceExplorer } from "@/components/evidence-explorer";
import { getCandidateProfile } from "@/lib/data/repository";

function renderValue(value: unknown) {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value ?? "");
}

export default async function ProfilePage() {
  const profile = await getCandidateProfile();
  const verifiedFacts = profile.facts.filter((fact) => fact.status === "verified");
  const verifiedEvidence = profile.evidence.filter((item) => item.status === "verified");
  const needsReview = profile.facts.filter((fact) => fact.status === "needs_review").length +
    profile.evidence.filter((item) => item.status === "needs_review").length;

  return (
    <AppShell>
      <div className="pageHeader">
        <div><div className="eyebrow">Candidate intelligence</div><h1 className="title">{profile.displayName}</h1><p className="sub">This is the evidence-backed source of truth used for future CV tailoring. Facts and reusable evidence remain separate from generated application prose.</p></div>
        <DataSourceBadge source={profile.source} />
      </div>
      <section className="metrics">
        <div className="metric"><span>Verified facts</span><strong>{verifiedFacts.length}</strong></div>
        <div className="metric"><span>Evidence records</span><strong>{verifiedEvidence.length}</strong></div>
        <div className="metric"><span>Sources</span><strong>{profile.sources.length}</strong></div>
        <div className="metric"><span>Needs review</span><strong>{needsReview}</strong></div>
      </section>
      <section className="profileGrid">
        <div className="card">
          <div className="cardHeader"><div><h2>Verified facts</h2><p>Stable applicant facts only</p></div></div>
          <div className="factsList">
            {profile.facts.map((fact) => (
              <div className="factRow" key={fact.factKey}>
                <div><span>{fact.factKey}</span><strong>{renderValue(fact.value)}</strong></div>
                <span className={`badge ${fact.status === "verified" ? "review" : "action"}`}>{fact.status.replace("_", " ")}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="cardHeader"><div><h2>Authoritative sources</h2><p>Evidence provenance</p></div></div>
          <div className="factsList">
            {profile.sources.map((source) => (
              <div className="factRow" key={source.sourceKey}>
                <div><span>{source.sourceType.replace("_", " ")}</span><strong>{source.title}</strong></div>
                <span className="monoKey">{source.sourceKey}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
      <EvidenceExplorer items={profile.evidence} />
      <div className="notice">Application-specific sensitive disclosures are deliberately excluded from this reusable profile unless explicitly promoted by the user.</div>
    </AppShell>
  );
}
