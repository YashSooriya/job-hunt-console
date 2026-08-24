export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const MCP_TOOLS = [
  {
    name: "get_candidate_profile",
    description: "Read the authenticated user's private candidate profile, facts, evidence and preferences.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_search_preferences",
    description: "Read the authenticated user's job-search preferences and enabled CV families.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_pending_work",
    description: "Read the authenticated user's pending ChatGPT work items and recent reasoning results.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_application_context",
    description: "Read one of the authenticated user's frozen application contexts.",
    inputSchema: {
      type: "object",
      properties: { application_id: { type: "string", description: "Application UUID." } },
      required: ["application_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_verified_evidence",
    description: "Read only verified evidence items belonging to the authenticated user.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_reusable_answers",
    description: "Read non-sensitive, verified reusable screening answers belonging to the authenticated user.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_browser_agent_question_context",
    description: "Read the authenticated user's browser-helper sessions that are active or waiting for a user answer.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "save_discovered_job",
    description: "Persist a discovered vacancy to the authenticated user's private job inbox. It does not approve or submit an application.",
    inputSchema: {
      type: "object",
      properties: {
        company: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        source_url: { type: "string" },
        application_url: { type: "string" },
        external_job_id: { type: "string" },
        location: { type: "string" },
        work_mode: { type: "string" },
        salary_text: { type: "string" },
        salary_min: { type: "number" },
        salary_max: { type: "number" },
        salary_currency: { type: "string" },
        posted_at: { type: "string" },
        closes_at: { type: "string" },
        employment_type: { type: "string" },
        ats_provider: { type: "string" },
        dedupe_key: { type: "string" },
        raw_metadata: { type: "object" },
      },
      required: ["company", "title"],
      additionalProperties: true,
    },
  },
  {
    name: "save_job_analysis",
    description: "Persist a structured job analysis for an authenticated user's vacancy without changing human verification state.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        model: { type: "string" },
        eligibility: { type: "string", enum: ["eligible", "eligible_with_concerns", "unknown", "ineligible"] },
        eligibility_notes: { type: "array", items: { type: "string" } },
        fit_score: { type: "number", minimum: 0, maximum: 100 },
        priority_score: { type: "number", minimum: 0, maximum: 100 },
        fit_components: { type: "object" },
        priority_components: { type: "object" },
        recommended_cv_family: { type: "string" },
        strengths: { type: "array" },
        weaknesses: { type: "array" },
        application_strategy: { type: "string" },
        cover_letter_value: { type: "string" },
        evidence_item_ids: { type: "array", items: { type: "string" } },
        triage: { type: "string", enum: ["auto_prepare", "recommend", "maybe", "reject"] },
        triage_reason: { type: "string" },
        requirements: { type: "array" },
      },
      required: ["job_id", "eligibility", "fit_score", "priority_score"],
      additionalProperties: true,
    },
  },
  {
    name: "save_application_package",
    description: "Persist a preparation package for a discovered vacancy. Human Gate 1 remains required.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        selected_cv_family: { type: "string" },
        strategy_text: { type: "string" },
        package: { type: "object" },
        notes: { type: "string" },
        state: { type: "string", enum: ["preparing", "shortlisted", "discovered"] },
      },
      required: ["job_id"],
      additionalProperties: true,
    },
  },
  {
    name: "report_user_required_question",
    description: "Create a private user-required work item when ChatGPT cannot safely infer an answer.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        context: { type: "object" },
        idempotency_key: { type: "string" },
      },
      required: ["question"],
      additionalProperties: true,
    },
  },
  {
    name: "queue_application_for_review",
    description: "Queue a private human Gate 1 review request. This never approves content and never submits an employer form.",
    inputSchema: {
      type: "object",
      properties: {
        application_id: { type: "string" },
        idempotency_key: { type: "string" },
        note: { type: "string" },
      },
      required: ["application_id"],
      additionalProperties: true,
    },
  },
  {
    name: "save_reasoning_result",
    description: "Save a harmless, auditable reasoning result to the authenticated user's private workspace.",
    inputSchema: {
      type: "object",
      properties: {
        result_kind: { type: "string" },
        result: { type: "object" },
        provenance: { type: "object" },
        model: { type: "string" },
        work_item_id: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["result_kind", "result"],
      additionalProperties: true,
    },
  },
  {
    name: "mark_work_item_complete",
    description: "Mark one of the authenticated user's ChatGPT work items complete.",
    inputSchema: {
      type: "object",
      properties: { work_item_id: { type: "string" }, output: { type: "object" } },
      required: ["work_item_id"],
      additionalProperties: true,
    },
  },
  {
    name: "mark_work_item_failed",
    description: "Mark one of the authenticated user's ChatGPT work items failed with a safe error record.",
    inputSchema: {
      type: "object",
      properties: { work_item_id: { type: "string" }, error: { type: "object" }, message: { type: "string" } },
      required: ["work_item_id"],
      additionalProperties: true,
    },
  },
] as const;

export const READ_TOOLS = new Set(MCP_TOOLS.slice(0, 7).map((tool) => tool.name));
export const WRITE_TOOLS = new Set(MCP_TOOLS.slice(7).map((tool) => tool.name));
