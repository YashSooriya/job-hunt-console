import {
  buildChatGptMemorySummaryInstruction,
  buildProfessionalBackgroundInstructions,
  buildProfessionalBackgroundSourceInstructions,
  type ProfessionalBackgroundInput,
  type ProfessionalBackgroundSourceTask,
} from "@/lib/chatgpt/professional-background";
import { instructionIdempotencyKey } from "@/lib/chatgpt/idempotency";
import { applyChatGptTestingMode, chatGptInstructionBodyLimit, readChatGptTestingMode } from "@/lib/chatgpt/testing-mode";

type JsonRecord = Record<string, any>;

type Dispatch = JsonRecord;

type SourceDocument = JsonRecord;

export type QueuedProfessionalBackgroundImport = {
  dispatches: Dispatch[];
  sourceTasks: ProfessionalBackgroundSourceTask[];
  summaryDispatch: Dispatch | null;
};

// Keep the structured-profile request on a new idempotency namespace whenever
// its delivery contract changes. This prevents an older summary request (which
// had no dependency barrier) from being mistaken for the current flow.
export const PROFESSIONAL_BACKGROUND_SUMMARY_KEY_PREFIX = "profile.memory.summary:v3";

function linkedInContextSource(linkedinUrl: string): SourceDocument {
  return {
    id: "linkedin-profile",
    original_name: "LinkedIn profile URL",
    source_type: "linkedin_profile",
    source_url: linkedinUrl,
  };
}

function sourceVersion(source: SourceDocument | undefined) {
  if (!source) return "current";
  // Signed URLs are regenerated on every Save. Use the immutable content
  // hash when available so saving an unchanged source bundle reuses the same
  // idempotent dispatch instead of creating another ChatGPT message.
  const value = source.sha256 || source.updated_at || source.created_at;
  return String(value || "current").replace(/[^A-Za-z0-9]/g, "").slice(0, 36) || "current";
}

async function sourceTaskIdempotencyKey(
  task: ProfessionalBackgroundSourceTask,
  source: SourceDocument | undefined,
  allowMemoryUpdate: boolean,
  testingModeEnabled: boolean,
) {
  const mode = testingModeEnabled ? "test-context" : allowMemoryUpdate ? "memory" : "context";
  // The Memory and context-only modes must never share an idempotency key. A
  // context-only request created by an older build is not evidence that the
  // authorised Memory update was delivered.
  if (task.idempotencyKeyMaterial) {
    return instructionIdempotencyKey(`profile.background.${mode}.source`, task.idempotencyKeyMaterial);
  }
  if (source?.id && source?.updated_at) {
    return `profile.background:${mode}:source:${String(source.id)}:${sourceVersion(source)}:${task.part}`;
  }
  return instructionIdempotencyKey(`profile.background.${mode}.source`, task.instruction);
}

async function legacySourceTaskIdempotencyKey(task: ProfessionalBackgroundSourceTask, source: SourceDocument | undefined) {
  // This is the pre-barrier key used by the first source-first implementation.
  // It is accepted only for a safe in-place upgrade of an undelivered request.
  if (source?.id && source?.updated_at) {
    return `profile.background:source:${String(source.id)}:${sourceVersion(source)}:${task.part}`;
  }
  return instructionIdempotencyKey("profile.background.source", task.instruction);
}

async function summaryIdempotencyKey(profileId: string, sourceTasks: ProfessionalBackgroundSourceTask[], summaryInstruction: string) {
  const instruction = [
    profileId,
    PROFESSIONAL_BACKGROUND_SUMMARY_KEY_PREFIX,
    summaryInstruction,
    ...sourceTasks.map((task) => `${task.sourceId}:${task.part}/${task.parts}:${task.idempotencyKeyMaterial || task.instruction}`),
  ].join("\n\n");
  return instructionIdempotencyKey(PROFESSIONAL_BACKGROUND_SUMMARY_KEY_PREFIX, instruction);
}

async function createDispatch(supabase: any, values: {
  displayTitle: string;
  idempotencyKey: string;
  priority: number;
  instruction: string;
  dependencyRequestIds?: string[];
  legacyIdempotencyKey?: string | null;
}) {
  const { data, error } = await supabase.rpc("create_chatgpt_dispatch_request_with_dependencies", {
    p_action_type: "profile.background",
    p_subject_refs: {},
    p_origin: "user_click",
    p_display_title: values.displayTitle,
    p_idempotency_key: values.idempotencyKey,
    p_priority: values.priority,
    p_website_instruction: values.instruction,
    p_dependency_request_ids: values.dependencyRequestIds || [],
    p_legacy_idempotency_key: values.legacyIdempotencyKey || null,
  });
  if (error) throw error;
  return data as Dispatch;
}

