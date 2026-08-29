import { build } from "esbuild";
import { zipSync } from "fflate";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const version = "0.1.78";
const DEFAULT_JOB_HUNT_ORIGIN = "https://job-hunt-console.yashwanth-sooriya.workers.dev";
const DEFAULT_BRIDGE_ENDPOINT = "https://sgarcjiqkvlhldmrlsqo.supabase.co/functions/v1/chatgpt-bridge";
const CHATGPT_URL_PATTERNS = ["https://chatgpt.com/*", "https://chat.openai.com/*"];

function jobHuntPattern() {
  const raw = process.env.JOB_HUNT_ORIGIN || DEFAULT_JOB_HUNT_ORIGIN;
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("JOB_HUNT_ORIGIN must be an http(s) origin without a path, query, or credentials.");
  return `${url.origin}/*`;
}

function bridgeEndpointConfig() {
  const raw = process.env.JOB_HUNT_BRIDGE_ENDPOINT?.trim() || DEFAULT_BRIDGE_ENDPOINT;
  if (!raw) return { endpoint: "", hostPattern: null };
  const url = new URL(raw);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if ((!local && url.protocol !== "https:") || (local && !/^https?:$/.test(url.protocol)) || url.username || url.password || url.search || url.hash || url.pathname === "/") {
    throw new Error("JOB_HUNT_BRIDGE_ENDPOINT must be an HTTPS endpoint (or localhost for development) with a path and no credentials, query, or fragment.");
  }
  return { endpoint: url.toString().replace(/\/$/, ""), hostPattern: `${url.origin}/*` };
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.length);
  return output;
}

function icon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const inset = Math.max(1, Math.floor(size * 0.08));
    const inside = x >= inset && x < size - inset && y >= inset && y < size - inset;
    const stripe = x >= Math.floor(size * 0.43) && x < Math.floor(size * 0.62) && y >= Math.floor(size * 0.22) && y < Math.floor(size * 0.76);
    const hook = y >= Math.floor(size * 0.68) && y < Math.floor(size * 0.82) && x >= Math.floor(size * 0.26) && x < Math.floor(size * 0.62);
    const offset = (y * size + x) * 4;
    pixels[offset] = inside && (stripe || hook) ? 255 : 14;
    pixels[offset + 1] = inside && (stripe || hook) ? 255 : 116;
    pixels[offset + 2] = inside && (stripe || hook) ? 255 : 144;
    pixels[offset + 3] = 255;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0;
    pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]);
}

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = {};
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await walk(full));
    else files[path.relative(dist, full).replaceAll(path.sep, "/")] = new Uint8Array(await fs.readFile(full));
  }
  return files;
}

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(dist, { recursive: true });
const jobPattern = jobHuntPattern();
const jobOrigin = jobPattern.slice(0, -2);
const bridge = bridgeEndpointConfig();
const common = { bundle: true, platform: "browser", target: "es2022", sourcemap: false, logLevel: "warning" };
await build({ ...common, entryPoints: [path.join(root, "src/background.ts")], outfile: path.join(dist, "background.js"), format: "iife" });
await build({ ...common, entryPoints: [path.join(root, "src/content/chatgpt.ts")], outfile: path.join(dist, "chatgpt.js"), format: "iife" });
await build({ ...common, entryPoints: [path.join(root, "src/content/jobhunt-bridge.ts")], outfile: path.join(dist, "jobhunt-bridge.js"), format: "iife" });
await build({ ...common, entryPoints: [path.join(root, "src/popup.ts")], outfile: path.join(dist, "popup.js"), format: "iife" });
await build({ ...common, entryPoints: [path.join(root, "src/options.ts")], outfile: path.join(dist, "options.js"), format: "iife" });

const optionsPath = path.join(dist, "options.js");
await fs.writeFile(optionsPath, (await fs.readFile(optionsPath, "utf8")).replaceAll("__JOB_HUNT_ORIGIN__", jobOrigin));
const popupHtml = await fs.readFile(path.join(root, "popup.html"), "utf8");
await fs.writeFile(path.join(dist, "popup.html"), popupHtml.replaceAll("__JOB_HUNT_BRIDGE_ENDPOINT__", bridge.endpoint));
await fs.copyFile(path.join(root, "options.html"), path.join(dist, "options.html"));
await fs.copyFile(path.join(root, "styles.css"), path.join(dist, "styles.css"));
for (const size of [16, 48, 128]) await fs.writeFile(path.join(dist, `icon${size}.png`), icon(size));

const manifest = {
  manifest_version: 3,
  name: "JobHuntAI ChatGPT Bridge",
  description: "A narrow visible-UI bridge for authenticated JobHuntAI dispatches through a user-bound ChatGPT Project conversation.",
  version,
  permissions: ["storage", "tabs", "alarms", "scripting", "downloads"],
  host_permissions: [jobPattern, ...(bridge.hostPattern ? [bridge.hostPattern] : []), ...CHATGPT_URL_PATTERNS],
  background: { service_worker: "background.js" },
  action: { default_title: "JobHuntAI ChatGPT Bridge", default_popup: "popup.html" },
  options_page: "options.html",
  icons: { "16": "icon16.png", "48": "icon48.png", "128": "icon128.png" },
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
  content_scripts: [
    { matches: [jobPattern], js: ["jobhunt-bridge.js"], run_at: "document_start" },
    { matches: CHATGPT_URL_PATTERNS, js: ["chatgpt.js"], run_at: "document_idle" },
  ],
};
await fs.writeFile(path.join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const archive = zipSync(await walk(dist), { level: 9 });
const archivePath = path.join(dist, `jobhunt-chatgpt-bridge-v${version}.zip`);
await fs.writeFile(archivePath, archive);
console.log(`Built ${archivePath} for ${jobOrigin}`);
