"use client";

import { useState, type CSSProperties } from "react";
import { DOCUMENT_TEMPLATES, type DocumentTemplate } from "@/lib/document/templates";
import { DOCUMENT_PREVIEW_CV, DOCUMENT_PREVIEW_LETTER } from "@/lib/document/preview-content";

type PaperStyle = CSSProperties & {
  "--paper-margin": string;
  "--paper-body-size": string;
  "--paper-name-size": string;
  "--paper-heading-size": string;
  "--paper-headline-size": string;
  "--paper-contact-size": string;
  "--paper-sub-size": string;
  "--paper-section-before": string;
};
type PreviewEntry = { heading?: string; subheading?: string; date?: string; location?: string; bullets?: Array<string | { text: string }> };
type PreviewSection = { section_key: string; heading: string; entries: PreviewEntry[] };

function SampleDocument({ theme, kind }: { theme: DocumentTemplate; kind: "CV" | "Cover letter" }) {
  const isCv = kind === "CV";
  const cv = DOCUMENT_PREVIEW_CV;
  const letter = DOCUMENT_PREVIEW_LETTER;
  const paperStyle: PaperStyle = {
    fontFamily: `${theme.font}, ${theme.font === "Georgia" ? "serif" : "sans-serif"}`,
    color: "#232a32",
    "--paper-margin": `${(theme.marginMm / 210) * 100}%`,
    "--paper-body-size": `${theme.bodySize * 0.1681}cqw`,
    "--paper-name-size": `${theme.nameSize * 0.1681}cqw`,
    "--paper-heading-size": `${theme.headingSize * 0.1681}cqw`,
    "--paper-headline-size": `${11 * 0.1681}cqw`,
    "--paper-contact-size": `${9 * 0.1681}cqw`,
    "--paper-sub-size": `${9.5 * 0.1681}cqw`,
    "--paper-section-before": `${theme.sectionBeforePt * 0.1681}cqw`,
  };
  const sections = (isCv ? cv.sections : []) as unknown as PreviewSection[];
  const candidate = isCv ? cv.candidate : null;
  const contact = isCv
    ? [cv.candidate.location, cv.candidate.email, cv.candidate.phone, cv.candidate.linkedin].filter(Boolean).join("  |  ")
    : [letter.candidate_location, letter.candidate_email, letter.candidate_phone].filter(Boolean).join("  |  ");

  return <span className="templatePaperFrame" style={paperStyle}>
    <span className="templatePaper" role="img" aria-label={`${kind} page 1 preview for fictional candidate Taylor Example`}>
      <span className="templatePaperName" style={{ color: theme.accent }}>{candidate?.name || letter.candidate_name}</span>
      {isCv ? <>
        <span className="templatePaperRole" style={{ color: theme.accent }}>{cv.headline}</span>
        <span className="templatePaperContact">{contact}</span>
        <span className="templatePaperHeading" style={{ color: theme.accent, borderColor: theme.accent, borderBottomStyle: theme.sectionRule ? "solid" : "none" }}>PROFILE</span>
        <span className="templatePaperBody">{cv.profile_summary.text}</span>
        {sections.map((section) => <span className="templatePaperSection" key={section.section_key}>
          <span className="templatePaperHeading" role="heading" aria-level={4} style={{ color: theme.accent, borderColor: theme.accent, borderBottomStyle: theme.sectionRule ? "solid" : "none" }}>
            {section.heading.toUpperCase()}
          </span>
          {section.entries.map((entry, index) => <span className="templatePaperEntry" key={`${section.section_key}-${index}`}>
            <span className="templatePaperEntryTitle">{[entry.heading, entry.date].filter(Boolean).join("  |  ")}</span>
            {entry.subheading || entry.location ? <span className="templatePaperEntrySub">{[entry.subheading, entry.location].filter(Boolean).join("  |  ")}</span> : null}
            {entry.bullets?.map((bullet, bulletIndex) => <span className="templatePaperBullet" key={bulletIndex}>- {typeof bullet === "string" ? bullet : bullet.text}</span>)}
          </span>)}
        </span>)}
      </> : <>
        <span className="templatePaperContact">{contact}</span>
        <span className="templatePaperLetterCompany">{letter.company}</span>
        <span className="templatePaperLetterRole">{letter.job_title}</span>
        <span className="templatePaperLetterSalutation">{letter.salutation}</span>
        {letter.paragraphs.map((paragraph, index) => <span className="templatePaperLetterParagraph" key={index}>{paragraph.text}</span>)}
        <span className="templatePaperLetterClosing">{letter.closing}</span>
        <span className="templatePaperLetterSignature">{letter.candidate_name}</span>
      </>}
    </span>
    <span className="templatePaperCaption">{kind} · page 1</span>
  </span>;
}

export function DocumentTemplateGallery({ defaultTemplateId }: { defaultTemplateId: string }) {
  const [selected, setSelected] = useState(defaultTemplateId);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function saveDefault() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/documents/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaultTemplateId: selected }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) throw new Error(data?.error || "Could not save the default theme.");
      setMessage("Default theme saved. It will be used for future requests.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save the default theme.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <div className="documentTemplateGrid">
      {DOCUMENT_TEMPLATES.map((theme) => <article className={`documentTemplateCard ${selected === theme.id ? "selected" : ""}`} key={theme.id}>
        <button className="documentTemplateSelect" type="button" onClick={() => setSelected(theme.id)} aria-pressed={selected === theme.id}>
          <span className="documentTemplatePreviews">
            <SampleDocument theme={theme} kind="CV" />
            <SampleDocument theme={theme} kind="Cover letter" />
          </span>
          <span className="documentTemplateDetails">
            <span className="documentTemplateTitle">{theme.name}</span>
            <span>{theme.description}</span>
            <span className="documentTemplateSpecs">DOCX {theme.font} · PDF built-in {theme.pdfFont === "TimesRoman" ? "Times Roman" : "Helvetica"} fallback · {theme.bodySize} pt body · A4 · {theme.marginMm} mm margins</span>
          </span>
        </button>
        <button className="textLink" type="button" onClick={() => setExpanded(theme.id)}>View larger preview</button>
      </article>)}
    </div>
    <div className="documentTemplateFooter">
      <p>{message || "Choose a paired CV and cover-letter design. The same theme will be used for both documents."}</p>
      <button className="primaryButton" type="button" disabled={busy} onClick={() => void saveDefault()}>{busy ? "Saving…" : "Set as default"}</button>
    </div>
    {expanded ? (() => {
      const theme = DOCUMENT_TEMPLATES.find((item) => item.id === expanded)!;
      return <div className="templatePreviewOverlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setExpanded(null); }}>
        <section className="templatePreviewDialog" role="dialog" aria-modal="true" aria-label={`${theme.name} document previews`}>
          <div className="templatePreviewDialogHead">
            <div><h2>{theme.name}</h2><p>{theme.description}</p><p className="documentTemplateSpecs">DOCX {theme.font} · PDF built-in {theme.pdfFont === "TimesRoman" ? "Times Roman" : "Helvetica"} fallback</p></div>
            <button className="secondaryButton" type="button" onClick={() => setExpanded(null)}>Close</button>
          </div>
          <div className="templatePreviewLarge"><SampleDocument theme={theme} kind="CV"/><SampleDocument theme={theme} kind="Cover letter"/></div>
        </section>
      </div>;
    })() : null}
  </>;
}
