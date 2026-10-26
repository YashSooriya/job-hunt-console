# JobHuntAI product and implementation handover

Prepared: 2026-10-26

Purpose: give a continuing Codex agent a reference for the intended product, the user journey, implementation constraints, and evidence required for completion.

**This describes the intended behaviour. It is not a certification that every feature is implemented or working in production.** The repository contains substantial uncommitted work. Preserve it, inspect the current implementation, and verify live state before acting.

## 1. Product purpose

JobHuntAI is a private job-search and application workspace. It helps a user establish their professional background, find suitable vacancies, understand their fit, choose which jobs to pursue, and create strong application-specific CVs and cover letters. It also provides the wider application tracking, review, email monitoring, and interview preparation workflow.

The intended daily experience is:

1. See new suitable jobs and anything requiring attention.
2. Inspect a vacancy and the reasons for its fit assessment.
3. Choose whether to apply.
4. Explicitly request the documents needed, using the selected visual theme.
5. Review factual accuracy and application content, download documents, and access their Drive copies.
6. Track the application and prepare for subsequent assessments or interviews.

The app should reduce repetitive effort while keeping consequential decisions with the user. It should feel like a coherent workspace rather than a collection of disconnected ChatGPT prompts or an overloaded general job board.

## 2. Which requirements take precedence

Use the current user's instructions and root `AGENTS.md` first. Read `docs/HANDOFF_JOBHUNTAI_2026-10-22.md` for continuation state. The original continuation request supplied in this conversation contains the most specific requirements for the current onboarding → jobs → documents work; these are restated below so another agent does not need the attachment.

`docs/SPEC.md`, `docs/IMPLEMENTATION_CONTRACTS.md`, and the milestone documents explain the larger system and its existing contracts. Some passages describe earlier designs. Do not restore those designs where they conflict with the later requirements.

| Earlier design or assumption | Current requirement |
|---|---|
| Send the stored applicant profile/evidence to ChatGPT when analysing jobs or writing documents | Only onboarding may send professional background. Later ChatGPT workflows rely on ChatGPT Memory. |
| Automatically create CVs and letters for sufficiently high-scoring jobs | A user must choose to apply and then explicitly request generation. Neither high scores nor choosing to apply alone authorizes document generation. |
| Every generated claim is automatically verified because it has an evidence reference | Memory-based drafts must be labelled as requiring factual review. ChatGPT's `memory_support` text is not independently verified database evidence. |
| Require all search, Gmail, helper, and integration setup before completing the profile | Profile readiness and search/integration readiness are separate. The newer readiness migration removes search preferences as a profile-completion prerequisite. |
| A custom Job Hunt Console ChatGPT MCP/plugin is the normal route to ChatGPT | The user deleted that custom plugin. Current ChatGPT contact must use the existing generic Website Bridge dispatch flow. Do not reintroduce the plugin. |
| A passing build or health endpoint proves completion | Required user-facing flows need actual authenticated browser acceptance and redacted evidence. |

Older automatic-preparation, deterministic generation, and MCP code may remain for compatibility. Its existence is not permission to bypass these current requirements. Preserve useful infrastructure without presenting an obsolete workflow as the target product.

## 3. Main concepts and ownership

- **Candidate profile:** the user's editable, reviewed professional and personal information, source documents, structured history, and verification state.
- **ChatGPT Memory:** the candidate context that ChatGPT is expected to use after onboarding. The app cannot assume that checking a consent box proves Memory contains a complete or accurate profile.
- **Job:** a discovered or manually added vacancy, with a stable ID, saved listing snapshot, sources, metadata, and analyses.
- **Job analysis:** a versioned assessment of one exact vacancy. It has component scores, explanations, limitations, and provenance.
- **Application:** a persistent workflow associated with a job the user wants to pursue. It contains document requests and versions, screening answers, reviews, state, and timeline.
- **Document generation request:** the durable orchestration record for explicitly requested CV/letter generation, including its frozen inputs, selected theme, steps, Bridge requests, results, and recovery state.
- **Document version:** an immutable version of content and rendered files. A later edit creates another version.
- **Managed Google Sheet:** a synchronized mirror of authoritative application/job records, also read by ChatGPT to avoid duplicate or inappropriate search results.

Supabase/PostgreSQL is authoritative for app state. Google Sheets is a mirror. Google Drive stores accessible document copies; a temporary Drive failure must not destroy a valid generated document in the app.

Every user owns their profile, jobs, applications, documents, Bridge state, integrations, and automation configuration. Sign-in alone does not grant access to another user's data or to an invite-only workspace.

## 4. Sign-in and initial setup

The production web app is `https://job-hunt-console.yashwanth-sooriya.workers.dev/`.

The intended entry flow is:

1. Sign in with the invited Google account.
2. Verify active app membership before creating or accessing private applicant records.
3. Show the user's existing workspace, or guide a new user into profile setup.
4. Explain which integrations are connected and which actions need further setup.

Google identity, Gmail permission, Google Drive permission, the JobHuntAI Website Bridge, and the separate browser-control extension are different connections. The UI must identify the one actually needed. It must not repeatedly ask for Google consent when adequate authorization is already available.

Use narrow Google permissions: Gmail is read-only; Drive uses `drive.file` for app-managed resources. Missing Gmail or Drive access should produce an appropriate reconnect state at the feature that needs it. It should not be disguised as a broken login or silently broadened permission request.

## 5. Onboarding: establish a reviewed professional profile

### 5.1 Supply background material

The user can supply one or several CVs or other professional documents, a LinkedIn profile URL, and additional free-text information. The source upload interface currently accepts PDF, DOCX, TXT, Markdown, and RTF.

