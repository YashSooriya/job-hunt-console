# Milestone 9 — Assessment and Interview Workspaces

Milestone 9 turns progression events into structured preparation without adding paid model API usage.

## Scope

- assessment/interview action centre
- assessment detail workspace with invitation facts, deadline, provider and preparation rules
- interview detail workspace
- versioned preparation packages
- immutable submission-context schema for exact later-stage recall
- context-quality labelling for historical records
- evidence-backed interview preparation
- synthetic assessment practice plan
- ChatGPT Plus handoff prompts
- assessment status tracking

## Context integrity

Each `workflow_preparation_versions` row stores both the preparation package and the context snapshot used to make it. Context is labelled:

- `exact_submitted`: sourced from immutable `application_submission_contexts`
- `approved_pre_submission`: approved application package exists but no immutable submission snapshot was captured yet
- `best_available`: historical/imported record or incomplete application history

The UI must display this quality rather than implying historical reconstruction is exact.

## Assessment safety boundary

All assessment packages must contain `practice_only: true`.

The database rejects preparation payloads containing live-assessment answer/submission fields. The product may create synthetic practice, role refreshers and readiness checklists, but may not answer or submit live assessment questions. Employer instructions requiring independent completion take precedence.

The Rolls-Royce JR6158436 local verification fixture records the AON MapTQ provider, four-day deadline, one-attempt constraint and independent-completion instruction without storing the invitation access link.

## Interview workspace

Interview preparation uses the exact submitted context when available, including the submitted CV/cover-letter version IDs and screening/salary recap. It generates likely questions, strongest evidence prompts, weak areas, questions to ask and salary consistency guidance.

## Zero-additional-cost execution

`deterministic_v1` creates the base workspace. The web app exposes a copyable ChatGPT handoff prompt so deeper synthetic assessment practice and mock interviews can be done through the user's ChatGPT Plus session rather than separately billed API calls.
