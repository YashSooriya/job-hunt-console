const version = document.getElementById("version");
if (version) version.textContent = "0.1.0";

document.getElementById("openSettings")?.addEventListener("click", () => {
  chrome.tabs.create({ url: "__JOB_HUNT_ORIGIN__/settings#chatgpt-bridge" });
});