The app should:

- Save source documents privately under the authenticated user.
- Extract usable text with visible diagnostics for unreadable or unsupported content.
- Keep the original source and its locator/provenance.
- Let the user add, clear, or remove individual sources without resetting unrelated profile data.
- Save the source bundle before asking ChatGPT to build the profile.
- Ask for clarification when the sources are incomplete or contradictory rather than inventing details.

A LinkedIn URL does not authorize signing in, bypassing restrictions, or silently substituting another person's profile. If it cannot be read, explain what is missing and allow the existing document/text route.

### 5.2 Build the structured profile with ChatGPT

Onboarding is the permitted boundary for sending the user's professional background to ChatGPT. The current design uses a source-first professional-background workflow and the existing Website Bridge.

ChatGPT should help organize the supplied background and, where the user permits it, relevant previous ChatGPT knowledge into an editable profile. Imported material remains reviewable; extraction or model output does not make a claim verified automatically.

The profile includes, where relevant and supplied:

- Name, contact details, current location, and professional links.
- Employment history: employer, actual role, dates, location, responsibilities, contributions, and achievements.
- Education and qualifications, accurately distinguishing awarded, ongoing, incomplete, or other statuses.
- Skills, programming languages, software/tools, domain knowledge, and supported proficiency information.
- Projects, technical methods, personal contribution, outcomes, technologies, and links.
- Publications, presentations, and other relevant supporting material.
- Explicit work authorization, countries of eligibility, sponsorship needs, and any relevant visa facts.
- Reusable factual application answers such as notice period, availability, and user-supplied pay expectations.

Do not treat every available form field as mandatory. Do not infer citizenship, legal eligibility, clearance, sensitive disclosures, qualifications, dates, or metrics.

### 5.3 Review and correct

The user must be able to inspect and edit the imported profile through normal forms. Individual employment, education, skill, project, and publication records can be corrected, added, or removed.

Expected behaviour:

- Clearly distinguish missing details, imported proposals, and user-verified records.
- Preserve source provenance and factual conflicts until resolved.
- Show history in a sensible reverse-chronological order; handle undated items consistently.
- Persist edits across navigation and refresh.
- Ask focused follow-up questions for missing facts.
- Keep destructive profile reset separate, with explicit confirmation; never use reset as ordinary recovery.

### 5.4 Finish profile setup and establish Memory

The user confirms the intended ChatGPT Memory settings and explicitly finishes setup. The app sends the reviewed background through the onboarding workflow and records the outcome of that exact Bridge request.

Profile setup must not appear complete merely because a request was queued, consent was confirmed, or an unrelated assistant message was found. New non-test completion requires the durable onboarding activation lifecycle to complete. That lifecycle records ChatGPT's confirmation; it is not an independent guarantee that every fact was retained in ChatGPT's internal Memory.

Later edits should support a focused correction/sync path that sends only the reviewed changes from profile setup. Keep this action within the onboarding/profile-maintenance boundary; do not resend the whole background from job or document features.

**Testing Mode is deliberately different:** a test request must say not to change Memory and must not mark real Memory activation complete. Browser testing must leave that safeguard enabled. Do not turn it off just to manufacture a passing onboarding test.

Search preferences have their own setup action. The current readiness design permits profile completion once required profile details are verified and imported claims are reviewed, without requiring search preferences to be complete first. If old UI text still claims otherwise, reconcile it with the newer readiness contract.

### Onboarding acceptance

A user can build a profile from their sources, correct it, save and revisit it, resolve required questions, and see honest activation status. A failed or interrupted Bridge step can resume without duplicate sends. Testing Mode does not mutate Memory or falsely complete real onboarding.

## 6. Search preferences: define what to look for

Keep these under Jobs → Search settings, reachable from onboarding. They are explicit user settings and are allowed in search prompts. They are not permission to transmit the stored professional profile.

Support the three current search modes:

1. **Keywords only:** use the user's selected role terms/families without silently broadening the search through Memory.
2. **Memory-fit:** infer suitable role titles, families, seniority, and relevant industries from ChatGPT Memory, preserving all explicit hard constraints.
3. **Keywords plus Memory-fit:** start from the selected role terms and use Memory to consider related suitable roles.

Persist the relevant settings:

- Target roles/keywords, role families, and seniority when applicable to the selected mode.
- Preferred and excluded industries.
- Locations, work modes, and commute preferences where supported.
- Salary minimum, target, currency, and sponsorship requirement.
- Maximum posting age and minimum fit threshold.
- Existing preparation/automation settings, without allowing them to bypass explicit document-generation consent.
- Enabled search sources.
- Manual/daily/weekday/weekly cadence, schedule enabled/paused, local time, and timezone.
- Other user preferences.

Changing mode must not erase values temporarily hidden by that mode. Saving preferences must preserve hard constraints exactly. The UI should distinguish “settings saved” from “ChatGPT setup confirmation completed.”

## 7. Job discovery and manual search

The app should find suitable current public vacancies using the enabled sources and saved preferences. ChatGPT uses Memory for candidate context, investigates the exact listing, and returns structured results through the Website Bridge.

### 7.1 One-off search

The user presses Search now. The app creates a bounded, durable search run and shows progress. A normal manual search is limited to once per hour, with a server-enforced next-allowed time and visible countdown. Diagnostics has an explicit override for testing.

That search cooldown does **not** apply to generic Bridge messaging, URL imports, fit requests, or document-generation steps. Consecutive Bridge requests must work without an arbitrary app-imposed waiting period.

