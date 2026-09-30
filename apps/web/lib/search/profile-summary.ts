import type { ProfessionalBackgroundInput } from "@/lib/chatgpt/professional-background";

function text(value: unknown, maximum = 220) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

function rows(title: string, values: string[]) {
  const usable = values.filter(Boolean).slice(0, 8);
  return usable.length ? `${title}:\n${usable.map((value) => `- ${value}`).join("\n")}` : "";
}

/** A compact, verified, non-contact summary used only to assess role fit. */
export function buildSearchProfileSummary(input: ProfessionalBackgroundInput, maximum = 1400) {
  const blocks = [
    rows("Experience", input.employment.map((item) => [text(item.role_title), text(item.employer), text(item.details, 240)].filter(Boolean).join(" — "))),
    rows("Education", input.education.map((item) => [text(item.qualification), text(item.institution), text(item.field_of_study)].filter(Boolean).join(" — "))),
    rows("Skills", input.skills.map((item) => [text(item.name), text(item.proficiency, 80), typeof item.years_experience === "number" ? `${item.years_experience} years` : ""].filter(Boolean).join(" — "))),
    rows("Projects", input.projects.map((item) => [text(item.title), text(item.description, 180), Array.isArray(item.technologies) ? item.technologies.map((entry) => text(entry, 50)).filter(Boolean).slice(0, 6).join(", ") : ""].filter(Boolean).join(" — "))),
    rows("Evidence", input.evidence.map((item) => [text(item.claim), text(item.detail, 180)].filter(Boolean).join(" — "))),
  ].filter(Boolean);
  const summary = blocks.join("\n");
  if (summary.length <= maximum) return summary;
  const marker = " …[more verified evidence omitted]";
  if (maximum <= marker.length) return marker.slice(0, maximum);
  const limit = maximum - marker.length;
  const cutoff = summary.lastIndexOf("\n", limit);
  const end = cutoff > 0 ? cutoff : limit;
  return `${summary.slice(0, end).trimEnd()}${marker}`;
}
