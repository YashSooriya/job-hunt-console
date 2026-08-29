type RecordValue = Record<string, unknown>;

export type ChronologyKind = "history" | "project" | "publication";

function dateScore(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!text) return null;
  const normalised = /^\d{4}$/.test(text)
    ? `${text}-01-01T00:00:00Z`
    : /^\d{4}-\d{2}$/.test(text)
      ? `${text}-01T00:00:00Z`
      : text;
  const parsed = Date.parse(normalised);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstDate(record: RecordValue, fields: string[]) {
  for (const field of fields) {
    const score = dateScore(record[field]);
    if (score !== null) return score;
  }
  return null;
}

function chronologyScore(record: RecordValue, kind: ChronologyKind) {
  if (kind === "publication") {
    return firstDate(record, ["published_on", "publishedOn", "date", "created_at"]);
  }
  if (kind === "project") {
    // Projects historically had no dedicated date column, so created_at is a
    // deterministic fallback for older records. Newer records can provide a
    // start/end or completion date without changing the ordering contract.
    return firstDate(record, ["start_date", "startDate", "completed_on", "completedOn", "end_date", "endDate", "date", "created_at"]);
  }
  return firstDate(record, ["start_date", "startDate", "date", "end_date", "endDate", "created_at"]);
}

/** Return a stable newest-first copy of an onboarding record list. */
export function sortReverseChronological<T extends RecordValue>(records: T[], kind: ChronologyKind) {
  return records
    .map((record, index) => ({ record, index, score: chronologyScore(record, kind) }))
    .sort((left, right) => {
      if (left.score === null && right.score === null) return left.index - right.index;
      if (left.score === null) return 1;
      if (right.score === null) return -1;
      if (left.score !== right.score) return right.score - left.score;
      return left.index - right.index;
    })
    .map(({ record }) => record);
}
