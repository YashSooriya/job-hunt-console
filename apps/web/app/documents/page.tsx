import { AppShell, DataSourceBadge } from "@/components/app-shell";
import { DocumentTemplateGallery } from "@/components/document-template-gallery";
import { getDocumentDataset, getPreparationApplications } from "@/lib/data/repository";
import { DEFAULT_DOCUMENT_TEMPLATE, isDocumentTemplateId } from "@/lib/document/templates";
import { getDataMode, isSupabaseConfigured } from "@/lib/config";
import { CopyDocumentTextButton } from "@/components/copy-document-text-button";

type GeneratedDocumentItem = {
  id: string;
  application_id: string;
  document_kind: "cv" | "cover_letter";
  state: string;
  version_number: number | null;
  plaintext: string | null;
  drive_state: string;
  drive_folder_id: string | null;
  created_at: string;
  error_message: string | null;
};

export default async function DocumentsPage() {
  const [documents, applications] = await Promise.all([getDocumentDataset(), getPreparationApplications()]);
  let defaultTemplateId = DEFAULT_DOCUMENT_TEMPLATE;
  let generatedItems: GeneratedDocumentItem[] = [];
  let customDocumentsAvailable = false;
  try {
    if (isSupabaseConfigured() && getDataMode() !== "local") {
      const { createClient } = await import("@/lib/supabase/server");
      const supabase = await createClient();
      const [{ data: preference, error: preferenceError }, { data: rows, error: rowsError }] = await Promise.all([
        supabase.from("document_preferences").select("default_template_id").maybeSingle(),
        supabase.from("document_generation_items")
          .select("id,application_id,document_kind,state,version_number,plaintext,drive_state,drive_folder_id,created_at,error_message")
          .order("created_at", { ascending: false }).limit(200),
      ]);
      if (preferenceError) throw preferenceError;
      if (rowsError) throw rowsError;
      defaultTemplateId = isDocumentTemplateId(preference?.default_template_id) ? preference.default_template_id : DEFAULT_DOCUMENT_TEMPLATE;
      generatedItems = (rows || []) as GeneratedDocumentItem[];
      customDocumentsAvailable = true;
    }
  } catch (error) {
    console.warn("Custom application document list could not be loaded.", error);
  }

  const applicationById = new Map(applications.records.map((application) => [application.id, application]));
  const oldVersions = documents.records.flatMap((document) =>
    document.versions.map((version) => ({ document, version })),
  ).sort((a, b) => b.version.createdAt.localeCompare(a.version.createdAt));

  return <AppShell>
    <div className="pageHeader">
      <div><div className="eyebrow">Application materials</div><h1 className="title">Documents</h1><p className="sub">Choose a paired CV and cover-letter design, then review the documents created for each application.</p></div>
      <DataSourceBadge source={applications.source} />
    </div>

    <section className="card documentTemplateSection">
      <div className="cardHeader"><div><h2>Choose your document style</h2><p>All themes are single-column and ATS-readable. Choose a default here; you can change it for any application.</p></div></div>
      <DocumentTemplateGallery defaultTemplateId={defaultTemplateId} />
    </section>

    <section className="card documentLibrary">
      <div className="cardHeader"><div><h2>Documents by application</h2><p>Your tailored files stay together with the job they were made for.</p></div><span className="badge">{generatedItems.filter((item) => item.state === "ready").length} ready</span></div>
      {!customDocumentsAvailable ? <div className="notice">Sign in with the connected account to view and create private application documents.</div> : null}
      <div className="documentLibraryList">
        {generatedItems.map((item) => {
          const application = applicationById.get(item.application_id);
          const label = item.document_kind === "cv" ? "Tailored CV" : "Cover letter";
          const ready = item.state === "ready";
          return <article className="documentLibraryRow" key={item.id}>
            <div className="documentLibraryMain">
              <span className="documentKindIcon" aria-hidden="true">{item.document_kind === "cv" ? "CV" : "CL"}</span>
              <div><strong>{application?.company || "Application"} · {application?.role || "Job listing"}</strong><p>{label}{item.version_number ? " · v" + item.version_number : ""} · {ready ? "Ready for your review" : item.error_message || item.state.replaceAll("_", " ")}</p></div>
            </div>
            <div className="documentLibraryActions">
              {ready ? <>
                <a className="textLink" href={"/api/application-documents/" + item.id + "/download?format=pdf"} target="_blank" rel="noreferrer">Open PDF</a>
                <a className="textLink" href={"/api/application-documents/" + item.id + "/download?format=docx"}>Download Word</a>
                {item.document_kind === "cover_letter" && item.plaintext ? <CopyDocumentTextButton text={item.plaintext} /> : null}
                {item.drive_state === "ready" && item.drive_folder_id ? <a className="textLink" href={"https://drive.google.com/drive/folders/" + encodeURIComponent(item.drive_folder_id)} target="_blank" rel="noreferrer">Open Drive folder</a> : null}
              </> : null}
              <a className="secondaryButton" href={"/applications/" + item.application_id}>Open application</a>
            </div>
            {ready && item.document_kind === "cover_letter" && item.plaintext ? <details className="coverLetterPlaintext"><summary>Plain-text letter</summary><textarea readOnly value={item.plaintext} aria-label="Cover letter text for copying" /><CopyDocumentTextButton text={item.plaintext} /></details> : null}
            {ready ? <details className="documentPreviewDetails"><summary>Preview {label.toLowerCase()}</summary><iframe className="generatedDocumentPreview" title={label + " PDF preview"} src={"/api/application-documents/" + item.id + "/download?format=pdf"} /></details> : null}
          </article>;
        })}
        {customDocumentsAvailable && generatedItems.length === 0 ? <div className="emptyState">No tailored documents yet. Open an application and choose which documents you want ChatGPT to draft.</div> : null}
      </div>
    </section>

    {oldVersions.length ? <details className="card legacyDocumentVersions">
      <summary><strong>Earlier document versions</strong><span>{oldVersions.length} saved version{oldVersions.length === 1 ? "" : "s"}</span></summary>
      <div className="versionList">{oldVersions.map(({ document, version }) => (
        <article className="versionRow" key={version.id}>
          <div><strong>{document.title} · v{version.versionNumber}</strong><p>{document.kind.replaceAll("_", " ")} · {version.approvalStatus.replaceAll("_", " ")} · {version.engine || "unknown engine"}</p></div>
          <div className="badges"><span className={"badge " + (version.unsupportedClaimsCount === 0 ? "review" : "danger")}>{version.unsupportedClaimsCount} unsupported</span>{version.renderedObjectKey ? <a className="textLink" href={"/api/documents/" + version.id + "/download"} target="_blank" rel="noreferrer">Open PDF</a> : null}</div>
        </article>
      ))}</div>
    </details> : null}
  </AppShell>;
}
