import fs from "node:fs";
import { planAdaptivePage } from "../packages/form-agent/index.js";

const input = fs.readFileSync(0, "utf8");
const payload = JSON.parse(input);
const plan = planAdaptivePage(payload.observation, payload.context || {});
process.stdout.write(JSON.stringify(plan));
