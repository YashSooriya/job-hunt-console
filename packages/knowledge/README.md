# Applicant knowledge bootstrap

The initial pipeline separates source discovery from evidence extraction.

## Current bootstrap

`data/knowledge/source-manifest.json` records authoritative source artifacts available from the user's File Library and connected Google Drive.

`data/knowledge/seed.json` contains the first verified facts/evidence extracted from those sources during specification work.

Run:

```bash
npm run knowledge:bootstrap
```

This validates source references, evidence-key uniqueness, tags and strengths, then writes `knowledge-base.generated.json`.

## Next extraction stage

Milestone 1 replaces manual seed expansion with a Responses API ingestion worker using `knowledge-extraction.schema.json`. Extracted items enter `needs_review` unless they can be matched to a high-confidence source span and accepted automatically under profile policy.

The pipeline must never promote an application-specific voluntary disclosure into a reusable candidate fact without an explicit user action.
