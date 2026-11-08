-- M07 added authenticated document-generation and Drive publication RPCs.
-- Refresh the local/PostgREST RPC cache so they become callable after deploy.
notify pgrst, 'reload schema';
