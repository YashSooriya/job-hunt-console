import { CONVERSATION_SLOT_DEFINITIONS, type ConversationSlot, type ConversationSlotKey, type WorkflowSetupStatus } from "./shared/protocol";

type ExtensionStatus = {
  ok?: boolean;
  paired?: boolean;
  backendUrl?: string;
  projectUrl?: string | null;
  conversationSlots?: ConversationSlot[];
  boundConversationUrl?: string | null;
  boundProjectName?: string | null;
  boundProjectVerified?: boolean;
  automaticSendEnabled?: boolean;
  workflowSetup?: WorkflowSetupStatus;
  lastError?: string | null;
  lastDispatchId?: string | null;
  lastDispatchAt?: string | null;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusText = $("statusText");
const statusDetails = $("statusDetails");
const backendUrl = $("backendUrl") as HTMLInputElement;
const pairingCode = $("pairingCode") as HTMLInputElement;
const displayName = $("displayName") as HTMLInputElement;
const workflowKey = $("workflowKey") as HTMLSelectElement;
const slotStatus = $("slotStatus");
const automaticSend = $("automaticSend") as HTMLInputElement;
const pairButton = $("pairButton") as HTMLButtonElement;
const setupButton = $("setupButton") as HTMLButtonElement;
const bindButton = $("bindButton") as HTMLButtonElement;
const openButton = $("openButton") as HTMLButtonElement;
const retryButton = $("retryButton") as HTMLButtonElement;
const forgetButton = $("forgetButton") as HTMLButtonElement;
let latestStatus: ExtensionStatus | null = null;

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

function render(status: ExtensionStatus) {
  latestStatus = status;
  backendUrl.value = status.backendUrl || backendUrl.value;
  automaticSend.checked = status.automaticSendEnabled === true;
  const slots = status.conversationSlots || [];
  const selected = selectedSlot(status);
  if (!status.paired) showStatus("Not paired");
  else if (status.workflowSetup?.state === "running") showStatus("Setting up workflow conversations…");
  else if (status.workflowSetup?.state === "partial") showStatus("Workflow setup paused · review the safe-stop message", true);
  else if (slots.length === 0) showStatus("Paired · set up workflow conversations");
  else if (!status.automaticSendEnabled) showStatus("Bound · Automatic Send is off");
  else showStatus("Ready · Automatic Send is on");
  slotStatus.textContent = selected ? `Bound: ${selected.conversationUrl}` : `Not bound yet. Setup can create this ${selectedDefinition().label.toLowerCase()} chat automatically.`;
  statusDetails.textContent = [
    `Selected workflow: ${selectedDefinition().label}`,
    selected ? `Selected conversation: ${selected.conversationUrl}` : "Selected conversation: none",
    slots.length ? `Bound workflows: ${slots.map((slot) => slot.displayName).join(", ")}` : "Bound workflows: none",
    `Setup: ${setupLabel(status.workflowSetup)}`,
    `Last dispatch: ${status.lastDispatchId ? `${status.lastDispatchId} · ${formatDate(status.lastDispatchAt)}` : "none"}`,
    status.lastError ? `Last safe stop: ${status.lastError}` : "No recent safe-stop error",
  ].join("\n");
  retryButton.dataset.requestId = status.lastDispatchId || "";
  pairButton.disabled = false;
  setupButton.disabled = !status.paired || status.workflowSetup?.state === "running" || slots.length === CONVERSATION_SLOT_DEFINITIONS.length;
  bindButton.disabled = !status.paired;
  openButton.disabled = !selected;
  automaticSend.disabled = !status.paired || slots.length === 0;
  retryButton.disabled = !status.lastDispatchId || !status.paired || !status.automaticSendEnabled;
  forgetButton.disabled = !status.paired;
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
    const result = await send({ type: "PAIR_EXTENSION", backendUrl: backendUrl.value, pairingCode: pairingCode.value, displayName: displayName.value || "Job Hunt ChatGPT Bridge" });
    if (!result?.ok) throw new Error(result?.reason || "Pairing failed.");
    pairingCode.value = "";
    showStatus("Paired · set up workflow conversations");
    await refresh();
  } catch (error) { showStatus(error instanceof Error ? error.message : "Pairing failed.", true); }
  finally { pairButton.disabled = false; }
});

setupButton.addEventListener("click", async () => {
  if (!window.confirm("Create the missing Job Hunt workflow chats automatically? The extension will open the visible Job Hunt Project, send one fixed harmless setup marker per missing workflow, and bind each new chat. Automatic Send will remain off until you enable it.")) return;
  setupButton.disabled = true;
  try {
    const result = await send({ type: "SET_UP_WORKFLOW_CONVERSATIONS" });
    if (!result?.ok) throw new Error(result?.reason || "Automatic workflow setup stopped.");
    showStatus("Workflow conversations are ready · Automatic Send is off");
    await refresh();
  } catch (error) { showStatus(error instanceof Error ? error.message : "Automatic workflow setup stopped.", true); }
  finally { setupButton.disabled = false; await refresh().catch(() => undefined); }
});

bindButton.addEventListener("click", async () => {
  bindButton.disabled = true;
  try {
    const result = await send({ type: "BIND_CURRENT_CONVERSATION", workflowKey: selectedKey() });
    if (!result?.ok) throw new Error(result?.reason || "Binding failed.");
    showStatus(`Bound ${selectedDefinition().label} · Automatic Send is off`);
    await refresh();
  } catch (error) { showStatus(error instanceof Error ? error.message : "Binding failed.", true); }
  finally { bindButton.disabled = false; }
});

openButton.addEventListener("click", async () => {
  const result = await send({ type: "OPEN_BOUND_CONVERSATION", workflowKey: selectedKey() });
  if (!result?.ok) showStatus(result?.reason || "Unable to open the selected workflow conversation.", true);
});

automaticSend.addEventListener("change", async () => {
  automaticSend.disabled = true;
  try {
    const result = await send({ type: "SET_AUTOMATIC_SEND", enabled: automaticSend.checked });
    if (!result?.ok) throw new Error(result?.reason || "Unable to change Automatic Send.");
    await refresh();
  } catch (error) {
    automaticSend.checked = !automaticSend.checked;
    showStatus(error instanceof Error ? error.message : "Unable to change Automatic Send.", true);
  } finally { automaticSend.disabled = false; }
});

retryButton.addEventListener("click", async () => {
  retryButton.disabled = true;
  try {
    const result = await send({ type: "RETRY_DISPATCH", requestId: retryButton.dataset.requestId });
    if (!result?.accepted && !result?.ok) throw new Error(result?.reason || "Retry was not accepted.");
    showStatus("Retry claimed by the bridge.");
  } catch (error) { showStatus(error instanceof Error ? error.message : "Retry failed.", true); }
  finally { await refresh().catch(() => undefined); }
});

forgetButton.addEventListener("click", async () => {
  if (!window.confirm("Forget this browser's local bridge credential? Revoke the device in Job Hunt Settings as well.")) return;
  const result = await send({ type: "FORGET_LOCAL_PAIRING" });
  if (!result?.ok) showStatus(result?.reason || "Unable to forget local pairing.", true);
  else { showStatus("Local pairing forgotten"); await refresh(); }
});

void refresh().catch((error) => showStatus(error instanceof Error ? error.message : "Extension unavailable.", true));
setInterval(() => { void refresh().catch(() => undefined); }, 5000);
