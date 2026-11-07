export type DocumentTemplate = {
  id: string;
  name: string;
  description: string;
  font: "Arial" | "Georgia";
  pdfFont: "Helvetica" | "TimesRoman";
  bodySize: number;
  nameSize: number;
  headingSize: number;
  marginMm: number;
  sectionBeforePt: number;
  sectionRule: boolean;
  accent: string;
  layout: string;
};

export const DOCUMENT_TEMPLATES: readonly DocumentTemplate[] = [
  { id: "classic-navy", name: "Classic Navy", description: "A clear, familiar engineering CV with restrained navy headings.", font: "Arial", pdfFont: "Helvetica", bodySize: 10.5, nameSize: 21, headingSize: 12, marginMm: 20, sectionBeforePt: 7, sectionRule: true, accent: "#17324D", layout: "Thin navy section rules, standard spacing and balanced margins" },
  { id: "clean-charcoal", name: "Clean Charcoal", description: "A quiet black and charcoal layout with direct section hierarchy.", font: "Arial", pdfFont: "Helvetica", bodySize: 10.5, nameSize: 20, headingSize: 12, marginMm: 20, sectionBeforePt: 8, sectionRule: false, accent: "#292929", layout: "Charcoal headings without section rules" },
  { id: "technical-slate", name: "Technical Slate", description: "A compact, readable layout for technical evidence and skills.", font: "Arial", pdfFont: "Helvetica", bodySize: 10.2, nameSize: 20, headingSize: 11.5, marginMm: 19, sectionBeforePt: 5, sectionRule: true, accent: "#334155", layout: "Compact type, narrow margins and slate section rules" },
  { id: "research-classic", name: "Research Classic", description: "A traditional serif option for research, modelling and R&D roles.", font: "Georgia", pdfFont: "TimesRoman", bodySize: 11, nameSize: 21, headingSize: 12.5, marginMm: 20, sectionBeforePt: 8, sectionRule: true, accent: "#202020", layout: "Serif type with restrained, rule-led section headings" },
  { id: "modern-teal", name: "Modern Teal", description: "A restrained modern style with a muted teal accent.", font: "Arial", pdfFont: "Helvetica", bodySize: 10.5, nameSize: 21, headingSize: 12, marginMm: 20, sectionBeforePt: 10, sectionRule: true, accent: "#155E63", layout: "Teal headings, thin rules and open section spacing" },
  { id: "engineering-blue", name: "Engineering Blue", description: "A structured layout that gives roles and technical projects clear weight.", font: "Arial", pdfFont: "Helvetica", bodySize: 10.5, nameSize: 20, headingSize: 12, marginMm: 19, sectionBeforePt: 6, sectionRule: true, accent: "#24466B", layout: "Blue headings, strong role hierarchy and compact margins" },
  { id: "quiet-olive", name: "Quiet Olive", description: "A muted, understated theme with generous breathing room.", font: "Arial", pdfFont: "Helvetica", bodySize: 10.5, nameSize: 20, headingSize: 12, marginMm: 21, sectionBeforePt: 11, sectionRule: true, accent: "#46533D", layout: "Olive headings with the widest margins and generous spacing" },
  { id: "minimal-black", name: "Minimal Black", description: "A minimal single-column layout with no decorative colour blocks.", font: "Arial", pdfFont: "Helvetica", bodySize: 10.5, nameSize: 20, headingSize: 12, marginMm: 20, sectionBeforePt: 7, sectionRule: false, accent: "#111111", layout: "Black headings without section rules or decorative colour" },
] as const;

export const DEFAULT_DOCUMENT_TEMPLATE = DOCUMENT_TEMPLATES[0].id;

export function isDocumentTemplateId(value: unknown): value is DocumentTemplate["id"] {
  return typeof value === "string" && DOCUMENT_TEMPLATES.some((item) => item.id === value);
}

export function getDocumentTemplate(id: unknown) {
  return DOCUMENT_TEMPLATES.find((item) => item.id === id) || DOCUMENT_TEMPLATES[0];
}

export function documentTemplateManifest(id: unknown) {
  const template = getDocumentTemplate(id);
  return [
    `Selected JobHuntAI document theme: ${template.name}.`,
    `The DOCX renderer uses ${template.font}; the PDF renderer uses its built-in ${template.pdfFont} font. Use body ${template.bodySize} pt, name ${template.nameSize} pt and section headings ${template.headingSize} pt; A4 with ${template.marginMm} mm margins.`,
    `Visual structure: ${template.layout}.`,
    "Both the CV and cover letter must use the same theme. Preserve the original template styles and ATS-safe single-column reading order. Never use sidebars, text boxes, icons, photos, skill bars, decorative graphics or tables for the main content.",
  ].join("\n");
}
