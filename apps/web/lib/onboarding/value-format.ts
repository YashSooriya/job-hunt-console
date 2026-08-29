const URL_PATTERN = /https?:\/\/[^\s"'\\[\]{}<>,;]+/gi;

const URL_FIELDS = new Set([
  "linkedin",
  "linkedin_url",
  "portfolio",
  "portfolio_links",
  "github",
  "github_url",
  "url",
  "link",
]);

function trimUrl(value: string) {
  return value.replace(/[.,;:!?]+$/g, "");
}

export function extractUrls(value: unknown) {
  const source = Array.isArray(value)
    ? value.map((item) => typeof item === "string" ? item : item && typeof item === "object" ? JSON.stringify(item) : "").join(" ")
    : typeof value === "string" ? value : "";
  const urls = [...source.matchAll(URL_PATTERN)]
    .map((match) => trimUrl(match[0]))
    .filter(Boolean);
  return [...new Set(urls)];
}

export function cleanUrlValue(value: unknown) {
  return extractUrls(value)[0] || null;
}

export function cleanUrlList(value: unknown) {
  return extractUrls(value).slice(0, 30);
}

export function isUrlField(fieldKey = "") {
  return URL_FIELDS.has(fieldKey.toLowerCase());
}

function simpleItemText(item: unknown) {
  if (typeof item === "string" || typeof item === "number") return String(item).trim();
  if (!item || typeof item !== "object" || Array.isArray(item)) return "";
  const record = item as Record<string, unknown>;
  if (typeof record.url === "string" || typeof record.link === "string") return cleanUrlValue(record.url || record.link) || "";
  const name = typeof record.language === "string"
    ? record.language
    : typeof record.name === "string"
      ? record.name
      : typeof record.title === "string"
        ? record.title
        : typeof record.certification === "string" ? record.certification : "";
  const proficiency = typeof record.proficiency === "string" ? record.proficiency : typeof record.level === "string" ? record.level : "";
  const issuer = typeof record.issuer === "string" ? record.issuer : "";
  const date = typeof record.date === "string" ? record.date : "";
  return [name, proficiency, issuer, date].filter(Boolean).join(" — ");
}

export function formatProfileValue(value: unknown, fieldKey = "") {
  if (isUrlField(fieldKey)) {
    const urls = cleanUrlList(value);
    if (urls.length) return urls.join(", ");
  }
  if (Array.isArray(value)) {
    const items = value.map(simpleItemText).filter(Boolean);
    if (items.length) return items.join(", ");
  }
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    try { return JSON.stringify(value); } catch { return ""; }
  }
  return "";
}
