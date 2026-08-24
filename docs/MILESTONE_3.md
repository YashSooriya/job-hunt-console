# Milestone 3: Job intelligence

Milestone 3 creates the first real pre-application pipeline. A Job is now a persistent object separate from an Application, and new vacancies can be ingested, preserved, analysed and triaged before any application is created.

## Delivered

- Manual vacancy-ingestion UI and API route for end-to-end testing.
- Persistent Job records in Supabase with validated local snapshot fallback.
- Original advert snapshots with content hashes so changed/reposted descriptions are preserved without duplicating identical snapshots.
- Per-user job deduplication using canonical company + external job ID where available, otherwise company + title + source host.
- Historical tracker-created Jobs are explicitly marked `historical_tracker` and excluded from the discovery inbox.
- Deterministic, evidence-grounded requirement extraction.
- Requirement-to-evidence matching with provenance IDs.
- Separate Fit Score and Priority Score calculations using the frozen V1 weights.
- Eligibility uncertainty handling that refuses to guess clearance, citizenship, sponsorship or work-authorisation facts.
- Four-family CV recommendation with an explicit Motorsport guard.
- `auto_prepare`, `recommend`, `maybe`, and `reject` classification with stored reasons.
- Analysis version persistence through `job_analyses` and analysis-linked `job_requirements`.
- Job detail view containing component scores, requirements, evidence matches, concerns, application strategy, preserved advert, CV recommendation and cover-letter value.
- Dashboard support for newly discovered strong matches.

## Zero-additional-cost intelligence path

The web application does not require separately billed OpenAI API calls.

Milestone 3 uses deterministic code for the first pass:

```text
Vacancy text
    ↓
Requirement extraction
    ↓
Verified evidence matching
    ↓
Fit components
    ↓
Fit Score
    ↓
Priority inputs
    ↓
Priority Score
    ↓
CV family + triage
```

This is deliberately a first-pass system rather than a claim that deterministic keyword matching is equivalent to ChatGPT reasoning. The analysis has explicit provenance `deterministic_v1` so a later ChatGPT analysis can supersede it while preserving the original record.

## Fit Score

Weights remain:

- technical capability: 30%
- evidence strength: 20%
- seniority fit: 15%
- domain fit: 15%
- role-type fit: 10%
- qualifications: 10%

The arithmetic is code-owned, not free-form AI arithmetic.

## Priority Score

Weights remain:

- Fit: 35%
- screening probability: 20%
- compensation value: 15%
- geography: 10%
- posting freshness: 10%
- low application effort: 5%
- closing-date urgency: 5%

Posting freshness uses the agreed policy: 0–7 days strongest, 8–14 still worthwhile, 15–30 selective, 30+ low priority unless unusually strong.

## CV family rule

The family selector considers Simulation/CAE, Scientific Software and Quantitative/Data for general roles.

The Motorsport CV has a hard guard:

```text
explicit Formula 1 / F1 / motorsport / racing context
    → Motorsport eligible and preferred

no explicit motorsport context
    → Motorsport cannot be selected
```

This prevents a generic CFD, structural or software vacancy from receiving the motorsport CV just because some candidate evidence comes from Formula Student.

## Eligibility behaviour

The deterministic analyser is intentionally conservative. If a vacancy mentions SC/DV clearance, citizenship, sponsorship, visa status or right-to-work conditions and the candidate knowledge base does not contain a verified matching fact, the result is `unknown`, not `eligible` or `ineligible`.

Unknown eligibility is surfaced as a concern and blocks `auto_prepare` until resolved.

## Persistence

Migration `0007_job_intelligence.sql` adds:

- `jobs.discovery_source`
- `jobs.dedupe_key`
- snapshot content hashes
- analysis provenance
- analysis triage result/reason
- requirement-to-analysis linkage
- supporting indexes

Migration `0008_separate_discovery_from_history.sql` ensures historical tracker Jobs remain outside the discovery inbox, including after the staged Milestone 2 batch is claimed.

## Manual test

With the app running locally, open `/jobs`, paste a full job description, and select **Analyse job**.

Expected flow:

```text
/jobs
  → POST /api/jobs/ingest
  → preserve Job + snapshot
  → run deterministic analysis
  → persist requirements + analysis
  → redirect /jobs/[id]
```

## Automated verification

Run:

```bash
npm run milestone:3
```

The job-intelligence verifier checks:

- Fit weights sum to 100
- Priority weights sum to 100
- strong simulation evidence is not rejected
- quantitative roles select Quantitative/Data
- explicit Formula 1 roles select Motorsport
- non-motorsport CFD roles cannot select Motorsport
- unsupported Staff backend roles remain low-fit/rejected
- unverified clearance remains `unknown`
- duplicate external job IDs normalise consistently
- every strong-match analysis retains evidence provenance

## Milestone boundary

Milestone 3 does not yet turn a recommended Job into a prepared Application. That is the next milestone.

The next vertical slice should implement:

```text
Job
  → Apply / Auto-prepare decision
  → Application record
  → application strategy version
  → CV family lock
  → preparation task queue
```
