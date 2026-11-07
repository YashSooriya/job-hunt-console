-- The M04 authenticated RPCs are added after the core database migration
-- history; make the PostgREST API refresh its schema before the frontend calls
-- the new owner-scoped recovery lookup and atomic batch dispatch functions.
notify pgrst, 'reload schema';
