# Milestone 11: Productionisation and real-world acceptance

## Goal

Convert the completed Milestone 0-10 repository into a persistent zero-additional-cost deployment and make real ATS testing safe and repeatable.

## Hosting choice

Cloudflare Workers + OpenNext is the production target. Supabase remains the source of truth. The local browser companion remains local and controls a dedicated Job Hunt Chrome profile.

## Production compatibility

The web app uses legacy `middleware.ts` for Supabase session refresh/enforcement because current OpenNext/Cloudflare support does not yet cover Next.js 16 Node-runtime `proxy.ts` reliably.

## Acceptance safety

`browser:acceptance` always enables no-submit mode. When final employer review is detected, the session is persisted as `final_review` and the local runner exits without waiting for Gate 2 or interacting with the final Submit control.

## Completion criteria

- Cloudflare/OpenNext config in repo
- production environment contract documented
- Google OAuth/Gmail production callback runbook documented
- health endpoint reports configuration readiness without leaking secrets
- no-submit ATS acceptance mode enforced in code
- provider-diverse acceptance protocol documented
- prior Milestone 1-10 regression remains green
