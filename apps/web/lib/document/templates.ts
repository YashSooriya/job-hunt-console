export type DocumentTemplate = {
  id: string;
  name: string;
  description: string;
  font: "Arial" | "Georgia";
  bodySize: number;
  nameSize: number;
  headingSize: number;
  marginMm: number;
  accent: string;
  layout: string;
};

export const DOCUMENT_TEMPLATES: readonly DocumentTemplate[] = [
  { id: "classic-navy", name: "Classic Navy", description: "A clear, familiar engineering CV with restrained navy headings.", font: "Arial", bodySize: 10.5, nameSize: 21, headingSize: 12, marginMm: 20, accent: "#17324D", layout: "Thin section rules and balanced spacing" },
  { id: "clean-charcoal", name: "Clean Charcoal", description: "A quiet black and charcoal layout with direct section hierarchy.", font: "Arial", bodySize: 10.5, nameSize: 20, headingSize: 12, marginMm: 20, accent: "#292929", layout: "Simple headings with no section rules" },
  { id: "technical-slate", name: "Technical Slate", description: "A compact, readable layout for technical evidence and skills.", font: "Arial", bodySize: 10.2, nameSize: 20, headingSize: 11.5, marginMm: 19, accent: "#334155", layout: "Compact skill categories and clear role hierarchy" },
  { id: "research-classic", name: "Research Classic", description: "A traditional serif option for research, modelling and R&D roles.", font: "Georgia", bodySize: 11, nameSize: 21, headingSize: 12.5, marginMm: 20, accent: "#202020", layout: "Serif body text and compact selected publications" },
  { id: "modern-teal", name: "Modern Teal", description: "A restrained modern style with a muted teal accent.", font: "Arial", bodySize: 10.5, nameSize: 21, headingSize: 12, marginMm: 20, accent: "#155E63", layout: "Subtle separators and open section spacing" },
  { id: "engineering-blue", name: "Engineering Blue", description: "A structured layout that gives roles and technical projects clear weight.", font: "Arial", bodySize: 10.5, nameSize: 20, headingSize: 12, marginMm: 19, accent: "#24466B", layout: "Prominent role headings and consistent date alignment" },
  { id: "quiet-olive", name: "Quiet Olive", description: "A muted, understated theme with generous breathing room.", font: "Arial", bodySize: 10.5, nameSize: 20, headingSize: 12, marginMm: 21, accent: "#46533D", layout: "Light hierarchy with generous section spacing" },
  { id: "minimal-black", name: "Minimal Black", description: "A minimal single-column layout with no decorative colour blocks.", font: "Arial", bodySize: 10.5, nameSize: 20, headingSize: 12, marginMm: 20, accent: "#111111", layout: "Black text, plain rules and conventional headings" },
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
    `Use the supplied ${template.font} family; body ${template.bodySize} pt; name ${template.nameSize} pt; section headings ${template.headingSize} pt; A4 with ${template.marginMm} mm margins; accent ${template.accent}.`,
    `Visual structure: ${template.layout}.`,
    "Both the CV and cover letter must use the same theme. Preserve the original template styles and ATS-safe single-column reading order. Never use sidebars, text boxes, icons, photos, skill bars, decorative graphics or tables for the main content.",
  ].join("\n");
}