The current manual-search prompt requests at most ten distinct returned vacancies. Reuse the existing bound rather than introducing unbounded crawling.

### 7.2 Recurring search

The app owns the saved cadence and should expose whether scheduling is enabled, the next run, and the latest outcome. Current search prompts explicitly say they do not create or modify a ChatGPT Task.

Older milestone documents describe a user-created ChatGPT Task calling MCP tools. Do not present that as the current scheduler or recreate the deleted custom plugin. Inspect `supabase/functions/job-pool-scheduler`, the current search configuration, and deployment settings to establish what actually triggers the saved cadence. A saved schedule or a ChatGPT acknowledgement alone does not prove unattended runs occur.

Runs should record checked, deduplicated, and accepted counts, partial failures, last success, and an actionable error. Avoid overlapping duplicate active runs.

### 7.3 Consult the existing pool before searching

Before a sheet-backed search, synchronize and verify the managed mirror against the database. ChatGPT must read the active Job Pool rows and its manifest through its connected Google Drive access.

Use the existing exact publication/revision/hash/readback contract. ChatGPT returns the manifest's access-check token and exact rows-read proof. The token must be read from the Sheet, not supplied in the prompt so it can merely be echoed.

If the Sheet is stale, inaccessible, modified externally, or only partly read, fail safely. Do not import results under a fabricated proof or silently treat the Sheet as authoritative. Keep unrelated spreadsheet tabs and files untouched.

### Search acceptance

Preferences survive refresh, each search respects them, previously known/applied/closed jobs are avoided, current Sheet proof is checked, results appear in the pool, the hourly cooldown works, its Diagnostics override works, and scheduled execution is verified separately from saving schedule settings.

## 8. Add jobs by URL or pasted listing

### 8.1 URL batch import

The user can submit one or multiple exact job URLs. The current URL-inspection contract supports one to ten entries, subject to the complete instruction fitting within the Bridge message limit.

**One submitted URL batch produces one dispatch whose same assistant response contains both listing extraction and initial fit components.** Do not insert the jobs and then issue a second initial-analysis message. If the submitted batch is too large for one message, reject it before sending with a clear instruction to reduce it.

Allocate stable per-entry request IDs and a batch ID before dispatch. Every returned result must match the exact requested ID and URL. Do not associate facts, salary research, or scores with a sibling vacancy by array position or title similarity.

For each verified vacancy, capture where available:

- Employer, role title, industry, employer reference/job ID.
- Exact source URL and application URL.
- Location, work mode, and employment type.
- Full useful job-description snapshot, summary, responsibilities, essential/desirable requirements, skills, benefits, and application instructions.
- Salary text, numeric range, currency, source, confidence, period, and supporting research.
- Posting date, closing date, and provenance for date interpretation.
- ATS/provider, company website, and discovery timestamp where supported.
- The initial Memory-fit components, explanations, strengths, limitations, and eligibility caution.

Check advertised salary first. If none is given, research comparable pay and return a defensible estimate where possible, explicitly labelled “Estimated” and “not employer-advertised,” with the basis and source URLs. If research cannot support a range, keep salary unknown and record why.

Investigate the posting date on the exact advert or a verified same-vacancy employer/ATS mirror. Normalize relative dates using the recorded assessment timestamp. Never substitute a closing, update, or retrieval date as the posting date. Prefer null plus a reason over an invented date. Any permitted estimate must be unmistakably labelled rather than displayed as a confirmed date.

Unavailable pages, non-listings, insufficient Memory, or incomplete fit must yield explicit per-entry outcomes. Preserve valid siblings. Under the current combined import contract, an entry lacking the required complete fit is not a successful `found` import; do not invent an aggregate to make it pass. Review the existing validators before changing that policy.

### 8.2 Pasted/manual listing

Provide the existing manual-entry route for a vacancy whose useful text the user can supply. Preserve its saved text and provenance. An internal `manual-listing.invalid` reference identifies stored input; it is never a real URL to browse or publish as a vacancy source.

### 8.3 Deduplication and persistence

Detect duplicates using canonical URLs, employer reference IDs, employer/title identity, and available listing similarity. Keep repost relationships where relevant. Repeating a request, refreshing, or recovering a response upload must not duplicate jobs or analyses.

Retain the original snapshot when the external advert later disappears. A different job at a similar URL is not a valid substitute for the requested vacancy.

## 9. Fit analysis and prioritization

After onboarding, analysis prompts contain only permitted vacancy input and request correlation metadata. Do not serialize the stored professional profile, evidence records, CV, contact details, candidate-profile ID, or a profile-derived hash into them.

For existing public jobs, pending/selected analysis uses exact job IDs and listing URLs. For saved manual listings without a public URL, include the bounded listing text. Use the existing packer: up to 100 selected jobs per operation, no more than five per analysis message, and a 5,800-character analysis budget below the Bridge hard limit. The Testing Mode prefix counts toward the final size.

The current component rubric is:

| Component | Weight | What it assesses |
|---|---:|---|
| Technical capability | 30% | Explicit tools, skills, and methods |
| Strength of evidence | 20% | Remembered contributions and outcomes, beyond skill names |
| Seniority | 15% | Scope, level, leadership, and responsibilities |
| Domain | 15% | Sector, product, and customer relevance |
| Role type | 10% | Fit to the function and actual work |
| Qualifications | 10% | Stated formal requirements |

Assessed components use 0, 25, 50, 75, or 100 under the existing rubric. Each component also has an explanation and one of `assessed`, `not_applicable`, `insufficient_memory`, or `listing_data_missing`.

