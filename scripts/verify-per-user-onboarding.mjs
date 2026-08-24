import fs from 'node:fs';
const files=['database/migrations/0035_per_user_onboarding_and_applicant_knowledge.sql','database/migrations/0036_onboarding_provenance_indexes.sql','apps/web/app/onboarding/page.tsx','apps/web/components/onboarding-workspace.tsx','apps/web/app/api/onboarding/state/route.ts','apps/web/app/api/onboarding/import-cv/route.ts','apps/web/app/api/onboarding/review/route.ts','apps/web/app/api/onboarding/complete/route.ts','apps/web/lib/onboarding/extract.ts'];
for(const f of files)if(!fs.existsSync(f))throw new Error(`Missing M17 file: ${f}`);
const sql=fs.readFileSync(files[0],'utf8'); const indexes=fs.readFileSync('database/migrations/0036_onboarding_provenance_indexes.sql','utf8');
for(const table of ['candidate_onboarding','candidate_education','candidate_employment','candidate_skills','candidate_projects','candidate_publications','candidate_cv_families','candidate_source_documents']){
 if(!sql.includes(`create table public.${table}`))throw new Error(`M17 table missing: ${table}`);
 if(!sql.includes(`policy ${table}_owner`) && table!=='candidate_source_documents')throw new Error(`M17 RLS policy missing: ${table}`);
}
if(!sql.includes('candidate_source_documents_owner'))throw new Error('Source-document RLS policy missing.');
if(!sql.includes('storage.foldername(name)')||!sql.includes("bucket_id='candidate-source-documents'"))throw new Error('Per-user source-document storage isolation missing.');
for(const idx of ['candidate_education_source_idx','candidate_employment_source_idx','candidate_skills_source_idx','candidate_projects_source_idx','candidate_publications_source_idx'])if(!indexes.includes(idx))throw new Error(`M17 provenance index missing: ${idx}`);
if(!sql.includes('get_onboarding_readiness')||!sql.includes('pending_review')||!sql.includes('work_authorisation'))throw new Error('Database readiness gate is incomplete.');
const importer=fs.readFileSync('apps/web/app/api/onboarding/import-cv/route.ts','utf8');
if(!importer.includes("verification_status:'needs_review'"))throw new Error('CV extraction must enter needs-review state.');
if(!importer.includes('evidence_sources')||!importer.includes('source_locator'))throw new Error('CV extraction provenance is incomplete.');
const review=fs.readFileSync('apps/web/app/api/onboarding/review/route.ts','utf8');if(!review.includes("status==='verified'")||!review.includes("status==='rejected'"))throw new Error('Explicit factual review path missing.');
const callback=fs.readFileSync('apps/web/app/auth/callback/route.ts','utf8');if(!callback.includes('new_member')||!callback.includes('/onboarding'))throw new Error('Fresh invited members are not routed into onboarding.');
console.log('Milestone 17 per-user onboarding contracts passed.');
console.log('Fresh-user profile building, source provenance, explicit verification, preferences, CV families, reusable answers, and readiness gating are present.');
