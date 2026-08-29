import { CHATGPT_PROJECT_NAME, CHATGPT_RESPONSE_CAPTURE_TIMEOUT_MS, MAX_WEBSITE_INSTRUCTION_CHARS, PROFESSIONAL_BACKGROUND_INITIALIZATION_MESSAGE, extractStructuredProfileJson, isNonEmptyString, safeReason, sameProjectUrl, type ConversationSlotKey, type DispatchTiming } from "../shared/protocol";

export type AssistantResponseBaseline = { count: number; lastText: string; artifactCount?: number };
export type AdapterTiming = DispatchTiming;
export type AdapterFailure = { ok: false; code: string; reason: string; userRequired: true; timing?: AdapterTiming };
export type AdapterSuccess = { ok: true; sent: true; delivery: "verified" | "reused"; assistantBaseline?: AssistantResponseBaseline; existingResponseText?: string; artifactJson?: string; timing?: AdapterTiming };

type Composer = HTMLElement & { value?: string; disabled?: boolean };

const AUTH_URL_RE = /\/(auth|login|sign-in)(?:[/?#]|$)/i;
const BLOCKING_RE = /(captcha|verify you are human|permission|allow access|confirm|sign in|log in|mfa|multi-factor|security check|continue with)/i;
const RATE_LIMIT_RE = /(too many requests|making requests too quickly|temporarily limited access to your conversations|please wait a few minutes)/i;
const MISSING_CONVERSATION_RE = /(?:conversation|chat|thread).{0,80}(?:not found|does not exist|no longer (?:exists|available)|deleted|unavailable|could not find|can't find)|(?:page|conversation|chat).{0,20}\b404\b|\b404\b.{0,40}(?:not found|conversation|chat|page)/i;
const SEND_LABEL_RE = /^(send|send message|send prompt|submit|submit message)$/i;
const SEND_TEST_ID_RE = /^send(?:[-_:]?(?:button|message|prompt))?(?:[-_:]?button)?$/i;
const STOP_LABEL_RE = /^(stop|stop generating|stop streaming|stop answering|cancel|cancel response)$/i;
const TRANSIENT_ASSISTANT_TEXT_RE = /^(?:thinking(?:[.…]+)?|generating(?:[.…]+)?|working(?:[.…]+)?|processing(?:[.…]+)?|loading(?:[.…]+)?|searching(?:[.…]+)?|drafting(?:[.…]+)?|preparing(?:[.…]+)?|one moment(?:[.…]+)?|[.…]{2,})$/i;
const PROJECT_NAV_LABEL_RE = /^projects$/i;
const PROJECT_CREATE_LABEL_RE = /^(?:new|create)(?:\s+a)?\s+project$/i;
const PROJECT_SUBMIT_LABEL_RE = /^(?:create(?:\s+a)?\s+project|create|save)$/i;
const PROJECT_NAME_FIELD_RE = /(?:project\s+(?:name|title)|name\s+(?:your\s+)?project)/i;
const PROFESSIONAL_PROFILE_ARTIFACT_RE = /(?:^|[^a-z0-9])professional[-_ ]profile(?:\s*\(\d+\))?\.json(?:$|[^a-z0-9])/i;
const JSON_ARTIFACT_RE = /(?:^|[^a-z0-9])[^\s/]+\.json(?:$|[^a-z0-9])/i;
const ARTIFACT_OPEN_ACTION_RE = /\b(open|view|preview|show|code|edit)\b/i;
const ARTIFACT_DOWNLOAD_ACTION_RE = /\b(download|save)\b/i;
const PROJECT_LIST_MIN_WAIT_MS = 4500;
const PROJECT_LIST_STABLE_MS = 500;
const SENT_VERIFICATION_TIMEOUT_MS = 15000;
const WORKFLOW_CONVERSATION_CREATION_TIMEOUT_MS = 90000;
const WORKFLOW_CONVERSATION_RECOVERY_TIMEOUT_MS = 15000;
const PROJECT_CREATION_VERIFY_TIMEOUT_MS = 30000;
const WORKFLOW_CONVERSATION_PROJECT_MATCH_TIMEOUT_MS = 5000;

function visible(element: Element | null): element is HTMLElement {
  if (!element || (typeof HTMLElement !== "undefined" && !(element instanceof HTMLElement))) return false;
  if (typeof (element as Element).getAttribute !== "function") return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return style?.display !== "none" && style?.visibility !== "hidden" && element.getClientRects().length > 0;
}

function enabled(element: HTMLElement) {
  return element.getAttribute("aria-disabled") !== "true" && element.getAttribute("data-disabled") !== "true" && element.getAttribute("disabled") === null && !(element as HTMLButtonElement).disabled;
}

function label(element: Element) {
  return (element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || "").trim().replace(/\s+/g, " ");
}

function interactiveMetadata(element: Element) {
  return [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("download"),
    element.getAttribute("data-file-name"),
    element.getAttribute("data-filename"),
    element.getAttribute("data-url"),
    element.getAttribute("data-file-url"),
    element.getAttribute("data-download-url"),
    element.getAttribute("href"),
    element.getAttribute("data-testid"),
    element.textContent,
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function normaliseFieldText(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normaliseComposerText(value: string) {
  // ChatGPT's contenteditable composer can represent the same visible text
  // with different CRLFs, paragraph breaks, non-breaking spaces, or runs of
  // whitespace. Keep every non-whitespace character exact while normalising
  // only those DOM presentation differences.
  return value.replace(/[\u00a0\u200b]/g, " ").replace(/\s+/gu, " ").trim();
}

function exactTextCandidates(document: ParentNode, text: string) {
  const expected = text.trim().replace(/\s+/g, " ");
  return [...new Set([...document.querySelectorAll("button, [role=button], [role=option], [role=menuitem], [role=link], li, h1, h2, h3, nav a, [aria-label]")])]
    .filter(visible)
    .filter((element) => label(element) === expected);
}

function projectSlug(projectName: string) {
  return projectName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function projectTitleMatchesName(document: ParentNode, projectName: string) {
  const title = typeof (document as Document).title === "string" ? (document as Document).title.trim().replace(/\s+/g, " ") : "";
  const expected = projectName.trim().replace(/\s+/g, " ");
  if (!title || !expected) return false;
  if (title === expected) return true;
  return [" | ", "|", " - ", " – ", " — ", ":"].some((separator) => title.startsWith(`${expected}${separator}`));
}

function projectUrlMatchesName(value: string, projectName: string) {
  try {
    const pathname = new URL(normalizeUrl(value)).pathname.toLowerCase();
    const slug = projectSlug(projectName);
    const slugs = projectName === CHATGPT_PROJECT_NAME ? [slug, "job-hunt-ai", "job-hunt"] : [slug];
    return slugs.some((candidate) => pathname.endsWith(`-${candidate}/project`) || pathname.includes(`-${candidate}/c/`));
  } catch {
    return false;
  }
}

function normalizeUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function projectUrlFor(value: string) {
  try {
    const url = new URL(normalizeUrl(value));
    const conversationIndex = url.pathname.indexOf("/c/");
    if (conversationIndex > 0) {
      url.pathname = `${url.pathname.slice(0, conversationIndex)}/project`;
      return url.toString().replace(/\/$/, "");
    }
    if (/\/project$/i.test(url.pathname)) return url.toString().replace(/\/$/, "");
    return null;
  } catch {
    return null;
  }
}

function conversationUrl(value: string) {
  try {
    const url = new URL(normalizeUrl(value));
    return /\/c\/[^/]+/i.test(url.pathname) ? url.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

function workflowSetupMarker(workflowKey: ConversationSlotKey, displayName: string) {
  return workflowKey === "profile.background"
    ? PROFESSIONAL_BACKGROUND_INITIALIZATION_MESSAGE
    : `This conversation is reserved for my ${displayName} workflow. Do not browse, call tools, or change any application data during setup. Reply only Ready.`;
}

function failure(code: string, reason: string): AdapterFailure {
  return { ok: false, code, reason: safeReason(reason), userRequired: true } as AdapterFailure;
}

function dispatchDomEvent(element: HTMLElement, type: string, init?: { inputType?: string; data?: string | null }) {
  try {
    element.dispatchEvent(new InputEvent(type, {
      bubbles: true,
      composed: true,
      inputType: init?.inputType || "",
      data: init?.data ?? null,
    }));
    return;
  } catch {
    // Some isolated browser contexts expose DOM nodes but not constructible
    // InputEvent objects. Fall through to the broadest compatible event path.
  }
  try {
    element.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    return;
  } catch {
    // Use the owning document's legacy factory as a final cross-realm fallback.
  }
  try {
    const event = element.ownerDocument.createEvent?.("Event");
    if (!event) return;
    event.initEvent(type, true, true);
    element.dispatchEvent(event);
  } catch {
    // There is no useful safe fallback if the page cannot dispatch an event.
  }
}

export class ChatGptUiAdapter {
  private createdProjectUrl: string | null = null;

  constructor(private readonly document: Document = window.document, private readonly location: Location = window.location) {}

  private projectWasCreatedHere(expectedProjectName: string) {
    const currentProjectUrl = projectUrlFor(this.location.href);
    return expectedProjectName === CHATGPT_PROJECT_NAME
      && Boolean(currentProjectUrl && this.createdProjectUrl && sameProjectUrl(currentProjectUrl, this.createdProjectUrl));
  }

  private projectMatchesExpectedUrl(expectedProjectUrl?: string) {
    if (!expectedProjectUrl) return false;
    const currentProjectUrl = projectUrlFor(this.location.href);
    const expectedProject = projectUrlFor(expectedProjectUrl);
    return Boolean(currentProjectUrl && expectedProject && sameProjectUrl(currentProjectUrl, expectedProject));
  }

  private projectIsVerified(expectedProjectName: string, expectedProjectUrl?: string) {
    return projectTitleMatchesName(this.document, expectedProjectName)
      || exactTextCandidates(this.document, expectedProjectName).length === 1
      || projectUrlMatchesName(this.location.href, expectedProjectName)
      || this.projectMatchesExpectedUrl(expectedProjectUrl)
      || this.projectWasCreatedHere(expectedProjectName);
  }

  private clickableElements(root: ParentNode) {
    return [...new Set([...root.querySelectorAll("a, button, [role=link], [role=button], [role=menuitem]")])]
      .filter(visible)
      .filter(enabled);
  }

  private exactClickableCandidates(root: ParentNode, expected: string) {
    const normalised = expected.trim().replace(/\s+/g, " ");
    return this.clickableElements(root).filter((element) => label(element) === normalised);
  }

  private projectNavigationCandidates() {
    return this.clickableElements(this.document).filter((element) => PROJECT_NAV_LABEL_RE.test(label(element)));
  }

  private projectCreateCandidates(root: ParentNode = this.document) {
    return this.clickableElements(root).filter((element) => PROJECT_CREATE_LABEL_RE.test(label(element)));
  }

  private projectHomeCandidate(projectItem: HTMLElement) {
    let row = projectItem.parentElement;
    for (let depth = 0; row && depth < 4; depth += 1, row = row.parentElement) {
      const candidates = this.exactClickableCandidates(row, "Open project home");
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) return null;
    }
    return null;
  }

  private projectListSignature() {
    const heading = [...this.document.querySelectorAll("h2, h3, h4, h5, h6, [role=heading]")]
      .filter(visible)
      .find((element) => normaliseFieldText(label(element)) === "projects");
    const section = heading?.parentElement?.parentElement;
    if (!section) return null;
    const expanded = heading.parentElement?.getAttribute("aria-expanded");
    if (expanded !== "true") return null;
    const projectItems = [...section.querySelectorAll('[data-sidebar-item="true"][role="button"]')]
      .filter(visible)
      .map((element) => label(element))
      .filter(Boolean);
    return projectItems.join("\u001f");
  }

  private projectDialogRoots() {
    const candidates = [...new Set([...this.document.querySelectorAll('[role=dialog], [aria-modal="true"], [data-testid*="modal" i]')])].filter(visible);
    const matching = candidates.filter((root) => {
      const testId = (root.getAttribute("data-testid") || "").toLowerCase();
      if (testId === "modal-new-project-enhanced") return true;
      const hasCreateHeading = [...root.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]")]
        .filter(visible)
        .some((element) => /^create(?:\s+a\s+new)?\s+project$/i.test(label(element)));
      if (hasCreateHeading) return true;
      return this.editableElements(root).some((element) => {
        const identity = ["aria-label", "placeholder", "name", "id", "data-testid"]
          .map((name) => element.getAttribute(name) || "")
          .concat(element.previousElementSibling?.textContent || "")
          .concat(element.parentElement?.textContent || "")
          .join(" ");
        return PROJECT_NAME_FIELD_RE.test(normaliseFieldText(identity));
      });
    });
    // ChatGPT's modal often exposes both an outer dialog and one or more
    // nested modal test-id elements. Treat those as one surface; otherwise a
    // perfectly valid Project name field is rejected as ambiguous.
    return matching.filter((root) => !matching.some((other) => other !== root
      && typeof other.contains === "function"
      && other.contains(root)));
  }

  private editableElements(root: ParentNode) {
    return [...new Set([...root.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"], [aria-label*="project" i], [placeholder*="project" i], [data-testid*="project" i]')])]
      .filter(visible)
      .filter(enabled)
      .filter((element) => {
        const tag = element.tagName?.toLowerCase();
        const type = (element.getAttribute("type") || "").toLowerCase();
        const role = (element.getAttribute("role") || "").toLowerCase();
        const contentEditable = element.getAttribute("contenteditable") === "true";
        const labelledControl = element.getAttribute("tabindex") !== null && (element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.getAttribute("data-testid"));
        return tag === "input" && !["hidden", "button", "checkbox", "file", "image", "radio", "range", "reset", "submit"].includes(type)
          || tag === "textarea"
          || contentEditable
          || role === "textbox"
          || role === "combobox"
          || Boolean(labelledControl);
      });
  }

  private projectCreationRoots() {
    const dialogs = this.projectDialogRoots();
    if (dialogs.length > 0) return dialogs;
    const headings = [...new Set([...this.document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading], div, span, p")])]
      .filter(visible)
      .filter((element) => /^create(?:\s+a\s+new)?\s+project$/i.test(label(element)))
      .filter((element) => {
        const clickableAncestor = typeof element.closest === "function" ? element.closest("button, a, [role=button], [role=link]") : null;
        return !clickableAncestor && !(element.children && [...element.children].some((child) => label(child) === label(element)));
      });
    const roots: Element[] = [];
    for (const heading of headings) {
      let root: Element | null = heading;
      for (let depth = 0; root && depth < 8; depth += 1) {
        if (this.editableElements(root).length > 0) {
          roots.push(root);
          break;
        }
        root = root.parentElement;
      }
    }
    const uniqueRoots = [...new Set(roots)];
    return uniqueRoots.length === 1 ? uniqueRoots : [];
  }

  private projectNameInput() {
    const roots = this.projectCreationRoots();
    if (roots.length > 1) return null;
    const scoped = roots.length === 1;
    const root = scoped ? roots[0] : this.document;
    const candidates = this.editableElements(root);
    const matching = candidates.filter((element) => {
      const associatedLabels = "labels" in element && (element as HTMLInputElement).labels
        ? Array.from((element as HTMLInputElement).labels || []).map((associated) => associated.textContent || "")
        : [];
      const labelledBy = (element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).flatMap((id) => {
        const associated = element.ownerDocument.getElementById?.(id);
        return associated ? [associated.textContent || ""] : [];
      });
      const closestLabel = typeof element.closest === "function" ? element.closest("label")?.textContent || "" : "";
      const attributes = ["aria-label", "placeholder", "name", "id", "data-testid"]
        .map((name) => element.getAttribute(name) || "")
        .concat(associatedLabels)
        .concat(labelledBy)
        .concat(closestLabel)
        .concat(element.previousElementSibling?.textContent || "")
        .concat(element.parentElement?.textContent || "")
        .join(" ");
      return PROJECT_NAME_FIELD_RE.test(normaliseFieldText(attributes));
    });
    if (matching.length === 1) return matching[0];
    if (matching.length === 0) {
      const composer = this.findComposer();
      const nonComposer = candidates.filter((candidate) => candidate !== composer);
      const surfaceText = normaliseFieldText((root.textContent || ((root as HTMLElement).innerText || "")).slice(0, 4000));
      const isCreationSurface = /create(?: a new)? project/.test(surfaceText) && /project name/.test(surfaceText);
      if (nonComposer.length === 1 && (scoped || isCreationSurface)) return nonComposer[0];
      if (scoped && candidates.length === 1) return candidates[0];
    }
    return null;
  }

  private projectSubmitCandidates() {
    const roots = this.projectCreationRoots();
    if (roots.length > 1) return [];
    const root = roots.length === 1 ? roots[0] : this.document;
    const labelled = this.clickableElements(root).filter(enabled).filter((element) => {
      const visibleLabel = label(element);
      const metadata = ["aria-label", "title", "data-testid", "name", "id"]
        .map((name) => element.getAttribute(name) || "")
        .join(" ");
      return PROJECT_SUBMIT_LABEL_RE.test(visibleLabel) || /create(?:\s+a)?\s+project/i.test(normaliseFieldText(metadata));
    });
    if (labelled.length > 0) return [...new Set(labelled)];
    // Some ChatGPT locales expose the action only as a form submit control,
    // with no accessible name or visible text. It is safe to use when the
    // control is inside the already verified Project creation surface.
    return [...new Set([...root.querySelectorAll('button[type="submit"], input[type="submit"]')])]
      .filter(visible)
      .filter(enabled) as HTMLElement[];
  }

  private projectInputValue(element: HTMLElement) {
    if ("value" in element && typeof (element as HTMLInputElement).value === "string") return (element as HTMLInputElement).value.trim().replace(/\s+/g, " ");
    return (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ");
  }

  private setProjectName(element: HTMLElement, projectName: string) {
    element.focus();
    if ("value" in element && typeof (element as HTMLInputElement).value === "string") {
      const input = element as HTMLInputElement;
      // Use the native HTMLInputElement setter explicitly. ChatGPT uses a
      // controlled React input; assigning only the wrapper property can make
      // the text visibly change while React still believes the field is empty,
      // leaving Create project disabled.
      // Prefer the prototype belonging to the actual element so this also
      // works when ChatGPT renders the field as a textarea or when the page
      // and the isolated extension world expose different DOM constructors.
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set
        || (typeof HTMLInputElement !== "undefined" ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set : undefined)
        || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
      const assign = (value: string) => { if (setter) setter.call(input, value); else input.value = value; };
      assign("");
      dispatchDomEvent(element, "input", { inputType: "deleteContentBackward", data: null });
      assign(projectName);
      dispatchDomEvent(element, "input", { inputType: "insertText", data: projectName });
      // execCommand follows the browser's native editing path and is a useful
      // fallback for controlled inputs whose event delegation rejects a
      // synthetic value assignment. It is harmless when unsupported or when
      // the field already contains the exact value.
      if (this.projectInputValue(input) !== projectName) {
        try {
          input.select();
          input.ownerDocument.execCommand?.("insertText", false, projectName);
        } catch {
          // The native setter/input events above remain the primary path.
        }
      }
      dispatchDomEvent(element, "change");
    } else {
      const document = element.ownerDocument;
      const selection = document.getSelection?.();
      const range = document.createRange?.();
      selection?.removeAllRanges();
      if (range) {
        range.selectNodeContents(element);
        selection?.addRange(range);
      }
      const inserted = document.execCommand?.("insertText", false, projectName);
      if (!inserted) element.textContent = projectName;
      dispatchDomEvent(element, "input", { inputType: "insertText", data: projectName });
    }
    return this.projectInputValue(element) === projectName ? null : failure("project_name_mismatch", `The exact Project name '${projectName}' was not verified in ChatGPT.`);
  }

  private async waitForProjectList(timeoutMs = 10000) {
    const started = Date.now();
    let previousSignature: string | null = null;
    let signatureStableSince = started;
    while (Date.now() - started < timeoutMs) {
      const existing = this.exactClickableCandidates(this.document, CHATGPT_PROJECT_NAME);
      if (existing.length > 0) return { existing, create: this.projectCreateCandidates() };
      const signature = this.projectListSignature();
      if (signature !== null && signature !== previousSignature) {
        previousSignature = signature;
        signatureStableSince = Date.now();
      }
      const create = this.projectCreateCandidates();
      const minimumWaitElapsed = Date.now() - started >= PROJECT_LIST_MIN_WAIT_MS;
      const listSettled = signature !== null
        ? Date.now() - signatureStableSince >= PROJECT_LIST_STABLE_MS
        : minimumWaitElapsed;
      // ChatGPT renders the New project button before it finishes loading the
      // existing Project rows. Prefer an exact existing JobHuntAI row whenever
      // it appears, and only use New project after the visible list has had a
      // bounded opportunity to settle. This prevents duplicate Projects.
      if (create.length > 0 && minimumWaitElapsed && listSettled) return { existing, create };
      await this.waitForDomChange(Math.min(250, Math.max(1, timeoutMs - (Date.now() - started))));
    }
    return { existing: this.exactClickableCandidates(this.document, CHATGPT_PROJECT_NAME), create: this.projectCreateCandidates() };
  }

  private async waitForProjectNameInput(timeoutMs = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const input = this.projectNameInput();
      if (input) return input;
      await this.waitForDomChange(Math.min(250, Math.max(1, timeoutMs - (Date.now() - started))));
    }
    return null;
  }

  private async waitForProjectSubmit(timeoutMs = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const candidates = this.projectSubmitCandidates();
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) return null;
      await this.waitForDomChange(Math.min(250, Math.max(1, timeoutMs - (Date.now() - started))));
    }
    return null;
  }

  private async waitForCreatedProjectContext(expectedProjectName: string, previousUrl: string, timeoutMs = PROJECT_CREATION_VERIFY_TIMEOUT_MS) {
    const started = Date.now();
    let projectHomeOpening = false;
    while (Date.now() - started < timeoutMs) {
      const current = normalizeUrl(this.location.href);
      const createdProjectUrl = projectUrlFor(current);
      const pageText = (this.document.body?.innerText || "").slice(0, 8000);
      const projectSurfaceReady = !AUTH_URL_RE.test(this.location.pathname)
        && !/\b(log in|sign in)\b/i.test(pageText)
        && !this.detectBlockingModal();
      const navigatedToNewProject = Boolean(createdProjectUrl
        && createdProjectUrl !== previousUrl
        && /\/project$/i.test(current)
        && projectSurfaceReady);
      if (navigatedToNewProject) {
        // The exact Project name was verified in the visible creation dialog,
        // and this is the new authenticated Project surface reached by that
        // exact Create action. ChatGPT sometimes uses an opaque ID-only URL,
        // so URL slug matching alone cannot verify this legitimate result.
        this.createdProjectUrl = createdProjectUrl;
        const verified = this.verifyProjectContext(expectedProjectName);
        if (verified.ok === true) return { ...verified, createdProject: true as const };
      }
      // ChatGPT may close the dialog back to the Projects list rather than
      // navigating directly to the new Project. The exact name entered in the
      // dialog plus the newly visible row is causal evidence of this same
      // creation action; open that row's verified home and continue.
      if (!projectHomeOpening) {
        const createdRows = this.exactClickableCandidates(this.document, expectedProjectName);
        if (createdRows.length === 1) {
          const projectHome = this.projectHomeCandidate(createdRows[0]);
          if (projectHome) {
            projectHomeOpening = true;
            projectHome.click();
          } else {
            const href = createdRows[0].getAttribute("href") || "";
            try {
              const absoluteHref = new URL(href, this.location.href).toString();
              if (/\/project$/i.test(new URL(absoluteHref).pathname)) {
                projectHomeOpening = true;
                createdRows[0].click();
              }
            } catch {
              // The row may expose its Open project home action only after a
              // small render delay. Continue waiting for that action.
            }
          }
        }
      }
      await this.waitForDomChange(Math.min(250, Math.max(1, timeoutMs - (Date.now() - started))));
    }
    const final = this.verifyProjectContext(expectedProjectName);
    return final.ok === true ? { ...final, createdProject: true as const } : final;
  }

  private async completeVisibleProjectCreation(expectedProjectName: string, previousUrl: string) {
    let input = await this.waitForProjectNameInput();
    if (!input) return failure("project_name_input_not_verified", "The Project name field could not be identified safely in ChatGPT.");
    let set: AdapterFailure | null = null;
    // ChatGPT may replace the controlled input immediately after the first
    // input event. Re-acquire the live field and retry the exact value a few
    // times before stopping; this avoids leaving a correctly filled modal for
    // the user's next setup click to finish.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      set = this.setProjectName(input, expectedProjectName);
      if (!set) break;
      await this.waitForDomChange(150);
      input = this.projectNameInput() || input;
    }
    if (set) return set;
    const submit = await this.waitForProjectSubmit();
    if (!submit) return failure("project_create_submit_not_verified", "The enabled Project creation control could not be identified safely in ChatGPT.");
    submit.click();
    const created = await this.waitForCreatedProjectContext(expectedProjectName, previousUrl);
    return created.ok === true ? created : failure("project_creation_unverified", created.reason || `ChatGPT did not verify the new '${expectedProjectName}' Project.`);
  }

  async ensureProjectContext(initialWaitMs = 2500, expectedProjectUrl?: string) {
    const current = await this.waitForProjectContext(CHATGPT_PROJECT_NAME, initialWaitMs, expectedProjectUrl);
    if (current.ok === true) return current;
    const visibleCreationRoots = this.projectCreationRoots();
    if (visibleCreationRoots.length > 1) return failure("project_creation_ambiguous", "ChatGPT exposed more than one visible Project creation dialog; setup stopped safely.");
    if (visibleCreationRoots.length === 1) {
      // Resume a dialog that was already open when the extension worker or
      // popup was refreshed. Do not click New project again or create a
      // duplicate Project.
      return this.completeVisibleProjectCreation(CHATGPT_PROJECT_NAME, normalizeUrl(this.location.href));
    }
    const navigation = this.projectNavigationCandidates();
    const visibleProjectSetupControl = navigation.length > 0
      || this.projectCreateCandidates().length > 0
      || this.exactClickableCandidates(this.document, CHATGPT_PROJECT_NAME).length > 0;
    if (!this.detectAuthenticationState() && !visibleProjectSetupControl) return current;
    const modal = this.detectBlockingModal();
    if (modal) return modal;

    if (navigation.length > 1) return failure("projects_navigation_ambiguous", "ChatGPT exposed more than one visible Projects navigation control; the Project setup stopped safely.");
    if (navigation.length === 1 && navigation[0].getAttribute("aria-expanded") !== "true") navigation[0].click();

    const list = await this.waitForProjectList();
    if (list.existing.length > 1) return failure("project_ambiguous", `ChatGPT exposed more than one visible Project named '${CHATGPT_PROJECT_NAME}'; choose one manually before setup.`);
    if (list.existing.length === 1) {
      const projectHome = this.projectHomeCandidate(list.existing[0]);
      if (!projectHome) return failure("project_home_not_verified", "ChatGPT exposed the existing JobHuntAI Project but not its safe Open project home control.");
      projectHome.click();
      const opened = await this.waitForProjectContext(CHATGPT_PROJECT_NAME, 12000);
      return opened.ok === true ? opened : failure("project_navigation_unverified", opened.reason || `The '${CHATGPT_PROJECT_NAME}' Project could not be verified after opening it.`);
    }
    if (list.create.length !== 1) return failure("project_create_not_verified", "ChatGPT did not expose exactly one safe New project/Create project control.");

    const previousUrl = normalizeUrl(this.location.href);
    list.create[0].click();
    return this.completeVisibleProjectCreation(CHATGPT_PROJECT_NAME, previousUrl);
  }

  detectAuthenticationState() {
    if (AUTH_URL_RE.test(this.location.pathname)) return false;
    const composer = this.findComposer();
    if (composer) return true;
    const text = (this.document.body?.innerText || "").slice(0, 8000);
    if (/\b(log in|sign in)\b/i.test(text)) return false;
    return false;
  }

  detectRateLimit(): AdapterFailure | null {
    const text = (this.document.body?.innerText || "").slice(0, 12000);
    return RATE_LIMIT_RE.test(text)
      ? failure("chatgpt_rate_limited", "ChatGPT temporarily limited requests because setup was too fast. Wait a few minutes before resuming; no new message was sent.")
      : null;
  }

  detectBlockingModal(): AdapterFailure | null {
    const dialogs = [...this.document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-testid*="modal" i]')].filter(visible);
    const blocking = dialogs.find((dialog) => BLOCKING_RE.test((dialog.textContent || "").slice(0, 2000)));
    return blocking ? failure("blocking_modal", "ChatGPT has a blocking login, permission, confirmation, verification, or CAPTCHA dialog open.") : null;
  }

  verifyBoundConversation(boundConversationUrl: string, expectedProjectName: string, expectedProjectUrl?: string) {
    try {
      const currentUrl = normalizeUrl(this.location.href);
      const expectedConversation = normalizeUrl(boundConversationUrl);
      if (currentUrl !== expectedConversation) return failure("wrong_conversation", "The current ChatGPT URL is not the bound JobHuntAI conversation.");
      if (expectedProjectUrl) {
        const actualProject = projectUrlFor(expectedConversation);
        const expectedProject = projectUrlFor(expectedProjectUrl);
        if (!expectedProject || !sameProjectUrl(actualProject, expectedProject)) return failure("conversation_wrong_project", "The bound ChatGPT conversation is not inside the JobHuntAI Project.");
      }
    } catch { return failure("invalid_bound_url", "The bound ChatGPT conversation URL is invalid."); }
    if (!this.projectIsVerified(expectedProjectName, expectedProjectUrl)) return failure("project_not_verified", `The visible Project could not be verified as exactly '${expectedProjectName}'.`);
    return null;
  }

  private boundConversationIsMissing(boundConversationUrl: string, expectedProjectName: string, expectedProjectUrl?: string) {
    try {
      const current = normalizeUrl(this.location.href);
      const expected = normalizeUrl(boundConversationUrl);
      // ChatGPT commonly redirects a deleted conversation to its Project home.
      // Only classify that redirect as missing after the expected Project is
      // itself visible and verified; a still-loading page must not cause a
      // replacement conversation to be created.
      if (/\/project$/i.test(current) && this.projectIsVerified(expectedProjectName, expectedProjectUrl)) return true;
      // Some deleted conversations redirect to ChatGPT's signed-in home page
      // instead. Require the home surface to be visibly loaded so the brief
      // URL transition during navigation is not treated as deletion.
      if (current !== expected && /^\/$/.test(new URL(current).pathname)) {
        const text = (this.document.body?.innerText || "").slice(0, 12000);
        if (!AUTH_URL_RE.test(this.location.pathname) && !/\b(log in|sign in)\b/i.test(text) && /\b(chat history|new chat)\b/i.test(text)) return true;
      }
      // ChatGPT may keep the deleted conversation URL in the address bar
      // while rendering the signed-in home surface. A URL-only check would
      // incorrectly treat that page as a healthy bound conversation because
      // the project slug is still present. Bound workflow chats always have
      // at least one persisted message, so the home greeting plus no message
      // surface is a safe deletion signal.
      if (current === expected && this.messageElements().length === 0) {
        const text = (this.document.body?.innerText || "").slice(0, 12000);
        if (/\b(chat history|projects|new chat)\b/i.test(text) && /\b(how can i help|ready to dive in|what(?:'|’)s on your mind)\b/i.test(text)) return true;
      }
    } catch {
      // Continue with the visible error-page text check below.
    }
    const text = (this.document.body?.innerText || "").slice(0, 12000);
    return MISSING_CONVERSATION_RE.test(text);
  }

  async checkBoundConversation(boundConversationUrl: string, expectedProjectName: string, timeoutMs = 12000, expectedProjectUrl?: string) {
    const safeTimeout = Math.max(1000, Math.min(timeoutMs, 30000));
    const started = Date.now();
    let latest = this.verifyBoundConversation(boundConversationUrl, expectedProjectName, expectedProjectUrl);
    while (Date.now() - started < safeTimeout) {
      if (this.boundConversationIsMissing(boundConversationUrl, expectedProjectName, expectedProjectUrl)) {
        return failure("conversation_missing", "The bound ChatGPT conversation is missing or was deleted.");
      }
      const pageText = (this.document.body?.innerText || "").slice(0, 8000);
      if (AUTH_URL_RE.test(this.location.pathname) || /\b(log in|sign in)\b/i.test(pageText)) {
        return failure("not_authenticated", "ChatGPT is not visibly signed in. Sign in manually before checking workflow conversations.");
      }
      if (!latest && this.findComposer() && this.messageElements().length > 0) {
        return { ok: true as const, verified: true as const, conversationUrl: normalizeUrl(boundConversationUrl) };
      }
      await this.waitForDomChange(Math.min(150, Math.max(1, safeTimeout - (Date.now() - started))));
      latest = this.verifyBoundConversation(boundConversationUrl, expectedProjectName, expectedProjectUrl);
    }
    if (this.boundConversationIsMissing(boundConversationUrl, expectedProjectName, expectedProjectUrl)) {
      return failure("conversation_missing", "The bound ChatGPT conversation is missing or was deleted.");
    }
    return latest || failure("conversation_not_verified", "The bound ChatGPT conversation did not expose a stable conversation surface. Setup stopped safely without creating a replacement.");
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

  private waitForDomChange(timeoutMs = 250) {
    return new Promise<void>((resolve) => {
      let observer: MutationObserver | null = null;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (observer) observer.disconnect();
        resolve();
      };
      const timer = window.setTimeout(finish, Math.max(0, timeoutMs));
      const Observer = (globalThis as typeof globalThis & { MutationObserver?: typeof MutationObserver }).MutationObserver;
      if (!Observer || !this.document.body) return;
      try {
        observer = new Observer(() => {
          clearTimeout(timer);
          finish();
        });
        observer.observe(this.document.body, { childList: true, subtree: true, characterData: true });
      } catch {
        clearTimeout(timer);
        finish();
      }
    });
  }

  async waitForComposer(timeoutMs = 5000): Promise<Composer | null> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const composer = this.findComposer();
      if (composer) return composer;
      await this.waitForDomChange(Math.min(250, Math.max(1, timeoutMs - (Date.now() - started))));
    }
    return this.findComposer();
  }

  setComposerText(composer: Composer, text: string) {
    if (!isNonEmptyString(text, MAX_WEBSITE_INSTRUCTION_CHARS)) return failure("instruction_invalid", "The server instruction is missing or too long.");
    composer.focus();
    if ("value" in composer && typeof composer.value === "string") {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(composer), "value")?.set
        || (typeof HTMLTextAreaElement !== "undefined" ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set : undefined)
        || (typeof HTMLInputElement !== "undefined" ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set : undefined);
      if (setter) setter.call(composer, text); else composer.value = text;
      dispatchDomEvent(composer, "input", { inputType: "insertText", data: text });
    } else {
      const document = composer.ownerDocument || this.document;
      const selection = document.getSelection?.();
      const range = document.createRange?.();
      range?.selectNodeContents(composer);
      selection?.removeAllRanges();
      if (range) selection?.addRange(range);
      // ProseMirror (the current ChatGPT composer) listens to the browser's
      // editing events rather than a direct textContent assignment. Emit the
      // cancellable precursor first, then use the native editing command so
      // the page-owned editor receives one coherent transaction.
      dispatchDomEvent(composer, "beforeinput", { inputType: "insertText", data: text });
      let inserted = false;
      try { inserted = Boolean(document.execCommand?.("insertText", false, text)); } catch { /* fall through to the DOM fallback */ }
      if (!inserted || normaliseComposerText(composer.innerText || composer.textContent || "") !== normaliseComposerText(text)) {
        composer.textContent = text;
      }
      dispatchDomEvent(composer, "input", { inputType: "insertText", data: text });
    }
    return null;
  }

  verifyComposerText(composer: Composer, expected: string, description = "server instruction") {
    const actual = "value" in composer && typeof composer.value === "string" ? composer.value : composer.innerText || composer.textContent || "";
    return normaliseComposerText(actual) === normaliseComposerText(expected)
      ? null
      : failure("composer_mismatch", `The exact ${description} was not verified in the ChatGPT composer.`);
  }

  private async settleComposerInput() {
    const view = this.document.defaultView;
    if (typeof view?.requestAnimationFrame === "function") {
      await new Promise<void>((resolve) => view.requestAnimationFrame(() => view.requestAnimationFrame(() => resolve())));
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  findSendControl(composer?: Composer) {
    const form = composer?.closest("form");
    const candidates = [...new Set([...this.document.querySelectorAll("button, [role=button], input[type=submit]")])]
      .filter(visible).filter(enabled)
      .filter((element) => {
        const aria = element.getAttribute("aria-label") || "";
        const title = element.getAttribute("title") || "";
        const text = element.textContent || "";
        const testId = element.getAttribute("data-testid") || "";
        const semanticSubmit = element.getAttribute("type")?.toLowerCase() === "submit" && form?.contains(element) === true;
        return SEND_LABEL_RE.test(aria.trim()) || SEND_LABEL_RE.test(title.trim()) || SEND_LABEL_RE.test(text.trim().replace(/\s+/g, " ")) || SEND_TEST_ID_RE.test(testId.trim()) || semanticSubmit;
      });
    const scoped = form ? candidates.filter((element) => form.contains(element)) : candidates;
    const usable = scoped.length > 0 ? scoped : candidates;
    return usable.length === 1 ? usable[0] as HTMLElement : null;
  }

  async waitForSendControl(composer: Composer, timeoutMs = 5000): Promise<HTMLElement | null> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const send = this.findSendControl(composer);
      if (send) return send;
      await this.waitForDomChange(Math.min(150, Math.max(1, timeoutMs - (Date.now() - started))));
    }
    return this.findSendControl(composer);
  }

  detectGenerationStarted() {
    return [...this.document.querySelectorAll("button[aria-label], [role=button][aria-label]")].filter(visible).some((element) => STOP_LABEL_RE.test(label(element)));
  }

  private messageElements() {
    const roleElements = [...new Set([...this.document.querySelectorAll('[data-message-author-role], [data-message-author]')])].filter(visible);
    // ChatGPT's current renderer keeps the author on the conversation-turn
    // while the nested message role is mounting. Keep those turn markers even
    // when older precise role nodes already exist elsewhere in the thread: a
    // newly submitted user turn can briefly be represented only by its outer
    // marker, and dropping it here can turn a real send into a false timeout.
    const turnElements = [...new Set([...this.document.querySelectorAll('[data-turn="user"], [data-turn="assistant"]')])]
      .filter(visible)
      .filter((element) => {
        // Do not double-count a turn whose nested role node is already part of
        // the result. Test fixtures may not implement querySelector.
        if (typeof (element as Element).querySelector !== "function") return true;
        return !(element as Element).querySelector('[data-message-author-role], [data-message-author]');
      });
    return [...roleElements, ...turnElements];
  }

  private messageAuthor(element: Element) {
    return (element.getAttribute("data-message-author-role") || element.getAttribute("data-message-author") || element.getAttribute("data-turn") || "").trim().toLowerCase();
  }

  private assistantMessageElements() {
    return this.messageElements().filter((element) => this.messageAuthor(element) === "assistant");
  }

  private messageText(element: Element) {
    const visibleText = "innerText" in element && typeof (element as HTMLElement).innerText === "string"
      ? (element as HTMLElement).innerText
      : element.textContent || "";
    return visibleText.trim()
      .replace(/^(?:you said|chatgpt said)\s*:\s*/i, "")
      .replace(/\s+/g, " ")
      .replace(/(?:show more|show less)+$/i, "")
      .trim()
      .slice(0, 100000);
  }

  private assistantMessageTexts() {
    return this.assistantMessageElements()
      .map((element) => this.messageText(element))
      .filter((text) => text.length > 0);
  }

  /**
   * Return the rendered conversation surface, excluding ChatGPT's sidebar and
   * account controls. Artifact discovery is intentionally scoped to this
   * subtree: walking every button/link in the application shell can become a
   * multi-second main-thread operation while ChatGPT is mounting a Project.
   * Test fixtures may not expose querySelector at all, so the document remains
   * a compatibility fallback there. In a real browser, if ChatGPT is between
   * route surfaces and no conversation boundary exists yet, use an empty
   * fragment instead of scanning the whole application shell.
   */
  private conversationRoot(): ParentNode {
    try {
      const querySelector = (this.document as Document & { querySelector?: (selectors: string) => Element | null }).querySelector;
      if (typeof querySelector === "function") {
        for (const selector of ["#thread", "main", '[role="main"]']) {
          const root = querySelector.call(this.document, selector);
          if (root) return root;
        }
        const createDocumentFragment = (this.document as Document & { createDocumentFragment?: () => DocumentFragment }).createDocumentFragment;
        if (typeof createDocumentFragment === "function") return createDocumentFragment.call(this.document);
      }
    } catch {
      // Use the document fallback when a legacy/fixture document has no
      // querySelector implementation or the SPA replaces the root mid-read.
    }
    return this.document;
  }

  private userMessageTexts() {
    return this.messageElements()
      .filter((element) => this.messageAuthor(element) === "user")
      .map((element) => this.messageText(element))
      .filter((text) => text.length > 0);
  }

  private isTransientAssistantText(text: string) {
    return TRANSIENT_ASSISTANT_TEXT_RE.test(text.trim());
  }

  private isCompleteStructuredProfile(text: string) {
    return Boolean(extractStructuredProfileJson(text));
  }

  private expectsStructuredProfileResponse(instruction: string) {
    return /structured onboarding profile|professional-profile\.json|return exactly one json object/i.test(instruction);
  }

  private structuredProfileArtifactButtons(root: ParentNode = this.document, allowAnyJson = false) {
    const artifactName = allowAnyJson ? JSON_ARTIFACT_RE : PROFESSIONAL_PROFILE_ARTIFACT_RE;
    const candidates = [...new Set([
      ...root.querySelectorAll('button[aria-label], [role="button"][aria-label]'),
      ...root.querySelectorAll('button, [role="button"], a, [role="link"], [download], [data-testid*="artifact" i], [data-testid*="file" i]'),
    ])]
      .filter(visible)
      .filter(enabled);
    return candidates.filter((element) => {
      const ownMetadata = interactiveMetadata(element);
      if (artifactName.test(ownMetadata)) return true;

      // Some ChatGPT locales label the action only as “Open file” or
      // “Download”, while the filename is exposed on the surrounding card.
      // Keep this bounded to a nearby card and require an explicit file action
      // so unrelated buttons cannot be clicked.
      let parent = element.parentElement;
      for (let depth = 0; parent && depth < 5; depth += 1, parent = parent.parentElement) {
        const parentMetadata = interactiveMetadata(parent);
        if (artifactName.test(parentMetadata)
          && (ARTIFACT_OPEN_ACTION_RE.test(ownMetadata) || ARTIFACT_DOWNLOAD_ACTION_RE.test(ownMetadata))) return true;
      }
      return false;
    });
  }

  private structuredProfileViewerJsonCandidates() {
    const selectors = [
      '[id^="artifact-code-preview-"] .cm-content',
      '[id^="artifact-code-preview-"] pre',
      '[data-testid*="artifact" i] .cm-content',
      '[data-testid*="artifact" i] pre',
      '[data-testid*="artifact" i] code',
      '[data-testid*="file" i] .cm-content',
      '[data-testid*="file" i] pre',
      '[data-testid*="file" i] code',
      '[data-testid*="code" i] .cm-content',
      '[data-testid*="code" i] pre',
      '[data-testid*="code" i] code',
      '[data-artifact-preview-surface-mount] .cm-content',
      '[data-artifact-preview-surface-mount] pre',
      '[data-artifact-preview-surface-mount] code',
      '[data-artifact-preview-surface-mount]',
      '[data-testid="screen-threadFlyOut"] .cm-content',
      '[data-testid="screen-threadFlyOut"] pre',
      '[data-testid="screen-threadFlyOut"] code',
      '[data-testid="screen-threadFlyOut"]',
      '[id*="artifact" i] .cm-content',
      '[id*="artifact" i] pre',
      '[id*="artifact" i] code',
      '[class*="cm-content" i]',
      '[class*="code-block" i]',
      '[class*="codeblock" i]',
      'pre',
      'code',
      'textarea',
    ];
    const candidates = [...new Set(selectors.flatMap((selector) => [...this.document.querySelectorAll(selector)]))]
      .filter(visible)
      .map((element) => "value" in element && typeof (element as HTMLInputElement).value === "string"
        ? (element as HTMLInputElement).value
        : "innerText" in element && typeof (element as HTMLElement).innerText === "string"
          ? (element as HTMLElement).innerText
          : element.textContent || "")
      .map((raw) => raw.trim())
      .filter((raw) => raw.length > 0 && raw.length <= 120000);
    // ChatGPT has used several different preview components for generated
    // files. When none of the semantic preview selectors are present, inspect
    // only the visible file-preview surface rather than walking the entire
    // conversation on every poll. Parsing is still schema-gated by
    // extractStructuredProfileJson, so a normal prose element cannot be
    // accepted as a profile response.
    if (!candidates.some((raw) => Boolean(extractStructuredProfileJson(raw)))) {
      const previewRoots = [...new Set([
        ...this.document.querySelectorAll('[data-artifact-preview-surface-mount], [data-testid="screen-threadFlyOut"], [data-testid*="artifact" i], [role="dialog"]'),
      ])].filter(visible);
      const previewElements = previewRoots.flatMap((root) => [root, ...root.querySelectorAll("div, section, article")]);
      candidates.push(...previewElements
        .filter(visible)
        .map((element) => "value" in element && typeof (element as HTMLInputElement).value === "string"
          ? (element as HTMLInputElement).value
          : "innerText" in element && typeof (element as HTMLElement).innerText === "string"
            ? (element as HTMLElement).innerText
            : element.textContent || "")
        .map((raw) => raw.trim())
        .filter((raw) => raw.length > 0 && raw.length <= 120000 && /["']profile["']\s*:/i.test(raw)));
    }
    return [...new Set(candidates)].sort((left, right) => left.length - right.length);
  }

  private structuredProfileViewerJson() {
    for (const raw of this.structuredProfileViewerJsonCandidates()) {
      const json = extractStructuredProfileJson(raw);
      if (json) return json;
    }
    return null;
  }

  private async structuredProfileJsonFromArtifactLink(element: HTMLElement) {
    const metadata = interactiveMetadata(element);
    if (!JSON_ARTIFACT_RE.test(metadata)) return null;
    const href = (element as HTMLAnchorElement).href
      || element.getAttribute("href")
      || element.getAttribute("data-url")
      || element.getAttribute("data-file-url")
      || element.getAttribute("data-download-url");
    if (!href) return null;
    try {
      if (href.startsWith("data:")) {
        const comma = href.indexOf(",");
        if (comma < 0) return null;
        const metadataPart = href.slice(0, comma);
        const body = href.slice(comma + 1);
        const raw = /;base64/i.test(metadataPart) ? atob(body) : decodeURIComponent(body);
        return extractStructuredProfileJson(raw);
      }
      const parsed = new URL(href, this.location.href);
      const current = new URL(this.location.href);
      if (parsed.protocol !== "blob:" && parsed.origin !== current.origin) return null;
      const response = await fetch(parsed.toString(), { credentials: "include" });
      if (!response.ok) return null;
      return extractStructuredProfileJson(await response.text());
    } catch {
      return null;
    }
  }

  private structuredProfileJsonFromAssistantElement(element: Element) {
    const direct = extractStructuredProfileJson(this.messageText(element));
    if (direct) return direct;
    for (const selector of ["pre", "code", ".cm-content", '[data-testid*="artifact" i] pre', '[data-testid*="file" i] pre']) {
      for (const child of [...element.querySelectorAll(selector)]) {
        const raw = "innerText" in child && typeof (child as HTMLElement).innerText === "string"
          ? (child as HTMLElement).innerText
          : child.textContent || "";
        const json = extractStructuredProfileJson(raw);
        if (json) return json;
      }
    }
    return null;
  }

  private async openStructuredProfileArtifact(buttons: HTMLElement[], timeoutMs = 8000) {
    if (!buttons.length) return null;
    const orderedButtons = buttons
      .map((button, index) => ({ button, index, preferred: ARTIFACT_OPEN_ACTION_RE.test(`${String(button.className || "")} ${interactiveMetadata(button)}`) ? 2 : ARTIFACT_DOWNLOAD_ACTION_RE.test(interactiveMetadata(button)) ? 0 : 1 }))
      .sort((left, right) => right.preferred - left.preferred || right.index - left.index)
      .map(({ button }) => button);
    for (const button of orderedButtons) {
      const linkedJson = await this.structuredProfileJsonFromArtifactLink(button);
      if (linkedJson) return linkedJson;
      try {
        button.click();
      } catch {
        continue;
      }
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const json = this.structuredProfileViewerJson();
        if (json) return json;
        await this.waitForDomChange(Math.min(150, Math.max(1, timeoutMs - (Date.now() - started))));
      }
    }
    return null;
  }

  private async structuredProfileFromAssistantElement(element: Element, artifactButtons: HTMLElement[] = [], allowAnyJson = false) {
    return this.structuredProfileJsonFromAssistantElement(element)
      || await this.openStructuredProfileArtifact(artifactButtons.length ? artifactButtons : this.structuredProfileArtifactButtons(element, allowAnyJson));
  }

  private matchingProfessionalBackgroundUserIndex(instruction: string, messages = this.messageElements()) {
    const expected = normaliseComposerText(instruction);
    let lastMatchingUser = -1;
    messages.forEach((element, index) => {
      if (this.messageAuthor(element) === "user" && normaliseComposerText(this.messageText(element)) === expected) lastMatchingUser = index;
    });
    return lastMatchingUser;
  }

  private async existingProfessionalBackgroundResult(instruction: string, allowGlobalArtifact = true) {
    const requireStructuredProfile = this.expectsStructuredProfileResponse(instruction);
    const messages = this.messageElements();
    const lastMatchingUser = this.matchingProfessionalBackgroundUserIndex(instruction, messages);
    if (lastMatchingUser < 0) return null;
    const responses = messages.slice(lastMatchingUser + 1)
      .filter((element) => this.messageAuthor(element) === "assistant")
      .reverse();
    for (const element of responses) {
      const text = this.messageText(element);
      if (this.isTransientAssistantText(text)) continue;
      // The profile workflow can be issued with a short legacy instruction as
      // well as the current structured-profile wording. Parse a complete JSON
      // response whenever one is visible so an upgrade never sends the same
      // already-completed prompt a second time.
      const artifactJson = await this.structuredProfileFromAssistantElement(element, [], requireStructuredProfile);
      if (artifactJson) return { responseText: artifactJson, artifactJson };
      if (!requireStructuredProfile && text) return { responseText: text, artifactJson: null };
    }
    if (requireStructuredProfile && allowGlobalArtifact) {
      const artifactJson = await this.openStructuredProfileArtifact(this.structuredProfileArtifactButtons(this.conversationRoot(), requireStructuredProfile));
      if (artifactJson) return { responseText: artifactJson, artifactJson };
    }
    return null;
  }

  private existingProfessionalBackgroundResponse(instruction: string) {
    const requireStructuredProfile = this.expectsStructuredProfileResponse(instruction);
    const messages = this.messageElements();
    const lastMatchingUser = this.matchingProfessionalBackgroundUserIndex(instruction, messages);
    if (lastMatchingUser < 0) return null;
    const responses = messages.slice(lastMatchingUser + 1)
      .filter((element) => this.messageAuthor(element) === "assistant")
      .map((element) => this.messageText(element))
      .filter((text) => !this.isTransientAssistantText(text) && (!requireStructuredProfile || this.isCompleteStructuredProfile(text)));
    return responses[responses.length - 1] || null;
  }

  async checkExistingProfessionalBackgroundResponse(instruction: string, timeoutMs = 30000, boundConversationUrl?: string, boundProjectName?: string, boundProjectUrl?: string): Promise<AdapterSuccess | AdapterFailure> {
    if (boundConversationUrl && boundProjectName) {
      const target = this.verifyBoundConversation(boundConversationUrl, boundProjectName, boundProjectUrl);
      if (target) return target;
    }
    const safeTimeout = Math.max(1000, Math.min(timeoutMs, 120000));
    const started = Date.now();
    while (Date.now() - started < safeTimeout) {
      const existing = await this.existingProfessionalBackgroundResult(instruction);
      if (existing?.artifactJson) {
        return {
          ok: true as const,
          sent: true as const,
          delivery: "reused" as const,
          existingResponseText: existing.responseText || undefined,
          artifactJson: existing.artifactJson,
        };
      }
      await this.waitForDomChange(Math.min(250, Math.max(1, safeTimeout - (Date.now() - started))));
    }
    return failure("completed_response_not_found", "No completed professional-profile.json response was found in the bound ChatGPT conversation. No new message was sent.");
  }

  /**
   * Read-only recovery check for a dispatch whose message was already sent.
   * The exact user message is the anchor, so a response from an earlier
   * workflow part can never complete the current request. This is intentionally
   * separate from executeDispatch: recovery must never type or click Send.
   */
  async checkExistingDispatchResponse(instruction: string, timeoutMs = 30000, boundConversationUrl?: string, boundProjectName?: string, boundProjectUrl?: string): Promise<AdapterSuccess | AdapterFailure> {
    if (boundConversationUrl && boundProjectName) {
      const target = this.verifyBoundConversation(boundConversationUrl, boundProjectName, boundProjectUrl);
      if (target) return target;
    }
    const safeTimeout = Math.max(1000, Math.min(timeoutMs, 120000));
    const started = Date.now();
    const requireStructuredProfile = this.expectsStructuredProfileResponse(instruction);
    while (Date.now() - started < safeTimeout) {
      const existing = await this.existingProfessionalBackgroundResult(instruction, false);
      if (existing && (!requireStructuredProfile || existing.artifactJson)) {
        return {
          ok: true as const,
          sent: true as const,
          delivery: "reused" as const,
          existingResponseText: existing.responseText || undefined,
          artifactJson: existing.artifactJson || undefined,
        };
      }
      await this.waitForDomChange(Math.min(250, Math.max(1, safeTimeout - (Date.now() - started))));
    }
    const hasOutgoingMessage = this.matchingProfessionalBackgroundUserIndex(instruction) >= 0;
    return failure(
      hasOutgoingMessage ? "response_not_ready" : "dispatch_message_not_found",
      hasOutgoingMessage
        ? "The dispatch message is visible, but ChatGPT has not exposed a completed response yet."
        : "The previously sent dispatch message was not found in the bound ChatGPT conversation. No message was sent during recovery.",
    );
  }

  /**
   * Read-only delivery confirmation. This is used when the asynchronous
   * adapter operation or its runtime channel was interrupted after ChatGPT
   * accepted the message. An exact visible user message is sufficient proof
   * that the one-time send happened; no composer changes or clicks occur.
   */
  verifyExistingDispatchMessage(instruction: string, boundConversationUrl?: string, boundProjectName?: string, boundProjectUrl?: string): AdapterSuccess | AdapterFailure {
    if (boundConversationUrl && boundProjectName) {
      const target = this.verifyBoundConversation(boundConversationUrl, boundProjectName, boundProjectUrl);
      if (target) return target;
    }
    const expected = normaliseComposerText(instruction);
    const visibleUserMessage = this.messageElements()
      .filter((element) => this.messageAuthor(element) === "user")
      .some((element) => normaliseComposerText(this.messageText(element)) === expected);
    if (!visibleUserMessage) return failure("dispatch_message_not_found", "The exact dispatch message is not visible in the bound ChatGPT conversation. The bridge will keep checking without sending another message.");
    return {
      ok: true as const,
      sent: true as const,
      delivery: "verified" as const,
      assistantBaseline: this.assistantResponseSnapshot(),
    };
  }

  /**
   * Recover a workflow chat after the extension worker was suspended between
   * sending its setup marker and persisting the new conversation URL. This is
   * deliberately read-only: it only accepts the current conversation when
   * the exact one-time marker is already visible in a user message.
   */
  async recoverWorkflowConversation(input: { marker: string; projectUrl: string }) {
    let current: string;
    let expectedProject: string;
    try {
      current = normalizeUrl(this.location.href);
      expectedProject = normalizeUrl(input.projectUrl);
    } catch {
      return failure("workflow_recovery_url_invalid", "The workflow setup recovery URLs could not be verified safely.");
    }
    const conversation = conversationUrl(current);
    if (!conversation || conversation === expectedProject) return failure("workflow_recovery_not_conversation", "The active ChatGPT page is not a candidate workflow conversation.");
    if (!sameProjectUrl(projectUrlFor(conversation), expectedProject)) return failure("workflow_recovery_wrong_project", "The active ChatGPT conversation is not inside the JobHuntAI Project.");
    if (!this.detectAuthenticationState()) return failure("not_authenticated", "ChatGPT is not visibly signed in.");
    const modal = this.detectBlockingModal();
    if (modal) return modal;
    if (!this.projectIsVerified(CHATGPT_PROJECT_NAME, expectedProject)) return failure("project_not_verified", `The visible Project could not be verified as exactly '${CHATGPT_PROJECT_NAME}'.`);

    const expectedMarker = normaliseComposerText(input.marker);
    const started = Date.now();
    while (Date.now() - started < WORKFLOW_CONVERSATION_RECOVERY_TIMEOUT_MS) {
      const messages = this.messageElements();
      const markerVisible = messages.some((element) => this.messageAuthor(element) === "user" && normaliseComposerText(this.messageText(element)) === expectedMarker);
      if (markerVisible) {
        return {
          ok: true as const,
          conversationUrl: conversation,
          projectName: CHATGPT_PROJECT_NAME,
          projectVerified: true as const,
          setupMessageSent: true as const,
          recovered: true as const,
        };
      }
      // A settled existing conversation without the marker cannot become the
      // requested workflow chat. Avoid adding a 15-second pause before every
      // normal next-chat creation while still allowing a newly navigated chat
      // a bounded period to render its first message.
      if (messages.length > 0) break;
      await this.waitForDomChange(Math.min(250, Math.max(1, WORKFLOW_CONVERSATION_RECOVERY_TIMEOUT_MS - (Date.now() - started))));
    }
    return failure("workflow_marker_not_found", "The exact workflow setup marker was not found in the active conversation.");
  }

  private duplicateProfessionalBackgroundInstruction(instruction: string) {
    const messages = this.messageElements();
    const lastMatchingUser = this.matchingProfessionalBackgroundUserIndex(instruction, messages);
    if (lastMatchingUser < 0) return false;
    return messages.slice(lastMatchingUser + 1).some((element) => {
      if (this.messageAuthor(element) !== "assistant") return false;
      const text = this.messageText(element);
      return text.length > 0 && !this.isTransientAssistantText(text)
        && (this.isCompleteStructuredProfile(text) || this.structuredProfileArtifactButtons(element).length > 0);
    });
  }

  assistantResponseSnapshot(includeArtifacts = true): AssistantResponseBaseline {
    const messages = this.assistantMessageElements();
    return {
      count: messages.length,
      lastText: messages.length ? this.messageText(messages[messages.length - 1]) : "",
      // Count every visible JSON artifact at the baseline. The profile
      // response may use a slightly different filename on another ChatGPT
      // locale, and an older JSON file must never be mistaken for the new
      // response just because the structured wait accepts generic .json
      // filenames.
      ...(includeArtifacts ? { artifactCount: this.structuredProfileArtifactButtons(this.conversationRoot(), true).length } : {}),
    };
  }

  async waitForAssistantResponse(baseline: AssistantResponseBaseline, timeoutMs = 180000, workflowKey?: ConversationSlotKey, expectStructuredProfile = false) {
    const safeTimeout = Math.max(1000, Math.min(timeoutMs, CHATGPT_RESPONSE_CAPTURE_TIMEOUT_MS));
    const started = Date.now();
    let stableText = "";
    let stableSince = 0;
    let capturedArtifactJson: string | null = null;
    let artifactCaptureAttempts = 0;
    let lastArtifactCaptureAttemptAt = 0;
    while (Date.now() - started < safeTimeout) {
      const messages = this.assistantMessageElements();
      const candidateElement = messages[messages.length - 1] || null;
      const candidate = candidateElement ? this.messageText(candidateElement) : "";
      const artifactButtons = expectStructuredProfile ? this.structuredProfileArtifactButtons(this.conversationRoot(), true) : [];
      const newArtifactButtons = artifactButtons.length > (baseline.artifactCount || 0)
        ? artifactButtons.slice(baseline.artifactCount || 0)
        : [];
      const isNew = messages.length > baseline.count
        || (Boolean(candidate) && candidate !== baseline.lastText)
        || newArtifactButtons.length > 0;
      let artifactJson: string | null = expectStructuredProfile
        ? capturedArtifactJson || extractStructuredProfileJson(candidate)
        : null;
      if (expectStructuredProfile && !artifactJson && isNew && Date.now() - lastArtifactCaptureAttemptAt >= 1000 && artifactCaptureAttempts < 8) {
        const candidateArtifactButtons = candidateElement ? this.structuredProfileArtifactButtons(candidateElement, true) : [];
        const captureButtons = candidateArtifactButtons.length ? candidateArtifactButtons : newArtifactButtons;
        if (captureButtons.length > 0) {
          artifactCaptureAttempts += 1;
          lastArtifactCaptureAttemptAt = Date.now();
          artifactJson = candidateElement
            ? await this.structuredProfileFromAssistantElement(candidateElement, captureButtons)
            : await this.openStructuredProfileArtifact(captureButtons);
          if (artifactJson) capturedArtifactJson = artifactJson;
        }
      }
      const responseText = artifactJson || candidate;
      const isTransient = !artifactJson && this.isTransientAssistantText(candidate);
      const isReadyForWorkflow = !expectStructuredProfile || Boolean(artifactJson);
      // A complete JSON object is authoritative even if ChatGPT briefly keeps
      // its stop control visible while it renders the attachment/toolbar.
      const generationFinished = !this.detectGenerationStarted() || Boolean(artifactJson);
      if (isNew && Boolean(responseText) && !isTransient && isReadyForWorkflow && generationFinished) {
        if (responseText !== stableText) {
          stableText = responseText;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 700) {
          return { ok: true as const, responseText, artifactJson: artifactJson || undefined };
        }
      } else {
        stableText = "";
        stableSince = 0;
      }
      await this.waitForDomChange(Math.min(250, Math.max(1, safeTimeout - (Date.now() - started))));
    }
    return failure("response_not_captured", "ChatGPT did not expose a completed assistant response in the bound conversation. The message was sent once; choose the explicit MCP fallback or review the chat manually.");
  }

  async verifyMessageSent(expected: string, composer: Composer, timeoutMs = SENT_VERIFICATION_TIMEOUT_MS, initialComposerValue?: string) {
    const started = Date.now();
    const expectedText = normaliseComposerText(expected);
    const initial = initialComposerValue ?? ("value" in composer && typeof composer.value === "string" ? composer.value : composer.innerText || composer.textContent || "");
    const initialText = normaliseComposerText(initial);
    while (Date.now() - started < timeoutMs) {
      const current = "value" in composer && typeof composer.value === "string" ? composer.value : composer.innerText || composer.textContent || "";
      const currentText = normaliseComposerText(current);
      const outgoing = this.messageElements()
        .filter((element) => this.messageAuthor(element) === "user")
        .some((element) => normaliseComposerText(this.messageText(element)) === expectedText);
      // Clearing the composer alone is not proof of delivery: ChatGPT can
      // rerender or discard an uncommitted editor transaction without adding
      // a user turn. Require either the exact outgoing message or the visible
      // Stop control that only appears after generation has begun. This keeps
      // the at-most-once guarantee honest and prevents false "sent" records.
      if (outgoing || this.detectGenerationStarted()) return null;
      await this.waitForDomChange(Math.min(150, Math.max(1, timeoutMs - (Date.now() - started))));
    }
    return failure("delivery_uncertain", "The ChatGPT composer did not clear and the exact outgoing message could not be verified. No automatic resend is safe.");
  }

  async sendMessage(expected: string, composer: Composer) {
    if (this.detectGenerationStarted()) return failure("already_generating", "ChatGPT is already generating another response.");
    // Let the page-owned editor flush the input transaction before resolving
    // the Send control. Without this yield a React/ProseMirror update can be
    // one event-loop turn behind, so a programmatic click may observe an empty
    // internal value and do nothing even though the text is visible.
    await this.settleComposerInput();
    const settledComposer = this.findComposer() || composer;
    const settled = this.verifyComposerText(settledComposer, expected);
    if (settled) return settled;
    const sendControlStartedAt = Date.now();
    const send = await this.waitForSendControl(settledComposer);
    const sendControlWaitMs = Date.now() - sendControlStartedAt;
    if (!send) return failure("send_not_verified", "The enabled ChatGPT Send control could not be identified safely for this account or locale.");
    const composerBeforeSend = "value" in settledComposer && typeof settledComposer.value === "string" ? settledComposer.value : settledComposer.innerText || settledComposer.textContent || "";
    const postClickStartedAt = Date.now();
    send.click();
    const verified = await this.verifyMessageSent(expected, settledComposer, SENT_VERIFICATION_TIMEOUT_MS, composerBeforeSend);
    const postClickVerificationMs = Date.now() - postClickStartedAt;
    return verified || ({
      ok: true,
      sent: true,
      delivery: "verified",
      timing: { send_control_wait_ms: sendControlWaitMs, post_click_verification_ms: postClickVerificationMs },
    } as AdapterSuccess);
  }

  bindCurrentConversation(expectedProjectName: string) {
    if (!this.detectAuthenticationState()) return failure("not_authenticated", "ChatGPT is not visibly signed in.");
    const modal = this.detectBlockingModal();
    if (modal) return modal;
    if (!this.projectIsVerified(expectedProjectName)) return failure("project_not_verified", `Open the dedicated conversation inside the '${expectedProjectName}' Project before binding.`);
    try {
      const url = normalizeUrl(this.location.href);
      if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(url)) return failure("wrong_origin", "The active tab is not on a supported ChatGPT origin.");
      if (!conversationUrl(url)) return failure("not_a_conversation", "The active ChatGPT page is the Project home, not a conversation. Choose a workflow and use automatic setup or open a conversation first.");
      return { ok: true as const, conversationUrl: url, projectName: expectedProjectName, projectVerified: true as const };
    } catch { return failure("conversation_not_canonical", "The current ChatGPT URL could not be canonicalised safely."); }
  }

  verifyProjectContext(expectedProjectName: string, expectedProjectUrl?: string) {
    const rateLimit = this.detectRateLimit();
    if (rateLimit) return rateLimit;
    const current = normalizeUrl(this.location.href);
    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(current)) return failure("wrong_origin", "The active tab is not on a supported ChatGPT origin.");
    const modal = this.detectBlockingModal();
    if (modal) return modal;
    // Immediately after the exact Create project action, ChatGPT can expose
    // the new Project URL before it mounts the composer. In that narrow,
    // causally verified state, the exact name entered in the dialog plus the
    // newly navigated Project URL is sufficient; normal/manual verification
    // still requires a visible authenticated ChatGPT surface.
    const createdHere = this.projectWasCreatedHere(expectedProjectName);
    const matchesExpectedUrl = this.projectMatchesExpectedUrl(expectedProjectUrl);
    if (!this.detectAuthenticationState() && !createdHere && !matchesExpectedUrl) return failure("not_authenticated", "ChatGPT is not visibly signed in.");
    if (/\/c\//i.test(new URL(current).pathname) && this.boundConversationIsMissing(current, expectedProjectName)) {
      return failure("conversation_missing", "The active ChatGPT conversation is missing or was deleted.");
    }
    const projectUrl = projectUrlFor(current);
    if (!projectUrl) return failure("project_url_unknown", "The JobHuntAI Project URL could not be derived safely from the active ChatGPT page.");
    if (!this.projectIsVerified(expectedProjectName, expectedProjectUrl)) return failure("project_not_verified", `The visible Project could not be verified as exactly '${expectedProjectName}'.`);
    return { ok: true as const, projectUrl, projectName: expectedProjectName, projectVerified: true as const };
  }

  async waitForProjectContext(expectedProjectName: string, timeoutMs = 12000, expectedProjectUrl?: string) {
    const started = Date.now();
    let latest = this.verifyProjectContext(expectedProjectName, expectedProjectUrl);
    while (latest.ok !== true && Date.now() - started < timeoutMs) {
      await this.waitForDomChange(Math.min(150, Math.max(1, timeoutMs - (Date.now() - started))));
      latest = this.verifyProjectContext(expectedProjectName, expectedProjectUrl);
    }
    return latest;
  }

  async createWorkflowConversation(input: { workflowKey: ConversationSlotKey; displayName: string; projectUrl: string }) {
    const context = await this.waitForProjectContext(CHATGPT_PROJECT_NAME, 12000, input.projectUrl);
    if (!context || context.ok !== true) return context;
    if (context.projectUrl !== normalizeUrl(input.projectUrl)) return failure("wrong_project", "The active ChatGPT page is not the stored JobHuntAI Project. Nothing was sent.");
    if (!/\/project$/i.test(normalizeUrl(this.location.href))) return failure("project_home_required", "The JobHuntAI Project home is required to create a fresh workflow conversation.");
    const composer = await this.waitForComposer(12000);
    if (!composer) return failure("composer_not_verified", "The JobHuntAI Project new-chat composer was not identified safely.");
    const marker = workflowSetupMarker(input.workflowKey, input.displayName);
    const set = this.setComposerText(composer, marker);
    if (set) return set;
    const verified = this.verifyComposerText(composer, marker, "workflow setup message");
    if (verified) return verified;
    const sent = await this.sendMessage(marker, composer);
    if (sent.ok !== true) return sent;
    const started = Date.now();
    let unassociatedConversationSince: number | null = null;
    const expectedProject = normalizeUrl(input.projectUrl);
    while (Date.now() - started < WORKFLOW_CONVERSATION_CREATION_TIMEOUT_MS) {
      const created = conversationUrl(this.location.href);
      if (created && created !== normalizeUrl(input.projectUrl)) {
        if (sameProjectUrl(projectUrlFor(created), expectedProject)) {
          return { ok: true as const, conversationUrl: created, projectName: CHATGPT_PROJECT_NAME, projectVerified: true as const, setupMessageSent: true as const };
        }
        // A route transition can briefly expose a generic /c/<id> URL before
        // ChatGPT attaches the conversation to its Project URL. Give that
        // transition a short bounded window, but never bind an unassociated
        // conversation as a workflow chat.
        unassociatedConversationSince ??= Date.now();
        if (Date.now() - unassociatedConversationSince >= WORKFLOW_CONVERSATION_PROJECT_MATCH_TIMEOUT_MS) {
          return failure("conversation_wrong_project", "ChatGPT opened the setup conversation outside the JobHuntAI Project. No conversation was bound; retry setup to create it from the verified Project home.");
        }
      }
      await this.waitForDomChange(Math.min(250, Math.max(1, WORKFLOW_CONVERSATION_CREATION_TIMEOUT_MS - (Date.now() - started))));
    }
    return failure("conversation_creation_uncertain", "ChatGPT accepted the setup marker but did not expose the new conversation URL. No duplicate setup message is safe; inspect the Project and retry setup.");
  }

  async executeDispatch(input: { requestId: string; workflowKey: ConversationSlotKey; instruction: string; boundConversationUrl: string; boundProjectName: string; boundProjectUrl?: string }): Promise<AdapterSuccess | AdapterFailure> {
    const rateLimit = this.detectRateLimit();
    if (rateLimit) return rateLimit;
    // A newly opened bound conversation can expose the content script before
    // ChatGPT has mounted its composer. Checking authentication immediately
    // at that point misclassifies a signed-in loading page as signed out.
    // Wait for the visible composer first, then perform the authenticated
    // delivery checks against the settled page.
    const composerWaitStartedAt = Date.now();
    const composer = await this.waitForComposer(12000);
    const composerWaitMs = Date.now() - composerWaitStartedAt;
    if (!composer) {
      const pageText = (this.document.body?.innerText || "").slice(0, 8000);
      const signedOut = AUTH_URL_RE.test(this.location.pathname) || /\b(log in|sign in)\b/i.test(pageText);
      return signedOut
        ? failure("not_authenticated", "ChatGPT is not visibly signed in. Sign in manually and retry.")
        : failure("composer_not_verified", "The ChatGPT composer was not identified safely. Keep the bound conversation open and retry.");
    }
    const auth = this.detectAuthenticationState();
    if (!auth) return failure("not_authenticated", "ChatGPT is not visibly signed in. Sign in manually and retry.");
    const modal = this.detectBlockingModal();
    if (modal) return modal;
    const target = this.verifyBoundConversation(input.boundConversationUrl, input.boundProjectName, input.boundProjectUrl);
    if (target) return target;
    if (input.workflowKey === "profile.background") {
      const existing = await this.existingProfessionalBackgroundResult(input.instruction);
      if (existing?.artifactJson) {
        return {
          ok: true as const,
          sent: true as const,
          delivery: "reused" as const,
          existingResponseText: existing.responseText,
          artifactJson: existing.artifactJson,
        };
      }
    }
    if (input.workflowKey === "profile.background" && this.duplicateProfessionalBackgroundInstruction(input.instruction)) {
      return failure("duplicate_instruction", "An identical professional-background instruction is already visible in this ChatGPT conversation. The duplicate dispatch was stopped without sending another message.");
    }
    // The extension transports the server instruction into the already bound
    // Project conversation. It must not open ChatGPT's +/app picker: whether
    // the JobHuntAI MCP connection is available is a ChatGPT Project/account
    // concern, not a prerequisite for website delivery.
    // Artifact enumeration walks the entire rendered ChatGPT conversation and
    // can be expensive on long threads. Only the structured profile workflow
    // needs an artifact baseline; ordinary Website Bridge dispatches can start
    // immediately after the assistant-message snapshot.
    const assistantBaselineStartedAt = Date.now();
    const assistantBaseline = this.assistantResponseSnapshot(input.workflowKey === "profile.background");
    const assistantBaselineMs = Date.now() - assistantBaselineStartedAt;
    const preSendValidationStartedAt = Date.now();
    const set = this.setComposerText(composer, input.instruction);
    if (set) return set;
    const verified = this.verifyComposerText(composer, input.instruction);
    if (verified) return verified;
    const preSendValidationMs = Date.now() - preSendValidationStartedAt;
    const sent = await this.sendMessage(input.instruction, composer);
    return sent.ok === true ? {
      ...sent,
      assistantBaseline,
      timing: {
        composer_wait_ms: composerWaitMs,
        assistant_baseline_ms: assistantBaselineMs,
        pre_send_validation_ms: preSendValidationMs,
        ...sent.timing,
      },
    } : sent;
  }
}

export function adapterErrorForTest(document: Document, location: Location) {
  return new ChatGptUiAdapter(document, location);
}
