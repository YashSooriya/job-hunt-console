export function ChatGptReasoningWorkerSettings() {
  return <section className="card settingsCard reasoningWorkerCard" id="chatgpt-reasoning-worker">
    <div className="cardHeader"><div><div className="eyebrow">Optional fallback</div><h2>ChatGPT reasoning worker</h2><p>Use the authenticated ChatGPT/MCP connection when the Website Bridge is unavailable. It is a backup path, not part of onboarding and not the normal way JobHuntAI sends work.</p></div><span className="badge muted">Fallback only</span></div>
    <div className="notice settingsNotice"><strong>Website Bridge is the normal path</strong><p>Keep using the Website Bridge for automatic tasks in the ChatGPT website. Open the reasoning worker only when you deliberately want to connect ChatGPT through the MCP fallback and authorise that connection.</p></div>
    <div className="buttonRow settingsActions"><a className="secondaryButton" href="/chatgpt">Open reasoning worker settings</a></div>
  </section>;
}