- Missing Memory is unknown/null, never automatically zero.
- Technical, evidence, and role-type components are required.
- Only permitted genuinely inapplicable dimensions may be excluded under the existing aggregation contract.
- The app computes the weighted overall score locally; ChatGPT does not supply authoritative arithmetic.
- Do not display a complete aggregate for partial Memory, missing listing data, or incomplete components.
- Keep fit, confidence/completeness, and eligibility cautions distinct.
- ChatGPT may identify a specific possible eligibility conflict; it must not decide legal work authorization from guesswork.

The older specification also defines a separate **Priority Score**: fit 35%, estimated screening probability 20%, compensation 15%, geography 10%, freshness 10%, effort 5%, closing urgency 5%. Preserve a clear distinction wherever priority is exposed. It is not a second label for fit, and uncertain inputs must remain visible.

Older defaults include `auto_prepare`, `recommend`, `maybe`, and `reject` triage labels. Treat these as advice and compatibility state, never automatic authorization to write documents. A low fit classification alone should not prevent the user choosing to apply. Never fabricate missing personal facts to satisfy eligibility or generation gates.

## 10. The Job Pool: the user's working shortlist

Imported and discovered jobs must become visibly usable records, not disappear into an integration log. The pool should support:

- Search and appropriate filtering by source, industry, work mode, triage, and user status.
- Sorting by fit, salary, posting date, closing date, date added, company, role, industry, and location where available.
- Explicit labels for salary estimates, unknown dates, pending/partial fit, and analysis failures.
- Company/title, source link, location, salary, posting age/date, fit, and user's status in useful row/detail views.
- A detail page with the saved advert, structured fields, analysis, strengths/gaps, provenance, and actions.
- Editing a selected vacancy and analysing pending or selected entries.
- “Choose to apply,” opening the associated application when one exists.
- Removing only selected entries from the active pool and restoring them through the existing archive/restore behaviour.

Sorting must handle unknown values consistently and compare salary periods/currencies honestly. Selected records, navigation state, and persisted status must not become associated with a different row after sorting or filtering.

“Remove from pool” must not wipe the user's pool, profile, or unrelated applications. Preserve the existing archive/restore semantics and stable job IDs. The Sheet mirror must reflect changes according to its managed publication contract.

## 11. Choose to apply: an explicit user decision

Job discovery and application preparation are separate. The user chooses a job and presses **Choose to apply**. This creates or reuses the owned Application and records the decision idempotently.

Choosing to apply should take the user to a clear application workspace with the vacancy context and document options. It must not automatically send document-writing prompts, generate files, write Drive copies, start an employer form, or submit anything.

Existing automatically prepared application records may need the current explicit promotion-to-manual-choice path. Do not confuse an old application row with proof that the user has now consented to generation. Enforce the gate server-side as well as in the UI.

## 12. CV content families and visual themes

These are different choices:

- **CV family** determines which kind of evidence and professional positioning is relevant.
- **Theme** determines how the selected content is presented visually.

The existing families are `simulation_cae`, `scientific_software`, `quantitative_data`, and `motorsport`. Select/recommend the appropriate enabled family using the vacancy and supported background. Motorsport is reserved for explicitly motorsport/F1/racing vacancies; its use must not imply sector experience absent from Memory.

The user must be able to choose among the existing eight paired CV/cover-letter themes:

| Theme | ID | Intended appearance |
|---|---|---|
| Classic Navy | `classic-navy` | Familiar engineering layout with restrained navy headings and thin section rules |
| Clean Charcoal | `clean-charcoal` | Simple charcoal hierarchy with no section rules |
| Technical Slate | `technical-slate` | Compact technical content and clear role hierarchy |
| Research Classic | `research-classic` | Traditional serif presentation for research, modelling, and R&D |
| Modern Teal | `modern-teal` | Muted teal accents, subtle separators, and open spacing |
| Engineering Blue | `engineering-blue` | Structured role/project emphasis and consistent dates |
| Quiet Olive | `quiet-olive` | Understated olive accents with generous spacing |
| Minimal Black | `minimal-black` | Plain black, conventional headings, minimal decoration |

Provide a gallery with recognisable sample CV and cover-letter previews, a larger preview action, visible selection, and “Set as default.” Use fictional sample content. Persist the default for future requests and allow the application request to select a theme. Record the selected theme on the request/version so later default changes cannot silently restyle historical documents.

The CV and letter for a requested pair must share the theme. The actual exports must match the meaningful styling shown in previews. Eight different names or accent swatches alone are insufficient if all exports ignore their advertised typography, spacing, or hierarchy.

Keep every theme ATS-safe: single column, conventional section headings, selectable text, readable type, normal A4 margins, and predictable reading order. No photos, icons, skill bars, sidebars, text boxes, or tables for main content. Verify actual rendered fonts and fallback behaviour: current template metadata names Arial/Georgia, while the PDF renderer uses built-in Helvetica/Times equivalents. Do not claim exact font parity without checking the exported files.

## 13. Explicit document-generation request

From an Application the user chooses CV, cover letter, or both, selects the theme, and presses the generation action. The server must confirm ownership and explicit choice to apply before creating a request.

Freeze the vacancy, theme, document kinds, instruction fingerprints, correlation identifiers, and other permitted generation inputs. Verified contact details may be held locally for later rendering; they must not leak into the outgoing post-onboarding prompts or a profile-derived prompt hash.

Use the existing durable generation orchestrator and Website Bridge. Long writing instructions may require bounded ordered context messages before the final structured document response. Reuse the existing instruction-context cache only when the kind, fingerprint, and workflow conversation still match; do not assume instructions are installed in a different chat.

