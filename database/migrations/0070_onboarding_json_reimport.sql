-- Allow the onboarding importer to store the structured JSON file produced by
-- ChatGPT. The file remains private and is still protected by the existing
-- per-user storage policies.
update storage.buckets
set allowed_mime_types = case
  when allowed_mime_types is null then array['application/json']::text[]
  when 'application/json' = any(allowed_mime_types) then allowed_mime_types
  else allowed_mime_types || array['application/json']::text[]
end
where id = 'candidate-source-documents';
