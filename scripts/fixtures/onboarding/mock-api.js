// Injected only into the test-owned Chrome profile by the Windows UI runner.
// It substitutes synthetic onboarding API responses; no application server
// route, Supabase account, ChatGPT session, or production data is involved.
(() => {
  const key = "jobhunt-m02-onboarding-fixture-v1";
  const fresh = () => ({
    nextId: 100,
    profile: { id: "synthetic-profile-01", display_name: "Synthetic QA Candidate" },
    onboarding: { profile_id: "synthetic-profile-01", status: "in_progress" },
    facts: [], evidence: [], extractionProposals: [], employment: [], education: [],
    skills: [], projects: [], publications: [], cvFamilies: [], sourceDocuments: [],
    preferences: {}, additionalInformation: "", uploadAttempts: 0,
    memory: { confirmed: false, decision: "undecided", memorySyncEnabled: false,
      reminderRequired: false, importStatus: "not_requested", updateStatus: "not_requested" },
    diagnostics: { calls: [], uploadAttempts: 0, memoryWriteAttempts: 0, profileDispatchAttempts: 0 },
  });
  let state;
  try { state = JSON.parse(localStorage.getItem(key) || "null"); } catch { state = null; }
  if (!state) state = fresh();
  const persist = () => localStorage.setItem(key, JSON.stringify(state));
  const record = (method, path, details = {}) => {
    state.diagnostics.calls.push({ method, path, ...details });
    persist();
  };
  const readiness = () => {
    const all = [state.facts, state.evidence, state.extractionProposals, state.employment,
      state.education, state.skills, state.projects, state.publications].flat();
    const pending = all.filter((item) => item.verification_status === "needs_review").length;
    const verifiedHistory = [...state.employment, ...state.education].filter((item) => item.verification_status === "verified").length;
    const workAuth = state.facts.some((item) => item.fact_key === "work_authorisation" && item.verification_status === "verified");
    const complete = verifiedHistory > 0 && workAuth;
    const extracted = state.sourceDocuments.some((item) => ["stored", "extracted"].includes(item.extraction_status));
    return { ready: complete && pending === 0, activation_ready: complete && pending === 0,
      profile_complete: complete, score: (complete ? 70 : 0) + (extracted ? 20 : 0) + (pending === 0 ? 10 : 0),
      status: state.onboarding.status, pending_review: pending, history: verifiedHistory,
      skills: state.skills.filter((item) => item.verification_status === "verified").length,
      verified_evidence: state.evidence.filter((item) => item.verification_status === "verified").length,
      work_authorisation: workAuth, locations: false, target_roles: false, search_mode: "keywords_and_profile",
      work_modes: false, role_families: false, target_seniority: false, preferences_complete: true,
      cv_families: 0, source_document_extracted: extracted, external_connections_required: false };
  };
  const reply = (payload, status = 200) => new Response(JSON.stringify(payload), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
  const ok = (payload = {}) => reply({ ok: true, ...payload });
  const makeProposal = (source, type, locator, claim, proposed) => ({
    id: state.nextId++, profile_id: state.profile.id, source_id: source.id,
    source_title: source.original_name, source_locator: locator, proposal_type: type,
    claim, proposed_json: { claim, ...proposed }, verification_status: "needs_review",
    created_at: new Date().toISOString(),
  });
  const originalFetch = window.fetch.bind(window);
  window.__M02FixtureDiagnostics = () => JSON.parse(JSON.stringify(state.diagnostics));
  window.__M02FixtureReadiness = () => readiness();
  window.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === "string" ? input : input.url;
    const url = new URL(rawUrl, location.href);
    if (!url.pathname.startsWith("/api/onboarding/")) return originalFetch(input, init);
    const method = String(init.method || input.method || "GET").toUpperCase();
    record(method, url.pathname);

    if (url.pathname === "/api/onboarding/state" && method === "GET") {
      return ok({ ...state, readiness: readiness(), bundleRevision: `fixture-${state.sourceDocuments.length}-${state.additionalInformation.length}` });
    }
    if (url.pathname === "/api/onboarding/memory" && method === "GET") return ok({ memory: state.memory });
    if (url.pathname === "/api/onboarding/memory" && method === "POST") {
      state.diagnostics.memoryWriteAttempts += 1;
      const body = JSON.parse(init.body || "{}");
      if (body.action === "allow") state.memory = { ...state.memory, confirmed: true, decision: "allowed", memorySyncEnabled: true };
      if (body.action === "decline") state.memory = { ...state.memory, confirmed: false, decision: "declined", memorySyncEnabled: false };
      persist();
      return ok({ memory: state.memory });
    }
    if (url.pathname === "/api/onboarding/professional-background" && method === "POST") {
      state.diagnostics.profileDispatchAttempts += 1; persist();
      return ok({ profileImportQueued: false, sourceCount: state.sourceDocuments.length });
    }
    if (url.pathname === "/api/onboarding/import-cv" && method === "POST") {
      const form = init.body;
      const file = form instanceof FormData ? form.get("file") : null;
      if (!(file instanceof File)) return reply({ ok: false, error: "Synthetic fixture upload did not contain a file." }, 400);
      state.uploadAttempts += 1;
      state.diagnostics.uploadAttempts += 1;
      persist();
      // One planned 503 verifies that the visible recovery path preserves work
      // without writing a partial source or duplicate proposal.
      if (state.uploadAttempts === 1) return reply({ ok: false, error: "Synthetic interruption before source save. Retry the selected file." }, 503);
      const source = { id: state.nextId++, profile_id: state.profile.id, original_name: file.name,
        source_type: "cv_upload", mime_type: file.type || "text/plain", byte_size: file.size,
        sha256: "synthetic-fixture-only", extraction_status: "extracted", extraction_format: "plain_text",
        extraction_error: null, created_at: new Date().toISOString() };
      state.sourceDocuments.push(source);
      if (file.name === "synthetic-source-a.txt") {
        state.extractionProposals.push(
          makeProposal(source, "employment", "line:2", "Data Quality Engineer at Northstar Analytics | Jan 2022 to Dec 2024",
            { employer: "Northstar Analytics", role_title: "Data Quality Engineer", location: null, start_date: "2022-01-01", end_date: "2024-12-01", current: false, details: "Built deterministic data checks for fictional analytics fixtures." }),
          makeProposal(source, "education", "line:5", "Ada Lovelace University | BSc Software Engineering | 2018 to 2021",
            { institution: "Ada Lovelace University", qualification: "BSc Software Engineering", field_of_study: "Software Engineering", location: null, start_date: "2018-01-01", end_date: "2021-01-01", current: false, details: null }),
          makeProposal(source, "skill", "line:7", "PostgreSQL", { name: "PostgreSQL", category: "skill", proficiency: "" }),
          makeProposal(source, "project", "line:9", "Synthetic Quality Dashboard: Built a fictional dashboard for test data.",
            { title: "Synthetic Quality Dashboard", description: "Built a fictional dashboard for test data.", technologies: ["PostgreSQL"], start_date: null, end_date: null, url: null }),
        );
      } else if (file.name === "synthetic-source-b.md") {
        state.extractionProposals.push(
          makeProposal(source, "employment", "line:2", "Data Quality Engineer at Northstar Analytics | Feb 2022 to Present",
            { employer: "Northstar Analytics", role_title: "Data Quality Engineer", location: null, start_date: "2022-02-01", end_date: null, current: true, details: null }),
          makeProposal(source, "skill", "line:5", "Python", { name: "Python", category: "skill", proficiency: "" }),
        );
      }
      persist();
      return ok({ source, extractionStatus: "extracted", proposalCount: state.extractionProposals.length });
    }
    if (url.pathname === "/api/onboarding/sources" && method === "POST") {
      const body = JSON.parse(init.body || "{}");
      if (typeof body.additionalInformation === "string") {
        state.additionalInformation = body.additionalInformation;
        state.sourceDocuments = state.sourceDocuments.filter((item) => item.source_type !== "user_description");
        if (body.additionalInformation.trim()) state.sourceDocuments.push({ id: state.nextId++, profile_id: state.profile.id,
          original_name: "Additional Information", source_type: "user_description", extraction_status: "extracted",
          extraction_format: "text/plain", extraction_error: null, created_at: new Date().toISOString() });
      } else if (body.additionalInformation === null) {
        state.additionalInformation = "";
        state.sourceDocuments = state.sourceDocuments.filter((item) => item.source_type !== "user_description");
      }
      persist();
      return ok({ documents: state.sourceDocuments, additionalInformation: state.additionalInformation,
        bundleRevision: `fixture-${state.sourceDocuments.length}-${state.additionalInformation.length}` });
    }
    if (url.pathname === "/api/onboarding/review" && method === "POST") {
      const body = JSON.parse(init.body || "{}");
      if (body.kind === "proposal") {
        const proposal = state.extractionProposals.find((item) => String(item.id) === String(body.id));
        if (!proposal) return reply({ ok: false, error: "Synthetic review item not found." }, 404);
        proposal.verification_status = body.status === "verified" ? "verified" : "rejected";
        if (body.status === "verified") {
          const value = { ...proposal.proposed_json, ...(body.fields || {}) };
          if (body.claim) value.claim = body.claim;
          const row = { id: state.nextId++, profile_id: state.profile.id, source_id: proposal.source_id,
            source_title: proposal.source_title, verification_status: "verified", updated_at: new Date().toISOString(), ...value };
          if (proposal.proposal_type === "employment") state.employment.push(row);
          else if (proposal.proposal_type === "education") state.education.push(row);
          else if (proposal.proposal_type === "skill") state.skills.push(row);
          else if (proposal.proposal_type === "project") state.projects.push(row);
          else if (proposal.proposal_type === "publication") state.publications.push(row);
        }
        persist(); return ok({ reviewed: true });
      }
      if (body.kind === "fact") {
        const fact = state.facts.find((item) => String(item.id) === String(body.id));
        if (fact) { fact.verification_status = body.status; if (body.value) fact.value_json = body.value; }
        persist(); return ok({ reviewed: true });
      }
      return reply({ ok: false, error: "Unsupported synthetic review kind." }, 400);
    }
    if (url.pathname === "/api/onboarding/profile" && method === "POST") {
      const body = JSON.parse(init.body || "{}");
      const map = { workAuthorisation: "work_authorisation", firstName: "first_name", surname: "surname",
        location: "location", email: "email", phone: "phone" };
      for (const [field, keyName] of Object.entries(map)) {
        if (!(field in body)) continue;
        let fact = state.facts.find((item) => item.fact_key === keyName);
        if (!fact) { fact = { id: state.nextId++, profile_id: state.profile.id, fact_key: keyName,
          value_json: body[field], verification_status: "verified", source_note: "synthetic_gui_test" }; state.facts.push(fact); }
        else { fact.value_json = body[field]; fact.verification_status = "verified"; }
      }
      persist(); return ok({ saved: true });
    }
    if (url.pathname === "/api/onboarding/history" && method === "POST") {
      const body = JSON.parse(init.body || "{}");
      const kind = body.kind === "education" ? "education" : "employment";
      const rows = state[kind];
      const record = rows.find((item) => String(item.id) === String(body.id)) || { id: state.nextId++, profile_id: state.profile.id, verification_status: "verified" };
      Object.assign(record, kind === "education" ? {
        institution: body.institution, qualification: body.qualification, field_of_study: body.fieldOfStudy || "",
        location: body.location || "", start_date: body.startDate || null, end_date: body.endDate || null,
        current: Boolean(body.current), details: body.details || "",
      } : {
        employer: body.employer, role_title: body.roleTitle, location: body.location || "",
        start_date: body.startDate || null, end_date: body.endDate || null, current: Boolean(body.current), details: body.details || "",
      }, { updated_at: new Date().toISOString() });
      if (!rows.includes(record)) rows.push(record);
      persist(); return ok({ saved: true });
    }
    if (url.pathname === "/api/onboarding/history" && method === "DELETE") {
      const kind = url.searchParams.get("kind") === "education" ? "education" : "employment";
      state[kind] = state[kind].filter((item) => String(item.id) !== url.searchParams.get("id"));
      persist(); return ok({ removed: true });
    }
    if (url.pathname === "/api/onboarding/skills" && method === "POST") {
      const body = JSON.parse(init.body || "{}");
      let row = body.id ? state.skills.find((item) => String(item.id) === String(body.id)) : null;
      if (!row) { row = { id: state.nextId++, profile_id: state.profile.id, verification_status: "verified" }; state.skills.push(row); }
      Object.assign(row, { name: body.name, category: body.category || "", proficiency: body.proficiency || "",
        years_experience: body.yearsExperience || null, updated_at: new Date().toISOString() });
      persist(); return ok({ saved: true });
    }
    if (url.pathname === "/api/onboarding/skills" && method === "DELETE") {
      state.skills = state.skills.filter((item) => String(item.id) !== url.searchParams.get("id"));
      persist(); return ok({ removed: true });
    }
    if (url.pathname === "/api/onboarding/portfolio" && method === "POST") {
      const body = JSON.parse(init.body || "{}");
      const kind = body.kind === "publication" ? "publications" : "projects";
      let row = body.id ? state[kind].find((item) => String(item.id) === String(body.id)) : null;
      if (!row) { row = { id: state.nextId++, profile_id: state.profile.id, verification_status: "verified" }; state[kind].push(row); }
      Object.assign(row, body, { updated_at: new Date().toISOString() });
      persist(); return ok({ saved: true });
    }
    if (url.pathname === "/api/onboarding/import-cv" && method === "DELETE") {
      const id = url.searchParams.get("id");
      const removed = state.sourceDocuments.find((item) => String(item.id) === id);
      state.sourceDocuments = state.sourceDocuments.filter((item) => String(item.id) !== id);
      state.extractionProposals = state.extractionProposals.filter((item) => String(item.source_id) !== id);
      for (const collection of ["employment", "education", "skills", "projects", "publications"])
        state[collection] = state[collection].filter((item) => String(item.source_id) !== id);
      persist(); return ok({ title: removed?.original_name || "Synthetic source" });
    }
    return reply({ ok: false, error: `No synthetic handler for ${method} ${url.pathname}.` }, 501);
  };
  persist();
})();
