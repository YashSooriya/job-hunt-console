import { chromium } from "playwright-core";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { planAdaptivePage, buildFinalReviewDiff, validatePagePlan } from "@jobhunt/form-agent";
import { observePage } from "./observe.mjs";
import { executeSingleAction, executeApprovedSubmission } from "./execute.mjs";
import { BridgeClient } from "./bridge.mjs";

function args() {
  const out = {}; const a = process.argv.slice(2);
  for (let i=0;i<a.length;i++) if (a[i].startsWith("--")) out[a[i].slice(2)] = a[i+1] && !a[i+1].startsWith("--") ? a[++i] : true;
  return out;
}

async function userPause(bridge, reasons) {
  console.log("\nNeeds you:"); for (const r of reasons) console.log(`  • ${r}`);
  if (process.env.JOBHUNT_DAEMON_MODE === "1") {
    console.log("Resolve this in JobHuntAI Chrome, then click Resume helper in the JobHuntAI web app.");
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const ctx = await bridge.call("context");
      if (ctx.session.status === "active") return true;
      if (["cancelled","expired","failed","submitted"].includes(ctx.session.status)) return false;
    }
  }
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question("Resolve this in Chrome, then press Enter to re-observe (or type q to stop): ");
  rl.close();
  if (answer.trim().toLowerCase() === "q") return false;
  await bridge.call("resume");
  return true;
}

async function waitForGate2(bridge) {
  console.log("\nFinal employer review detected. Review the form in Chrome and the structured diff in JobHuntAI.");
  console.log("Waiting for Gate 2 approval…");
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const ctx = await bridge.call("context");
    if (ctx.session.status === "approved_for_submission") return ctx;
    if (["cancelled","expired","failed"].includes(ctx.session.status)) throw new Error(`Session ended: ${ctx.session.status}`);
  }
}

async function main() {
  const a = args();
  const noSubmit = Boolean(a["no-submit"] || a.dryRun || a.acceptance);
  const formToken = a.token || process.env.JOBHUNT_FORM_TOKEN;
  if (!a.session || !formToken || !a.supabase) {
    console.error("Usage: npm run browser:agent -- --session <id> --token <one-time-token> --supabase <https://project.supabase.co> [--cdp http://127.0.0.1:9222]");
    process.exit(2);
  }
  const bridge = new BridgeClient({ baseUrl: a.supabase, sessionId: a.session, token: formToken, deviceId: process.env.JOBHUNT_BROWSER_DEVICE_ID || null, deviceToken: process.env.JOBHUNT_BROWSER_DEVICE_TOKEN || null });
  const initial = await bridge.call("context");
  const browser = await chromium.connectOverCDP(a.cdp || "http://127.0.0.1:9222", { isLocal: true });
  const contexts = browser.contexts(); const context = contexts[0];
  if (!context) throw new Error("Chrome has no browser context. Start Chrome with remote debugging enabled.");
  let page = context.pages().at(-1) || await context.newPage();
  if ((page.url() === "about:blank" || page.url() === "chrome://newtab/") && initial.application.applicationUrl) await page.goto(initial.application.applicationUrl);
  console.log(`Connected to ${initial.application.company} · ${initial.application.role}`);

  for (let step=1; step<=250; step++) {
    const contextPayload = await bridge.call("context");
    if (contextPayload.browserReasoning?.length) {
      const latest = contextPayload.browserReasoning[0];
      console.log(`[${step}] User-reviewed reasoning available (${latest.status}); it is advisory only and will not be applied automatically.`);
    }
    page = context.pages().at(-1) || page;
    const observation = await observePage(page);
    const persisted = await bridge.call("observation", { observation });
    const plan = planAdaptivePage(observation, contextPayload.approvedContext);
    const validation = validatePagePlan(plan);
    if (!validation.ok) throw new Error(`Invalid page plan: ${validation.errors.join("; ")}`);
    await bridge.call("plan", { observationId: persisted.observationId, plan, plannerSource: "deterministic_v1" });
    console.log(`[${step}] ${plan.page_purpose} · ${observation.title || observation.url}`);

    if (plan.page_purpose === "confirmation" && ["approved_for_submission","submitting"].includes(contextPayload.session.status)) {
      await bridge.call("submitted", { observation, submissionSource: "helper" });
      console.log("Application submission confirmed and recorded.");
      return;
    }

    if (plan.submission_detected) {
      const submitCandidate = observation.controls.find((c) => c.controlType === "button" && /submit|complete application|send application|confirm and submit/i.test(c.label));
      const diff = buildFinalReviewDiff(observation, plan);
      await bridge.call("final_review", { observationId: persisted.observationId, diff, submitCandidate: submitCandidate ? { fieldKey: submitCandidate.fieldKey, label: submitCandidate.label } : null });
      if (noSubmit) {
        if (a["acceptance-provider"] || contextPayload.session.acceptanceMode) {
          await bridge.call("acceptance_result", {
            outcome: "final_review",
            helperVersion: "0.1.0",
            metadata: { provider_family: a["acceptance-provider"] || contextPayload.session.acceptanceProviderFamily || null, no_submit: true },
          });
        }
        console.log("Acceptance/no-submit mode: final employer review reached. Submission was not clicked.");
        return;
      }
      await waitForGate2(bridge);
      const reviewedObservation = await observePage(page);
      await executeApprovedSubmission(page, reviewedObservation, submitCandidate);
      await bridge.call("submission_clicked", { label: submitCandidate?.label || null });
      continue;
    }

    if (plan.must_pause) {
      await bridge.call("needs_user", { reasons: plan.pause_reasons, observationId: persisted.observationId });
      if (!(await userPause(bridge, plan.pause_reasons))) return;
      continue;
    }

    const action = plan.actions[0];
    if (!action || action.action === "none") {
      const reasons = ["No safe generic action is available on the current page."];
      await bridge.call("needs_user", { reasons, observationId: persisted.observationId });
      if (!(await userPause(bridge, reasons))) return;
      continue;
    }
    const result = await executeSingleAction(page, observation, action);
    await bridge.call("action_result", { observationId: persisted.observationId, action, result });
  }
  throw new Error("Form agent stopped after 250 observation/action cycles.");
}

main().catch((error) => { console.error(`Form agent stopped: ${error.message || error}`); process.exitCode = 1; });
