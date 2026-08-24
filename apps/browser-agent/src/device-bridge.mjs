export class DeviceBridgeClient {
  constructor({ baseUrl, deviceId, token }) {
    this.url = `${baseUrl.replace(/\/$/, "")}/functions/v1/form-agent-bridge`;
    this.deviceId = deviceId;
    this.token = token;
  }
  async call(op, payload = {}) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-browser-device-id": this.deviceId,
        "x-browser-device-token": this.token,
      },
      body: JSON.stringify({ op, ...payload }),
    });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = { error: text }; }
    if (!response.ok) throw new Error(data.error || `Browser helper bridge failed (${response.status}).`);
    return data;
  }
}
