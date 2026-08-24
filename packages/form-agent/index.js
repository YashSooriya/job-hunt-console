const NORMAL_SPACE = /\s+/g;

function norm(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9£$%+@.]+/g, " ")
    .replace(NORMAL_SPACE, " ")
    .trim();
}

function tokens(value) {
  return new Set(norm(value).split(" ").filter((x) => x.length > 1));
}

function overlapScore(a, b) {
  const aa = tokens(a); const bb = tokens(b);
  if (!aa.size || !bb.size) return 0;
  let hit = 0;
  for (const t of aa) if (bb.has(t)) hit += 1;
  return hit / Math.max(aa.size, bb.size);
}

const SENSITIVE = [
  "gender", "sex", "sexual orientation", "ethnicity", "race", "religion", "belief",
  "disability", "disabled", "veteran", "criminal", "conviction", "political", "trade union",
  "date of birth", "birth date", "national insurance", "passport", "social security",
  "security clearance", "clearance", "right to work", "work authorization", "work authorisation",
  "visa sponsorship", "sponsorship", "citizenship", "nationality", "marital status",
];

const AUTH_WORDS = ["sign in", "log in", "login", "password", "verification code", "one time code", "mfa", "two factor"];
const CAPTCHA_WORDS = ["captcha", "i am not a robot", "recaptcha", "hcaptcha"];
const FINAL_SUBMIT = [
  /^submit$/, /^submit application$/, /^send application$/, /^complete application$/, /^finish application$/,
  /^confirm and submit$/, /^submit my application$/, /^send my application$/,
];
const CONTINUE = [
  /^continue$/, /^next$/, /^save and continue$/, /^save & continue$/, /^continue application$/, /^proceed$/, /^review application$/,
];
const START_APPLICATION = [
  /^apply$/, /^apply now$/, /^apply for this job$/, /^start application$/, /^start your application$/, /^begin application$/,
  /^apply manually$/, /^start my application$/, /^i m interested$/, /^im interested$/,
];

export function isDangerousSubmissionLabel(label) {
  const n = norm(label);
  return FINAL_SUBMIT.some((r) => r.test(n));
}

function isContinueLabel(label) {
  const n = norm(label);
  return CONTINUE.some((r) => r.test(n));
}

export function isStartApplicationLabel(label) {
  const n = norm(label);
  return START_APPLICATION.some((r) => r.test(n));
}

function isSensitive(label) {
  const n = norm(label);
  return SENSITIVE.some((x) => n.includes(x));
}

function pagePurpose(observation) {
  const labels = observation.controls.map((c) => c.label).join(" ");
  const text = norm(`${observation.title} ${observation.bodyText || ""} ${labels}`);
  if (observation.flags?.captcha || CAPTCHA_WORDS.some((x) => text.includes(x))) return ["authentication", 0.98];
  if (observation.flags?.authentication || AUTH_WORDS.some((x) => text.includes(x)) || observation.controls.some((c) => c.controlType === "text" && norm(c.autocomplete).includes("password"))) return ["authentication", 0.94];
  if (/thank you.*application|application (has been|was) submitted|submission received|application complete/.test(text)) return ["confirmation", 0.96];
  if (/review (your|my) application|application review|check your application/.test(text)) return ["review", 0.91];
  if (SENSITIVE.some((x) => text.includes(x)) && /equal|divers|demographic|monitoring|voluntary|disclosure/.test(text)) return ["voluntary_disclosure", 0.88];
  if (/education|university|degree|qualification|academic/.test(text)) return ["education", 0.82];
  if (/employment|work experience|experience|employer|job history/.test(text)) return ["employment", 0.79];
  if (/skills|competenc|technology|technical skills/.test(text)) return ["skills", 0.8];
  if (observation.controls.some((c) => c.controlType === "file") || /resume|résumé|curriculum vitae|cover letter|documents/.test(text)) return ["documents", 0.84];
  if (/screening|question|salary|notice period|sponsorship|clearance|eligibility/.test(text)) return ["screening", 0.72];
  if (/name|email|phone|address|linkedin/.test(text)) return ["candidate_details", 0.7];
  return ["unknown", 0.45];
}

function candidateValue(context, semantic) {
  const c = context.candidate || {};
  const aliases = {
    full_name: ["name", "full_name", "fullName"], first_name: ["first_name", "firstName", "given_name"], last_name: ["last_name", "lastName", "family_name"],
    email: ["email", "email_address"], phone: ["phone", "telephone", "mobile"], linkedin: ["linkedin", "linkedin_url"], github: ["github", "github_url"], orcid: ["orcid"],
  };
  for (const key of aliases[semantic] || []) if (c[key] != null && String(c[key]).trim()) return { value: c[key], provenance: [`candidate:${key}`] };
  return null;
}

