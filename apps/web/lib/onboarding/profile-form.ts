/**
 * The personal-details form is used in two different save paths:
 *
 * - the normal Save personal details action, which submits a complete profile;
 * - the Memory correction action, which must submit only fields the user
 *   changed and must not be blocked by unrelated required fields that an
 *   imported profile has not filled yet.
 *
 * Keep the field mapping and comparison in one place so those paths cannot
 * drift apart or accidentally turn an empty, untouched input into a delete.
 */

export const PERSONAL_DETAILS_FORM_FIELDS = [
  ["displayName", "displayName"],
  ["firstName", "firstName"],
  ["surname", "surname"],
  ["dateOfBirth", "dateOfBirth"],
  ["email", "email"],
  ["phone", "phone"],
  ["location", "location"],
  ["citizenship", "citizenship"],
  ["workAuthorisation", "workAuthorisation"],
  ["rightToWorkCountries", "rightToWorkCountries"],
  ["visaStatus", "visaStatus"],
  ["visaExpiry", "visaExpiry"],
  ["sponsorshipRequirement", "sponsorshipRequirement"],
  ["noticePeriod", "noticePeriod"],
  ["currentSalary", "currentSalary"],
  ["salaryCurrency", "salaryCurrency"],
  ["salaryExpectation", "salaryExpectation"],
  ["availabilityDate", "availabilityDate"],
  ["languages", "languages"],
  ["portfolioLinks", "portfolioLinks"],
  ["linkedinUrl", "linkedinUrl"],
  ["certifications", "certifications"],
] as const;

function formValue(values: FormData, fieldName: string) {
  const value = values.get(fieldName);
  return typeof value === "string" ? value : "";
}
function comparable(value: unknown) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean).join(", ");
  return String(value).trim();
}

/** Serialize every personal-details field for the complete-profile endpoint. */
export function personalDetailsPayload(values: FormData) {
  return Object.fromEntries(PERSONAL_DETAILS_FORM_FIELDS.map(([fieldName, apiName]) => [apiName, formValue(values, fieldName)]));
}

/**
 * Return a changed-fields-only payload for the incremental Memory update.
 * Empty values are retained when they differ from a saved value, allowing a
 * deliberate clear to delete that fact; untouched empty fields are omitted.
 */
export function personalDetailsPatch(values: FormData, baseline: Record<string, unknown>) {
  const current = personalDetailsPayload(values);
  return Object.fromEntries(Object.entries(current).filter(([apiName, value]) => (
    comparable(value) !== comparable(baseline[apiName])
  )));
}
