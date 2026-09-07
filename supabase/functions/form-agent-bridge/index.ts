import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return [...value].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authenticateDevice(req: Request, helperVersion?: string | null) {
  const deviceId = req.headers.get("x-browser-device-id") || "";
  const token = req.headers.get("x-browser-device-token") || "";
  if (!deviceId || !token || !/^[0-9a-f-]{36}$/i.test(deviceId) || token.length < 40) throw new Error("Missing browser-helper device credentials.");
  const tokenHash = await sha256(token);
  const { data: device, error } = await supabase.rpc("browser_agent_service_authenticate_device", {
    p_device_id: deviceId,
    p_token_hash: tokenHash,
    p_helper_version: helperVersion || null,
  });
  if (error) throw error;
  if (!device?.id || !device?.user_id) throw new Error("Invalid browser-helper device credentials.");
  return device;
}

async function pairDevice(body: any) {
  const pairingCode = String(body?.pairingCode || "").trim().toUpperCase();
  if (!pairingCode || pairingCode.length < 12) throw new Error("A valid pairing code is required.");
  const codeHash = await sha256(pairingCode);
  const rawToken = randomHex(32);
  const tokenHash = await sha256(rawToken);
  const displayName = String(body?.displayName || "JobHuntAI Browser Helper").slice(0, 160);
  const platform = String(body?.platform || "macos").slice(0, 40);
  const helperVersion = body?.helperVersion ? String(body.helperVersion).slice(0, 40) : null;
  const { data: device, error } = await supabase.rpc("browser_agent_service_pair_device", {
    p_code_hash: codeHash,
    p_token_hash: tokenHash,
    p_display_name: displayName,
    p_platform: platform,
    p_helper_version: helperVersion,
  });
  if (error) throw error;
  return { device, device_token: rawToken };
}

async function deviceOperation(req: Request, body: any) {
  const helperVersion = body?.helperVersion ? String(body.helperVersion).slice(0, 40) : null;
  const device = await authenticateDevice(req, helperVersion);
  const now = new Date().toISOString();
  if (body?.op === "device_heartbeat") return { ok: true, device: { id: device.id } };

  const { data: session, error } = await supabase.from("form_agent_sessions")
    .select("id,user_id,status,expires_at,application_id,acceptance_mode,acceptance_provider_family")
    .eq("browser_device_id", device.id)
    .eq("user_id", device.user_id)
    .in("status", ["active","needs_user","final_review","approved_for_submission","submitting"])
    .order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!session) return { ok: true, session: null };
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await supabase.from("form_agent_sessions").update({ status: "expired", completed_at: now, updated_at: now })
      .eq("id", session.id).eq("user_id", device.user_id).eq("browser_device_id", device.id);
    return { ok: true, session: null };
  }
  const formToken = randomHex(32);
  await supabase.from("form_agent_sessions").update({ token_hash: await sha256(formToken), helper_claimed_at: now, updated_at: now })
    .eq("id", session.id).eq("user_id", device.user_id).eq("browser_device_id", device.id);
  return { ok: true, session: { id: session.id, status: session.status, expires_at: session.expires_at, application_id: session.application_id, acceptance_mode: Boolean(session.acceptance_mode), acceptance_provider_family: session.acceptance_provider_family || null }, form_token: formToken };
}

function sanitizeObservation(input: any) {
  const controls = Array.isArray(input?.controls) ? input.controls.slice(0, 250).map((c: any) => {
    const sensitive = Boolean(c?.sensitive) || /(password|passcode|security answer|social security|national insurance|passport|date of birth|birth date|gender|sex|ethnicity|race|religion|disability|veteran|criminal|conviction|sexual orientation|political|trade union|clearance|citizenship|nationality)/i.test(`${c?.label || ""} ${c?.name || ""}`);
    return {
      fieldKey: String(c?.fieldKey || "").slice(0, 120), label: String(c?.label || "").slice(0, 500), name: c?.name || null, id: c?.id || null,
      role: c?.role || null, controlType: c?.controlType || "other", required: Boolean(c?.required), disabled: Boolean(c?.disabled), visible: c?.visible !== false,
      currentValue: sensitive ? null : c?.currentValue ?? null, hasValue: Boolean(c?.hasValue), options: Array.isArray(c?.options) ? c.options.slice(0, 200) : [],
      locator: c?.locator || {}, sensitive, autocomplete: c?.autocomplete || null, placeholder: c?.placeholder || null,
      optionLabel: c?.optionLabel || null, optionValue: c?.optionValue || null,
    };
  }) : [];
  return {
    url: String(input?.url || "").slice(0, 4000), title: String(input?.title || "").slice(0, 1000), bodyText: String(input?.bodyText || "").slice(0, 20000),
    ariaSnapshot: input?.ariaSnapshot ? String(input.ariaSnapshot).slice(0, 40000) : null, controls, flags: input?.flags || {}, fingerprint: String(input?.fingerprint || "").slice(0, 128),
  };
}

