import { isIP } from "node:net";

const enabled = process.env.JOBHUNT_M03_LOOPBACK_GOOGLE === "1";
const port = Number(process.env.JOBHUNT_M03_GOOGLE_PORT);
if (!enabled || !Number.isInteger(port) || port < 1024 || port > 65535 || isIP("127.0.0.1") !== 4) {
  throw new Error("The M03 loopback Google adapter is not safely configured.");
}

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const original = input instanceof Request ? new URL(input.url) : new URL(String(input));
  const supported = new Set(["oauth2.googleapis.com", "www.googleapis.com", "sheets.googleapis.com"]);
  if (!supported.has(original.hostname)) return originalFetch(input, init);
  const local = new URL(`http://127.0.0.1:${port}${original.pathname}${original.search}`);
  if (local.hostname !== "127.0.0.1") throw new Error("Refusing a non-loopback Google test destination.");
  return originalFetch(local, init || (input instanceof Request ? input : undefined));
};
