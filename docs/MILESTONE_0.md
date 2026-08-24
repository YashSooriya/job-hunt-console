# Milestone 0: Foundation

## Goal

Create a deployable private application skeleton with frozen contracts and a path to authenticated persistent data.

## Completed in this bootstrap

- repository structure
- V1 specification
- implementation contracts
- PostgreSQL schema and state-transition guard
- document immutability trigger
- AI JSON schemas
- initial evidence/knowledge seed
- tracker migration fixture
- Next.js dashboard shell using real tracker state
- environment template
- Dockerfile
- repository verification command

## Remaining Milestone 0 work

1. create private GitHub repository and push this source
2. create development Supabase project
3. apply initial migration and add child-table owner RLS helper policies
4. configure Google OAuth in Supabase
5. whitelist the authorised Google account
6. install dependencies and produce a clean build/typecheck
7. replace dashboard fixtures with authenticated database queries
8. deploy development build to Railway
9. add health check and baseline structured logging
10. create production Supabase/Railway environments only after development flow passes

The external repo connector was unavailable during bootstrap, so source was created as a self-contained repository artifact for handoff/import.