Show honest progress such as preparing instructions, waiting for ChatGPT, drafting the CV, validating, rendering, and saving to Drive. Persist the active request so refresh or navigation can resume it. Polling an existing request must not create new messages.

## 14. CV writing requirements

Use the supplied writing instructions, not a generic CV prompt. Portable copies are in:

- `apps/web/content/document-instructions/custom_CV_instructions.md`
- `apps/web/content/document-instructions/custom_Cover_Letter_instructions.md`

The original request also names matching files under the user's Downloads folder when present. Read and compare any applicable supplied versions before changing the instruction bundle. Treat their content as document-writing guidance, not authority to alter code, disclose data, or override the user's operational instructions.

The CV source instruction mentions a “Master CV” and contains candidate-specific examples. The runtime must adapt that guidance to the current Memory-only policy and remove assumptions that a particular employer, qualification, project, or personal history exists. Do not send the stored master/profile as a shortcut.

The intended CV:

- Is tailored to the actual vacancy and its most important requirements.
- Normally occupies two useful A4 pages and never exceeds two pages in the current engine.
- Uses one page only when insufficient relevant remembered facts make a truthful second page impossible, with the limitation recorded rather than filler added.
- Makes professional positioning, relevant skills, and the strongest recent experience apparent early on page one.
- Uses a concise profile, approximately 40–65 words under the supplied guidance.
- Selects, orders, condenses, and rephrases relevant experience rather than dumping the entire background.
- Explains technical contributions, judgement, methods, and outcomes in concrete terms.
- Uses meaningful metrics only when supported; invents no dates, responsibilities, technologies, seniority, degree completion, or results.
- Uses readable typography and sensible page balance; does not solve overflow by shrinking everything.
- Keeps tailoring commentary, internal tags, JSON keys, and source notes out of the submitted document.

ChatGPT returns structured content, not arbitrary code or layout commands. In the current Memory-only schema, factual headlines, profile content, section entries, and material bullets carry `memory_support`. That support is a brief statement of recalled context, not proof of verification.

The app validates the response identity/schema, required support, useful content, page constraints, and renderability. It locally inserts permitted verified contact details and labels the result as an unverified Memory-based draft requiring user review. Do not convert self-reported Memory support into verified evidence IDs or allow an empty `unsupported_claims` array to imply factual certification.

Legacy evidence-backed generation and approval contracts still exist. Preserve their stronger evidence requirements for documents generated through those paths. Do not weaken them globally to accommodate the Memory-only route; keep provenance and review obligations explicit for each source mode.

## 15. Cover-letter writing requirements

A letter should make a specific, credible case for this candidate doing this role. It should add useful interpretation beyond repeating the CV or flattering the employer.

The older product policy rates usefulness `high`, `medium`, `low`, or `not_accepted`. Present advice where useful, but respect the current explicit generation choice: do not mechanically create a letter for every job or generate one without a request.

For an ordinary UK industry role, target:

- One A4 page.
- Three to five substantive paragraphs.
- Normally about 300–450 body words, prioritizing relevance and readability.
- An appropriate named or generic salutation, conventional business-letter structure, and consistent closing.
- The selected CV theme and compatible typography.

The current response validator accepts a 200–500-word safety range; that is a validation boundary, not a reason to aim for an unnecessarily long or weak letter. Employer-specific academic/supporting-statement requirements may differ, but the current one-page letter engine must not silently violate its own constraints. Treat materially different output types as an explicit product decision.

Use the strongest supported evidence for the top hiring requirements, credible interest in the actual work, and reliable vacancy/company-specific information. Research public employer details where appropriate. Preserve the Memory-only boundary for candidate facts.

Apply the supplied anti-generic-writing checks: remove unsupported praise, corporate filler, repeated enthusiasm, artificial rhetorical patterns, copied advert wording, and redundant CV repetition. Check employer/title accuracy and whether the letter would still work unchanged for a competitor.

Return validated structured letter parts with Memory support for material paragraphs. Assemble plaintext locally from the salutation, paragraphs, closing, and verified candidate name; do not require a second inconsistent plaintext response from ChatGPT.

The user must have both **Download PDF** and **Copy text**. Copied text must match the actual reviewed version and contain normal paragraphs rather than JSON, citation tokens, or renderer artefacts.

## 16. Rendering, versions, downloads, and Drive

The current document renderer generates PDF and DOCX locally from validated structured content using `pdf-lib` and `docx`. Older specifications describe a LaTeX pipeline. Do not replace a working current renderer merely to recreate that older implementation detail; truthful content, readable output, the selected theme, and valid downloads are the acceptance targets.

For every successful version retain the relevant structured content, provenance/source mode, theme, generation/request identifiers, instruction versions, quality report, timestamps, and file references. Store files privately. Downloads must enforce current-user ownership.

At minimum each CV is downloadable as PDF; each letter is downloadable as PDF and copyable as plaintext. Preserve the current DOCX capability where present. Validate file type and nonempty useful content, selectable PDF text, page count, clipping, overflow, orphan headings, and whether the visual output matches the chosen theme.

Save generated files in the appropriate application folder in the user's Google Drive. The existing design associates folders with stable application IDs and associates each PDF/DOCX with user, application, document item, and format metadata. Use those identities and stored file IDs to recover from a failed save without creating duplicate folders/files.

- Retrying a save of the same version reuses the same artifact identity.
- A deliberate new generation creates a new document version and appropriately versioned files.
- A reconnect or Drive save failure leaves the valid app copy downloadable.
- Drive status must distinguish not configured, needs reconnect, retrying, failure, and ready.
- A “Save to Drive” retry must not regenerate the document or resend its ChatGPT prompt.