function semanticForLabel(label, control) {
  const n = norm(`${label} ${control.name || ""} ${control.autocomplete || ""} ${control.placeholder || ""}`);
  if (/first name|given name|forename/.test(n)) return "first_name";
  if (/last name|family name|surname/.test(n)) return "last_name";
  if (/full name|your name|candidate name/.test(n) || (n === "name")) return "full_name";
  if (/email/.test(n)) return "email";
  if (/phone|telephone|mobile/.test(n)) return "phone";
  if (/linkedin/.test(n)) return "linkedin";
  if (/github/.test(n)) return "github";
  if (/orcid/.test(n)) return "orcid";
  if (/salary expectation|expected salary|salary requirement|desired salary|expected base/.test(n)) return "salary_expectation";
  if (/current location|location city|city of residence|current city/.test(n)) return "current_location";
  if (/country of residence|current country|country/.test(n)) return "country";
  if (/resume|résumé|curriculum vitae|\bcv\b/.test(n) && control.controlType === "file") return "cv_upload";
  if (/cover letter|covering letter/.test(n) && control.controlType === "file") return "cover_letter_upload";
  if (/cover letter|covering letter/.test(n) && ["text","textarea"].includes(control.controlType)) return "cover_letter_text";
  return null;
}

function findFact(context, label, semantic) {
  const facts = (context.facts || []).filter((f) => f.verified !== false && f.value != null);
  const labelNorm = norm(label);
  const candidates = facts.map((f) => {
    const key = norm(f.factKey.replace(/[._]/g, " "));
    let score = overlapScore(labelNorm, key);
    if (semantic && key.includes(norm(semantic.replaceAll("_", " ")))) score = Math.max(score, 0.88);
    return { f, score };
  }).sort((a,b) => b.score-a.score);
  if (candidates[0]?.score >= 0.62) return { value: candidates[0].f.value, provenance: [candidates[0].f.id || candidates[0].f.factKey], semantic: candidates[0].f.factKey };
  return null;
}

function findApprovedAnswer(context, label) {
  const answers = (context.answers || []).filter((a) => a.approved && a.answerText != null && String(a.answerText).trim());
  const ranked = answers.map((a) => ({ a, score: Math.max(overlapScore(label, a.questionText), overlapScore(label, a.questionKey || "")) })).sort((a,b)=>b.score-a.score);
  if (ranked[0]?.score >= 0.48) return ranked[0];
  return null;
}

function radioOptionText(control) {
  return norm(`${control.optionLabel || ""} ${control.optionValue || ""}`);
}

function radioOptionMatches(control, value) {
  if (control.controlType !== "radio") return true;
  const desired = norm(value);
  const option = radioOptionText(control);
  if (!desired || !option) return false;
  return desired === option || option.includes(desired) || desired.includes(option);
}

function readyResolution(control, base) {
  if (control.controlType === "radio" && !radioOptionMatches(control, base.proposed_value)) {
    return { ...base, status: "unsupported", proposed_value: undefined, notes: "Radio option does not match the approved value; another option in the group may match." };
  }
  if ((control.controlType === "select") && Array.isArray(control.options) && control.options.length) {
    const desired = norm(base.proposed_value);
    const exact = control.options.find((o) => norm(o.label) === desired || norm(o.value) === desired);
    const close = exact || control.options.find((o) => norm(o.label).includes(desired) || desired.includes(norm(o.label)));
    if (close) return { ...base, proposed_value: close.label || close.value };
  }
  return base;
}

