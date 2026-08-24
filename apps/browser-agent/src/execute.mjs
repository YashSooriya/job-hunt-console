import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { isDangerousSubmissionLabel } from "@jobhunt/form-agent";

function cssEscape(value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, (m) => `\\${m}`); }

function byObservedControl(page, control) {
  const loc = control.locator || {};
  if (loc.id) return page.locator(`#${cssEscape(loc.id)}`);
  if (loc.name && control.controlType === "radio" && loc.value) return page.locator(`[name=${JSON.stringify(loc.name)}][value=${JSON.stringify(loc.value)}]`).first();
  if (loc.name) return page.locator(`[name=${JSON.stringify(loc.name)}]`).first();
  if (control.controlType === "button" && control.label) return page.getByRole("button", { name: control.label, exact: true }).first();
  if (loc.ariaLabel) return page.getByLabel(loc.ariaLabel, { exact: true }).first();
  if (control.label) return page.getByLabel(control.label, { exact: true }).first();
  return page.locator(`${loc.tag || "input"}:visible`).first();
}

async function downloadFile(url, filename = "application-document.pdf") {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download approved document (${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jobhunt-form-agent-"));
  const file = path.join(dir, filename.replace(/[^a-z0-9._-]+/gi, "_"));
  await fs.writeFile(file, buffer);
  return file;
}

export async function executeSingleAction(page, observation, action) {
  if (!action || action.action === "none") return { executed: false, reason: "No executable action." };
  if (action.safe_without_new_user_approval !== true) throw new Error("Plan action is not approved as safe.");
  const control = observation.controls.find((c) => c.fieldKey === action.target_key);
  if (!control) throw new Error(`Observed control ${action.target_key} no longer exists.`);
  if (control.controlType === "button" && isDangerousSubmissionLabel(control.label)) throw new Error("Final submission controls are blocked until Gate 2 approval.");
  const locator = byObservedControl(page, control);
  if (action.action === "fill") {
    await locator.fill(String(action.value ?? ""));
  } else if (action.action === "clear") {
    await locator.clear();
  } else if (action.action === "toggle") {
    const desired = Boolean(action.value);
    if (desired) await locator.check(); else await locator.uncheck();
  } else if (action.action === "select") {
    const desired = String(action.value ?? "");
    if (control.controlType === "select") {
      try { await locator.selectOption({ label: desired }); }
      catch { await locator.selectOption(desired); }
    } else if (control.controlType === "radio") {
      await locator.check().catch(async () => locator.click());
    } else {
      await locator.click();
      const option = page.getByRole("option", { name: desired, exact: true }).first();
      if (await option.count()) await option.click();
      else {
        await locator.fill(desired).catch(() => {});
        const fallback = page.getByText(desired, { exact: true }).first();
        if (await fallback.count()) await fallback.click(); else throw new Error(`Could not select ${desired}.`);
      }
    }
  } else if (action.action === "upload") {
    const rawUrl = String(action.value || "");
    const filename = /cover/i.test(control.label) ? "cover-letter.pdf" : "cv.pdf";
    const local = rawUrl.startsWith("http") ? await downloadFile(rawUrl, filename) : rawUrl;
    await locator.setInputFiles(local);
  } else if (action.action === "navigate") {
    await locator.click();
    await page.waitForTimeout(900);
  } else {
    throw new Error(`Unsupported action ${action.action}`);
  }
  return { executed: true, action: action.action, target: action.target_key, label: control.label };
}

export async function executeApprovedSubmission(page, observation, submitCandidate) {
  const expected = String(submitCandidate?.label || "");
  const candidate = observation.controls.find((c) => c.controlType === "button" && isDangerousSubmissionLabel(c.label) && (!expected || c.label === expected));
  if (!candidate) throw new Error("Approved final submission control no longer matches the reviewed page. Re-review is required.");
  const locator = byObservedControl(page, candidate);
  await locator.click();
  await page.waitForTimeout(1400);
  return { executed: true, label: candidate.label };
}