Do not overwrite submitted versions. Later revisions and theme changes create new versions. The exact document selected for application review/submission must remain identifiable.

## 17. Review and the wider application workflow

The broader application workspace includes overview/strategy, fit, CV, cover letter, questions, form, and timeline. Preserve this model while completing the requested onboarding/jobs/documents journey.

Screening answers use three trust classes:

| Class | Meaning | Required behaviour |
|---|---|---|
| Green / `verified` | Explicitly verified factual answer | May be prepared from its valid factual source |
| Amber / `proposed` | Generated judgement, motivation, or salary recommendation | Requires user review |
| Red / `user_required` | Unknown, sensitive, or user-only information | Remains unanswered until the user supplies it |

Keep sensitive voluntary disclosures application-scoped unless explicitly authorized otherwise. Advertised pay and estimated salary recommendations must remain visibly different.

**Gate 1: content approval.** Pin the exact CV/letter versions and letter decision, review proposed answers and salary, resolve required Red answers, and enforce the checks in the database. New document content invalidates stale approval as appropriate. Memory-based factual claims require actual user review; do not inherit “verified” status from a legacy evidence-only assumption.

**Gate 2: employer-form approval.** The existing browser-helper design fills only from approved content, observes the live page, pauses for uncertainty/login/CAPTCHA/sensitive questions, and requires explicit review of the exact final form/session before any submission. Page/control changes require re-review. Ordinary generation and review never authorize submission.

The current Codex implementation/testing authorization specifically excludes submitting job applications, contacting employers, or sending external communications. Test form behaviour only in a no-submit context. Do not cross a real submission boundary to prove a feature.

On an authorized submission record, retain an immutable snapshot of the exact submitted documents, answers, salary context, vacancy, analysis, and strategy. The user's manual “I submitted it myself” path must also record the correct package rather than use a later edited CV.

## 18. Dashboard, tracking, Gmail, assessments, and interviews

These are established wider-product requirements, rather than permission to expand the current completion task into unrelated new systems.

The dashboard should prioritize:

- **Needs You:** content review, required answers, failed integrations, ambiguous emails, approaching deadlines.
- **New strong matches:** recent suitable vacancies not yet actioned.
- **Preparing:** active application/document work with accurate progress.
- **Upcoming:** assessments, interviews, deadlines, and follow-ups.
- Compact pipeline counts.

Applications retain workflow stage, timeline, outcomes, and audit events. Historical tracker imports preserve source row values/number and normalization provenance. PostgreSQL remains authoritative after import; the managed Applications Sheet tab mirrors it.

Gmail monitoring is read-only. It identifies confirmations, rejections, assessment/interview invitations, offers, and recruiter messages, and matches them to the user's applications. Ordinary high-confidence safe transitions may occur only when both event classification and application match are sufficiently confident. Ambiguous/unmatched messages become actionable review items. Offers and recruiter correspondence remain human decision points. Reprocessing a Gmail message is idempotent.

Keep assessment/interview records tied to the application and its exact submitted package where available. Distinguish `exact_submitted`, `approved_pre_submission`, and `best_available` context rather than pretending historical artifacts exist.

Assessment preparation is practice-only: deadlines/rules, readiness, synthetic practice, and a preparation plan. It must not answer or submit a live assessment. Interview preparation includes submitted-content recap, role/evidence mapping, gaps, likely questions, employer questions, salary consistency, and mock practice.

Contextual ChatGPT actions should inherit the relevant job/application/document instead of asking the user to re-explain it. Any future action must still obey the post-onboarding Memory-only candidate-context boundary and the generic Website Bridge requirement.

## 19. Website Bridge requirements

The JobHuntAI Website Bridge is the shared transport for current ChatGPT workflows. It is separate from the ChatGPT/Codex Chrome extension used by an agent to inspect the browser, and from the employer-form browser helper.

Non-negotiable behaviour:

1. Send and capture in an inactive ChatGPT helper tab; the app stays selected. Sending must never activate or switch the user to ChatGPT.
2. Support consecutive requests without an arbitrary cooldown.
3. Bind every result to the exact dispatched user message and assistant turn using the existing correlation/provenance contract.
4. Never accept stale, sibling, or unrelated assistant content as a result.
5. Validate schema and identity before committing product state.
6. Persist a captured response so upload/validation/render/save recovery does not resend the original message.
7. Keep pairing unless a confirmed terminal authentication, revocation, or membership error requires clearing credentials.
8. Handle interruption, refresh, timeouts, and partial completion through durable lifecycle state.
9. Use the same generic dispatch path for diagnostics and ordinary workflows.

Preserve migration `0101_chatgpt_bridge_v3_security_boundary`, the v3 result-completion/provenance contract, `SECURITY INVOKER` wrappers, narrowly scoped service permissions, and documented older-extension compatibility. Do not reverse migrations or deploy an older incompatible Edge Function as a shortcut.

The last recorded extension build is 0.2.18. Historical version/test/deployment observations are not evidence of current live state; inspect what is actually installed before changing it.

## 20. Failure handling and interface quality

Each significant operation needs a durable identity and honest status. Use existing states such as pending/queued, running, completed, retrying, needs user, failed, cancelled, and partial rather than inventing another general workflow engine.

Keep separate recovery actions for separate failures:

- Message not sent: safely resume the existing request according to its send boundary.
- Response captured but upload failed: upload the captured result again.
- Captured response rejected: retain it and offer the existing safe revalidation/recovery path where appropriate; do not silently regenerate.
- Structured document valid but rendering failed: preserve content and retry rendering.
- Document rendered but Drive save failed: preserve downloads and retry only the Drive step.
- One URL/document sibling succeeded: retain it while reporting the failing sibling.