function resolveField(control, context) {
  const label = control.label || control.name || control.fieldKey;
  const semantic = semanticForLabel(label, control);
  const sensitive = control.sensitive || isSensitive(label);
  const existing = control.hasValue || (control.currentValue != null && String(control.currentValue).trim() !== "");

  if (existing) {
    return { field_key: control.fieldKey, label, control_type: control.controlType === "button" ? "other" : control.controlType, required: Boolean(control.required), semantic_key: semantic, trust: sensitive ? "user_required" : "verified", status: "already_complete", provenance_ids: [], notes: sensitive ? "Existing user-entered sensitive value retained without inference." : "Field already contains a value." };
  }

  if (sensitive) {
    const approved = findApprovedAnswer(context, label);
    if (approved) {
      return readyResolution(control, { field_key: control.fieldKey, label, control_type: control.controlType, required: Boolean(control.required), semantic_key: approved.a.questionKey || semantic, trust: approved.a.trust, status: "ready", proposed_value: approved.a.answerText, provenance_ids: [approved.a.id || approved.a.questionKey || "approved-answer"], notes: approved.a.trust === "user_required" ? "Exact user-supplied and Gate 1-approved answer. It is inserted, not inferred." : "Exact previously approved answer." });
    }
    return { field_key: control.fieldKey, label, control_type: control.controlType, required: Boolean(control.required), semantic_key: semantic, trust: "user_required", status: control.required ? "needs_user" : "unsupported", provenance_ids: [], notes: "Sensitive or user-only field is never inferred." };
  }

  if (semantic) {
    const candidate = candidateValue(context, semantic);
    if (candidate) return readyResolution(control, { field_key: control.fieldKey, label, control_type: control.controlType, required: Boolean(control.required), semantic_key: semantic, trust: "verified", status: "ready", proposed_value: candidate.value, provenance_ids: candidate.provenance, notes: "Verified candidate detail." });
    if (semantic === "salary_expectation" && context.salary?.approved && context.salary.value != null) return readyResolution(control, { field_key: control.fieldKey, label, control_type: control.controlType, required: Boolean(control.required), semantic_key: semantic, trust: "proposed", status: "ready", proposed_value: context.salary.value, provenance_ids: ["approved-salary"], notes: "Salary value approved at Gate 1." });
    if (semantic === "cv_upload" && context.documents?.cv?.url) return readyResolution(control, { field_key: control.fieldKey, label, control_type: control.controlType, required: Boolean(control.required), semantic_key: semantic, trust: "verified", status: "ready", proposed_value: context.documents.cv.url, provenance_ids: [context.documents.cv.versionId || "approved-cv"], notes: "Exact Gate 1 CV version." });
    if (semantic === "cover_letter_upload" && context.documents?.coverLetter?.url) return readyResolution(control, { field_key: control.fieldKey, label, control_type: control.controlType, required: Boolean(control.required), semantic_key: semantic, trust: "verified", status: "ready", proposed_value: context.documents.coverLetter.url, provenance_ids: [context.documents.coverLetter.versionId || "approved-cover-letter"], notes: "Exact Gate 1 cover-letter version." });
    if (semantic === "cover_letter_text" && context.coverLetterContent) return readyResolution(control, { field_key: control.fieldKey, label, control_type: control.controlType, required: Boolean(control.required), semantic_key: semantic, trust: "proposed", status: "ready", proposed_value: context.coverLetterContent, provenance_ids: [context.documents?.coverLetter?.versionId || "approved-cover-letter"], notes: "Plain-text form of the exact Gate 1-approved cover letter." });
  }

  const fact = findFact(context, label, semantic);
  if (fact) return readyResolution(control, { field_key: control.fieldKey, label, control_type: control.controlType, required: Boolean(control.required), semantic_key: fact.semantic || semantic, trust: "verified", status: "ready", proposed_value: fact.value, provenance_ids: fact.provenance, notes: "Matched verified candidate fact." });

  const approved = findApprovedAnswer(context, label);
  if (approved) return readyResolution(control, { field_key: control.fieldKey, label, control_type: control.controlType, required: Boolean(control.required), semantic_key: approved.a.questionKey || null, trust: approved.a.trust, status: "ready", proposed_value: approved.a.answerText, provenance_ids: [approved.a.id || approved.a.questionKey || "approved-answer"], notes: approved.a.trust === "user_required" ? "Matched exact user-supplied Gate 1-approved answer." : "Matched an exact Gate 1 approved answer." });

  return { field_key: control.fieldKey, label, control_type: control.controlType === "button" ? "other" : control.controlType, required: Boolean(control.required), semantic_key: semantic, trust: control.required ? "user_required" : "proposed", status: control.required ? "needs_user" : "unsupported", provenance_ids: [], notes: control.required ? "No verified or previously approved value was found." : "Optional field has no approved source and will be skipped." };
}

function actionForField(field) {
  if (field.status !== "ready") return null;
  const type = field.control_type;
  if (type === "file") return { action: "upload", target_key: field.field_key, value: field.proposed_value, safe_without_new_user_approval: true };
  if (type === "select" || type === "combobox" || type === "radio" || type === "tags") return { action: "select", target_key: field.field_key, value: field.proposed_value, safe_without_new_user_approval: true };
  if (type === "checkbox") return { action: "toggle", target_key: field.field_key, value: Boolean(field.proposed_value), safe_without_new_user_approval: true };
  return { action: "fill", target_key: field.field_key, value: field.proposed_value, safe_without_new_user_approval: true };
}

