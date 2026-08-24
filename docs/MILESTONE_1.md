# Milestone 1: Persistent foundation + candidate intelligence

## Goal

Move the Milestone 0 shell away from hard-coded UI fixtures and make the candidate profile/evidence layer usable before job scoring and document generation are added.

## Implemented

- future Milestone 10 browser contract locked as website-agnostic adaptive form completion
- repository data layer with `auto`, `local`, and `supabase` modes
- validated local fallback for all primary screens
- Supabase SSR client scaffolding using cookie-based sessions
- Google OAuth login and callback route
- authorised-email enforcement in proxy and auth callback
- sign-out route
- health endpoint
- second database migration with child-table RLS owner policies
- idempotent historical tracker import index
- dev seed script for candidate knowledge and historical application data
- normalised live tracker snapshot
- application dashboard and application table backed by repository reads
- assessment view backed by tracker/database state
- candidate Profile page with verified facts, evidence sources and searchable atomic evidence
- CV-family Documents page
- explicit Jobs inbox boundary retained for the next vertical slice

## Data modes

`JOBHUNT_DATA_MODE=local` always uses validated repository snapshots.

`JOBHUNT_DATA_MODE=supabase` requires the database and fails if it cannot be read.

`JOBHUNT_DATA_MODE=auto` uses Supabase when configured and falls back to validated local data during development.

## Connecting Supabase

1. create a Supabase project
2. apply `0001_initial.sql`
3. apply `0002_owner_policies_and_indexes.sql`
4. enable Google OAuth in Supabase
5. set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and an explicit development-only `JOBHUNT_SEED_EMAIL` when using the seed script
6. sign in to the app once with the authorised Google account
7. run `npm run seed:dev`
8. set `JOBHUNT_DATA_MODE=supabase`
9. run the app and confirm the source badge says `Live database`

## Exit criteria

Milestone 1 is complete when the app can run locally in snapshot mode, and when a configured Supabase deployment shows the same candidate knowledge/application data behind authenticated reads.