Never show “ready” when only an instruction was dispatched. Do not leave a dead button or blank screen while ChatGPT is actually working. Prevent double-click duplication, explain why controls are disabled, and release stale operation locks through existing recovery rules.

Keep technical details such as hashes, chunk numbers, raw JSON, and credentials in diagnostics unless they help the user resolve a specific failure. Main screens should use clear labels, readable layouts, and direct next actions. Preserve refresh/navigation state and make errors recoverable without re-entering everything.

## 21. Implementation map for the next agent

Use the existing modules before introducing replacements:

| Area | Existing starting points |
|---|---|
| Project/operating requirements | `AGENTS.md`, `docs/HANDOFF_JOBHUNTAI_2026-10-22.md`, `docs/SPEC.md`, `docs/IMPLEMENTATION_CONTRACTS.md` |
| Onboarding UI and APIs | `apps/web/components/onboarding-workspace.tsx`, `apps/web/app/api/onboarding/` |
| Background/Memory orchestration | `apps/web/lib/chatgpt/professional-background-dispatch.ts`, `profile-snapshot.ts`, `verified-professional-background.ts` |
| Profile readiness/current activation rules | `database/migrations/20261004104333_onboarding_profile_completion_without_search_preference_gate.sql`, `20261004122553_require_real_memory_for_onboarding_completion.sql` |
| Search settings and execution | `components/job-search-preferences.tsx`, `manual-search-button.tsx`, `search-automation-panel.tsx`, `app/api/search/`, `lib/search/`, `supabase/functions/job-pool-scheduler/` under `apps/web/` where applicable |
| URL extraction plus initial fit | `apps/web/lib/job-url-inspection-prompt.ts`, `apps/web/app/api/jobs/inspect/`, `apps/web/app/api/jobs/ingest/` |
| Existing-job Memory-fit | `apps/web/lib/job-fit-memory-v4/`, `apps/web/app/api/jobs/analysis/memory/` |
| Pool and manual input | `apps/web/components/job-pool-table.tsx`, `job-ingest-form.tsx`, `job-url-inspection-form.tsx`, `apps/web/app/jobs/` |
| Database/Sheet publication | `apps/web/lib/job-pool-sheet-contract.ts`, related Sheets services, `job-pool-sheet-settings.tsx` |
| Choice to apply | `apps/web/components/application-create-button.tsx`, `apps/web/app/api/applications/[id]/choose-to-apply/` and current creation route |
| Themes and previews | `apps/web/lib/document/templates.ts`, `apps/web/components/document-template-gallery.tsx` |
| Generation and recovery | `apps/web/components/application-document-generator.tsx`, `apps/web/app/api/document-generations/`, `apps/web/lib/document/generation-context.ts`, `service.ts` |
| Writing instruction sources | `apps/web/content/document-instructions/`; generated instruction bundle/script and fingerprints must stay consistent |
| Rendering and storage | `apps/web/lib/document/render.ts`, `apps/web/app/api/application-documents/`, `apps/web/app/api/documents/` |
| Drive exports | `apps/web/lib/document/google-drive.ts`, `google-drive-contract.ts`, `apps/web/components/document-drive-action.tsx` |
| Bridge | `apps/chatgpt-bridge-extension/`, `apps/web/lib/chatgpt-bridge/`, `apps/web/app/api/chatgpt-bridge/`, `supabase/functions/chatgpt-bridge/` |
| Operational acceptance | `docs/CHATGPT_BRIDGE_ACCEPTANCE.md`, `docs/TWO_USER_ACCEPTANCE_RUNBOOK.md`, `docs/ATS_ACCEPTANCE.md`, `docs/PRODUCTION_RUNBOOK.md`, `docs/evidence/` |

This map identifies starting points, not an instruction to edit every area. Read the relevant implementation and migrations before deciding a change is needed. Schema/RLS and server validation must enforce the same constraints as the visible UI.

## 22. Required verification and evidence

Before editing, inspect Git status and relevant diffs, preserve the user's extensive uncommitted baseline, and read applicable instructions. Do not reset/clean/replace the checkout. If Bridge files need changes, first preserve a recoverable copy of the exact files. Implement the smallest coherent fixes to the existing design.

Use relevant existing checks, including:

```sh
npm run verify
npm run chatgpt-bridge:verify
npm run supabase:security:verify
npm run onboarding:verify
npm run onboarding:memory:verify
npm run job-url:verify
npm run job-fit:verify
npm run search:verify
npm run job-pool-sheet:verify
npm run testing-mode:verify
npm run documents:verify
npm run cv:verify
npm run content:verify
npm run applications:verify
npm run preparation:verify
npm run review:verify
npm run typecheck
npm run build
```

Select further checks for the areas actually changed. These scripts include historical assumptions; a green source-text assertion is not a substitute for the current product requirements. Reconcile obsolete assertions deliberately rather than restoring wrong behaviour just to pass them.

For authenticated browser acceptance, use the user's existing account and test pool. Before using Chrome, inspect all windows for an existing JobHuntAI page and use its window. Do not take over another in-use window. If none exists, navigate to the actual app. Use the current authenticated session; do not send Google feedback or initiate unrelated sign-ins.

Before **each live test dispatch**, visibly confirm Testing Mode is enabled in Diagnostics. Every dispatched test message must begin with the clear test/no-Memory-change warning. Do not overwrite the profile with synthetic background. Use only safe disposable records for removal tests. Avoid importing a known test URL again without checking for duplicates.

