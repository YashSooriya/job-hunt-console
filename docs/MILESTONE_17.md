# Milestone 17: Per-user onboarding and applicant knowledge

Milestone 17 makes a fresh invited member independently usable without database or developer intervention.

The onboarding flow captures personal details, education, employment, skills/tools, projects, publications, CV source documents, CV-family choices, reusable screening answers, salary and location preferences, work-mode preferences, work authorisation and job-search preferences.

Every M17 record resolves through the authenticated user's candidate profile and is protected by RLS. Candidate source documents are stored in a private bucket under the authenticated user ID.

CV extraction is deliberately conservative. Extracted facts and evidence enter `needs_review`, retain their source and source locator, and are not reusable until explicitly verified. Rejected extraction is retained as rejected rather than silently discarded from the audit trail.

The database readiness RPC requires verified history, skills, evidence, work authorisation, location preferences and at least one enabled CV family, with no unresolved extracted facts/evidence, before onboarding can become `ready`.
