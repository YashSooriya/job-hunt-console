const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.4";

type RpcClient = {
  rpc: (name: string, args: Record<string, unknown>) => any;
};

export type DirectInspectionRecord = {
  id: string;
  source_url: string;
  status: "queued" | "processing" | "completed" | "failed" | "user_required";
  attempt_count: number;
  error_json?: { message?: string } | null;
  job_id?: string | null;
  provider?: string | null;
  provider_response_id?: string | null;
  completed_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

const JOB_LISTING_SCHEMA = {
  type: "object",
  properties: {
    company: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    application_url: { type: ["string", "null"] },
    external_job_id: { type: ["string", "null"] },
    location: { type: ["string", "null"] },
    work_mode: { type: ["string", "null"] },
    salary_text: { type: ["string", "null"] },
    salary_min: { type: ["number", "null"] },
    salary_max: { type: ["number", "null"] },
    salary_currency: { type: ["string", "null"] },
    salary_source: { type: "string", enum: ["advertised", "chatgpt_estimate", "not_available"] },
    salary_confidence: { type: ["string", "null"], enum: ["high", "medium", "low", null] },
    salary_basis: { type: "array", items: { type: "string" } },
    posted_at: { type: ["string", "null"] },
    closes_at: { type: ["string", "null"] },
    employment_type: { type: ["string", "null"] },
    ats_provider: { type: ["string", "null"] },
    summary: { type: ["string", "null"] },
    responsibilities: { type: "array", items: { type: "string" } },
    essential_requirements: { type: "array", items: { type: "string" } },
    desirable_requirements: { type: "array", items: { type: "string" } },
    skills: { type: "array", items: { type: "string" } },
    benefits: { type: "array", items: { type: "string" } },
    application_instructions: { type: ["string", "null"] },
    company_website: { type: ["string", "null"] },
  },
  required: [
    "company", "title", "description", "application_url", "external_job_id", "location", "work_mode",
    "salary_text", "salary_min", "salary_max", "salary_currency", "salary_source", "salary_confidence",
    "salary_basis", "posted_at", "closes_at", "employment_type", "ats_provider", "summary", "responsibilities",
    "essential_requirements", "desirable_requirements", "skills", "benefits", "application_instructions", "company_website",
  ],
  additionalProperties: false,
} as const;

const INSPECTION_INSTRUCTIONS = [
  "You are the immediate JobHuntAI listing-inspection worker.",
  "Use web search to open and read the exact public job-listing URL supplied by the user. The URL is authoritative; do not substitute a similarly named vacancy.",
  "Extract only facts supported by the listing or clearly identified source evidence. Never log in, bypass access controls, apply for the job, click an application submission button, or invent missing facts.",
  "Use an advertised salary exactly when the listing gives one. If salary is absent, you may provide a clearly labelled chatgpt_estimate only when there is a defensible evidence basis; otherwise use not_available. Never describe an estimate as employer-provided.",
  "Use ISO 8601 timestamps for dates when the listing provides enough information; use null when it does not. Keep arrays concise but complete.",
  "If the exact page is blocked, private, requires login, or is not a job listing, the response should not invent a vacancy record.",
].join(" ");

function apiKey() {
  return process.env.OPENAI_API_KEY?.trim() || null;
}

export function directOpenAiInspectionConfigured() {
  return Boolean(apiKey());
}

function errorText(payload: any, fallback: string) {
  const message = payload?.error?.message || payload?.message;
  return typeof message === "string" && message.trim() ? message.trim().slice(0, 500) : fallback;
}

async function openAiRequest(path: string, init: RequestInit = {}) {
  const key = apiKey();
  if (!key) throw new Error("OPENAI_API_KEY is not configured for immediate job inspection.");
  const response = await fetch(`${OPENAI_RESPONSES_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`OpenAI inspection request failed (${response.status}): ${errorText(payload, "The OpenAI request was rejected.")}`);
  return payload as any;
}

async function rpcOrThrow(client: RpcClient, name: string, args: Record<string, unknown>) {
  const result = await client.rpc(name, args);
  if (result.error) throw new Error(result.error.message || `Supabase RPC ${name} failed.`);
  return result.data;
}

function responseText(payload: any) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  const chunks: string[] = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

function parseExtraction(payload: any) {
  const text = responseText(payload);
  if (!text) throw new Error("OpenAI completed without a structured job listing result.");
  let extraction: any;
  try {
    extraction = JSON.parse(text);
  } catch {
    throw new Error("OpenAI returned an invalid structured job listing result.");
  }
  if (!extraction || typeof extraction !== "object" || Array.isArray(extraction)) {
    throw new Error("OpenAI returned an invalid job listing object.");
  }
  if (typeof extraction.company !== "string" || typeof extraction.title !== "string" || typeof extraction.description !== "string") {
    throw new Error("OpenAI did not return the required company, title and description.");
  }
  return extraction;
}

function publicInspection(value: any): DirectInspectionRecord {
  return {
    id: String(value.id),
    source_url: String(value.source_url),
    status: value.status,
    attempt_count: Number(value.attempt_count || 0),
    error_json: value.error_json || null,
    job_id: value.job_id || null,
    completed_at: value.completed_at || null,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

export async function startImmediateOpenAiInspection(client: RpcClient, requestId: string, sourceUrl: string) {
  await rpcOrThrow(client, "start_job_url_inspection", {
    p_request_id: requestId,
    p_provider: "openai_responses",
  });

  try {
    const response = await openAiRequest("", {
      method: "POST",
      body: JSON.stringify({
        model: process.env.OPENAI_JOB_INSPECTION_MODEL?.trim() || DEFAULT_MODEL,
        background: true,
        store: true,
        tools: [{ type: "web_search_preview" }],
        tool_choice: "required",
        instructions: INSPECTION_INSTRUCTIONS,
        input: `Inspect this exact public job listing URL now: ${sourceUrl}`,
        text: {
          format: {
            type: "json_schema",
            name: "job_listing_extraction",
            description: "A complete, source-grounded extraction of one public job listing.",
            strict: true,
            schema: JOB_LISTING_SCHEMA,
          },
          verbosity: "low",
        },
        max_output_tokens: 6000,
        include: ["web_search_call.action.sources"],
        metadata: { jobhunt_inspection: requestId },
      }),
    });
    if (typeof response?.id !== "string" || !response.id) throw new Error("OpenAI did not return an inspection response id.");
    await rpcOrThrow(client, "set_job_url_inspection_response", {
      p_request_id: requestId,
      p_provider_response_id: response.id,
    });
    return { id: requestId, status: "processing" as const, provider_response_id: response.id };
  } catch (error) {
    try {
      await rpcOrThrow(client, "mark_job_url_inspection_failed", {
        p_request_id: requestId,
        p_message: error instanceof Error ? error.message : "OpenAI inspection failed.",
        p_user_required: false,
      });
    } catch {
      // Preserve the original OpenAI error for the route response.
    }
    throw error;
  }
}

export async function reconcileImmediateOpenAiInspection(client: RpcClient, inspection: DirectInspectionRecord) {
  if (inspection.status !== "processing" || inspection.provider !== "openai_responses" || !inspection.provider_response_id) {
    return inspection;
  }

  const response = await openAiRequest(`/${encodeURIComponent(inspection.provider_response_id)}`, { method: "GET" });
  const status = response?.status;
  if (["queued", "in_progress", "pending"].includes(status)) return inspection;
  if (status !== "completed") {
    const message = errorText(response, `OpenAI inspection ended with status ${status || "unknown"}.`);
    await rpcOrThrow(client, "mark_job_url_inspection_failed", {
      p_request_id: inspection.id,
      p_message: message,
      p_user_required: false,
    });
    return { ...inspection, status: "failed" as const, error_json: { message } };
  }

  const extraction = parseExtraction(response);
  const sources = Array.isArray(response?.output)
    ? response.output.flatMap((item: any) => Array.isArray(item?.action?.sources) ? item.action.sources : [])
    : [];
  const rawMetadata = {
    openai_response_id: inspection.provider_response_id,
    openai_model: typeof response?.model === "string" ? response.model : null,
    web_sources: sources.slice(0, 20),
  };
  const result = await rpcOrThrow(client, "complete_job_url_inspection", {
    p_request_id: inspection.id,
    p_extraction: { ...extraction, raw_metadata: rawMetadata },
    p_provider: "openai_responses",
    p_provider_response_id: inspection.provider_response_id,
  });
  return { ...inspection, ...result, status: "completed" as const, job_id: result?.job_id || null };
}

export { publicInspection };
