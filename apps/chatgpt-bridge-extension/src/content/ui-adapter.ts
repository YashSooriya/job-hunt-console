import { CHATGPT_PROJECT_NAME, CHATGPT_RESPONSE_CAPTURE_TIMEOUT_MS, MAX_WEBSITE_INSTRUCTION_CHARS, PROFESSIONAL_BACKGROUND_INITIALIZATION_MESSAGE, canonicalBridgeConversationUrl, extractStructuredProfileJson, isNonEmptyString, safeReason, sameConversationUrl, sameProjectUrl, type ConversationSlotKey, type DispatchResponseBaseline, type DispatchResponseProvenance, type DispatchTiming, type DispatchTurnAnchor } from "../shared/protocol";
import { parseRetryAfterSeconds } from "../shared/concurrency";

export type AssistantResponseBaseline = DispatchResponseBaseline & { userTurnPrefix?: string | null };
export type AdapterTiming = DispatchTiming;
export type AdapterFailure = { ok: false; code: string; reason: string; userRequired: true; retryAfterSeconds?: number | null; timing?: AdapterTiming };
export type AdapterSuccess = { ok: true; sent: true; delivery: "verified" | "reused"; assistantBaseline?: AssistantResponseBaseline; turnAnchor?: DispatchTurnAnchor | null; userTurnFingerprint?: string | null; userTurnMessageId?: string | null; existingResponseText?: string; artifactJson?: string; responseProvenance?: DispatchResponseProvenance; timing?: AdapterTiming };

type Composer = HTMLElement & { value?: string; disabled?: boolean };
type StructuredProfileCapture = {
  json: string;
  source: DispatchResponseProvenance["source"];
  artifactKey: string | null;
};

const AUTH_URL_RE = /\/(auth|login|sign-in)(?:[/?#]|$)/i;
const BLOCKING_RE = /(captcha|verify you are human|permission|allow access|confirm|sign in|log in|mfa|multi-factor|security check|continue with)/i;
const RATE_LIMIT_RE = /(too many requests|making requests too quickly|temporarily limited access to your conversations|please wait (?:a few|\d+) (?:seconds?|minutes?)|rate limit(?:ed)?)/i;
const MISSING_CONVERSATION_RE = /(?:conversation|chat|thread).{0,80}(?:not found|does not exist|no longer (?:exists|available)|deleted|unavailable|could not find|can't find)|(?:page|conversation|chat).{0,20}\b404\b|\b404\b.{0,40}(?:not found|conversation|chat|page)/i;
const SEND_LABEL_RE = /^(send|send message|send prompt|submit|submit message)$/i;
const SEND_TEST_ID_RE = /^(?:.*[-_:])?(?:send|submit)(?:[-_:]?(?:button|message|prompt))?(?:[-_:]?button)?$/i;
const STOP_LABEL_RE = /^(stop|stop generating|stop streaming|stop answering|cancel|cancel response)$/i;
const COPY_RESPONSE_LABEL_RE = /^copy response$/i;
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
const RESPONSE_BASELINE_SETTLE_MS = 400;
const RESPONSE_BASELINE_TIMEOUT_MS = 12000;
// An inactive ChatGPT tab can be throttled while its SPA mounts after a
// reload. Keep the normal warm path immediate, but give a cold background tab
// enough time to expose its composer before stopping before Send.
const WEBSITE_DISPATCH_COMPOSER_WAIT_TIMEOUT_MS = 30000;

function visible(element: Element | null): element is HTMLElement {
  if (!element || (typeof HTMLElement !== "undefined" && !(element instanceof HTMLElement))) return false;
  if (typeof (element as Element).getAttribute !== "function") return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return style?.display !== "none" && style?.visibility !== "hidden" && element.getClientRects().length > 0;
}

function backgroundVisible(element: Element | null): element is HTMLElement {
  if (visible(element)) return true;
  if (!element || !element.isConnected || element.getAttribute("aria-hidden") === "true" || element.hasAttribute("hidden")) return false;
  // Chrome can temporarily report no layout rect for a control while an
  // inactive ChatGPT document is mounting. Keep the structural visibility
  // checks, but do not require a paint rect until the tab is foregrounded.
  const document = element.ownerDocument;
  if (document.visibilityState !== "hidden") return false;
  const style = document.defaultView?.getComputedStyle(element);
  return style?.display !== "none" && style?.visibility !== "hidden";
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

function composerTextChunks(value: string, limit = 1600) {
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(value.length, start + limit);
    if (end < value.length) {
      const boundary = Math.max(value.lastIndexOf("\n", end), value.lastIndexOf(" ", end));
      if (boundary > start + Math.floor(limit / 2)) end = boundary + 1;
    }
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

function composerMatchesMarkdownLinks(actual: string, expected: string, composer: Composer) {
  const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const expectedLinks = [...expected.matchAll(pattern)];
  if (!expectedLinks.length) return false;

  // The ChatGPT composer may keep Markdown links as text while exposing the
  // URL with inserted spaces, e.g. "[role]( https://example.com/job )".
  // Normalise only those link-boundary spaces and list markers, then require
  // the full source text (including every URL) to match exactly.
  const normaliseMarkdownSource = (value: string) => normaliseComposerText(
    value
      .replace(/\]\(\s*(https?:\/\/[^)\s]+)\s*\)/g, "]($1)")
      .replace(/^[ \t]*[-*+][ \t]+/gm, ""),
  );
  if (normaliseMarkdownSource(actual) === normaliseMarkdownSource(expected)) return true;

  // ChatGPT can render a Markdown link as an anchor in its rich-text
  // composer. In that representation innerText contains the visible label
  // while the destination lives in href. Accept that equivalent rendering
  // only when every label and destination still matches the original input.
  const visibleExpected = expected
    .replace(pattern, "$1")
    // ChatGPT renders Markdown bullet lines as semantic list items, whose
    // innerText no longer contains the source "- " marker. Validate the
    // remaining line text exactly and recover the link destinations below.
    .replace(/^\s*[-*+]\s+/gm, "");
  if (normaliseComposerText(actual) !== normaliseComposerText(visibleExpected)) return false;
  const anchors = [...composer.querySelectorAll("a[href]")];
  if (anchors.length !== expectedLinks.length) return false;

  return expectedLinks.every((match, index) => {
    const label = normaliseComposerText(match[1] || "");
    const expectedUrl = match[2] || "";
    const anchor = anchors[index];
    const actualLabel = normaliseComposerText(anchor.textContent || (anchor as HTMLElement).innerText || "");
    const href = anchor.getAttribute("href") || "";
    try {
      const actualUrl = new URL(href, composer.ownerDocument.baseURI).toString().replace(/\/$/, "");
      const exactExpectedUrl = new URL(expectedUrl).toString().replace(/\/$/, "");
      return actualLabel === label && actualUrl === exactExpectedUrl;
    } catch {
      return false;
    }
  });
}

function composerMatchesRawUrlAnchors(actual: string, expected: string, composer: Composer) {
  // Website instructions commonly carry public listing URLs as JSON string
  // values rather than Markdown links. ChatGPT may auto-linkify those values
  // and render only a shortened label in innerText. Accept that editor-owned
  // representation only when every href is the exact URL and all surrounding
  // composer text remains byte-for-byte equivalent after whitespace folding.
  const markdownLinkPattern = /\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/g;
  if (markdownLinkPattern.test(expected)) return false;
  const expectedUrls = [...expected.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) => match[0]);
  if (!expectedUrls.length) return false;
  const anchors = [...composer.querySelectorAll("a[href]")];
  if (anchors.length !== expectedUrls.length) return false;

  const expectedText = normaliseComposerText(expected);
  const actualText = normaliseComposerText(actual);
  let expectedCursor = 0;
  let actualCursor = 0;
  for (let index = 0; index < expectedUrls.length; index += 1) {
    const expectedUrl = expectedUrls[index];
    const expectedIndex = expectedText.indexOf(expectedUrl, expectedCursor);
    if (expectedIndex < 0) return false;
    const prefix = expectedText.slice(expectedCursor, expectedIndex);
    if (actualText.slice(actualCursor, actualCursor + prefix.length) !== prefix) return false;
    actualCursor += prefix.length;

    const anchor = anchors[index];
    const actualLabel = normaliseComposerText(anchor.textContent || (anchor as HTMLElement).innerText || "");
    const href = anchor.getAttribute("href") || "";
    try {
      const actualUrl = new URL(href, composer.ownerDocument.baseURI).toString().replace(/\/$/, "");
      const exactExpectedUrl = new URL(expectedUrl).toString().replace(/\/$/, "");
      if (actualUrl !== exactExpectedUrl || !actualLabel) return false;
    } catch {
      return false;
    }

    // If the full URL is shown, its anchor label must be the full URL too. If
    // ChatGPT shortens the visible label, consume only that label and rely on
    // the exact href above to reconstruct this single URL span.
    const visibleSpan = actualText.slice(actualCursor, actualCursor + actualLabel.length);
    if (visibleSpan !== actualLabel) return false;
    if (actualLabel === expectedUrl && visibleSpan !== expectedUrl) return false;
    actualCursor += actualLabel.length;
    expectedCursor = expectedIndex + expectedUrl.length;
  }
  return actualText.slice(actualCursor) === expectedText.slice(expectedCursor);
}

function composerMatchesInsertedPrefix(composer: Composer, expected: string) {
  const actual = composer.innerText || composer.textContent || "";
  return normaliseComposerText(actual) === normaliseComposerText(expected)
    || composerMatchesMarkdownLinks(actual, expected, composer)
    || composerMatchesRawUrlAnchors(actual, expected, composer);
}

function composerMismatchDiagnostics(actual: string, expected: string, composer: Composer) {
  const normalizedActual = normaliseComposerText(actual);
  const normalizedExpected = normaliseComposerText(expected);
  const contentText = composer.textContent || "";
  const normalizedContent = normaliseComposerText(contentText);
  let commonPrefixLength = 0;
  const commonLimit = Math.min(normalizedActual.length, normalizedExpected.length);
  while (commonPrefixLength < commonLimit
    && normalizedActual[commonPrefixLength] === normalizedExpected[commonPrefixLength]) commonPrefixLength += 1;
  let commonSuffixLength = 0;
  while (commonSuffixLength < commonLimit - commonPrefixLength
    && normalizedActual[normalizedActual.length - commonSuffixLength - 1]
      === normalizedExpected[normalizedExpected.length - commonSuffixLength - 1]) commonSuffixLength += 1;
  let anchorCount = -1;
  try { anchorCount = composer.querySelectorAll("a[href]").length; } catch { /* The rendered composer may not expose link nodes. */ }
  const expectedUrls = [...expected.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) => match[0]);
  const actualUrls = [...actual.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) => match[0]);
  const exactUrlMatches = expectedUrls.reduce((count, url, index) => count + Number(actualUrls[index] === url), 0);
  const visibility = composer.ownerDocument.visibilityState === "hidden" ? "background" : "visible";
  return `lens=${expected.length}/${actual.length}; prefix=${commonPrefixLength}; suffix=${commonSuffixLength}; text=${contentText.length}/${Number(normalizedContent === normalizedExpected)}; urls=${expectedUrls.length}/${actualUrls.length}/${exactUrlMatches}; links=${anchorCount}; tab=${visibility}`;
}

