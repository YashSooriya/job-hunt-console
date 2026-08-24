export class BridgeClient {
  constructor({ baseUrl, sessionId, token, deviceId = null, deviceToken = null }) {
    this.url = `${baseUrl.replace(/\/$/, "")}/functions/v1/form-agent-bridge`;
    this.sessionId = sessionId;
    this.token = token;
    this.deviceId = deviceId;
    this.deviceToken = deviceToken;
  }
  async call(op, payload = {}) {
    const headers = { "content-type": "application/json", "x-form-agent-session": this.sessionId, "x-form-agent-token": this.token };
    if (this.deviceId && this.deviceToken) {
      headers["x-browser-device-id"] = this.deviceId;
      headers["x-browser-device-token"] = this.deviceToken;
    }
    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ op, ...payload }),
    });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = { error: text }; }
    if (!response.ok) throw new Error(data.error || `Bridge failed (${response.status}).`);
    return data;
  }
}
