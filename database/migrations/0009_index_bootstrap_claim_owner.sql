create index if not exists idx_bootstrap_import_batches_claimed_by
  on private.bootstrap_import_batches(claimed_by)
  where claimed_by is not null;
