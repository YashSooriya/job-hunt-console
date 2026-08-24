import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const seedEmail = process.env.JOBHUNT_SEED_EMAIL?.trim().toLowerCase();

if (!url || !serviceKey || !seedEmail) {
  console.error("NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and JOBHUNT_SEED_EMAIL are required for explicit development seeding.");
  process.exit(2);
}

const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  "Content-Type": "application/json",
};

async function request(endpoint, options = {}) {
  const response = await fetch(`${url}${endpoint}`, { headers: { ...headers, ...(options.headers || {}) }, ...options });
  if (!response.ok) throw new Error(`${options.method || "GET"} ${endpoint} failed ${response.status}: ${await response.text()}`);
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function rest(table, query = "", options = {}) {
  return request(`/rest/v1/${table}${query}`, options);
}

const usersPayload = await request("/auth/v1/admin/users?page=1&per_page=1000");
const users = Array.isArray(usersPayload) ? usersPayload : usersPayload.users || [];
const user = users.find((item) => item.email?.toLowerCase() === seedEmail);
if (!user) {
  throw new Error(`No Supabase Auth user found for ${seedEmail}. Sign in once before running seed:dev.`);
}

const knowledge = JSON.parse(await fs.readFile(path.join(root, "data/knowledge/knowledge-base.generated.json"), "utf8"));
const manifest = JSON.parse(await fs.readFile(path.join(root, "data/knowledge/source-manifest.json"), "utf8"));
const tracker = JSON.parse(await fs.readFile(path.join(root, "data/imports/tracker.normalized.json"), "utf8"));

const profileRows = await rest("candidate_profiles", "?on_conflict=user_id&select=id", {
  method: "POST",
  headers: { Prefer: "resolution=merge-duplicates,return=representation" },
  body: JSON.stringify([{ user_id: user.id, display_name: knowledge.profile?.display_name || user.email.split("@")[0] }]),
});
const profileId = profileRows[0].id;

await rest("candidate_preferences", "?on_conflict=profile_id", {
  method: "POST",
  headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  body: JSON.stringify([{ profile_id: profileId, preferences: knowledge.preferences || {} }]),
});

const sourceIdByKey = new Map();
for (const source of manifest.sources || []) {
  const rows = await rest("evidence_sources", "?on_conflict=profile_id,source_key&select=id,source_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{
      profile_id: profileId,
      source_key: source.source_key,
      title: source.title,
      source_type: source.source_type,
      provider: source.provider || null,
      provider_ref: source.provider_ref || null,
      captured_at: source.captured_at || null,
      metadata: source.metadata || {},
    }]),
  });
  sourceIdByKey.set(source.source_key, rows[0].id);
}

for (const fact of knowledge.profile?.facts || []) {
  await rest("candidate_facts", "?on_conflict=profile_id,fact_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      profile_id: profileId,
      fact_key: fact.fact_key,
      value_json: fact.value,
      verification_status: fact.status,
      source_note: fact.source_key || null,
      verified_at: fact.status === "verified" ? new Date().toISOString() : null,
    }]),
  });
}

for (const item of knowledge.evidence || []) {
  await rest("evidence_items", "?on_conflict=profile_id,evidence_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      profile_id: profileId,
      source_id: sourceIdByKey.get(item.source_key) || null,
      evidence_key: item.evidence_key,
      category: item.category,
      claim: item.claim,
      detail: item.detail || null,
      tags: item.tags || [],
      strength: item.strength,
      verification_status: item.status,
      source_locator: item.source_locator || null,
    }]),
  });
}

async function findOrCreateCompany(name) {
  const encoded = encodeURIComponent(name);
  const existing = await rest("companies", `?user_id=eq.${user.id}&canonical_name=eq.${encoded}&select=id`);
  if (existing.length) return existing[0].id;
  const created = await rest("companies", "?select=id", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{ user_id: user.id, canonical_name: name }]),
  });
  return created[0].id;
}

for (const record of tracker.records) {
  const existingApps = await rest("applications", `?user_id=eq.${user.id}&source_tracker_row=eq.${record.sourceRow}&select=id`);
  if (existingApps.length) continue;

  const companyId = await findOrCreateCompany(record.company);
  const createdJobs = await rest("jobs", "?select=id", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{
      user_id: user.id,
      company_id: companyId,
      title: record.role,
      external_job_id: record.externalJobId,
      discovered_at: record.applicationDate ? `${record.applicationDate}T00:00:00Z` : new Date().toISOString(),
      triage_reason: "Imported from historical application tracker",
    }]),
  });
  const jobId = createdJobs[0].id;
  const appliedAt = record.applicationDate ? `${record.applicationDate}T12:00:00Z` : null;
  const deadlineAt = record.deadline ? `${record.deadline}T23:59:59Z` : null;

  const createdApps = await rest("applications", "?select=id", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{
      user_id: user.id,
      job_id: jobId,
      state: record.applicationState,
      source_tracker_row: record.sourceRow,
      source_tracker_values: record,
      applied_at: appliedAt,
      submitted_at: appliedAt,
      next_action: record.nextAction,
      deadline_at: deadlineAt,
      notes: record.notes,
    }]),
  });

  if (record.applicationState === "assessment") {
    await rest("assessments", "", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify([{
        application_id: createdApps[0].id,
        invited_at: record.lastEmail ? `${record.lastEmail}T12:00:00Z` : null,
        deadline_at: deadlineAt,
        status: "pending",
        notes: record.notes,
      }]),
    });
  }
}

await rest("audit_events", "", {
  method: "POST",
  headers: { Prefer: "return=minimal" },
  body: JSON.stringify([{
    user_id: user.id,
    actor_type: "system",
    actor_id: "seed-dev-data",
    event_type: "milestone1.seed_completed",
    entity_type: "candidate_profile",
    entity_id: profileId,
    metadata: {
      facts: knowledge.profile?.facts?.length || 0,
      evidence: knowledge.evidence?.length || 0,
      tracker_records: tracker.records.length,
    },
  }]),
});

console.log(`Seed complete for ${seedEmail}`);
console.log(`${knowledge.profile?.facts?.length || 0} facts, ${knowledge.evidence?.length || 0} evidence items, ${tracker.records.length} tracker applications`);
