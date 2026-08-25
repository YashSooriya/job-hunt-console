import { EXTENSION_VERSION } from "./shared/protocol";

const version = document.getElementById("version");
if (version) version.textContent = EXTENSION_VERSION;

document.getElementById("openSettings")?.addEventListener("click", () => {
  chrome.tabs.create({ url: "__JOB_HUNT_ORIGIN__/settings#chatgpt-bridge" });
});
