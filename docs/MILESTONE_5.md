# Milestone 5 - Evidence-backed CV engine and document versions

## Delivered

Milestone 5 turns the queued `prepare_cv` task into an executable document pipeline.

```text
Application
  -> selected CV family
  -> verified candidate evidence
  -> deterministic relevance ranking
  -> structured CV content
  -> evidence audit
  -> LaTeX renderer
  -> PDF
  -> immutable DocumentVersion
  -> private document storage
  -> review
```

## Zero-extra-cost first draft

The default engine is `deterministic_v1`. It does not call a separately billed model API. It selects, condenses and reorders pre-written verified CV material according to the job description, extracted requirements and selected CV family.

ChatGPT Plus remains the higher-quality revision surface. A later user-requested ChatGPT revision creates another document version rather than overwriting the deterministic draft.

## Four base families

The canonical structured base families are:

- `simulation_cae`
- `scientific_software`
- `quantitative_data`
- `motorsport`

They share verified career records but use different profile summaries, skill grouping and relevance emphasis. The Motorsport family remains restricted upstream to explicitly motorsport-related roles.

## Evidence policy

Every material profile/bullet claim carries one or more evidence IDs. The engine audits every generated version before rendering.

Target:

```text
unsupported_claims = []
unsupported_claims_count = 0
```

The database independently refuses a reviewable CV with unsupported material claims or material bullets without evidence. Persistent Supabase versions additionally require evidence IDs to resolve to verified evidence belonging to the authenticated candidate profile.
A deferred transaction-level manifest check also requires every evidence ID embedded in structured CV content to have a matching `document_evidence_links` row before the transaction can commit. Direct writes cannot bypass this provenance requirement.

## Versioning

Each application has one logical CV document and many immutable versions.

A new preparation/revision creates:

- structured JSON content
- LaTeX source
- rendered private PDF
- change summary
- evidence-link manifest
- engine/provenance identifier
- approval state

No previous version is overwritten.

Submitted versions retain the existing `submission_locked_at` immutability guarantee. Milestone 5 extends this protection to evidence links as well.

## Storage

Rendered PDFs use the private Supabase Storage bucket `application-documents`.

The object path begins with the authenticated user's UUID, and Storage RLS only allows that user to access objects beneath their own prefix.

Local mode mirrors the same model under `data/documents/` so the app can be exercised without Supabase.

## UI

Application workspaces now show:

- prepare/new-version action
- version number
- engine
- approval state
- evidence-link count
- unsupported-claim count
- material change summary
- private PDF link

The Documents page also acts as the application CV archive.

## Not yet part of Milestone 5

- free-form ChatGPT revision import
- side-by-side base-vs-tailored visual diff
- user approval/rejection controls
- cover-letter generation
- screening-answer preparation
- full Ready for Review package assembly

These follow on top of the version/evidence foundation built here.
