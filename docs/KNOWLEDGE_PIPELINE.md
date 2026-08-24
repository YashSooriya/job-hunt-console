# Applicant Knowledge Extraction Pipeline

## Purpose

Build one evidence-backed profile that application generation can safely reuse without gradually inventing or distorting facts.

## Source priority

1. PhD thesis for detailed doctoral technical claims
2. current specialised CV families for concise role-ready claims
3. verified employment/education documents for dates and contractual facts
4. existing application materials for useful formulations that still require evidence linkage
5. application tracker for process history and outcomes, not professional-skill evidence

## Pipeline

```text
Source registered
    -> source text/file captured
    -> structured extraction with GPT-5.6 Terra
    -> JSON Schema validation
    -> canonical-key / duplicate matching
    -> confidence and source-span checks
    -> verified or needs_review
    -> evidence store
```

## Extraction output

Each source produces:

- candidate facts as key/value text records
- atomic evidence claims
- tags
- strength 1-5
- confidence
- source locator

The model does not decide final verification status. Application code does.

## Automatic acceptance policy

An extracted item may be promoted directly to `verified` only when all of the following are true:

- the source is in the trusted source manifest
- confidence is at least 0.95
- the source locator is present
- it does not conflict with an existing verified fact
- it is not a sensitive voluntary disclosure
- it is not an interpretive claim such as suitability, personality, or inferred seniority

Everything else enters `needs_review`.

## Deduplication

Evidence is atomic. Similar claims from multiple CVs should converge onto one canonical evidence item with multiple source links rather than becoming separate facts.

Examples:

- "ran models with approximately three million mechanical DOFs" and "large 3D models with around 3M mechanical DOFs" should merge
- "used ANSYS Fluent for Formula Student aerodynamics" and the more specific floor/diffuser claim should usually remain one detailed evidence item

## Safety policy

Application-specific equality/diversity, disability, health, political, religious, ethnicity, sexual-orientation or similar voluntary disclosures are never promoted into the reusable profile automatically.

No generated CV claim can be approved unless its material bullets reference accepted evidence IDs.

## Current seed

The bootstrap contains 18 verified atomic evidence records from the thesis and existing CV/application material. It is deliberately incomplete. Milestone 1 expands it with automated extraction and a review queue.

## Running the deterministic seed bootstrap

```bash
npm run knowledge:bootstrap
```

## Running AI extraction later

Export or mount source text, then run:

```bash
OPENAI_API_KEY=... npm run knowledge:extract -- thesis_2026 path/to/thesis.txt
```

The extractor writes a JSON result to `data/knowledge/extracted/` and never mutates the verified seed directly. A later reconciliation step reviews/promotes it.