async function authenticate(req: Request) {
  const sessionId = req.headers.get("x-form-agent-session") || "";
  const token = req.headers.get("x-form-agent-token") || "";
  if (!sessionId || !token || !/^[0-9a-f-]{36}$/i.test(sessionId) || token.length < 40) throw new Error("Missing form-agent session credentials.");
  const tokenHash = await sha256(token);
  const { data: session, error } = await supabase.from("form_agent_sessions").select("*").eq("id", sessionId).eq("token_hash", tokenHash).maybeSingle();
  if (error) throw error;
  if (!session) throw new Error("Invalid form-agent session credentials.");
  const { data: memberActive, error: memberError } = await supabase.rpc("browser_agent_service_member_active", { p_user: session.user_id });
  if (memberError) throw memberError;
  if (memberActive !== true) throw new Error("Browser-helper owner membership is no longer active.");
  if (session.browser_device_id) {
    const device = await authenticateDevice(req, null);
    if (device.id !== session.browser_device_id || device.user_id !== session.user_id) throw new Error("Form-agent session is bound to a different browser-helper device.");
  }
  if (new Date(session.expires_at).getTime() <= Date.now() && !["submitted","cancelled"].includes(session.status)) throw new Error("Form-agent session has expired.");
  if (["cancelled","expired","failed"].includes(session.status)) throw new Error(`Form-agent session is ${session.status}.`);
  return session;
}

async function signedDocument(versionId: string | null, filename: string) {
  if (!versionId) return null;
  const { data: version, error } = await supabase.from("document_versions").select("id,structured_content,rendered_object_key,version_number").eq("id", versionId).maybeSingle();
  if (error) throw error;
  if (!version) return null;
  let url: string | null = null;
  if (version.rendered_object_key) {
    const { data, error: signedError } = await supabase.storage.from("application-documents").createSignedUrl(version.rendered_object_key, 60 * 60 * 4, { download: filename });
    if (!signedError) url = data?.signedUrl || null;
  }
  return { versionId: version.id, versionNumber: version.version_number, filename, url, structuredContent: version.structured_content || null };
}

async function buildContext(session: any) {
  const { data: app, error: appError } = await supabase.from("applications").select("id,user_id,state,job_id,job_snapshot_id,job_analysis_id,selected_cv_family,submitted_at,jobs(id,title,application_url,ats_provider,companies(canonical_name))").eq("id", session.application_id).single();
  if (appError) throw appError;
  const job: any = Array.isArray((app as any).jobs) ? (app as any).jobs[0] : (app as any).jobs;
  const companyRel: any = Array.isArray(job?.companies) ? job.companies[0] : job?.companies;
  const [{ data: pkg, error: pkgError }, { data: profile, error: profileError }, { data: salary, error: salaryError }, { data: answers, error: answersError }] = await Promise.all([
    supabase.from("application_review_packages").select("*").eq("application_id", session.application_id).single(),
    supabase.from("candidate_profiles").select("id,display_name").eq("user_id", session.user_id).single(),
    supabase.from("application_salary_contexts").select("*").eq("application_id", session.application_id).maybeSingle(),
    supabase.from("application_answers").select("id,question_key,question_text,answer_text,trust,required,approved_at,metadata").eq("application_id", session.application_id).order("created_at"),
  ]);
  if (pkgError || profileError || salaryError || answersError) throw pkgError || profileError || salaryError || answersError;
  const [{ data: facts, error: factsError }, cv, cover, reasoningResult] = await Promise.all([
    supabase.from("candidate_facts").select("id,fact_key,value_json,verification_status").eq("profile_id", profile!.id).eq("verification_status", "verified"),
    signedDocument(pkg!.cv_version_id, "cv.pdf"),
    pkg!.cover_letter_decision === "use" ? signedDocument(pkg!.cover_letter_version_id, "cover-letter.pdf") : Promise.resolve(null),
    supabase.from("browser_agent_reasoning").select("id,status,source,proposal_json,observation_id,created_at,updated_at").eq("session_id", session.id).order("created_at", { ascending: false }).limit(5),
  ]);
  if (factsError || reasoningResult.error) throw factsError || reasoningResult.error;
  const candidate = { ...(cv?.structuredContent?.candidate || {}), name: cv?.structuredContent?.candidate?.name || profile!.display_name };
  return {
    session: { id: session.id, status: session.status, expiresAt: session.expires_at, currentUrl: session.current_url, finalReview: session.final_review_json, submitCandidate: session.submit_candidate, acceptanceMode: Boolean(session.acceptance_mode), acceptanceProviderFamily: session.acceptance_provider_family || null },
    application: { id: app.id, state: app.state, company: companyRel?.canonical_name || "Unknown company", role: job?.title || "Unknown role", applicationUrl: job?.application_url || null, providerHint: job?.ats_provider || null },
    browserReasoning: (reasoningResult.data || []).map((item: any) => ({ id: item.id, status: item.status, source: item.source, proposal: item.proposal_json, observationId: item.observation_id, createdAt: item.created_at, updatedAt: item.updated_at })),
    approvedContext: {
      candidate,
      facts: (facts || []).map((f: any) => ({ id: f.id, factKey: f.fact_key, value: f.value_json, verified: true })),
      answers: (answers || []).map((a: any) => ({ id: a.id, questionKey: a.question_key, questionText: a.question_text, answerText: a.answer_text, trust: a.trust, approved: Boolean(a.approved_at) || a.trust === "verified" })),
      salary: salary ? { value: salary.recommended_value, currency: salary.currency, approved: Boolean(salary.approved_at) } : null,
      documents: { cv: cv ? { url: cv.url, filename: cv.filename, versionId: cv.versionId } : null, coverLetter: cover ? { url: cover.url, filename: cover.filename, versionId: cover.versionId } : null },
      cvContent: cv?.structuredContent || null,
      coverLetterContent: cover?.structuredContent?.paragraphs?.map((p: any) => String(p?.text || "").trim()).filter(Boolean).join("\n\n") || null,
    },
  };
}

