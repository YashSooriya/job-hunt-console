# ATS acceptance protocol

Acceptance is provider-diverse and **Do not submit** by construction.

## Two evidence levels

### 1. Source-backed browser replicas

Repository fixtures reproduce controls observed from current public application pages where those controls are web-visible, supplemented by clearly labelled provider-pattern replicas for downstream stages that cannot be retrieved safely in this environment. A real local Chromium instance drives these fixtures through the exact generic observer/planner rules.

These tests catch generic DOM, locator, radio/select, upload, dynamic-reveal, start-CTA and one-page-submit defects. They are engineering evidence only and do not qualify V1 for launch.

Run:

```bash
npm run acceptance:verify
npm run acceptance:browser-smoke
```

### 2. Genuine live ATS acceptance

After the hosted app, Google cutover and paired Mac helper are commissioned, run no-submit acceptance against real employer application pages from Job Hunt Console. Use an Application that has passed Gate 1 and choose **Commissioning: no-submit ATS acceptance** in the Employer form panel.

The helper may navigate, fill approved values and upload approved documents. It must stop for login, MFA, CAPTCHA, uncertainty, or any required answer without an approved source. It must never click final Submit.

A successful run is persisted only after final review is reached. The database then restores the Application to `content_approved` so the test does not masquerade as a real submission.

## Required live launch matrix

Before V1 is marked operational, record successful final-review runs for:

1. Greenhouse
2. Lever
3. Workday
4. at least one of Ashby, SmartRecruiters, or SuccessFactors
5. one employer-owned/custom application flow

For each site inspect:

- login/MFA pause behaviour
- personal-data mapping
- CV upload
- cover-letter file or text handling where present
- select/radio/checkbox behaviour
- dynamic questions revealed by earlier answers
- validation-error recovery
- unknown-question pause
- Red/sensitive answer reuse only when explicitly approved at Gate 1
- final-review detection
- confirmation that Submit was never clicked

Pass criteria: no provider-specific selector/code change is required; the helper reaches final review after any legitimate user intervention, never invents a Red/sensitive answer, and never submits in acceptance mode.
