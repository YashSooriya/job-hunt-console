const required = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_GOOGLE_PICKER_API_KEY",
  "NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER",
  "SUPABASE_SERVICE_ROLE_KEY",
];

const missing = required.filter((key) => !process.env[key]?.trim());
if (missing.length) {
  console.error(`Missing required production environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

if (process.env.JOBHUNT_DATA_MODE !== "supabase") {
  console.error("JOBHUNT_DATA_MODE must be exactly 'supabase' for production deployment.");
  process.exit(1);
}

let supabaseUrl;
try {
  supabaseUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL);
} catch {
  console.error("NEXT_PUBLIC_SUPABASE_URL must be a valid HTTPS URL.");
  process.exit(1);
}

if (supabaseUrl.protocol !== "https:") {
  console.error("NEXT_PUBLIC_SUPABASE_URL must use HTTPS in production.");
  process.exit(1);
}

if (!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.startsWith("sb_publishable_") &&
    !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.startsWith("eyJ")) {
  console.error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY does not look like a Supabase publishable/legacy anon key.");
  process.exit(1);
}

if (!/^\d+$/.test(process.env.NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER)) {
  console.error("NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER must be the numeric Google Cloud project number used by Picker.");
  process.exit(1);
}

const googleConfigured = Boolean(
  process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim()
);

if (Boolean(process.env.GOOGLE_CLIENT_ID?.trim()) !== Boolean(process.env.GOOGLE_CLIENT_SECRET?.trim())) {
  console.error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must either both be set or both be absent.");
  process.exit(1);
}

if (process.env.OPENAI_API_KEY?.trim()) {
  console.log("Immediate OpenAI listing inspection: configured.");
} else {
  console.warn("Warning: OPENAI_API_KEY is not set. Inspect with ChatGPT will use the connected ChatGPT Task/MCP fallback instead of starting immediately.");
}

console.log("Production environment contract passed.");
console.log(`Supabase host: ${supabaseUrl.hostname}`);
console.log("Data mode: supabase");
console.log(`Google/Gmail OAuth server credentials: ${googleConfigured ? "configured" : "not yet configured (Milestone 13)"}`);
console.log(`Paid OpenAI API required for immediate URL inspection: ${process.env.OPENAI_API_KEY?.trim() ? "yes (configured)" : "no (MCP fallback active)"}`);
