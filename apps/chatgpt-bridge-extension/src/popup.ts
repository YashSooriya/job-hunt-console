type ExtensionStatus = {
  ok?: boolean;
  paired?: boolean;
  backendUrl?: string;
  boundConversationUrl?: string | null;
  boundProjectName?: string | null;
  boundProjectVerified?: boolean;
  automaticSendEnabled?: boolean;
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
const automaticSend = $("automaticSend") as HTMLInputElement;
const pairButton = $("pairButton") as HTMLButtonElement;
const bindButton = $("bindButton") as HTMLButtonElement;
const openButton = $("openButton") as HTMLButtonElement;
const retryButton = $("retryButton") as HTMLButtonElement;
const forgetButton = $("forgetButton") as HTMLButtonElement;

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

function render(status: ExtensionStatus) {
  backendUrl.value = status.backendUrl || backendUrl.value;
  automaticSend.checked = status.automaticSendEnabled === true;
  if (!status.paired) showStatus("Not paired");
  else if (!status.boundProjectVerified) showStatus("Paired · bind a Job Hunt conversation");
  else if (!status.automaticSendEnabled) showStatus("Bound · Automatic Send is off");
  else showStatus("Ready · Automatic Send is on");
  statusDetails.textContent = [
    status.boundConversationUrl ? `Bound: ${status.boundConversationUrl}` : "Bound conversation: none",
    `Last dispatch: ${status.lastDispatchId ? `${status.lastDispatchId} · ${formatDate(status.lastDispatchAt)}` : "none"}`,
    status.lastError ? `Last safe stop: ${status.lastError}` : "No recent safe-stop error",
  ].join("\n");
  retryButton.dataset.requestId = status.lastDispatchId || "";
  bindButton.disabled = !status.paired;
  openButton.disabled = !status.boundConversationUrl;
  automaticSend.disabled = !status.boundProjectVerified;
  retryButton.disabled = !status.lastDispatchId || !status.paired || !status.automaticSendEnabled;
  forgetButton.disabled = !status.paired;
}

async function refresh() {
  const result = await send({ type: "GET_EXTENSION_STATUS" });
  if (!result?.ok) throw new Error(result?.reason || "Unable to read extension status.");
  render(result);
}

pairButton.addEventListener("click", async () => {
  pairButton.disabled = true;
  try {
    const result = await send({ type: "PAIR_EXTENSION", backendUrl: backendUrl.value, pairingCode: pairingCode.value, displayName: displayName.value || "Job Hunt ChatGPT Bridge" });
    if (!result?.ok) throw new Error(result?.reason || "Pairing failed.");
    pairingCode.value = "";
    showStatus("Paired · bind a Job Hunt conversation");
    await refresh();
  } catch (error) { showStatus(error instanceof Error ? error.message : "Pairing failed.", true); }
  finally { pairButton.disabled = false; }
});

bindButton.addEventListener("click", async () => {
  bindButton.disabled = true;
  try {
    const result = await send({ type: "BIND_CURRENT_CONVERSATION" });
    if (!result?.ok) throw new Error(result?.reason || "Binding failed.");
    showStatus("Bound · Automatic Send is off");
    await refresh();
  } catch (error) { showStatus(error instanceof Error ? error.message : "Binding failed.", true); }
  finally { bindButton.disabled = false; }
});

openButton.addEventListener("click", async () => {
  const result = await send({ type: "OPEN_BOUND_CONVERSATION" });
  if (!result?.ok) showStatus(result?.reason || "Unable to open the bound conversation.", true);
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