| Acceptance scenario | Evidence required |
|---|---|
| Onboarding source/review | Sources saved, editable records accurate, corrections survive refresh, required questions clear |
| Real vs test activation | Tests cannot mark real Memory activation complete; real setup status derives from the exact durable lifecycle |
| Preferences | All three search modes preserve explicit constraints and hidden saved values |
| URL batch | One dispatch contains extraction plus initial fit; exact IDs/URLs match; valid siblings survive a bad entry |
| Immediate next action | Batch import followed by another request works without an unrelated cooldown |
| Fit | Correct deterministic weighting; unknown Memory is null; incomplete results have no complete score |
| Pool | Results visible, details usable, sorts/filters correct, status persists, targeted removal/restore affects only selected records |
| Search | Correct pool proof, bounded results, dedupe, hourly cooldown, Diagnostics override, honest saved/active schedule status |
| Explicit generation gate | Choosing to apply alone creates no document dispatch/file; explicit CV/letter request does |
| Themes | All eight are selectable, large paired previews readable, default persists, exports use the selected theme |
| Documents | Correct application context, useful tailored content, factual-review label, readable PDF pages, valid downloads, matching letter copy text |
| Recovery | Captured-response retry makes no new ChatGPT send; successful sibling/artifact remains available |
| Drive | Correct application folder, both requested documents saved, same-version retry creates no duplicate folder/file |
| Bridge | Two immediate harmless consecutive messages return their exact responses; app remains active, ChatGPT tab inactive, pairing retained |
| Isolation/review | Another user's records inaccessible; approval gates and immutable submitted versions cannot be bypassed |

Navigate away and refresh at meaningful points. Exercise import before changing preferences, multiple URLs, partial failure, consecutive dispatches, missing Memory, unavailable listings, upload recovery, Google reconnect, and document save retry. Record concise, redacted outcomes rather than raw applicant data or authentication material.

Computer Use/Chrome testing is authorized and expected. If the session lacks the actual tool, continue independent code work and report that concrete limitation. Do not reframe it as missing user permission, require a new test account, or claim live UI acceptance passed.

## 23. Known continuation items and decisions to resolve

The 2026-10-22 operational handoff records these unfinished live checks: recover a captured cover-letter result without another send, reconnect Google and save CV/letter copies without duplication, prove two consecutive background Bridge messages, and finish the outstanding job workflows. Inspect the current records before retrying; stored IDs/states in that note are historical.

Subsequent conversation records Windows extension installation/pairing and one successful harmless diagnostic. That single success does not prove the two-consecutive-message acceptance, all document/Drive recovery, or every job flow. It also reported a mismatch between the extension's “Automatic Send is on” state and the settings page's “enabling” label. Recheck before assuming it remains or is resolved.

The next agent must resolve these issues from current evidence, without inventing extra product scope:

1. **Memory-only versus legacy verified-document approval:** preserve truthful provenance and actual user factual review; do not silently call Memory output verified.
2. **Explicit generation versus legacy automatic preparation:** prove every public/current path respects both user decisions, including existing automatically prepared applications.
3. **Recurring schedule execution:** establish the actual deployed scheduler, trigger, and last successful run; do not infer unattended operation from preferences or a setup response.
4. **Preview/export fidelity:** verify that all eight themes are meaningful and that fonts, layout, spacing, and page balance match the promise of the gallery.
5. **Long instruction/response recovery:** prove chunk/context reuse and captured-result retries do not lose the exact-turn association or send duplicates.
6. **Google integration readiness:** prove existing authorization is detected, reconnect failures are actionable, and file/folder retries are idempotent.

Do not overcomplicate the solution with a replacement queue, new AI provider, custom ChatGPT plugin, generic theme builder, or new database architecture unless a demonstrated requirement cannot be met by the existing design.

Deployment and destructive production changes require explicit approval under `AGENTS.md`. Prepare and verify changes first. Do not commit, push, deploy, reapply migrations, or clear production data merely to make the checkout look complete.

## 24. Completion standard and continuation prompt

Completion means the authorized user can move from profile setup through preferences, finding/importing jobs, reviewing fit, choosing to apply, selecting a theme, explicitly generating documents, reviewing them, downloading them, copying the letter, and accessing reliable Drive copies. Their data survives navigation and failures; prompts respect the Memory boundary; the Bridge remains in the background; retries do not duplicate messages or artifacts. Wider enabled tracking/review features retain their ownership and approval guarantees.

Report separately what was changed, what automated checks passed, which user flows were actually exercised, what evidence was recorded, and what remains unverified. Do not claim full implementation from unit tests, static checks, a health response, or one successful diagnostic.

Suggested prompt for a continuing Codex agent:

> Continue JobHuntAI using `AGENTS.md`, `docs/PRODUCT_HANDOVER_JOBHUNTAI.md`, and `docs/HANDOFF_JOBHUNTAI_2026-10-22.md`. Preserve the existing uncommitted work. Compare the current implementation against the intended user journey and verify mutable live state before acting. Enforce onboarding-only transmission of candidate background, later Memory-only ChatGPT workflows, combined URL extraction/initial fit, explicit choose-to-apply plus explicit document generation, the eight paired themes, reliable downloads/letter copy text, and idempotent Drive storage. Reuse existing orchestration and the generic Website Bridge. Implement necessary fixes and run focused automated and authorized user-perspective acceptance with Testing Mode enabled for every test dispatch. Keep the job pool/profile intact and obtain explicit approval before deployment or destructive production changes. Record redacted evidence and do not declare completion while required live acceptance remains unverified.