export function planAdaptivePage(observation, context = {}) {
  const [purpose, confidence] = pagePurpose(observation);
  const buttons = observation.controls.filter((c) => c.controlType === "button" && c.visible !== false && !c.disabled);
  const rawFields = observation.controls.filter((c) => c.controlType !== "button" && c.visible !== false && !c.disabled);
  const fields = rawFields.map((c) => resolveField(c, context));
  const finalButton = buttons.find((b) => isDangerousSubmissionLabel(b.label));
  const startButton = buttons.find((b) => isStartApplicationLabel(b.label));
  const readyFields = fields.filter((f) => f.status === "ready");
  const unresolvedRequired = fields.filter((f) => f.status === "needs_user" && f.required);
  const continueButton = buttons.find((b) => isContinueLabel(b.label));

  // A visible final Submit button on a one-page ATS is not a reason to stop before
  // filling safe approved fields. Gate 2 starts only when no safe field remains and
  // no required field is waiting for the user.
  const submissionDetected = purpose === "confirmation" ? false : Boolean(finalButton)
    && readyFields.length === 0
    && unresolvedRequired.length === 0
    && (purpose === "review" || !continueButton);

  const immediatePauseReasons = [];
  if (observation.flags?.captcha) immediatePauseReasons.push("CAPTCHA detected. Complete it yourself in the browser.");
  if (observation.flags?.mfa) immediatePauseReasons.push("MFA/verification step detected. Complete it yourself in the browser.");
  if (purpose === "authentication") immediatePauseReasons.push("Authentication step detected. Sign in yourself in the browser.");

  const pauseReasons = [...immediatePauseReasons];
  const canMakeSafeProgress = immediatePauseReasons.length === 0 && readyFields.length > 0;
  if (!canMakeSafeProgress) {
    for (const f of unresolvedRequired) pauseReasons.push(`Required field needs you: ${f.label}`);
    if (submissionDetected) pauseReasons.push("Final submission control detected. Gate 2 review is required before submission.");
  }
  const mustPause = pauseReasons.length > 0;

  const actions = [];
  if (!mustPause) {
    const nextField = readyFields[0];
    const fieldAction = nextField && actionForField(nextField);
    if (fieldAction) actions.push(fieldAction);
    else if (continueButton) actions.push({ action: "navigate", target_key: continueButton.fieldKey, safe_without_new_user_approval: true });
    else if (startButton && rawFields.length === 0) actions.push({ action: "navigate", target_key: startButton.fieldKey, safe_without_new_user_approval: true });
    else actions.push({ action: "none", target_key: null, safe_without_new_user_approval: false });
  }

  return {
    page_purpose: purpose,
    page_confidence: confidence,
    fields,
    actions,
    must_pause: mustPause,
    pause_reasons: [...new Set(pauseReasons)],
    submission_detected: submissionDetected,
    next_observation_required: true,
  };
}

export function buildFinalReviewDiff(observation, plan) {
  const controlByKey = new Map(observation.controls.map((c) => [c.fieldKey, c]));
  const items = plan.fields.map((field) => {
    const control = controlByKey.get(field.field_key) || {};
    let status = "unresolved";
    if (field.status === "already_complete") status = field.trust === "user_required" ? "user_entered" : "already_present";
    else if (field.status === "ready") status = "approved_value_planned";
    else if (field.status === "unsupported" && !field.required) status = "skipped_optional";
    else if (field.status === "needs_user") status = "needs_user";
    return {
      field_key: field.field_key,
      label: field.label,
      semantic_key: field.semantic_key,
      trust: field.trust,
      required: field.required,
      status,
      expected_value: field.trust === "user_required" ? null : field.proposed_value ?? null,
      observed_value: control.sensitive ? null : (control.currentValue ?? null),
      observed_has_value: Boolean(control.hasValue || (control.currentValue != null && String(control.currentValue).trim())),
      notes: field.notes || null,
    };
  });
  const summary = {
    total: items.length,
    unresolved: items.filter((i) => i.status === "needs_user" || i.status === "unresolved").length,
    user_entered: items.filter((i) => i.status === "user_entered").length,
    approved_or_present: items.filter((i) => ["approved_value_planned","already_present"].includes(i.status)).length,
    skipped_optional: items.filter((i) => i.status === "skipped_optional").length,
  };
  return { summary, items };
}

export function validatePagePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object") return { ok: false, errors: ["Plan must be an object."] };
  for (const key of ["page_purpose","page_confidence","fields","actions","must_pause","pause_reasons","submission_detected"]) if (!(key in plan)) errors.push(`Missing ${key}`);
  if (Array.isArray(plan.actions)) {
    for (const action of plan.actions) {
      if (action.action === "navigate" && action.safe_without_new_user_approval !== true) errors.push("Navigation action is not approved as safe.");
      if (!["fill","select","toggle","upload","clear","navigate","none"].includes(action.action)) errors.push(`Unsupported action ${action.action}`);
    }
  }
  if (plan.submission_detected && Array.isArray(plan.actions) && plan.actions.some((a) => a.action === "navigate")) errors.push("Submission-detected plans may not navigate.");
  return { ok: errors.length === 0, errors };
}
