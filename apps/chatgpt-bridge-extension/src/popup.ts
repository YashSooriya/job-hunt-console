import { CONVERSATION_SLOT_DEFINITIONS, DEFAULT_WORKFLOW_SETUP_COOLDOWN_SECONDS, MAX_WORKFLOW_SETUP_COOLDOWN_SECONDS, MIN_WORKFLOW_SETUP_COOLDOWN_SECONDS, isCapturedResultUploadRetryCandidate, type ActiveDispatch, type BridgeServerCapabilities, type ConversationSlot, type ConversationSlotKey, type WorkflowSetupStatus } from "./shared/protocol";

type ExtensionStatus = {
  ok?: boolean;
  extensionVersion?: string;
  extensionBuildId?: string;
  paired?: boolean;
  backendUrl?: string;
  bridgeServerCapabilities?: BridgeServerCapabilities;
  projectUrl?: string | null;
  conversationSlots?: ConversationSlot[];
  boundConversationUrl?: string | null;
  boundProjectName?: string | null;
  boundProjectVerified?: boolean;
  automaticSendEnabled?: boolean;
  workflowSetupCooldownSeconds?: number;
  uiOperationPending?: number;
  activeRequestId?: string | null;
  activeDispatch?: ActiveDispatch | null;
  dispatchRecords?: Record<string, ActiveDispatch>;
  generationConcurrency?: number;
  generationBackoffUntil?: string | null;
  workflowSetup?: WorkflowSetupStatus;
  lastError?: string | null;
  lastHeartbeatAt?: string | null;
  lastHeartbeatError?: string | null;
  lastDispatchId?: string | null;
  lastDispatchAt?: string | null;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusText = $("statusText");
const statusDetails = $("statusDetails");
const capacityStatus = $("capacityStatus");
const activeDispatches = $("activeDispatches");
const backendUrl = $("backendUrl") as HTMLInputElement;
const pairingCode = $("pairingCode") as HTMLInputElement;
const displayName = $("displayName") as HTMLInputElement;
const workflowKey = $("workflowKey") as HTMLSelectElement;
const workflowSetupCooldownSeconds = $("workflowSetupCooldownSeconds") as HTMLInputElement;
const slotStatus = $("slotStatus");
const pairButton = $("pairButton") as HTMLButtonElement;
const setupButton = $("setupButton") as HTMLButtonElement;
const rotateButton = $("rotateButton") as HTMLButtonElement;
const bindButton = $("bindButton") as HTMLButtonElement;
const openButton = $("openButton") as HTMLButtonElement;
const retryButton = $("retryButton") as HTMLButtonElement;
const recoveryHelp = $("recoveryHelp");
const forgetButton = $("forgetButton") as HTMLButtonElement;
let latestStatus: ExtensionStatus | null = null;
let retryFeedback: { message: string; error: boolean; expiresAt: number } | null = null;

function send(message: unknown): Promise<any> {
  return chrome.runtime.sendMessage(message);
}

function showStatus(message: string, error = false) {
  statusText.textContent = message;
  statusText.className = error ? "status error" : "status";
}

function formatDate(value?: string | null) {
  if (!value) return "never";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function selectedKey() {
  return workflowKey.value as ConversationSlotKey;
}

function selectedDefinition() {
  return CONVERSATION_SLOT_DEFINITIONS.find((definition) => definition.key === selectedKey()) || CONVERSATION_SLOT_DEFINITIONS[0];
}

function selectedSlot(status: ExtensionStatus) {
  return (status.conversationSlots || []).find((slot) => slot.workflowKey === selectedKey()) || null;
}

function setupLabel(setup?: WorkflowSetupStatus) {
  if (!setup || setup.state === "idle") return "not started";
  if (setup.state === "running") return `running${setup.currentKey ? ` · ${CONVERSATION_SLOT_DEFINITIONS.find((definition) => definition.key === setup.currentKey)?.label || setup.currentKey}` : ""}`;
  if (setup.state === "complete") return "complete";
  return `paused${setup.error ? ` · ${setup.error}` : ""}`;
}

function dispatchPhaseLabel(phase?: ActiveDispatch["phase"]) {
  if (phase === "send_authorized" || phase === "send_ambiguous") return "Confirming delivery";
  if (phase === "sent_confirmed" || phase === "watching") return "Waiting for ChatGPT";
  if (phase === "result_pending") return "Answer captured; saving result";
  if (phase === "preparing") return "Preparing ChatGPT";
  if (phase === "claimed") return "Claimed";
  return phase || "Active";
}

function relativeDeadline(value?: string | null) {
  if (!value) return "none";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  if (seconds <= 0) return "due now";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)}m`;
}

function renderCapacity(status: ExtensionStatus) {
  const backoffUntil = status.generationBackoffUntil || null;
  const backoffActive = Boolean(backoffUntil && Date.parse(backoffUntil) > Date.now());
  const limit = backoffActive ? 1 : Math.max(1, Math.min(2, status.generationConcurrency || 2));
  capacityStatus.textContent = backoffActive
    ? `Reduced capacity: ${limit} generation until ${formatDate(backoffUntil)} (rate-limit recovery)`
    : `Capacity: ${limit} concurrent generation${limit === 1 ? "" : "s"}`;
  const records = Object.values(status.dispatchRecords || {})
    .filter((record) => record.phase !== "terminal")
    .slice(0, 2);
  if (!records.length) {
    activeDispatches.textContent = "No active workflow requests.";
    return;
  }
  const lines = records.map((record) => {
    const deadline = record.sentVerified
      ? `response deadline ${relativeDeadline(record.responseDeadlineAt)}`
      : `delivery deadline ${relativeDeadline(record.deliveryDeadlineAt)}`;
    const upload = record.resultUploadBlocked
      ? " · result upload stopped for manual recovery"
      : record.phase === "result_pending" || Boolean(record.capturedResponse) ? " · result upload pending" : "";
    return `${record.displayTitle || record.workflowKey}: ${dispatchPhaseLabel(record.phase)} · ${deadline}${upload}`;
  });
  const total = Object.values(status.dispatchRecords || {}).filter((record) => record.phase !== "terminal").length;
  if (total > records.length) lines.push(`+ ${total - records.length} more active request${total - records.length === 1 ? "" : "s"}`);
  activeDispatches.textContent = lines.join("\n");
}

function render(status: ExtensionStatus) {
  latestStatus = status;
  backendUrl.value = status.backendUrl || backendUrl.value;
  const cooldownSeconds = status.workflowSetupCooldownSeconds ?? DEFAULT_WORKFLOW_SETUP_COOLDOWN_SECONDS;
  workflowSetupCooldownSeconds.value = String(cooldownSeconds);
  const slots = status.conversationSlots || [];
  const selected = selectedSlot(status);
  const active = status.activeDispatch;
  renderCapacity(status);
  if (!status.paired) showStatus("Not paired");
  else if (status.workflowSetup?.state === "running") showStatus("Setting up workflow conversations…");
  else if (status.workflowSetup?.state === "partial") showStatus("Workflow setup paused · review the safe-stop message", true);
  else if (active?.sentVerified) showStatus("Waiting for ChatGPT response…");
  else if (slots.length === 0) showStatus("Paired · set up workflow conversations");
  else if (!status.automaticSendEnabled) showStatus("Paired · Automatic Send is off");
  else showStatus("Ready · Automatic Send is on");
  slotStatus.textContent = selected ? `Bound: ${selected.conversationUrl}` : `Not bound yet. Setup can create this ${selectedDefinition().label.toLowerCase()} chat automatically.`;
  statusDetails.textContent = [
    `Extension version: ${status.extensionVersion || "unknown"}`,
    `Extension build: ${status.extensionBuildId || "unknown"}`,
    `Result-completion backend: ${status.bridgeServerCapabilities?.result_completion_v3 === true && status.bridgeServerCapabilities?.response_provenance_v3 === true ? "v3 ready" : "v3 not advertised"}`,
    `Selected workflow: ${selectedDefinition().label}`,
    selected ? `Selected conversation: ${selected.conversationUrl}` : "Selected conversation: none",
    slots.length ? `Bound workflows: ${slots.map((slot) => slot.displayName).join(", ")}` : "Bound workflows: none",
    `Workflow-chat setup pause: ${cooldownSeconds} second${cooldownSeconds === 1 ? "" : "s"} (only when 3+ new chats are needed)`,
    active?.sentVerified
      ? `Active delivery: waiting for ChatGPT to finish${active.displayTitle ? ` · ${active.displayTitle}` : ""}`
      : active
        ? `Active delivery: verifying the one-time send${active.displayTitle ? ` · ${active.displayTitle}` : ""}`
        : "Active delivery: none",
    `ChatGPT UI queue: ${(status.uiOperationPending || 0) > 0 ? `${status.uiOperationPending} operation${status.uiOperationPending === 1 ? "" : "s"} pending` : "idle"}`,
    `Last heartbeat: ${formatDate(status.lastHeartbeatAt)}`,
    status.lastHeartbeatError ? `Heartbeat error: ${status.lastHeartbeatError}` : "Heartbeat: healthy or not yet attempted",
    `Setup: ${setupLabel(status.workflowSetup)}`,
    `Last dispatch: ${status.lastDispatchId ? `${status.lastDispatchId} · ${formatDate(status.lastDispatchAt)}` : "none"}`,
    status.lastError ? `Last safe stop: ${status.lastError}` : "No recent safe-stop error",
  ].join("\n");
  retryButton.dataset.requestId = status.lastDispatchId || "";
  const lastRecord = status.lastDispatchId ? status.dispatchRecords?.[status.lastDispatchId] : undefined;
  const retryCapturedResult = isCapturedResultUploadRetryCandidate(lastRecord);
  retryButton.dataset.retryKind = retryCapturedResult ? "captured_result" : "dispatch";
  retryButton.textContent = retryCapturedResult ? "Retry saved result upload" : "Retry last dispatch";
  recoveryHelp.textContent = retryCapturedResult
    ? "The assistant response is already captured. This retries only the saved result upload and will not send another ChatGPT message."
    : "If a delivery is ambiguous, the bridge stops and never resends automatically. Use Retry only after checking the ChatGPT conversation.";
  const uiBusy = (status.uiOperationPending || 0) > 0;
  pairButton.disabled = uiBusy;
  setupButton.textContent = slots.length === 0 ? "Set up JobHuntAI + workflow chats" : "Set up missing workflow chats";
  // Setup is also the repair action: it must remain available when every
  // local slot exists so the bound URLs can be checked for deleted chats.
  setupButton.disabled = !status.paired || status.workflowSetup?.state === "running" || uiBusy;
  rotateButton.disabled = !status.paired || status.workflowSetup?.state === "running" || uiBusy;
  bindButton.disabled = !status.paired || uiBusy;
  openButton.disabled = !selected || uiBusy;
  retryButton.disabled = !status.lastDispatchId || !status.paired || uiBusy;
  forgetButton.disabled = !status.paired || uiBusy;
  if (retryFeedback) {
    if (retryFeedback.expiresAt > Date.now()) showStatus(retryFeedback.message, retryFeedback.error);
    else retryFeedback = null;
  }
}

async function refresh() {
  const result = await send({ type: "GET_EXTENSION_STATUS" });
  if (!result?.ok) throw new Error(result?.reason || "Unable to read extension status.");
  render(result);
}

for (const definition of CONVERSATION_SLOT_DEFINITIONS) {
  if (![...workflowKey.options].some((option) => option.value === definition.key)) {
    workflowKey.add(new Option(definition.label, definition.key));
  }
}

workflowKey.addEventListener("change", () => { if (latestStatus) render(latestStatus); });

pairButton.addEventListener("click", async () => {
  pairButton.disabled = true;
  try {
    const result = await send({ type: "PAIR_EXTENSION", backendUrl: backendUrl.value, pairingCode: pairingCode.value, displayName: displayName.value || "JobHuntAI ChatGPT Bridge" });
    if (!result?.ok) throw new Error(result?.reason || "Pairing failed.");
    pairingCode.value = "";
    showStatus("Paired · set up workflow conversations");
    await refresh();
  } catch (error) { showStatus(error instanceof Error ? error.message : "Pairing failed.", true); }
  finally { pairButton.disabled = false; }
});

setupButton.addEventListener("click", async () => {
  setupButton.disabled = true;
  showStatus("Setting up JobHuntAI automatically…");
  try {
    const result = await send({ type: "SET_UP_WORKFLOW_CONVERSATIONS" });
    if (!result?.ok) throw new Error(result?.reason || "Automatic workflow setup stopped.");
    showStatus(result.started ? "Workflow setup started · ChatGPT will finish it automatically" : "Workflow conversations are ready · Automatic Send is on");
    await refresh();
  } catch (error) { showStatus(error instanceof Error ? error.message : "Automatic workflow setup stopped.", true); }
  finally { setupButton.disabled = false; await refresh().catch(() => undefined); }
});

rotateButton.addEventListener("click", async () => {
  if (!window.confirm(`Create a fresh ${selectedDefinition().label.toLowerCase()} chat and replace only this workflow's conversation? Automatic Send remains enabled.`)) return;
  rotateButton.disabled = true;
  try {
    const result = await send({ type: "ROTATE_WORKFLOW_CONVERSATION", workflowKey: selectedKey() });
    if (!result?.ok) throw new Error(result?.reason || "Workflow rotation stopped.");
    showStatus(result.started ? `Fresh ${selectedDefinition().label.toLowerCase()} chat setup started` : `Fresh ${selectedDefinition().label.toLowerCase()} chat is ready · Automatic Send is on`);
    await refresh();
  } catch (error) { showStatus(error instanceof Error ? error.message : "Workflow rotation stopped.", true); }
  finally { rotateButton.disabled = false; await refresh().catch(() => undefined); }
});

