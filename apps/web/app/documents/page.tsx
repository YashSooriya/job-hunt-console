import { AppShell, DataSourceBadge } from "@/components/app-shell";
import { getCandidateProfile, getDocumentDataset } from "@/lib/data/repository";

const families = [
  ["simulation_cae", "Simulation / CAE", "Engineering simulation, FEM, structural dynamics and multiphysics roles."],
  ["scientific_software", "Scientific Software", "Research software, numerical computing and scientific Python roles."],
  ["quantitative_data", "Quantitative / Data", "Mathematical modelling, quantitative analysis and data roles."],
  ["motorsport", "Motorsport", "Used only for explicitly motorsport-related vacancies."],
] as const;

export default async function DocumentsPage() {
  const [profile, documents] = await Promise.all([getCandidateProfile(), getDocumentDataset()]);
  return (
    <AppShell>
      <div className="pageHeader">
        <div><div className="eyebrow">CV architecture</div><h1 className="title">Documents</h1><p className="sub">The four CV families share a verified evidence base. Application CVs are stored as immutable versions with evidence provenance and rendered PDFs.</p></div>
        <DataSourceBadge source={profile.source} />
      </div>
      <section className="documentGrid">
        {families.map(([key, title, description]) => (
          <article className="card documentCard" key={key}>
            <span className="monoKey">{key}</span>
            <h2>{title}</h2>
            <p>{description}</p>
            <div className="badges"><span className="badge review">{profile.evidence.length} evidence records available</span></div>
          </article>
        ))}
      </section>
      <section className="card">
        <div className="cardHeader"><div><h2>Application CV versions</h2><p>{documents.records.filter((d) => d.kind === "cv").length} application CV documents stored.</p></div><DataSourceBadge source={documents.source} /></div>
        <div className="versionList">
          {documents.records.filter((d) => d.kind === "cv").flatMap((document) => document.versions.map((version) => (
            <article className="versionRow" key={version.id}>
              <div><strong>{document.title} · v{version.versionNumber}</strong><p>{document.cvFamily?.replaceAll("_", " ") || "CV"} · {version.approvalStatus.replaceAll("_", " ")} · {version.engine || "unknown engine"}</p></div>
              <div className="badges"><span className={`badge ${version.unsupportedClaimsCount === 0 ? "review" : "danger"}`}>{version.unsupportedClaimsCount} unsupported</span>{version.renderedObjectKey ? <a className="textLink" href={`/api/documents/${version.id}/download`} target="_blank">Open PDF</a> : null}</div>
            </article>
          )))}
          {!documents.records.some((d) => d.kind === "cv" && d.versions.length) ? <div className="emptyState">No application CV versions have been generated yet.</div> : null}
        </div>
      </section>
      <div className="notice">The document engine generates structured content first, requires evidence IDs for every material claim, then renders LaTeX/PDF. Layout commands are never generated or edited by the tailoring engine.</div>
    </AppShell>
  );
}