async function insertObservation(session: any, raw: any) {
  const observation = sanitizeObservation(raw);
  const { data: last } = await supabase.from("form_agent_observations").select("sequence_number").eq("session_id", session.id).order("sequence_number", { ascending: false }).limit(1).maybeSingle();
  const sequence = Number(last?.sequence_number || 0) + 1;
  const { data, error } = await supabase.from("form_agent_observations").insert({ session_id: session.id, sequence_number: sequence, url: observation.url, title: observation.title, page_purpose: null, fingerprint: observation.fingerprint || await sha256(JSON.stringify(observation)), observation_json: observation }).select("id").single();
  if (error) throw error;
  await supabase.from("form_agent_sessions").update({ current_url: observation.url, current_title: observation.title, last_fingerprint: observation.fingerprint || null, updated_at: new Date().toISOString() }).eq("id", session.id);
  return { observation, observationId: data.id };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST required." }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const op = String(body?.op || "");

    if (op === "pair_device") return json(await pairDevice(body));
    if (op === "device_poll" || op === "device_heartbeat") return json(await deviceOperation(req, body));

    const session = await authenticate(req);
    if (op === "context") return json(await buildContext(session));
    if (op === "observation") return json(await insertObservation(session, body.observation));
    if (op === "plan") {
      if (!body.observationId || !body.plan) return json({ error: "Observation and plan are required." }, 400);
      const { data, error } = await supabase.from("form_agent_plans").insert({ session_id: session.id, observation_id: body.observationId, planner_source: String(body.plannerSource || "deterministic_v1"), plan_json: body.plan, status: body.plan.must_pause ? "paused" : "validated" }).select("id").single();
      if (error) throw error;
      return json({ planId: data.id });
    }
    if (op === "action_result") {
      const { data: plan } = await supabase.from("form_agent_plans").select("id").eq("session_id", session.id).eq("observation_id", body.observationId).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (plan) await supabase.from("form_agent_plans").update({ status: body?.result?.executed ? "action_executed" : "failed", action_result: body.result || {} }).eq("id", plan.id);
      return json({ ok: true });
    }
    if (["needs_user","resume","submission_clicked"].includes(op)) {
      const payload = op === "needs_user" ? { reasons: body.reasons || [], observation_id: body.observationId || null } : {};
      const { data, error } = await supabase.rpc("form_agent_service_transition", { p_session_id: session.id, p_operation: op, p_payload: payload });
      if (error) throw error; return json(data);
    }
    if (op === "final_review") {
      const { data, error } = await supabase.rpc("form_agent_service_transition", { p_session_id: session.id, p_operation: "final_review", p_payload: { observation_id: body.observationId, diff: body.diff || {}, submit_candidate: body.submitCandidate || null } });
      if (error) throw error; return json(data);
    }
    if (op === "acceptance_result") {
      const { data, error } = await supabase.rpc("record_form_agent_acceptance_result", {
        p_session_id: session.id,
        p_outcome: String(body.outcome || "final_review"),
        p_helper_version: body.helperVersion ? String(body.helperVersion) : null,
        p_metadata: body.metadata || {},
      });
      if (error) throw error; return json(data);
    }
    if (op === "submitted") {
      const persisted = body.observation ? await insertObservation(session, body.observation) : null;
      const { data, error } = await supabase.rpc("form_agent_service_transition", { p_session_id: session.id, p_operation: "submitted", p_payload: { submission_source: body.submissionSource || "helper", confirmation_observation_id: persisted?.observationId || null } });
      if (error) throw error; return json(data);
    }
    return json({ error: "Unsupported operation." }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, /credential|expired|pairing code/i.test(String(error)) ? 401 : 500);
  }
});