bindButton.addEventListener("click", async () => {
  bindButton.disabled = true;
  try {
    const result = await send({ type: "BIND_CURRENT_CONVERSATION", workflowKey: selectedKey() });
    if (!result?.ok) throw new Error(result?.reason || "Binding failed.");
    showStatus(`Bound ${selectedDefinition().label} · Automatic Send is on`);
    await refresh();
  } catch (error) { showStatus(error instanceof Error ? error.message : "Binding failed.", true); }
  finally { bindButton.disabled = false; }
});

openButton.addEventListener("click", async () => {
  const result = await send({ type: "OPEN_BOUND_CONVERSATION", workflowKey: selectedKey() });
  if (!result?.ok) showStatus(result?.reason || "Unable to open the selected workflow conversation.", true);
});

workflowSetupCooldownSeconds.addEventListener("change", async () => {
  const previous = latestStatus?.workflowSetupCooldownSeconds ?? DEFAULT_WORKFLOW_SETUP_COOLDOWN_SECONDS;
  const seconds = Number(workflowSetupCooldownSeconds.value);
  workflowSetupCooldownSeconds.disabled = true;
  try {
    if (!Number.isFinite(seconds) || seconds < MIN_WORKFLOW_SETUP_COOLDOWN_SECONDS || seconds > MAX_WORKFLOW_SETUP_COOLDOWN_SECONDS) {
      throw new Error(`Choose a workflow setup pause from ${MIN_WORKFLOW_SETUP_COOLDOWN_SECONDS} to ${MAX_WORKFLOW_SETUP_COOLDOWN_SECONDS} seconds.`);
    }
    const result = await send({ type: "SET_WORKFLOW_SETUP_COOLDOWN", seconds });
    if (!result?.ok) throw new Error(result?.reason || "Unable to save the workflow setup pause.");
    await refresh();
  } catch (error) {
    workflowSetupCooldownSeconds.value = String(previous);
    showStatus(error instanceof Error ? error.message : "Unable to save the workflow setup pause.", true);
  } finally { workflowSetupCooldownSeconds.disabled = false; }
});

