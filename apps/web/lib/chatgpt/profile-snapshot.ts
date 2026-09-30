import type { ProfessionalBackgroundInput } from "@/lib/chatgpt/professional-background";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ProfileSnapshot = Record<string, JsonValue>;

function normalise(value: unknown): JsonValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["source_id", "verification_status", "source_note", "updated_at"].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalise(item)]));
  }
  return String(value);
}

function recordKey(item: Record<string, unknown>, fields: string[]) {
  return fields.map((field) => String(item[field] ?? "").trim().toLowerCase()).join("|");
}

export function snapshotFromInput(input: ProfessionalBackgroundInput): ProfileSnapshot {
  const snapshot: ProfileSnapshot = {};
  if (input.displayName.trim()) snapshot["profile.display_name"] = input.displayName.trim();
  for (const fact of input.facts) {
    const key = String(fact.fact_key || "").trim();
    // Display Name has a canonical profile column. The mirrored fact is only
    // provenance for a user edit and must not create a duplicate correction.
    if (key && key !== "display_name") snapshot[`facts.${key}`] = normalise(fact.value_json);
  }
  for (const item of input.employment) snapshot[`employment.${recordKey(item, ["employer", "role_title", "start_date"])}`] = normalise(item);
  for (const item of input.education) snapshot[`education.${recordKey(item, ["institution", "qualification", "start_date"])}`] = normalise(item);
  for (const item of input.skills) snapshot[`skills.${recordKey(item, ["name", "category"])}`] = normalise(item);
  for (const item of input.projects) snapshot[`projects.${recordKey(item, ["title", "start_date"])}`] = normalise(item);
  for (const item of input.publications) snapshot[`publications.${recordKey(item, ["title", "published_on"])}`] = normalise(item);
  return snapshot;
}

export type ProfileDelta = Array<{ path: string; before: JsonValue; after: JsonValue }>;

export function diffSnapshots(previous: ProfileSnapshot, current: ProfileSnapshot): ProfileDelta {
  const paths = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...paths].sort().flatMap((path) => {
    const before = Object.prototype.hasOwnProperty.call(previous, path) ? previous[path] : null;
    const after = Object.prototype.hasOwnProperty.call(current, path) ? current[path] : null;
    // Snapshots can cross a JSONB round-trip, which may change object key
    // insertion order without changing the value. Compare canonicalised JSON
    // rather than raw JSON.stringify output or unchanged records become false
    // correction messages.
    return JSON.stringify(normalise(before)) === JSON.stringify(normalise(after)) ? [] : [{ path, before, after }];
  });
}

export function snapshotHasValues(snapshot: ProfileSnapshot) {
  return Object.keys(snapshot).length > 0;
}
