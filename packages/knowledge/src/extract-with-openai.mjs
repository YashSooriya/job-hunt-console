import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const [sourceKey, sourcePath] = process.argv.slice(2);
if (!sourceKey || !sourcePath) {
  console.error("Usage: node extract-with-openai.mjs <source_key> <text-file>");
  process.exit(2);
}
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required");
  process.exit(2);
}

const root = process.cwd();
const manifest = JSON.parse(await fs.readFile(path.join(root, "data/knowledge/source-manifest.json"), "utf8"));
const source = manifest.sources.find((item) => item.source_key === sourceKey);
if (!source) throw new Error(`Unknown source_key: ${sourceKey}`);

const schema = JSON.parse(await fs.readFile(path.join(root, "packages/contracts/schemas/knowledge-extraction.schema.json"), "utf8"));
const sourceText = await fs.readFile(path.resolve(sourcePath), "utf8");
const model = process.env.OPENAI_KNOWLEDGE_MODEL || "gpt-5.6-terra";

const instructions = `You extract factual candidate-profile information from an authoritative source.
Return atomic, conservative claims only. Do not infer skills that are not stated or directly demonstrated.
Use the exact source_key ${sourceKey}.
For facts, use stable dotted keys where possible. Put the source value in value_text.
For evidence, make each claim independently reusable in a CV or application.
Give a short source_locator that would let a reviewer find the supporting passage.
Do not extract sensitive voluntary demographic/health/political/religious/sexual information into a reusable profile.`;

const response = await fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model,
    instructions,
    input: [{ role: "user", content: [{ type: "input_text", text: `Source: ${source.title}\n\n${sourceText}` }] }],
    text: {
      format: {
        type: "json_schema",
        name: "candidate_knowledge_extraction",
        strict: true,
        schema,
      },
    },
  }),
});

if (!response.ok) {
  const errorText = await response.text();
  throw new Error(`OpenAI Responses API failed (${response.status}): ${errorText}`);
}
const payload = await response.json();
const text = payload.output
  ?.flatMap((item) => item.content || [])
  ?.find((item) => item.type === "output_text")
  ?.text;
if (!text) throw new Error("Response contained no structured output text");
const extracted = JSON.parse(text);
if (extracted.source_key !== sourceKey) throw new Error("Model returned a mismatched source_key");

const outDir = path.join(root, "data/knowledge/extracted");
await fs.mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, `${sourceKey}.json`);
await fs.writeFile(outPath, JSON.stringify({ ...extracted, extraction_model: model, extracted_at: new Date().toISOString() }, null, 2) + "\n");
console.log(`Extraction written to ${outPath}`);