retryButton.addEventListener("click", async () => {
  retryButton.disabled = true;
  let feedback = "";
  let feedbackIsError = false;
  try {
    const uploadOnly = retryButton.dataset.retryKind === "captured_result";
    const result = await send({ type: uploadOnly ? "RETRY_CAPTURED_RESULT" : "RETRY_DISPATCH", requestId: retryButton.dataset.requestId });
    if (!result?.accepted && !result?.ok) throw new Error(result?.reason || "Retry was not accepted.");
    feedback = uploadOnly
      ? result.alreadyCompleted ? "The saved result was already uploaded; local recovery is cleared." : "Saved result uploaded. No ChatGPT message was sent."
      : "Retry claimed by the bridge.";
  } catch (error) {
    feedback = error instanceof Error ? error.message : "Retry failed.";
    feedbackIsError = true;
  } finally {
    if (feedback) retryFeedback = { message: feedback, error: feedbackIsError, expiresAt: Date.now() + 15000 };
    await refresh().catch(() => { retryButton.disabled = false; });
    if (feedback) showStatus(feedback, feedbackIsError);
  }
});

forgetButton.addEventListener("click", async () => {
  if (!window.confirm("Forget this browser's local bridge credential? Revoke the device in JobHuntAI Settings as well.")) return;
  const result = await send({ type: "FORGET_LOCAL_PAIRING" });
  if (!result?.ok) showStatus(result?.reason || "Unable to forget local pairing.", true);
  else { showStatus("Local pairing forgotten"); await refresh(); }
});

void refresh().catch((error) => showStatus(error instanceof Error ? error.message : "Extension unavailable.", true));
setInterval(() => { void refresh().catch(() => undefined); }, 5000);
