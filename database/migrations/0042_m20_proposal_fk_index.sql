-- Cover the proposal -> materialized evidence foreign key introduced by M20.
create index if not exists candidate_extraction_proposals_materialized_evidence_idx
  on public.candidate_extraction_proposals(materialized_evidence_id);
