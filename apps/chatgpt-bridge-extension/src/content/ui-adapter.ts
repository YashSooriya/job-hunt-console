import { isNonEmptyString, safeReason } from "../shared/protocol";

export type AdapterFailure = { ok: false; code: string; reason: string; userRequired: true };

export type AdapterSuccess = { ok: true; sent: true; delivery: "verified" };

type Composer = HTMLElement & { value?: string; disabled?: boolean };

const AUTH_URL_RE = /\/(auth|login|sign-in)(?:[/?#]|$)/i;
const BLOCKING_RE = /(captcha|verify you are human|permission|allow access|confirm|sign in|log in|mfa|multi-factor|security check|continue with)/i;
const SEND_LABEL_RE = /^(send|send message|submit message)$/i;
const STOP_LABEL_RE = /^(stop|stop generating|cancel)$/i;

function visible(element: Element | null): element is HTMLElement {
  if (!element || (typeof HTMLElement !== "undefined" && !(element instanceof HTMLElement))) return false;
  if (typeof (element as Element).getAttribute !== "function") return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return style?.display !== "none" && style?.visibility !== "hidden" && element.getClientRects().length > 0;
}

function enabled(element: HTMLElement) {
  return element.getAttribute("aria-disabled") !== "true" && !(element as HTMLButtonElement).disabled;
}

function label(element: Element) {
  return (element.getAttribute("aria-label") || element.textContent || "").trim().replace(/\s+/g, " ");
}

function exactTextCandidates(document: Document, text: string) {
  return [...document.querySelectorAll("button, [role=button], [role=option], [role=menuitem], li, h1, h2, h3, nav a")]
    .filter(visible)
    .filter((element) => element.textContent?.trim() === text);
}

function normalizeUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function failure(code: string, reason: string): AdapterFailure {
  return { ok: false, code, reason: safeReason(reason), userRequired: true } as AdapterFailure;
}

export class ChatGptUiAdapter {
  constructor(private readonly document: Document = window.document, private readonly location: Location = window.location) {}

  detectAuthenticationState() {
    if (AUTH_URL_RE.test(this.location.pathname)) return false;
    const composer = this.findComposer();
    if (composer) return true;
    const text = (this.document.body?.innerText || "").slice(0, 8000);
    if (/\b(log in|sign in)\b/i.test(text)) return false;
    return false;
  }

  detectBlockingModal(): AdapterFailure | null {
    const dialogs = [...this.document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-testid*="modal" i]')].filter(visible);
    const blocking = dialogs.find((dialog) => BLOCKING_RE.test((dialog.textContent || "").slice(0, 2000)));
    return blocking ? failure("blocking_modal", "ChatGPT has a blocking login, permission, confirmation, verification, or CAPTCHA dialog open.") : null;
  }

  verifyBoundConversation(boundConversationUrl: string, expectedProjectName: string) {
    try {
      if (normalizeUrl(this.location.href) !== normalizeUrl(boundConversationUrl)) return failure("wrong_conversation", "The current ChatGPT URL is not the bound Job Hunt conversation.");
    } catch { return failure("invalid_bound_url", "The bound ChatGPT conversation URL is invalid."); }
    const project = exactTextCandidates(this.document, expectedProjectName);
    if (project.length !== 1) return failure("project_not_verified", `The visible Project could not be verified as exactly '${expectedProjectName}'.`);
    return null;
  }

  private findComposer(): Composer | null {
    const candidates = [
      ...this.document.querySelectorAll('[contenteditable="true"][role="textbox"]'),
      ...this.document.querySelectorAll('[contenteditable="true"][aria-label]'),
      ...this.document.querySelectorAll('textarea[aria-label]'),
      ...this.document.querySelectorAll('textarea[data-testid]'),
    ].filter(visible).filter(enabled);
    const unique = [...new Set(candidates)];
    return unique.length === 1 ? unique[0] as Composer : null;
  }

  waitForComposer(timeoutMs = 5000): Promise<Composer | null> {
    const started = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        const composer = this.findComposer();
        if (composer || Date.now() - started >= timeoutMs) return resolve(composer);
        window.setTimeout(check, 100);
      };
      check();
    });
  }

  private selectedAppVisible(expectedProjectName: string) {
    const exact = exactTextCandidates(this.document, expectedProjectName);
    const composer = this.findComposer();
    const composerText = composer?.closest("form")?.textContent || composer?.parentElement?.textContent || "";
    return exact.length === 1 && /job hunt/i.test(composerText);
  }

  async ensureJobHuntAppSelected() {
    const modal = this.detectBlockingModal();
    if (modal) return modal;
    if (this.selectedAppVisible("Job Hunt")) return null;
    const appButtons = [...this.document.querySelectorAll("button[aria-label], [role=button][aria-label]")]
      .filter(visible).filter(enabled).filter((element) => /^(add (an )?app|apps|tools)$/i.test(label(element)));
    if (appButtons.length !== 1) return failure("app_not_verified", "The Job Hunt app is not visibly selected and its app selector could not be identified safely.");
    appButtons[0].click();
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    const afterMenuModal = this.detectBlockingModal();
    if (afterMenuModal) return afterMenuModal;
    const jobHuntOptions = exactTextCandidates(this.document, "Job Hunt").filter((element) => element.matches("[role=option], [role=menuitem], button, li, [role=button]"));
    if (jobHuntOptions.length !== 1) return failure("app_not_verified", "The Job Hunt app selector did not expose exactly one safe Job Hunt option.");
    jobHuntOptions[0].click();
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    if (!this.selectedAppVisible("Job Hunt")) return failure("app_not_verified", "The Job Hunt app selection could not be verified after the click.");
    return null;
  }

  setComposerText(composer: Composer, text: string) {
    if (!isNonEmptyString(text, 2000)) return failure("instruction_invalid", "The server instruction is missing or too long.");
    composer.focus();
    if ("value" in composer && typeof composer.value === "string") {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (setter) setter.call(composer, text); else composer.value = text;
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    } else {
      const selection = this.document.getSelection();
      const range = this.document.createRange();
      range.selectNodeContents(composer);
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (!this.document.execCommand("insertText", false, text)) composer.textContent = text;
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    return null;
  }

  verifyComposerText(composer: Composer, expected: string) {
    const actual = "value" in composer && typeof composer.value === "string" ? composer.value : composer.innerText || composer.textContent || "";
    return actual === expected ? null : failure("composer_mismatch", "The exact server instruction was not verified in the ChatGPT composer.");
  }

  findSendControl() {
    const candidates = [...this.document.querySelectorAll("button[aria-label], [role=button][aria-label], button[data-testid]")]
      .filter(visible).filter(enabled)
      .filter((element) => {
        const aria = element.getAttribute("aria-label") || "";
        const testId = element.getAttribute("data-testid") || "";
        return SEND_LABEL_RE.test(aria.trim()) || /send-button/i.test(testId);
      });
    return candidates.length === 1 ? candidates[0] as HTMLButtonElement : null;
  }

  detectGenerationStarted() {
    return [...this.document.querySelectorAll("button[aria-label], [role=button][aria-label]")].filter(visible).some((element) => STOP_LABEL_RE.test(label(element)));
  }

  async verifyMessageSent(expected: string, composer: Composer, timeoutMs = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const current = "value" in composer && typeof composer.value === "string" ? composer.value : composer.innerText || composer.textContent || "";
      const outgoing = [...this.document.querySelectorAll('[data-message-author-role="user"], [data-message-author="user"], [role="article"]')]
        .filter(visible).some((element) => (element.textContent || "").includes(expected));
      if (outgoing || (current === "" && this.detectGenerationStarted())) return null;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    return failure("delivery_uncertain", "The ChatGPT composer did not clear and the exact outgoing message could not be verified. No automatic resend is safe.");
  }

  async sendMessage(expected: string, composer: Composer) {
    if (this.detectGenerationStarted()) return failure("already_generating", "ChatGPT is already generating another response.");
    const send = this.findSendControl();
    if (!send) return failure("send_not_verified", "The enabled ChatGPT Send control could not be identified safely for this account or locale.");
    send.click();
    const verified = await this.verifyMessageSent(expected, composer);
    return verified || ({ ok: true, sent: true, delivery: "verified" } as AdapterSuccess);
  }

  bindCurrentConversation(expectedProjectName: string) {
    if (!this.detectAuthenticationState()) return failure("not_authenticated", "ChatGPT is not visibly signed in.");
    const modal = this.detectBlockingModal();
    if (modal) return modal;
    const project = exactTextCandidates(this.document, expectedProjectName);
    if (project.length !== 1) return failure("project_not_verified", `Open the dedicated conversation inside the '${expectedProjectName}' Project before binding.`);
    try {
      const url = normalizeUrl(this.location.href);
      if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(url)) return failure("wrong_origin", "The active tab is not on a supported ChatGPT origin.");
      return { ok: true as const, conversationUrl: url, projectName: expectedProjectName, projectVerified: true as const };
    } catch { return failure("conversation_not_canonical", "The current ChatGPT URL could not be canonicalised safely."); }
  }

  async executeDispatch(input: { requestId: string; instruction: string; boundConversationUrl: string; boundProjectName: string }): Promise<AdapterSuccess | AdapterFailure> {
    const auth = this.detectAuthenticationState();
    if (!auth) return failure("not_authenticated", "ChatGPT is not visibly signed in. Sign in manually and retry.");
    const modal = this.detectBlockingModal();
    if (modal) return modal;
    const target = this.verifyBoundConversation(input.boundConversationUrl, input.boundProjectName);
    if (target) return target;
    const app = await this.ensureJobHuntAppSelected();
    if (app) return app;
    const composer = await this.waitForComposer();
    if (!composer) return failure("composer_not_verified", "The ChatGPT composer was not identified safely.");
    const set = this.setComposerText(composer, input.instruction);
    if (set) return set;
    const verified = this.verifyComposerText(composer, input.instruction);
    if (verified) return verified;
    return this.sendMessage(input.instruction, composer);
  }
}

export function adapterErrorForTest(document: Document, location: Location) {
  return new ChatGptUiAdapter(document, location);
}