function messageFingerprint(value: string) {
  // A short deterministic fingerprint lets recovery identify the exact
  // rendered turn without persisting the full prompt in another metadata
  // field. It is deliberately local and is not intended as a cryptographic
  // digest.
  const text = normaliseComposerText(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16)}:${text.length}`;
}

function fallbackSearchUnit(element: Element) {
  const keys = [
    element.getAttribute("data-content-search-unit-key"),
    element.getAttribute("data-chatgpt-search-unit-key"),
  ].filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim());
  if (!keys.length || keys.some((value) => value !== keys[0])) return null;
  const match = /^fallback-turn-(\d+):(\d+):(user|assistant)$/i.exec(keys[0]);
  if (!match) return null;
  return { key: keys[0], turnKey: `fallback-turn-${match[1]}`, author: match[3].toLowerCase() };
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

function failure(code: string, reason: string, extra: Partial<Pick<AdapterFailure, "retryAfterSeconds" | "timing">> = {}): AdapterFailure {
  return { ok: false, code, reason: safeReason(reason), userRequired: true, ...extra } as AdapterFailure;
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
    if (!RATE_LIMIT_RE.test(text)) return null;
    const retryAfterSeconds = parseRetryAfterSeconds(text);
    return failure(
      "chatgpt_rate_limited",
      retryAfterSeconds
        ? `ChatGPT temporarily limited requests. Retry after about ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}; no new message was sent.`
        : "ChatGPT temporarily limited requests. The bridge will wait for the safe fallback window before resuming; no new message was sent.",
      { retryAfterSeconds },
    );
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
      if (!sameConversationUrl(currentUrl, expectedConversation)) return failure("wrong_conversation", "The current ChatGPT URL is not the bound JobHuntAI conversation.");
      if (expectedProjectUrl) {
        const actualProject = projectUrlFor(currentUrl);
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
      if (!sameConversationUrl(current, expected) && /^\/$/.test(new URL(current).pathname)) {
        const text = (this.document.body?.innerText || "").slice(0, 12000);
        if (!AUTH_URL_RE.test(this.location.pathname) && !/\b(log in|sign in)\b/i.test(text) && /\b(chat history|new chat)\b/i.test(text)) return true;
      }
      // ChatGPT may keep the deleted conversation URL in the address bar
      // while rendering the signed-in home surface. A URL-only check would
      // incorrectly treat that page as a healthy bound conversation because
      // the project slug is still present. Bound workflow chats always have
      // at least one persisted message, so the home greeting plus no message
      // surface is a safe deletion signal.
      if (sameConversationUrl(current, expected) && this.messageElements().length === 0) {
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
    const canonical = [...this.document.querySelectorAll('[contenteditable="true"][role="textbox"]')]
      .filter(backgroundVisible).filter(enabled);
    if (canonical.length === 1) return canonical[0] as Composer;
    const candidates = [
      ...this.document.querySelectorAll('[contenteditable="true"][aria-label]'),
      ...this.document.querySelectorAll('textarea[aria-label]'),
      ...this.document.querySelectorAll('textarea[data-testid]'),
    ].filter(backgroundVisible).filter(enabled);
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
        const conversationRoot = this.conversationRoot();
        const observationTarget = "nodeType" in conversationRoot && (conversationRoot as Node).nodeType === 1
          ? conversationRoot as Node
          : this.document.body;
        observer = new Observer(() => {
          clearTimeout(timer);
          finish();
        });
        observer.observe(observationTarget, { childList: true, subtree: true, characterData: true });
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

  async setComposerText(composer: Composer, text: string) {
    if (!isNonEmptyString(text, MAX_WEBSITE_INSTRUCTION_CHARS)) return failure("instruction_invalid", "The server instruction is missing or too long.");
    let activeComposer = composer;
    activeComposer.focus();
    if ("value" in activeComposer && typeof activeComposer.value === "string") {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(activeComposer), "value")?.set
        || (typeof HTMLTextAreaElement !== "undefined" ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set : undefined)
        || (typeof HTMLInputElement !== "undefined" ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set : undefined);
      if (setter) setter.call(activeComposer, text); else activeComposer.value = text;
      dispatchDomEvent(activeComposer, "input", { inputType: "insertText", data: text });
    } else {
      const document = activeComposer.ownerDocument || this.document;
      const selection = document.getSelection?.();
      const range = document.createRange?.();
      // ProseMirror (the current ChatGPT composer) listens to the browser's
      // editing events rather than a direct textContent assignment. Long
      // prompts are inserted in bounded transactions so the page-owned editor
      // can commit each one before the next; one large synthetic insertion can
      // be discarded when the inactive page rerenders its editor state. The
      // editor node itself can also be replaced during that reconciliation, so
      // re-resolve it after each transaction and restart once if its saved text
      // does not contain the exact prefix already inserted.
      const chunks = composerTextChunks(text);
      let insertedLength = 0;
      let composerReplacementRestarts = 0;
      for (let index = 0; index < chunks.length; index += 1) {
        const currentComposer = typeof this.document.querySelectorAll === "function" ? this.findComposer() : null;
        if (currentComposer && currentComposer !== activeComposer) {
          activeComposer = currentComposer;
          if (insertedLength > 0 && !composerMatchesInsertedPrefix(activeComposer, text.slice(0, insertedLength))) {
            if (composerReplacementRestarts >= 1) return failure("composer_mismatch", "ChatGPT replaced the inactive composer before the complete server instruction could be verified. No message was sent.");
            composerReplacementRestarts += 1;
            insertedLength = 0;
            index = -1;
            continue;
          }
        }
        activeComposer.focus();
        range?.selectNodeContents(activeComposer);
        if (insertedLength > 0) range?.collapse?.(false);
        selection?.removeAllRanges();
        if (range) selection?.addRange(range);
        // ChatGPT's editor applies some rich-text conversions (for example,
        // Markdown links) in a later task. Observe the page-owned editor until
        // it has been quiet before inserting the next chunk, or the hidden tab
        // can replace its unsaved editor state with the previous value.
        const editorSettled = this.waitForComposerQuiet(activeComposer);
        const chunk = chunks[index];
        dispatchDomEvent(activeComposer, "beforeinput", { inputType: "insertText", data: chunk });
        let inserted = false;
        try { inserted = Boolean(document.execCommand?.("insertText", false, chunk)); } catch { /* use the guarded DOM fallback below */ }
        if (!inserted) {
          // Retain support for browsers whose editor does not implement the
          // native command. The following composer readback remains the
          // authority and fails closed before Send if its page state disagrees.
          activeComposer.textContent = text;
          dispatchDomEvent(activeComposer, "input", { inputType: "insertText", data: text });
          await editorSettled;
          insertedLength = text.length;
          break;
        }
        dispatchDomEvent(activeComposer, "input", { inputType: "insertText", data: chunk });
        await editorSettled;
        insertedLength += chunk.length;
        const settledComposer = typeof this.document.querySelectorAll === "function" ? this.findComposer() : null;
        if (settledComposer && settledComposer !== activeComposer) {
          activeComposer = settledComposer;
          if (!composerMatchesInsertedPrefix(activeComposer, text.slice(0, insertedLength))) {
            if (composerReplacementRestarts >= 1) return failure("composer_mismatch", "ChatGPT replaced the inactive composer before the complete server instruction could be verified. No message was sent.");
            composerReplacementRestarts += 1;
            insertedLength = 0;
            index = -1;
          }
        }
      }
      activeComposer = (typeof this.document.querySelectorAll === "function" ? this.findComposer() : null) || activeComposer;
      const actual = activeComposer.innerText || activeComposer.textContent || "";
      const contentText = activeComposer.textContent || "";
      if (normaliseComposerText(actual) !== normaliseComposerText(text)
        && normaliseComposerText(contentText) !== normaliseComposerText(text)
        && !composerMatchesMarkdownLinks(actual, text, activeComposer)
        && !composerMatchesRawUrlAnchors(actual, text, activeComposer)) {
        const editorSettled = this.waitForComposerQuiet(activeComposer);
        activeComposer.textContent = text;
        dispatchDomEvent(activeComposer, "input", { inputType: "insertText", data: text });
        await editorSettled;
      }
    }
    return null;
  }

  async setAndVerifyComposerText(composer: Composer, text: string, description = "server instruction") {
    let target = composer;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const set = await this.setComposerText(target, text);
      if (set) return set;
      await this.settleComposerInput();
      target = this.findComposer() || target;
      const verified = this.verifyComposerText(target, text, description);
      if (!verified) return null;
      if (attempt === 1) return verified;

      // A background ChatGPT tab can reconcile its page-owned editor state
      // after the first DOM readback. Re-select and reinsert once before
      // failing closed; the Send boundary is still untouched, so this is a
      // safe local composer recovery and can never duplicate a ChatGPT turn.
      await this.waitForComposerQuiet(target, 120, 800);
      target = this.findComposer() || target;
    }
    return this.verifyComposerText(target, text, description);
  }

  verifyComposerText(composer: Composer, expected: string, description = "server instruction") {
    const value = "value" in composer && typeof composer.value === "string" ? composer.value : null;
    const hasValue = value !== null;
    const actual = value ?? (composer.innerText || composer.textContent || "");
    const contentText = hasValue ? "" : composer.textContent || "";
    return normaliseComposerText(actual) === normaliseComposerText(expected)
      // For contenteditable composers, textContent is independent of CSS text
      // layout and preserves URL characters exactly. Accept this only when
      // the complete raw DOM text is an exact match; linkified rich text still
      // has to pass the destination-checked anchor paths below.
      || (!hasValue && normaliseComposerText(contentText) === normaliseComposerText(expected))
      || composerMatchesMarkdownLinks(actual, expected, composer)
      || composerMatchesRawUrlAnchors(actual, expected, composer)
      ? null
      : failure("composer_mismatch", `The exact ${description} was not verified in the ChatGPT composer. ${composerMismatchDiagnostics(actual, expected, composer)}`);
  }

  private async settleComposerInput() {
    // requestAnimationFrame is suspended in background tabs. Let the page's
    // input event handlers and their queued editor-state update flush without
    // relying on a page timer, then verify the actual editor and Send state.
    await Promise.resolve();
    await Promise.resolve();
  }

  private waitForComposerQuiet(composer: Composer, quietMs = 80, maxWaitMs = 1200) {
    if (composer.ownerDocument.visibilityState === "hidden") {
      // Chrome can throttle chained timers in a long-idle inactive tab to a
      // minute. Waiting for a visual quiet period there can outlive the
      // Bridge's two-minute delivery lease. Background insertion instead
      // yields to page-owned microtasks and relies on the exact readback (and
      // the independent pre-Send verification) before authorising Send.
      return this.settleComposerInput();
    }
    const Observer = (globalThis as typeof globalThis & { MutationObserver?: typeof MutationObserver }).MutationObserver;
    return new Promise<void>((resolve) => {
      let observer: MutationObserver | null = null;
      let settled = false;
      let quietTimer: number | null = null;
      let maxTimer: number | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (quietTimer !== null) window.clearTimeout(quietTimer);
        if (maxTimer !== null) window.clearTimeout(maxTimer);
        observer?.disconnect();
        resolve();
      };
      const resetQuietTimer = () => {
        if (quietTimer !== null) window.clearTimeout(quietTimer);
        quietTimer = window.setTimeout(finish, quietMs);
      };
      maxTimer = window.setTimeout(finish, maxWaitMs);
      if (Observer) {
        try {
          observer = new Observer(resetQuietTimer);
          observer.observe(composer, { childList: true, subtree: true, characterData: true, attributes: true });
        } catch {
          observer = null;
        }
      }
      resetQuietTimer();
    });
  }

  findSendControl(composer?: Composer) {
    const form = composer?.closest("form");
    const candidates = [...new Set([...this.document.querySelectorAll("button, [role=button], input[type=submit]")])]
      .filter(backgroundVisible).filter(enabled)
      .filter((element) => {
        const aria = element.getAttribute("aria-label") || "";
        const labelledBy = (element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
          .map((id) => this.document.getElementById?.(id)?.textContent || "")
          .join(" ");
        const title = element.getAttribute("title") || "";
        const text = element.textContent || "";
        const testId = element.getAttribute("data-testid") || "";
        const semanticSubmit = element.getAttribute("type")?.toLowerCase() === "submit" && form?.contains(element) === true;
        return SEND_LABEL_RE.test(aria.trim()) || SEND_LABEL_RE.test(labelledBy.trim().replace(/\s+/g, " ")) || SEND_LABEL_RE.test(title.trim()) || SEND_LABEL_RE.test(text.trim().replace(/\s+/g, " ")) || SEND_TEST_ID_RE.test(testId.trim()) || semanticSubmit;
      });
    const scoped = form ? candidates.filter((element) => form.contains(element)) : candidates;
    const usable = scoped.length > 0 ? scoped : candidates;
    return usable.length === 1 ? usable[0] as HTMLElement : null;
  }

  private sendControlDiagnostics(composer: Composer) {
    const form = composer.closest("form");
    const candidates = [...new Set([...this.document.querySelectorAll("button, [role=button], input[type=submit]")])]
      .filter((element) => {
        const aria = element.getAttribute("aria-label") || "";
        const labelledBy = (element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
          .map((id) => this.document.getElementById?.(id)?.textContent || "")
          .join(" ");
        const title = element.getAttribute("title") || "";
        const text = element.textContent || "";
        const testId = element.getAttribute("data-testid") || "";
        const semanticSubmit = element.getAttribute("type")?.toLowerCase() === "submit" && form?.contains(element) === true;
        return SEND_LABEL_RE.test(aria.trim()) || SEND_LABEL_RE.test(labelledBy.trim().replace(/\s+/g, " ")) || SEND_LABEL_RE.test(title.trim()) || SEND_LABEL_RE.test(text.trim().replace(/\s+/g, " ")) || SEND_TEST_ID_RE.test(testId.trim()) || semanticSubmit;
      });
    const scoped = form ? candidates.filter((element) => form.contains(element)) : candidates;
    const usable = scoped.length > 0 ? scoped : candidates;
    const details = usable.slice(0, 3).map((element) => {
      const name = (element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 48);
      const testId = (element.getAttribute("data-testid") || "").slice(0, 48);
      const state = enabled(element as HTMLElement) ? "enabled" : "disabled";
      return [name ? `label=${name}` : "unnamed", testId ? `testid=${testId}` : "", state].filter(Boolean).join(", ");
    });
    if (usable.length === 0) return "No matching Send control was found.";
    return `${usable.length} matching Send control${usable.length === 1 ? "" : "s"} found${details.length ? ` (${details.join("; ")})` : ""}.`;
  }

  async waitForSendControl(composer: Composer, timeoutMs = WEBSITE_DISPATCH_COMPOSER_WAIT_TIMEOUT_MS): Promise<HTMLElement | null> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const send = this.findSendControl(composer);
      if (send) return send;
      await this.waitForDomChange(Math.min(150, Math.max(1, timeoutMs - (Date.now() - started))));
    }
    return this.findSendControl(composer);
  }

  detectGenerationStarted() {
    // ChatGPT keeps a disabled "Stop answering" button mounted after a
    // response has finished. It is a renderer artifact, not an active
    // generation; treating it as live generation blocks the next dispatch and
    // makes response capture wait until its full timeout. Only an enabled,
    // visible stop control is evidence that generation is still running.
    return [...this.document.querySelectorAll("button[aria-label], [role=button][aria-label]")]
      .filter(visible)
      .filter(enabled)
      .some((element) => STOP_LABEL_RE.test(label(element)));
  }

  private assistantHasCompletionMarker(element: Element | null) {
    // ChatGPT can leave an enabled Stop answering control mounted for a short
    // period after the assistant text is already complete. The turn action
    // bar is owned by that exact assistant node and only becomes usable once
    // the renderer has finished the turn, so it is safe completion evidence
    // when the Stop control is stale. Keep the ancestor walk narrow to avoid
    // accepting a Copy response action from an older turn elsewhere in the
    // conversation.
    let current: Element | null = element;
    for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
      if (typeof current.querySelectorAll !== "function") continue;
      const controls = [...current.querySelectorAll("button, [role=button]")]
        .filter(backgroundVisible)
        .filter(enabled);
      if (controls.some((control) => control.getAttribute("data-testid") === "copy-turn-action-button" || COPY_RESPONSE_LABEL_RE.test(label(control)))) return true;
    }
    return false;
  }

  private messageElements() {
    const root = this.conversationRoot();
    const roleElements = [...new Set([...root.querySelectorAll('[data-message-author-role], [data-message-author]')])].filter(visible);
    const visibleRoleElements = new Set<Element>(roleElements);
    // ChatGPT's current renderer keeps the author on the conversation-turn
    // while the nested message role is mounting. Keep those turn markers even
    // when older precise role nodes already exist elsewhere in the thread: a
    // newly submitted user turn can briefly be represented only by its outer
    // marker, and dropping it here can turn a real send into a false timeout.
    const turnElements = [...new Set([...root.querySelectorAll('[data-turn="user"], [data-turn="assistant"]')])]
      .filter(visible)
      .filter((element) => {
        // Do not double-count a turn whose nested role node is already part of
        // the result. Test fixtures may not implement querySelector.
        if (typeof (element as Element).querySelector !== "function") return true;
        // During a ChatGPT SPA update the outer conversation-turn marker can
        // be painted before its nested role node has a layout box. The old
        // structural-only test discarded that outer marker even though it was
        // the only reliable proof that the outgoing user turn existed. Only
        // suppress the outer marker when a visible role node is actually part
        // of the rendered result; otherwise retain the fallback turn marker.
        const nested = [...(element as Element).querySelectorAll('[data-message-author-role], [data-message-author]')];
        return !nested.some((child) => visibleRoleElements.has(child) || visible(child));
      });
    // ChatGPT currently marks some rendered turns with fallback search-unit
    // keys instead of the older data-message-author-role/data-turn attributes.
    // Only accept the narrowly shaped renderer keys that explicitly identify
    // both the fallback turn and its speaker; never infer a speaker from text
    // or capture an unlabelled "latest assistant" node.
    const fallbackElements = [...new Set([...root.querySelectorAll('[data-content-search-unit-key], [data-chatgpt-search-unit-key]')])]
      .filter(visible)
      .filter((element) => Boolean(fallbackSearchUnit(element)))
      .filter((element) => this.messageText(element).length > 0)
      .filter((element) => !roleElements.some((roleElement) => {
        if (this.messageAuthor(roleElement) !== fallbackSearchUnit(element)?.author) return false;
        if (normaliseComposerText(this.messageText(roleElement)) !== normaliseComposerText(this.messageText(element))) return false;
        return roleElement === element
          || (typeof element.contains === "function" && element.contains(roleElement))
          || (typeof roleElement.contains === "function" && roleElement.contains(element));
      }));
    const uniqueFallbackElements = new Map<string, Element>();
    for (const element of fallbackElements) {
      const unit = fallbackSearchUnit(element);
      if (!unit) continue;
      const identity = `${unit.key}\u0000${normaliseComposerText(this.messageText(element))}`;
      const existing = uniqueFallbackElements.get(identity);
      // ChatGPT can expose the same fallback search unit on nested wrapper
      // nodes. Keep one copy for turn ordering, preferring the node that also
      // exposes a renderer-owned message id.
      if (!existing || (!this.messageId(existing) && this.messageId(element))) uniqueFallbackElements.set(identity, element);
    }

    // Recent ChatGPT Project builds temporarily render a turn with no role,
    // turn, or search-unit attributes. The user message still has the
    // renderer-owned `group/user-message` class, and the assistant turn is
    // its following sibling labelled “ChatGPT said:”. Keep this fallback
    // local to each explicit user marker instead of scanning the whole page
    // for assistant-looking text. This preserves exact turn order and avoids
    // mistaking an unlabelled/latest assistant node for the dispatched turn.
    const semanticElements: Element[] = [];
    const semanticUsers = [...new Set([...root.querySelectorAll('[class~="group/user-message"]')])]
      .filter(visible)
      .filter((element) => this.messageText(element).length > 0)
      .filter((element) => ![...element.querySelectorAll('[class~="group/user-message"]')].some((child) => this.messageText(child).length > 0));
    for (const userElement of semanticUsers) {
      semanticElements.push(userElement);

      let current: Element | null = userElement;
      let foundAssistant = false;
      let foundNextUser = false;
      for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
        let sibling = current.nextElementSibling;
        while (sibling) {
          const rawText = this.rawMessageText(sibling);
          if (/^chatgpt said\s*:/i.test(rawText) && this.messageText(sibling).length > 0) {
            semanticElements.push(sibling);
            foundAssistant = true;
            break;
          }
          // A following user marker starts another turn; do not skip over it
          // in search of a later assistant response.
          if (this.semanticMessageAuthor(sibling) === "user" || sibling.querySelector('[class~="group/user-message"]')) {
            foundNextUser = true;
            break;
          }
          sibling = sibling.nextElementSibling;
        }
        if (foundAssistant || foundNextUser) break;
      }
    }

    const existingElements = [...roleElements, ...turnElements, ...uniqueFallbackElements.values()];
    const uniqueSemanticElements = semanticElements.filter((element, index, all) => {
      const author = this.semanticMessageAuthor(element);
      if (!author) return false;
      const text = normaliseComposerText(this.messageText(element));
      // Nested wrappers can repeat the same accessible label and body. Keep
      // the deepest labelled node so assistant completion controls and
      // provenance remain attached to the actual rendered turn.
      if (all.some((other, otherIndex) => otherIndex !== index
        && this.semanticMessageAuthor(other) === author
        && normaliseComposerText(this.messageText(other)) === text
        && typeof element.contains === "function"
        && element.contains(other))) return false;
      // If this exact semantic node is already represented by an explicit
      // role/search-unit marker, do not count it as a second turn.
      if (existingElements.some((other) => this.messageAuthor(other) === author
        && normaliseComposerText(this.messageText(other)) === text
        && (other === element
          || (typeof element.contains === "function" && element.contains(other))
          || (typeof other.contains === "function" && other.contains(element))))) return false;
      return true;
    });

    const elements = [...new Set([...existingElements, ...uniqueSemanticElements])];
    // querySelectorAll preserves DOM order within each selector, but the two
    // selector results above are concatenated. Sort the merged set back into
    // rendered order so a response can be tied to the user turn immediately
    // before it. Fixtures without compareDocumentPosition retain insertion
    // order for backwards compatibility.
    return elements.sort((left, right) => {
      if (left === right) return 0;
      try {
        const position = left.compareDocumentPosition?.(right);
        if (typeof position === "number") {
          if (position & 4) return -1; // DOCUMENT_POSITION_FOLLOWING
          if (position & 2) return 1; // DOCUMENT_POSITION_PRECEDING
        }
      } catch {
        // A detached node or lightweight test fixture has no useful order.
      }
      return 0;
    });
  }

  private messageAuthor(element: Element) {
    const explicitAuthor = (element.getAttribute("data-message-author-role") || element.getAttribute("data-message-author") || element.getAttribute("data-turn") || "").trim().toLowerCase();
    return explicitAuthor || fallbackSearchUnit(element)?.author || this.semanticMessageAuthor(element) || "";
  }

  private semanticMessageAuthor(element: Element) {
    const classes = (element.getAttribute("class") || "").split(/\s+/);
    if (classes.includes("group/user-message")) return "user";
    return /^chatgpt said\s*:/i.test(this.rawMessageText(element)) ? "assistant" : "";
  }

  private rawMessageText(element: Element) {
    const visibleText = "innerText" in element && typeof (element as HTMLElement).innerText === "string"
      ? (element as HTMLElement).innerText
      : element.textContent || "";
    return visibleText.trim().replace(/\s+/g, " ").slice(0, 100000);
  }

  private assistantMessageElements() {
    return this.messageElements().filter((element) => this.messageAuthor(element) === "assistant");
  }

  private messageText(element: Element) {
    return this.rawMessageText(element)
      .replace(/^(?:you said|chatgpt said)\s*:\s*/i, "")
      // A collapsed long user turn renders its final source character(s) as
      // an ellipsis immediately before the UI-owned "Show more" label. The
      // ellipsis is not part of the dispatched prompt and must not change its
      // exact fingerprint after ChatGPT virtualises the surrounding history.
      .replace(/(?:\s*(?:…|\.{3}))?\s*(?:show more|show less)+$/i, "")
      .trim()
      .slice(0, 100000);
  }

  private assistantResponseText(element: Element) {
    // innerText includes CSS/layout line breaks inside linkified inline text
    // (for example, splitting an email address across a line). Those breaks
    // can corrupt otherwise-valid JSON. Capture the message's source text;
    // prefer the Markdown/body node when available so action-bar labels never
    // become part of a structured response.
    const content = typeof (element as HTMLElement).querySelector === "function"
      ? (element as HTMLElement).querySelector(".markdown, [data-message-content], .text-message")
      : null;
    const source = content?.textContent || element.textContent || this.rawMessageText(element);
    return source
      .replace(/^(?:you said|chatgpt said)\s*:\s*/i, "")
      .replace(/\s*(?:show more|show less)+\s*$/i, "")
      .trim()
      .slice(0, 100000);
  }

  private messageId(element: Element) {
    for (const attribute of ["data-message-id", "data-conversation-turn-id", "data-turn-id", "data-chatgpt-selection-message-id"]) {
      const value = element.getAttribute(attribute)?.trim();
      if (value) return value;
    }
    if (typeof element.querySelectorAll === "function") {
      const nestedIds = new Set([...element.querySelectorAll("[data-chatgpt-selection-message-id]")]
        .map((candidate) => candidate.getAttribute("data-chatgpt-selection-message-id")?.trim())
        .filter((value): value is string => Boolean(value)));
      if (nestedIds.size === 1) return [...nestedIds][0];
    }
    // Current ChatGPT builds sometimes omit renderer message IDs and expose
    // only the stable search-unit identity. Preserve it as the exact turn id
    // so response capture survives Markdown/link reformatting of long prompts.
    return fallbackSearchUnit(element)?.key || null;
  }

  private isPreSendAssistantElement(element: Element, anchor?: DispatchTurnAnchor | null) {
    if (!anchor) return false;
    const candidateId = this.messageId(element);
    if (anchor.lastAssistantMessageId && candidateId) {
      return candidateId === anchor.lastAssistantMessageId;
    }
    // Some conversation renderers omit durable IDs while recovering history.
    // In that case a matching pre-send fingerprint is a conservative fence;
    // when both distinct IDs exist, repeated answer text is still allowed.
    return Boolean(anchor.lastAssistantFingerprint
      && messageFingerprint(this.assistantResponseText(element)) === anchor.lastAssistantFingerprint);
  }

  private artifactKey(element: Element) {
    const metadata = interactiveMetadata(element);
    let parent = element.parentElement;
    const parentMetadata: string[] = [];
    for (let depth = 0; parent && depth < 5; depth += 1, parent = parent.parentElement) {
      const value = interactiveMetadata(parent);
      if (value) parentMetadata.push(value);
    }
    const href = element.getAttribute("href")
      || element.getAttribute("data-url")
      || element.getAttribute("data-file-url")
      || element.getAttribute("data-download-url")
      || "";
    const value = [metadata, ...parentMetadata, href]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    // Keep the identity bounded before it crosses the extension/server
    // boundary. Artifact cards can contain preview text or URLs supplied by
    // ChatGPT; those are untrusted and must never turn provenance into an
    // unbounded payload.
    return value ? `${messageFingerprint(value)}:${value.slice(0, 240)}` : null;
  }

  private artifactKeys(buttons: HTMLElement[]) {
    return [...new Set(buttons.map((button) => this.artifactKey(button)).filter((key): key is string => Boolean(key)))].slice(0, 100);
  }

  private responseProvenance(input: {
    userElement?: Element | null;
    userTurnFingerprint?: string | null;
    userTurnMessageId?: string | null;
    assistantElement?: Element | null;
    artifactKey?: string | null;
    source: DispatchResponseProvenance["source"];
  }): DispatchResponseProvenance | null {
    const userTurnFingerprint = input.userTurnFingerprint
      || (input.userElement ? messageFingerprint(this.messageText(input.userElement)) : null);
    if (!userTurnFingerprint) return null;
    return {
      conversationUrl: canonicalBridgeConversationUrl(this.location.href) || normalizeUrl(this.location.href),
      userTurnFingerprint,
      userTurnMessageId: input.userTurnMessageId || (input.userElement ? this.messageId(input.userElement) : null),
      assistantMessageId: input.assistantElement ? this.messageId(input.assistantElement) : null,
      assistantFingerprint: input.assistantElement ? messageFingerprint(this.assistantResponseText(input.assistantElement)) : null,
      artifactKey: input.artifactKey || null,
      source: input.source,
      generationFinished: true,
    };
  }

  private turnAnchorForMessages(messages = this.messageElements()): DispatchTurnAnchor {
    const users = messages.filter((element) => this.messageAuthor(element) === "user");
    const assistants = messages.filter((element) => this.messageAuthor(element) === "assistant");
    const lastUser = users[users.length - 1];
    const lastAssistant = assistants[assistants.length - 1];
    return {
      conversationUrl: canonicalBridgeConversationUrl(this.location.href) || normalizeUrl(this.location.href),
      turnCount: messages.length,
      lastUserFingerprint: lastUser ? messageFingerprint(this.messageText(lastUser)) : "",
      lastAssistantFingerprint: lastAssistant ? messageFingerprint(this.messageText(lastAssistant)) : "",
      lastUserMessageId: lastUser ? this.messageId(lastUser) : null,
      lastAssistantMessageId: lastAssistant ? this.messageId(lastAssistant) : null,
    };
  }

  private turnAnchorWithArtifactFence() {
    const anchor = this.turnAnchorForMessages();
    const artifactButtons = this.structuredProfileArtifactButtons(this.conversationRoot(), true);
    const artifactKeys = this.artifactKeys(artifactButtons);
    return {
      ...anchor,
      artifactCount: artifactButtons.length,
      ...(artifactKeys.length ? { artifactKeys } : {}),
    };
  }

  private preSendMessageBoundaryIndex(messages: Element[], anchor?: DispatchTurnAnchor | null) {
    if (!anchor) return -1;
    // ChatGPT can replace role-marked turns with search-unit turns while a
    // background Project conversation hydrates. The visible message count can
    // shrink or grow during that replacement, so the saved count is only a
    // fallback boundary. Prefer the durable last assistant identity, then the
    // last user identity; these remain meaningful when array indexes change.
    if (anchor.lastAssistantMessageId) {
      const assistantIndex = messages.findIndex((element) => this.messageAuthor(element) === "assistant"
        && this.messageId(element) === anchor.lastAssistantMessageId);
      if (assistantIndex >= 0) return assistantIndex;
    }
    if (anchor.lastUserMessageId) {
      const userIndex = messages.findIndex((element) => this.messageAuthor(element) === "user"
        && this.messageId(element) === anchor.lastUserMessageId);
      if (userIndex >= 0) return userIndex;
    }
    // Some Project renders preserve the pre-send turn fingerprints while
    // dropping renderer ids. Use them only when they identify one unique
    // prior turn; an ambiguous repeated answer is not a safe boundary.
    for (const [author, fingerprint] of [
      ["assistant", anchor.lastAssistantFingerprint],
      ["user", anchor.lastUserFingerprint],
    ] as const) {
      if (!fingerprint) continue;
      const matches = messages.map((element, index) => ({ element, index }))
        .filter(({ element }) => this.messageAuthor(element) === author
          && messageFingerprint(this.messageText(element)) === fingerprint);
      if (matches.length === 1) return matches[0].index;
    }
    return -1;
  }

  private userTurnIndicesAfterBoundary(messages: Element[], anchor: DispatchTurnAnchor) {
    const boundaryIndex = this.preSendMessageBoundaryIndex(messages, anchor);
    return messages.map((element, index) => ({ element, index }))
      .filter(({ element, index }) => this.messageAuthor(element) === "user"
        && (boundaryIndex >= 0 ? index > boundaryIndex : index >= anchor.turnCount));
  }

  private visiblePromptPrefixMatches(element: Element, expectedPrefix: string) {
    const visible = normaliseComposerText(this.messageText(element));
    // ChatGPT collapses long user turns behind a "Show more" control. The
    // full rendered text fingerprint then differs from the prompt we verified
    // in the composer, even though the leading portion still identifies the
    // new turn. A meaningful prefix is used only with a unique post-boundary
    // turn and the durable fingerprint of the exact prompt sent by the bridge.
    return expectedPrefix.length === 128 && visible.startsWith(expectedPrefix);
  }

  private matchingUserMessageIndex(instruction: string, messages = this.messageElements(), anchor?: DispatchTurnAnchor | null, userTurnFingerprint?: string | null, userTurnMessageId?: string | null) {
    const expected = normaliseComposerText(instruction);
    const preSendBoundaryIndex = this.preSendMessageBoundaryIndex(messages, anchor);
    let lastMatchingUser = -1;
    messages.forEach((element, index) => {
      if (this.messageAuthor(element) !== "user") return;
      const id = this.messageId(element);
      const expectedId = userTurnMessageId || null;
      // A renderer-owned message/search-unit id is stronger than visible text.
      // ChatGPT may flatten links, headings, or Markdown while rendering the
      // same long prompt, so recovery must not reject an otherwise exact turn.
      if (expectedId ? id !== expectedId : normaliseComposerText(this.messageText(element)) !== expected) return;
      if (anchor) {
        const afterPreSendBoundary = preSendBoundaryIndex >= 0
          ? index > preSendBoundaryIndex
          : index >= anchor.turnCount;
        // A post-send renderer id is independently exact. Without one, prefer
        // the saved previous turn identity over turnCount: current ChatGPT
        // Project builds can collapse legacy role nodes into fewer search-unit
        // nodes, placing the newly sent user turn at an index below the old
        // count. The fingerprint plus a surviving prior-turn identity keeps a
        // repeated prompt bound to the new message rather than its predecessor.
        if (!expectedId && userTurnFingerprint) {
          if (messageFingerprint(this.messageText(element)) !== userTurnFingerprint || !afterPreSendBoundary) return;
        } else if (!expectedId && !afterPreSendBoundary) {
          return;
        }
      }
      lastMatchingUser = index;
    });
    if (lastMatchingUser >= 0) return lastMatchingUser;

    // Some ChatGPT renderers collapse long prompts and omit a message id from
    // the new user turn. Once the send fence has recorded the exact prompt
    // fingerprint, a unique new turn after the saved boundary is still safe to
    // inspect when its visible prefix agrees. Never guess when there are zero
    // or multiple candidate turns.
    if (!anchor || userTurnFingerprint !== messageFingerprint(instruction)) return -1;
    const candidates = this.userTurnIndicesAfterBoundary(messages, anchor);
    const expectedPrefix = normaliseComposerText(instruction).slice(0, 128);
    if (candidates.length !== 1 || !this.visiblePromptPrefixMatches(candidates[0].element, expectedPrefix)) return -1;
    return candidates[0].index;
  }

  private userTurnAfterBoundary(expected: string, anchor: DispatchTurnAnchor) {
    const messages = this.messageElements();
    const preSendBoundaryIndex = this.preSendMessageBoundaryIndex(messages, anchor);
    const candidates = messages.map((element, index) => ({ element, index }))
      .filter(({ element, index }) => this.messageAuthor(element) === "user"
        && (preSendBoundaryIndex >= 0 ? index > preSendBoundaryIndex : index >= anchor.turnCount));
    const exact = candidates.filter(({ element }) => normaliseComposerText(this.messageText(element)) === normaliseComposerText(expected));
    if (exact.length === 1) return exact[0].element;
    if (exact.length > 1) return null;
    // A new user message after the saved pre-send boundary is unambiguous in
    // this single-flight composer. The fallback key is generated per turn and
    // remains stable even if the renderer changes the visible prompt text.
    const identified = candidates.filter(({ element }) => Boolean(fallbackSearchUnit(element)));
    return identified.length === 1 ? identified[0].element : null;
  }

  private async waitForUserTurnAfterBoundary(expected: string, anchor: DispatchTurnAnchor, timeoutMs = 3000) {
    const started = Date.now();
    while (true) {
      const userTurn = this.userTurnAfterBoundary(expected, anchor);
      if (userTurn) return userTurn;
      const candidates = this.userTurnIndicesAfterBoundary(this.messageElements(), anchor);
      const expectedPrefix = normaliseComposerText(expected).slice(0, 128);
      if (candidates.length === 1 && this.visiblePromptPrefixMatches(candidates[0].element, expectedPrefix)) return candidates[0].element;
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) return null;
      await this.waitForDomChange(Math.min(100, remaining));
    }
  }

  private assistantAfterUserIndex(messages: Element[], userIndex: number) {
    for (let index = userIndex + 1; index < messages.length; index += 1) {
      if (this.messageAuthor(messages[index]) === "assistant") return index;
    }
    return -1;
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

  /**
   * ChatGPT's current renderer puts the precise data-message-author-role node
   * inside a larger conversation-turn section. Generated files are rendered
   * beside that node, inside the section, rather than inside the role node
   * itself. Resolve that outer assistant boundary before looking for an
   * artifact so a late-mounted file from an older turn cannot satisfy the
   * current request.
   */
  private assistantTurnBoundary(element: Element | null) {
    const fallbackTurnKey = element ? fallbackSearchUnit(element)?.turnKey : null;
    let current: Element | null = element;
    for (let depth = 0; current && depth < 12; depth += 1, current = current.parentElement) {
      if (current.getAttribute("data-turn")?.trim().toLowerCase() === "assistant") return current;
      if (fallbackTurnKey && ["data-content-search-turn-key", "data-chatgpt-search-turn-key"]
        .some((attribute) => current?.getAttribute(attribute)?.trim() === fallbackTurnKey)) return current;
    }
    return null;
  }

  private structuredProfileArtifactButtonsForAssistant(element: Element, allowAnyJson = false) {
    const boundary = this.assistantTurnBoundary(element);
    return this.structuredProfileArtifactButtons(boundary || element, allowAnyJson);
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

  private async openStructuredProfileArtifact(buttons: HTMLElement[], timeoutMs = 8000): Promise<StructuredProfileCapture | null> {
    if (!buttons.length) return null;
    const orderedButtons = buttons
      .map((button, index) => ({ button, index, preferred: ARTIFACT_OPEN_ACTION_RE.test(`${String(button.className || "")} ${interactiveMetadata(button)}`) ? 2 : ARTIFACT_DOWNLOAD_ACTION_RE.test(interactiveMetadata(button)) ? 0 : 1 }))
      .sort((left, right) => right.preferred - left.preferred || right.index - left.index)
      .map(({ button }) => button);
    for (const button of orderedButtons) {
      const artifactKey = this.artifactKey(button);
      const linkedJson = await this.structuredProfileJsonFromArtifactLink(button);
      if (linkedJson) return { json: linkedJson, source: "assistant_artifact", artifactKey };
      try {
        button.click();
      } catch {
        continue;
      }
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const json = this.structuredProfileViewerJson();
        if (json) return { json, source: "assistant_artifact", artifactKey };
        await this.waitForDomChange(Math.min(150, Math.max(1, timeoutMs - (Date.now() - started))));
      }
    }
    return null;
  }

  private async structuredProfileFromAssistantElement(element: Element, artifactButtons: HTMLElement[] = [], allowAnyJson = false): Promise<StructuredProfileCapture | null> {
    const direct = this.structuredProfileJsonFromAssistantElement(element);
    if (direct) return { json: direct, source: "assistant_turn", artifactKey: null };
    return this.openStructuredProfileArtifact(artifactButtons.length ? artifactButtons : this.structuredProfileArtifactButtonsForAssistant(element, allowAnyJson));
  }

  private matchingProfessionalBackgroundUserIndex(instruction: string, messages = this.messageElements(), anchor?: DispatchTurnAnchor | null, userTurnFingerprint?: string | null, userTurnMessageId?: string | null) {
    return this.matchingUserMessageIndex(instruction, messages, anchor, userTurnFingerprint, userTurnMessageId);
  }

  private async existingProfessionalBackgroundResult(instruction: string, allowGlobalArtifact = true, anchor?: DispatchTurnAnchor | null, userTurnFingerprint?: string | null, userTurnMessageId?: string | null) {
    const requireStructuredProfile = this.expectsStructuredProfileResponse(instruction);
    const messages = this.messageElements();
    const lastMatchingUser = this.matchingProfessionalBackgroundUserIndex(instruction, messages, anchor, userTurnFingerprint, userTurnMessageId);
    if (lastMatchingUser < 0) return null;
    const userElement = messages[lastMatchingUser] || null;
    const afterUser = messages.slice(lastMatchingUser + 1);
    const nextUser = afterUser.findIndex((element) => this.messageAuthor(element) === "user");
    const responses = (nextUser >= 0 ? afterUser.slice(0, nextUser) : afterUser)
      .filter((element) => this.messageAuthor(element) === "assistant"
        && !this.isPreSendAssistantElement(element, anchor))
      .reverse();
    // A user turn can contain intermediate assistant messages (for example,
    // tool progress followed by a final answer). Only its latest assistant
    // turn can complete this dispatch; falling back to an older non-empty
    // message while the final turn is still generating would capture partial
    // or unrelated content as a finished response.
    const element = responses[0];
    if (!element) return null;
    const text = this.assistantResponseText(element);
    if (!text || this.isTransientAssistantText(text)) return null;
    // Match the normal capture fence: a visible enabled Stop control means
    // the assistant is still writing unless this exact assistant turn has an
    // enabled completion action. Provenance must never claim completion just
    // because some text is currently rendered.
    if (this.detectGenerationStarted() && !this.assistantHasCompletionMarker(element)) return null;
    // The profile workflow can be issued with a short legacy instruction as
    // well as the current structured-profile wording. Parse a complete JSON
    // response whenever one is visible so an upgrade never sends the same
    // already-completed prompt a second time.
    const capture = await this.structuredProfileFromAssistantElement(element, [], requireStructuredProfile);
    if (capture) return {
      responseText: capture.json,
      artifactJson: capture.json,
      responseProvenance: this.responseProvenance({
        userElement,
        userTurnFingerprint,
        userTurnMessageId,
        assistantElement: element,
        artifactKey: capture.artifactKey,
        source: capture.source,
      }) || undefined,
    };
    if (!requireStructuredProfile) return {
      responseText: text,
      artifactJson: null,
      responseProvenance: this.responseProvenance({ userElement, userTurnFingerprint, userTurnMessageId, assistantElement: element, source: "assistant_turn" }) || undefined,
    };
    // If the matching assistant response has a renderer-owned turn boundary,
    // its file card is expected to be inside that boundary. Do not fall back
    // to a global artifact card in this case: a late-hydrated file from an
    // older assistant turn is otherwise indistinguishable by filename alone.
    if (responses.some((element) => Boolean(this.assistantTurnBoundary(element)))) return null;
    if (requireStructuredProfile && allowGlobalArtifact && !this.detectGenerationStarted()) {
      const artifactButtons = this.structuredProfileArtifactButtons(this.conversationRoot(), requireStructuredProfile);
      const baselineArtifactKeys = anchor?.artifactKeys || [];
      const newArtifactButtons = baselineArtifactKeys.length > 0
        ? artifactButtons.filter((button) => {
          const key = this.artifactKey(button);
          return Boolean(key && !baselineArtifactKeys.includes(key));
        })
        : typeof anchor?.artifactCount === "number"
          ? artifactButtons.slice(Math.max(0, anchor.artifactCount))
          : artifactButtons;
      const capture = await this.openStructuredProfileArtifact(newArtifactButtons);
      if (capture) return {
        responseText: capture.json,
        artifactJson: capture.json,
        responseProvenance: this.responseProvenance({
          userElement,
          userTurnFingerprint,
          userTurnMessageId,
          artifactKey: capture.artifactKey,
          source: capture.source,
        }) || undefined,
      };
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

  async checkExistingProfessionalBackgroundResponse(instruction: string, timeoutMs = 30000, boundConversationUrl?: string, boundProjectName?: string, boundProjectUrl?: string, anchor?: DispatchTurnAnchor | null, userTurnFingerprint?: string | null, userTurnMessageId?: string | null): Promise<AdapterSuccess | AdapterFailure> {
    if (boundConversationUrl && boundProjectName) {
      const target = this.verifyBoundConversation(boundConversationUrl, boundProjectName, boundProjectUrl);
      if (target) return target;
    }
    const safeTimeout = Math.max(1000, Math.min(timeoutMs, 120000));
    const started = Date.now();
    // When a durable turn identity is available, an artifact outside the
    // matching assistant turn could belong to an older profile request. Keep
    // the read scoped to the anchored turn; the normal in-process response
    // waiter already tracks the artifact baseline separately.
    const allowGlobalArtifact = !anchor || typeof anchor.artifactCount === "number";
    while (Date.now() - started < safeTimeout) {
      const existing = await this.existingProfessionalBackgroundResult(instruction, allowGlobalArtifact, anchor, userTurnFingerprint, userTurnMessageId);
      if (existing?.artifactJson) {
        return {
          ok: true as const,
          sent: true as const,
          delivery: "reused" as const,
          existingResponseText: existing.responseText || undefined,
          artifactJson: existing.artifactJson,
          responseProvenance: existing.responseProvenance,
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
  async checkExistingDispatchResponse(instruction: string, timeoutMs = 30000, boundConversationUrl?: string, boundProjectName?: string, boundProjectUrl?: string, anchor?: DispatchTurnAnchor | null, userTurnFingerprint?: string | null, userTurnMessageId?: string | null): Promise<AdapterSuccess | AdapterFailure> {
    if (boundConversationUrl && boundProjectName) {
      const target = this.verifyBoundConversation(boundConversationUrl, boundProjectName, boundProjectUrl);
      if (target) return target;
    }
    const safeTimeout = Math.max(1000, Math.min(timeoutMs, 120000));
    const started = Date.now();
    const requireStructuredProfile = this.expectsStructuredProfileResponse(instruction);
    while (Date.now() - started < safeTimeout) {
      const existing = await this.existingProfessionalBackgroundResult(instruction, false, anchor, userTurnFingerprint, userTurnMessageId);
      if (existing && (!requireStructuredProfile || existing.artifactJson)) {
        return {
          ok: true as const,
          sent: true as const,
          delivery: "reused" as const,
          existingResponseText: existing.responseText || undefined,
          artifactJson: existing.artifactJson || undefined,
          responseProvenance: existing.responseProvenance,
        };
      }
      await this.waitForDomChange(Math.min(250, Math.max(1, safeTimeout - (Date.now() - started))));
    }
    const messages = this.messageElements();
    const matchingUserIndex = this.matchingProfessionalBackgroundUserIndex(instruction, messages, anchor, userTurnFingerprint, userTurnMessageId);
    const hasOutgoingMessage = matchingUserIndex >= 0;
    let notReadyDetail = "";
    if (hasOutgoingMessage) {
      const afterUser = messages.slice(matchingUserIndex + 1);
      const nextUser = afterUser.findIndex((element) => this.messageAuthor(element) === "user");
      const assistantNodes = (nextUser >= 0 ? afterUser.slice(0, nextUser) : afterUser)
        .filter((element) => this.messageAuthor(element) === "assistant");
      const newAssistantNodes = assistantNodes.filter((element) => !this.isPreSendAssistantElement(element, anchor));
      const latest = newAssistantNodes[newAssistantNodes.length - 1] || null;
      const latestText = latest ? this.assistantResponseText(latest) : "";
      const activeGeneration = this.detectGenerationStarted();
      notReadyDetail = !newAssistantNodes.length
        ? `No new assistant turn is rendered after the saved user turn (assistant turns in that range: ${assistantNodes.length}; pre-send turns excluded: ${assistantNodes.length - newAssistantNodes.length}).`
        : !latestText
          ? "The latest assistant turn is present but has no readable response text yet."
          : this.isTransientAssistantText(latestText)
            ? "The latest assistant turn is still showing a transient status rather than its final response."
            : activeGeneration && !this.assistantHasCompletionMarker(latest)
              ? "The latest assistant turn still appears to be generating; no partial text was captured."
              : "The latest assistant turn did not meet the saved response's completion requirements.";
    }
    return failure(
      hasOutgoingMessage ? "response_not_ready" : "dispatch_message_not_found",
      hasOutgoingMessage
        ? `The exact dispatch message is visible, but its completed assistant response is not available yet. ${notReadyDetail}`
        : "The previously sent dispatch message was not found in the bound ChatGPT conversation. No message was sent during recovery.",
    );
  }

  /**
   * Read-only delivery confirmation. This is used when the asynchronous
   * adapter operation or its runtime channel was interrupted after ChatGPT
   * accepted the message. An exact visible user message is sufficient proof
   * that the one-time send happened; no composer changes or clicks occur.
   */
  verifyExistingDispatchMessage(instruction: string, boundConversationUrl?: string, boundProjectName?: string, boundProjectUrl?: string, anchor?: DispatchTurnAnchor | null, userTurnFingerprint?: string | null, userTurnMessageId?: string | null): AdapterSuccess | AdapterFailure {
    if (boundConversationUrl && boundProjectName) {
      const target = this.verifyBoundConversation(boundConversationUrl, boundProjectName, boundProjectUrl);
      if (target) return target;
    }
    const messages = this.messageElements();
    const matchingIndex = this.matchingProfessionalBackgroundUserIndex(instruction, messages, anchor, userTurnFingerprint, userTurnMessageId);
    if (matchingIndex < 0) return failure("dispatch_message_not_found", "The exact dispatch message is not visible in the bound ChatGPT conversation. The bridge will keep checking without sending another message.");
    const matchingElement = messages[matchingIndex];
    return {
      ok: true as const,
      sent: true as const,
      delivery: "verified" as const,
      assistantBaseline: this.assistantResponseSnapshot(),
      turnAnchor: anchor || this.turnAnchorForMessages(),
      userTurnFingerprint: messageFingerprint(instruction),
      userTurnMessageId: matchingElement ? this.messageId(matchingElement) : null,
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
      const text = this.assistantResponseText(element);
      return text.length > 0 && !this.isTransientAssistantText(text)
        && (this.isCompleteStructuredProfile(text) || this.structuredProfileArtifactButtons(element).length > 0);
    });
  }

  assistantResponseSnapshot(includeArtifacts = true, includeTurnAnchor = false): AssistantResponseBaseline {
    const messages = this.assistantMessageElements();
    const artifactButtons = includeArtifacts ? this.structuredProfileArtifactButtons(this.conversationRoot(), true) : [];
    const artifactKeys = this.artifactKeys(artifactButtons);
    return {
      count: messages.length,
      lastText: messages.length ? this.messageText(messages[messages.length - 1]) : "",
      ...(includeTurnAnchor ? { turnAnchor: this.turnAnchorForMessages() } : {}),
      // Count every visible JSON artifact at the baseline. The profile
      // response may use a slightly different filename on another ChatGPT
      // locale, and an older JSON file must never be mistaken for the new
      // response just because the structured wait accepts generic .json
      // filenames.
      ...(includeArtifacts ? { artifactCount: artifactButtons.length, ...(artifactKeys.length ? { artifactKeys } : {}) } : {}),
    };
  }

  /**
   * Wait until the bound conversation has exposed a settled rendered history
   * before taking the response baseline. A zero-turn baseline is unsafe for a
   * persistent Project chat: history hydration can expose an older JSON file
   * after the send has already begun and make it look like the new response.
   */
  private async waitForConversationBaseline(timeoutMs = RESPONSE_BASELINE_TIMEOUT_MS) {
    const started = Date.now();
    let previousSignature = "";
    let stableSince = 0;
    while (Date.now() - started < timeoutMs) {
      const messages = this.messageElements();
      const artifactKeys = this.artifactKeys(this.structuredProfileArtifactButtons(this.conversationRoot(), true));
      const signature = JSON.stringify(messages.map((element) => ({
        author: this.messageAuthor(element),
        id: this.messageId(element),
        fingerprint: messageFingerprint(this.messageText(element)),
      })).concat(artifactKeys.map((key) => ({ author: "artifact", id: key, fingerprint: key }))));
      if (signature !== previousSignature) {
        previousSignature = signature;
        stableSince = Date.now();
      }
      const hasRenderedSurface = messages.length > 0 || artifactKeys.length > 0;
      if (hasRenderedSurface && stableSince > 0 && Date.now() - stableSince >= RESPONSE_BASELINE_SETTLE_MS) return null;
      await this.waitForDomChange(Math.min(250, Math.max(1, timeoutMs - (Date.now() - started))));
    }
    return failure("conversation_history_not_ready", "ChatGPT did not expose a settled conversation history before the profile request could be sent. Nothing was sent; reload the bound conversation and retry.");
  }

  async waitForAssistantResponse(baseline: AssistantResponseBaseline, timeoutMs = 180000, workflowKey?: ConversationSlotKey, expectStructuredProfile = false) {
    const safeTimeout = Math.max(1000, Math.min(timeoutMs, CHATGPT_RESPONSE_CAPTURE_TIMEOUT_MS));
    const started = Date.now();
    let stableText = "";
    let stableSince = 0;
    let capturedArtifactJson: string | null = null;
    let capturedArtifactSource: DispatchResponseProvenance["source"] | null = null;
    let capturedArtifactKey: string | null = null;
    let artifactCaptureAttempts = 0;
    let lastArtifactCaptureAttemptAt = 0;
    // An artifact can mount late while ChatGPT hydrates the existing Project
    // history. Before the exact current assistant turn is rendered, every
    // visible artifact is known to predate (or be unrelated to) this response
    // and is fenced out, even if it was absent from the initial baseline.
    const artifactsObservedBeforeCurrentAssistant = new Set<string>();
    let currentAssistantAnchorObserved = false;
    while (Date.now() - started < safeTimeout) {
      // A rate-limit surface can appear after the user turn is visible. Treat
      // it as an actionable post-send outcome so the coordinator can stop the
      // request without ever attempting a duplicate Send.
      const rateLimit = this.detectRateLimit();
      if (rateLimit) return rateLimit;
      const renderedMessages = this.messageElements();
      const messages = renderedMessages.filter((element) => this.messageAuthor(element) === "assistant");
      const hasDurableUserAnchor = Boolean(baseline.userTurnMessageId || baseline.userTurnFingerprint);
      // A structured v2 capture always carries the pre-send turn anchor. If
      // the post-send user identity was lost, fail closed rather than falling
      // back to the last visible assistant message.
      const requiresExactAnchor = hasDurableUserAnchor || (expectStructuredProfile && Boolean(baseline.turnAnchor));
      // `matchingUserMessageIndex` needs the prompt text for exact matching;
      // recovery records carry the fingerprint/id but not a second copy of the
      // prompt in the baseline. Locate the user turn directly by its durable
      // identity when available, then keep the legacy latest-assistant path for
      // older callers that have no turn metadata.
      const preSendBoundaryIndex = this.preSendMessageBoundaryIndex(renderedMessages, baseline.turnAnchor);
      const anchoredUserIndex = baseline.userTurnMessageId
        ? renderedMessages.findIndex((element) => this.messageAuthor(element) === "user"
          && this.messageId(element) === baseline.userTurnMessageId)
        : baseline.userTurnFingerprint
          ? renderedMessages.map((element, index) => ({ element, index })).filter(({ element, index }) => this.messageAuthor(element) === "user"
            && messageFingerprint(this.messageText(element)) === baseline.userTurnFingerprint
            && (preSendBoundaryIndex >= 0 ? index > preSendBoundaryIndex : index >= (baseline.turnAnchor?.turnCount || 0))).map(({ index }) => index).pop() ?? -1
          : -1;
      const collapsedUserTurn = anchoredUserIndex < 0
        && !baseline.userTurnMessageId
        && baseline.userTurnFingerprint
        && baseline.userTurnPrefix
        && baseline.turnAnchor
        && this.userTurnIndicesAfterBoundary(renderedMessages, baseline.turnAnchor).length === 1
        && this.userTurnIndicesAfterBoundary(renderedMessages, baseline.turnAnchor).some(({ element }) =>
          this.visiblePromptPrefixMatches(element, baseline.userTurnPrefix || ""),
        )
        ? this.userTurnIndicesAfterBoundary(renderedMessages, baseline.turnAnchor)
        : [];
      const resolvedUserTurnIndex = anchoredUserIndex >= 0
        ? anchoredUserIndex
        : collapsedUserTurn.length === 1 && baseline.userTurnFingerprint
          ? collapsedUserTurn[0].index
          : -1;
      const candidateElement = resolvedUserTurnIndex >= 0
        ? (() => {
            const afterUser = renderedMessages.slice(resolvedUserTurnIndex + 1);
            const nextUser = afterUser.findIndex((element) => this.messageAuthor(element) === "user");
            return (nextUser >= 0 ? afterUser.slice(0, nextUser) : afterUser).filter((element) => this.messageAuthor(element) === "assistant").pop() || null;
          })()
        : requiresExactAnchor ? null : messages[messages.length - 1] || null;
      const candidate = candidateElement ? this.assistantResponseText(candidateElement) : "";
      const candidateMessageId = candidateElement ? this.messageId(candidateElement) : null;
      const candidateTurnBoundary = candidateElement ? this.assistantTurnBoundary(candidateElement) : null;
      const baselineAssistantMessageId = baseline.turnAnchor?.lastAssistantMessageId || null;
      // A persistent Project renderer can place a hydrated pre-send answer
      // after the newly submitted user node while it rebuilds its search-unit
      // history. Position, text changes, and a larger visible message count
      // must never turn that same durable assistant message into a new reply.
      // Fail closed even when the renderer changed the content in place; a
      // genuine answer must have a distinct assistant-turn identity.
      const candidateReusesPreSendAssistant = Boolean(candidateElement
        && this.isPreSendAssistantElement(candidateElement, baseline.turnAnchor));
      const artifactButtons = expectStructuredProfile ? this.structuredProfileArtifactButtons(this.conversationRoot(), true) : [];
      const visibleArtifactKeys = this.artifactKeys(artifactButtons);
      if (requiresExactAnchor && !currentAssistantAnchorObserved && !candidateElement) {
        visibleArtifactKeys.forEach((key) => artifactsObservedBeforeCurrentAssistant.add(key));
      }
      if (requiresExactAnchor && candidateElement) currentAssistantAnchorObserved = true;
      const baselineArtifactKeys = baseline.artifactKeys || [];
      const canUseLegacyArtifactFallback = !requiresExactAnchor && !baseline.turnAnchor;
      // Once the current assistant turn has a renderer-owned boundary, only
      // artifacts inside that boundary belong to it. Keep the global fallback
      // for older renderers/tests whose artifact card is genuinely outside a
      // turn container.
      const globalArtifactFallbackAllowed = !candidateTurnBoundary;
      const newArtifactButtons = globalArtifactFallbackAllowed && (resolvedUserTurnIndex >= 0 || canUseLegacyArtifactFallback)
        ? baselineArtifactKeys.length > 0
          ? artifactButtons.filter((button) => {
            const key = this.artifactKey(button);
            return Boolean(key && !baselineArtifactKeys.includes(key) && !artifactsObservedBeforeCurrentAssistant.has(key));
          })
          : artifactButtons.length > (baseline.artifactCount || 0)
            ? artifactButtons.filter((button) => {
              const key = this.artifactKey(button);
              return Boolean(key && !artifactsObservedBeforeCurrentAssistant.has(key));
            })
            : []
        : [];
      const candidateChanged = requiresExactAnchor
        ? false
        : messages.length > baseline.count || (Boolean(candidate) && candidate !== baseline.lastText);
      // ChatGPT virtualises long conversations: when the newest turn mounts it
      // can evict an older assistant node, keeping the visible assistant count
      // unchanged. Repeated replies (for example several "OK" diagnostics)
      // also keep `lastText` unchanged. Once the exact rendered user turn is
      // anchored, a following assistant node is the response for this send;
      // prefer its durable message id when available and fall back to the
      // anchored turn itself when the renderer exposes no ids.
      const anchoredCandidateChanged = Boolean(candidateElement) && (
        !candidateReusesPreSendAssistant
        && (messages.length > baseline.count
          || candidate !== baseline.lastText
          || (candidateMessageId && baselineAssistantMessageId ? candidateMessageId !== baselineAssistantMessageId : !baselineAssistantMessageId))
      );
      const isNew = !candidateReusesPreSendAssistant && (newArtifactButtons.length > 0
        || (resolvedUserTurnIndex >= 0 && Boolean(candidateElement) ? anchoredCandidateChanged : candidateChanged));
      let artifactJson: string | null = null;
      if (expectStructuredProfile) {
        artifactJson = capturedArtifactJson || extractStructuredProfileJson(candidate);
      }
      if (expectStructuredProfile && !artifactJson && isNew && Date.now() - lastArtifactCaptureAttemptAt >= 1000 && artifactCaptureAttempts < 8) {
        const candidateArtifactButtons = candidateElement ? this.structuredProfileArtifactButtonsForAssistant(candidateElement, true) : [];
        const captureButtons = candidateArtifactButtons.length ? candidateArtifactButtons : newArtifactButtons;
        if (captureButtons.length > 0) {
          artifactCaptureAttempts += 1;
          lastArtifactCaptureAttemptAt = Date.now();
          const capture = candidateElement
            ? await this.structuredProfileFromAssistantElement(candidateElement, captureButtons)
            : await this.openStructuredProfileArtifact(captureButtons);
          if (capture) {
            artifactJson = capture.json;
            capturedArtifactJson = capture.json;
            capturedArtifactSource = capture.source;
            capturedArtifactKey = capture.artifactKey;
          }
        }
      }
      const responseText = artifactJson || candidate;
      const isTransient = !artifactJson && this.isTransientAssistantText(candidate);
      const isReadyForWorkflow = !expectStructuredProfile || Boolean(artifactJson);
      // A global artifact card is only accepted once the assistant turn after
      // the exact user message is rendered. Without this, a delayed old file
      // card could be mistaken for the new response during history hydration.
      const artifactHasCurrentAssistant = !artifactJson || Boolean(candidateElement);
      // A complete JSON object is not enough on its own. ChatGPT can expose an
      // older artifact while the current answer is still streaming; normally
      // the disappearance of the enabled Stop control closes the generation
      // fence. Some ChatGPT renderer versions leave that control enabled for
      // a short time after the current turn's action bar already exposes an
      // enabled Copy response button, which is stronger turn-local completion
      // evidence and avoids waiting for the full response timeout.
      const generationActive = this.detectGenerationStarted();
      const generationFinished = !generationActive || this.assistantHasCompletionMarker(candidateElement);
      if (isNew && Boolean(responseText) && !isTransient && isReadyForWorkflow && generationFinished && artifactHasCurrentAssistant) {
        if (responseText !== stableText) {
          stableText = responseText;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 700) {
          const userElement = anchoredUserIndex >= 0 ? renderedMessages[anchoredUserIndex] : null;
          return {
            ok: true as const,
            responseText,
            artifactJson: artifactJson || undefined,
            responseProvenance: this.responseProvenance({
              userElement,
              userTurnFingerprint: baseline.userTurnFingerprint,
              userTurnMessageId: baseline.userTurnMessageId,
              assistantElement: candidateElement,
              artifactKey: artifactJson && capturedArtifactJson ? capturedArtifactKey : null,
              source: artifactJson && capturedArtifactJson ? (capturedArtifactSource || "assistant_artifact") : "assistant_turn",
            }) || undefined,
          };
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

  async sendMessage(expected: string, composer: Composer, beforeSend?: (turnAnchor?: DispatchTurnAnchor) => Promise<void> | void, captureArtifactFence = false) {
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
    if (!send) return failure("send_not_verified", `The enabled ChatGPT Send control could not be identified safely for this account or locale. ${this.sendControlDiagnostics(settledComposer)} No message was sent.`);
    const composerBeforeSend = "value" in settledComposer && typeof settledComposer.value === "string" ? settledComposer.value : settledComposer.innerText || settledComposer.textContent || "";
    let sendBoundary: DispatchTurnAnchor | null = null;
    // Persist the at-most-once boundary immediately before the click. If the
    // content operation is lost after this point, the background worker must
    // only perform read-only confirmation and must never type the prompt a
    // second time. A failed marker is fail-closed: do not click Send.
    if (beforeSend) {
      try {
        sendBoundary = captureArtifactFence ? this.turnAnchorWithArtifactFence() : this.turnAnchorForMessages();
        await beforeSend(sendBoundary);
      } catch (error) {
        return failure("send_state_unrecorded", safeReason(error instanceof Error ? error.message : error, "The one-time ChatGPT send attempt could not be recorded safely. Nothing was sent."));
      }
    }
    const postClickStartedAt = Date.now();
    send.click();
    const verified = await this.verifyMessageSent(expected, settledComposer, SENT_VERIFICATION_TIMEOUT_MS, composerBeforeSend);
    const postClickVerificationMs = Date.now() - postClickStartedAt;
    const sentUserTurn = sendBoundary ? await this.waitForUserTurnAfterBoundary(expected, sendBoundary) : null;
    return verified || ({
      ok: true,
      sent: true,
      delivery: "verified",
      // Keep the pre-click boundary as the durable recovery anchor. A
      // post-click turn count includes the new user message and would make a
      // no-message-id DOM reject that exact message as being before its own
      // boundary. The rendered user identity is persisted separately below.
      turnAnchor: sendBoundary || this.turnAnchorForMessages(),
      userTurnFingerprint: messageFingerprint(expected),
      userTurnMessageId: sentUserTurn ? this.messageId(sentUserTurn) : null,
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
    const verified = await this.setAndVerifyComposerText(composer, marker, "workflow setup message");
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

  async executeDispatch(input: { requestId: string; workflowKey: ConversationSlotKey; instruction: string; boundConversationUrl: string; boundProjectName: string; boundProjectUrl?: string; protocol?: "v1" | "v2"; beforeComposerMutation?: () => Promise<void> | void; beforeSend?: (turnAnchor?: DispatchTurnAnchor) => Promise<void> | void }): Promise<AdapterSuccess | AdapterFailure> {
    const rateLimit = this.detectRateLimit();
    if (rateLimit) return rateLimit;
    // A newly opened bound conversation can expose the content script before
    // ChatGPT has mounted its composer. Checking authentication immediately
    // at that point misclassifies a signed-in loading page as signed out.
    // Wait for the visible composer first, then perform the authenticated
    // delivery checks against the settled page.
    const composerWaitStartedAt = Date.now();
    const composer = await this.waitForComposer(WEBSITE_DISPATCH_COMPOSER_WAIT_TIMEOUT_MS);
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
    if (input.workflowKey === "profile.background" && input.protocol !== "v2") {
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
    // Recheck immediately before mutating the composer. A rate-limit banner
    // may have appeared while the conversation was settling, and detecting it
    // here keeps the Send authorization fence unused so the request can be
    // deferred safely.
    const preSendRateLimit = this.detectRateLimit();
    if (preSendRateLimit) return preSendRateLimit;
    // A manually started response can begin between the initial composer
    // readiness check and this mutation point. Detect it before writing the
    // Website Bridge instruction so a bounded busy defer leaves the user's
    // composer untouched; sendMessage() repeats the check for the final
    // small race immediately before the Send control is resolved.
    if (this.detectGenerationStarted()) return failure("already_generating", "ChatGPT is already generating another response.");
    if (input.workflowKey === "profile.background" && input.protocol === "v2") {
      const baselineReady = await this.waitForConversationBaseline();
      if (baselineReady) return baselineReady;
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
    let assistantBaseline = this.assistantResponseSnapshot(input.workflowKey === "profile.background", true);
    const assistantBaselineMs = Date.now() - assistantBaselineStartedAt;
    const addArtifactFence = (anchor: DispatchTurnAnchor | null | undefined) => {
      if (!anchor) return anchor;
      const artifactKeys = [...new Set([...(assistantBaseline.artifactKeys || []), ...(anchor.artifactKeys || [])])].slice(0, 100);
      return {
        ...anchor,
        ...(typeof assistantBaseline.artifactCount === "number" || typeof anchor.artifactCount === "number"
          ? { artifactCount: Math.max(assistantBaseline.artifactCount || 0, anchor.artifactCount || 0) }
          : {}),
        ...(artifactKeys.length ? { artifactKeys } : {}),
      };
    };
    const preSendValidationStartedAt = Date.now();
    if (input.beforeComposerMutation) {
      try {
        await input.beforeComposerMutation();
      } catch (error) {
        return failure("composer_mutation_not_authorized", safeReason(error instanceof Error ? error.message : error, "The ChatGPT composer could not be touched safely."));
      }
    }
    const verified = await this.setAndVerifyComposerText(composer, input.instruction);
    if (verified) return verified;
    // History can finish mounting while the composer is being prepared. Take
    // one final pre-click snapshot so a file card that appeared after the
    // initial baseline is fenced out before the one-time Send boundary.
    if (input.workflowKey === "profile.background" && input.protocol === "v2") {
      assistantBaseline = this.assistantResponseSnapshot(true, true);
    }
    const preSendValidationMs = Date.now() - preSendValidationStartedAt;
    const sent = await this.sendMessage(input.instruction, composer, input.beforeSend
      ? async (turnAnchor) => input.beforeSend?.(turnAnchor
        ? addArtifactFence(turnAnchor) || undefined
        : turnAnchor)
      : undefined, input.workflowKey === "profile.background" && input.protocol === "v2");
    const sentTurnAnchor = sent.ok === true && sent.turnAnchor
      ? addArtifactFence(sent.turnAnchor)
      : addArtifactFence(assistantBaseline.turnAnchor) || null;
    const baselineTurnAnchor = assistantBaseline.turnAnchor
      ? addArtifactFence(assistantBaseline.turnAnchor)
      : sentTurnAnchor;
    return sent.ok === true ? {
      ...sent,
      turnAnchor: sentTurnAnchor,
      assistantBaseline: {
        ...assistantBaseline,
        turnAnchor: baselineTurnAnchor,
        userTurnFingerprint: sent.userTurnFingerprint || messageFingerprint(input.instruction),
        userTurnMessageId: sent.userTurnMessageId || null,
        userTurnPrefix: normaliseComposerText(input.instruction).slice(0, 128),
      },
      userTurnFingerprint: sent.userTurnFingerprint || messageFingerprint(input.instruction),
      userTurnMessageId: sent.userTurnMessageId || null,
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