export async function queueProfessionalBackgroundInstructions(args: {
  supabase: any;
  userId: string;
  input: ProfessionalBackgroundInput;
  displayTitle: string;
  idempotencyKeyPrefix: string;
  priority: number;
}) {
  const testingModeEnabled = await readChatGptTestingMode(args.supabase, args.userId);
  const promptInput = testingModeEnabled ? { ...args.input, allowMemoryUpdate: false } : args.input;
  const tasks = buildProfessionalBackgroundInstructions(promptInput, chatGptInstructionBodyLimit(testingModeEnabled)).map((task) => ({
    ...task,
    instruction: applyChatGptTestingMode(task.instruction, testingModeEnabled),
  }));
  const dispatches: Dispatch[] = [];
  let dependencyRequestIds: string[] = [];
  for (const task of tasks) {
    const dispatch = await createDispatch(args.supabase, {
      displayTitle: tasks.length > 1 ? `${args.displayTitle} (${task.part}/${task.parts})` : args.displayTitle,
      idempotencyKey: await instructionIdempotencyKey(`${args.idempotencyKeyPrefix}:part:${task.part}`, task.instruction),
      priority: args.priority,
      instruction: task.instruction,
      dependencyRequestIds,
    });
    if (!dispatch?.id) throw new Error("The Website Bridge did not return a profile update request.");
    dispatches.push(dispatch);
    // A later profile part must not reach ChatGPT until the previous part has
    // completed. This preserves the profile in order without adding a fixed
    // client-side sleep between messages.
    dependencyRequestIds = [String(dispatch.id)];
  }
  return dispatches;
}

export async function queueProfessionalBackgroundImport(args: {
  supabase: any;
  userId: string;
  profileId: string;
  displayName: string;
  sourceDocuments: SourceDocument[];
  linkedinUrl?: string | null;
  allowMemoryUpdate: boolean;
  includeJsonProfile: boolean;
}) : Promise<QueuedProfessionalBackgroundImport> {
  const testingModeEnabled = await readChatGptTestingMode(args.supabase, args.userId);
  // Testing mode is deliberately non-mutating: even a normally authorised
  // Memory action becomes a context-only dry run while the diagnostic switch
  // is on. The warning is included in every source and summary dispatch.
  const allowMemoryUpdate = args.allowMemoryUpdate && !testingModeEnabled;
  const promptLimit = chatGptInstructionBodyLimit(testingModeEnabled);
  const preparedDocuments = await Promise.all(args.sourceDocuments.map(async (source) => {
    if (source.source_type === "chatgpt_memory") return source;
    if (typeof source.source_url === "string" && /^https?:\/\//i.test(source.source_url)) return source;
    const storageKey = typeof source.storage_object_key === "string" ? source.storage_object_key : "";
    if (!storageKey) return source;
    const { data, error } = await args.supabase.storage
      .from("candidate-source-documents")
      .createSignedUrl(storageKey, 2 * 60 * 60);
    if (error || !data?.signedUrl) throw new Error("Could not prepare a source document for ChatGPT.");
    return { ...source, source_url: data.signedUrl };
  }));
  const contextDocuments = [
    ...preparedDocuments,
    ...(args.linkedinUrl ? [linkedInContextSource(args.linkedinUrl)] : []),
  ];
  const sourceTasks = buildProfessionalBackgroundSourceInstructions({
    displayName: args.displayName,
    sourceDocuments: contextDocuments,
    allowMemoryUpdate,
    includeJsonProfile: args.includeJsonProfile && allowMemoryUpdate,
  }, promptLimit).map((task) => ({
    ...task,
    instruction: applyChatGptTestingMode(task.instruction, testingModeEnabled),
  }));
  const dispatches: Dispatch[] = [];
  const combinedMemoryAndProfile = allowMemoryUpdate
    && args.includeJsonProfile
    && sourceTasks.length === 1
    && sourceTasks[0]?.includesJsonProfile === true;

  if (combinedMemoryAndProfile) {
    // The normal path is one Website Bridge message: ChatGPT reads all source
    // links, updates Memory, creates/downloads the JSON, and returns the same
    // JSON for the bridge to import. This removes the unnecessary second chat
    // message while preserving automatic response/artifact capture.
    const task = sourceTasks[0];
    const dispatch = await createDispatch(args.supabase, {
      displayTitle: "Update Memory and create structured professional profile",
      idempotencyKey: await summaryIdempotencyKey(args.profileId, sourceTasks, task.instruction),
      priority: 50,
      instruction: task.instruction,
    });
    dispatches.push(dispatch);
    return { dispatches, sourceTasks, summaryDispatch: dispatch };
  }

  for (const task of sourceTasks) {
    const source = contextDocuments.find((item) => String(item.id || "") === task.sourceId);
    const dispatch = await createDispatch(args.supabase, {
      displayTitle: `Remember source bundle ${task.part}/${task.parts}`,
      idempotencyKey: await sourceTaskIdempotencyKey(task, source, allowMemoryUpdate, testingModeEnabled),
      priority: 70,
      instruction: task.instruction,
      legacyIdempotencyKey: allowMemoryUpdate && source?.id
        ? await legacySourceTaskIdempotencyKey(task, source)
        : null,
    });
    dispatches.push(dispatch);
  }

  let summaryDispatch: Dispatch | null = null;
  if (args.includeJsonProfile) {
    const summaryInstruction = applyChatGptTestingMode(
      buildChatGptMemorySummaryInstruction(allowMemoryUpdate),
      testingModeEnabled,
    );
    if (summaryInstruction.length > 6000) throw new Error("The professional-profile summary instruction exceeds the Website Bridge limit.");
    summaryDispatch = await createDispatch(args.supabase, {
      displayTitle: "Create structured professional profile",
      idempotencyKey: await summaryIdempotencyKey(args.profileId, sourceTasks, summaryInstruction),
      // The database also enforces this dependency list. Priority is retained
      // as a useful queue hint, but it is no longer the correctness mechanism.
      priority: 40,
      instruction: summaryInstruction,
      dependencyRequestIds: dispatches.map((item) => String(item?.id || "")).filter(Boolean),
    });
    dispatches.push(summaryDispatch);
  }

  return { dispatches, sourceTasks, summaryDispatch };
}

export { linkedInContextSource };
