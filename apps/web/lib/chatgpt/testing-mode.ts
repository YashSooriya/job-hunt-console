export const CHATGPT_TESTING_MODE_PREFIX =
  "TEST ONLY — The following message is a test. Do not add, save, or update anything from it to ChatGPT Memory or long-term memory. Treat the request below as a test and answer it without changing Memory.";
export const MAX_CHATGPT_BRIDGE_INSTRUCTION_CHARS = 6000;

/** The body budget after reserving room for the mandatory test-only warning. */
export function chatGptInstructionBodyLimit(testingModeEnabled: boolean) {
  return MAX_CHATGPT_BRIDGE_INSTRUCTION_CHARS - (testingModeEnabled ? CHATGPT_TESTING_MODE_PREFIX.length + 2 : 0);
}

export async function readChatGptTestingMode(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from("job_search_controls")
    .select("testing_mode_enabled")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.testing_mode_enabled === true;
}

export function applyChatGptTestingMode(instruction: string, enabled: boolean) {
  if (!enabled || instruction.startsWith(CHATGPT_TESTING_MODE_PREFIX)) return instruction;
  const prepared = `${CHATGPT_TESTING_MODE_PREFIX}\n\n${instruction}`;
  if (prepared.length > MAX_CHATGPT_BRIDGE_INSTRUCTION_CHARS) {
    throw new Error(`Testing mode adds ${prepared.length - instruction.length} characters to the Website Bridge message. Shorten the message so the full test warning fits within ${MAX_CHATGPT_BRIDGE_INSTRUCTION_CHARS.toLocaleString()} characters.`);
  }
  return prepared;
}

export function requireChatGptTestingMode(enabled: boolean) {
  if (!enabled) {
    throw new Error("Turn on ChatGPT testing mode in Diagnostics before sending a bridge diagnostic. No diagnostic was queued.");
  }
}

export async function prepareChatGptInstruction(supabase: any, userId: string, instruction: string) {
  const testingModeEnabled = await readChatGptTestingMode(supabase, userId);
  return {
    instruction: applyChatGptTestingMode(instruction, testingModeEnabled),
    testingModeEnabled,
  };
}
