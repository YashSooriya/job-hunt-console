import { DISPATCH_ACTIVE_POLL_INTERVAL_MS, TERMINAL_DISPATCH_STATES, dispatchRetryDelayMs } from "./dispatch-state.ts";

export type DispatchStatusSnapshot = {
  id: string;
  state?: string;
  response?: string;
  raw?: Record<string, unknown>;
};

type DispatchApiBody = {
  ok?: boolean;
  dispatch?: unknown;
  error?: string;
};

export type PollSubscriber = (snapshot: DispatchStatusSnapshot | null, error: string | null) => void;

type Timer = ReturnType<typeof setTimeout>;
type SetTimer = (callback: () => void, delay: number) => Timer;
type ClearTimer = (timer: Timer) => void;

type SharedPoller = {
  id: string;
  snapshot: DispatchStatusSnapshot | null;
  error: string | null;
  failures: number;
  stopped: boolean;
  wakeRequested: boolean;
  timer: Timer | null;
  inFlight: Promise<DispatchStatusSnapshot | null> | null;
  subscribers: Set<PollSubscriber>;
};

export type DispatchStatusPoller = {
  subscribe(id: string, initial: Partial<DispatchStatusSnapshot> | undefined, subscriber: PollSubscriber): () => void;
  refresh(id: string, initial?: Partial<DispatchStatusSnapshot>): Promise<DispatchStatusSnapshot | null>;
  wake(id: string, initial?: Partial<DispatchStatusSnapshot>): Promise<DispatchStatusSnapshot | null>;
  dispose(): void;
};

export type DispatchStatusPollerOptions = {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  setTimeout?: SetTimer;
  clearTimeout?: ClearTimer;
  activePollIntervalMs?: number;
  retryDelayMs?: (failures: number) => number;
};

export class DispatchStatusError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "DispatchStatusError";
    this.status = status;
    this.retryable = retryable;
  }
}

function snapshotFromUnknown(value: unknown, id: string): DispatchStatusSnapshot {
  const dispatch = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    id,
    state: typeof dispatch.state === "string" ? dispatch.state : undefined,
    response: typeof dispatch.bridge_response === "string" ? dispatch.bridge_response : undefined,
    raw: dispatch,
  };
}

function actionableErrorMessage(status: number, message: string) {
  if (status === 401) return "Your session has expired. Sign in again, then refresh this page to continue tracking the ChatGPT request.";
  if (status === 403) return "Your account is not authorised to read this ChatGPT request. Sign in with the JobHuntAI account that created it.";
  if (status === 404) return "This ChatGPT request no longer exists. Start a new request from this page.";
  return message;
}

function errorForResponse(response: Response, body: DispatchApiBody) {
  const message = body.error || `Unable to read dispatch status (${response.status}).`;
  const retryable = response.status !== 401 && response.status !== 403 && response.status !== 404;
  return new DispatchStatusError(
    retryable ? message : actionableErrorMessage(response.status, message),
    response.status,
    retryable,
  );
}

/**
 * A process-local, one-request-per-id poller. The browser hook is only a
 * subscriber to this controller, so remounting a component cannot create a
 * second fetch loop or lose a response while an earlier request is in flight.
 */
export function createDispatchStatusPoller(options: DispatchStatusPollerOptions = {}): DispatchStatusPoller {
  const fetchImpl = options.fetch || ((input, init) => fetch(input, init));
  const setTimer = options.setTimeout || ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimeout || ((timer) => clearTimeout(timer));
  const activePollIntervalMs = options.activePollIntervalMs ?? DISPATCH_ACTIVE_POLL_INTERVAL_MS;
  const retryDelay = options.retryDelayMs || dispatchRetryDelayMs;
  const sharedPollers = new Map<string, SharedPoller>();

  function getSharedPoller(id: string, initial?: Partial<DispatchStatusSnapshot>) {
    const existing = sharedPollers.get(id);
    if (existing) return existing;
    const created: SharedPoller = {
      id,
      snapshot: { id, ...initial },
      error: null,
      failures: 0,
      stopped: false,
      wakeRequested: false,
      timer: null,
      inFlight: null,
      subscribers: new Set(),
    };
    sharedPollers.set(id, created);
    return created;
  }

  function publish(entry: SharedPoller) {
    for (const subscriber of entry.subscribers) {
      try {
        subscriber(entry.snapshot, entry.error);
      } catch {
        // A stale component must not prevent other subscribers from receiving
        // the authoritative snapshot or stop the shared polling loop.
      }
    }
  }

  function clearPollTimer(entry: SharedPoller) {
    if (entry.timer === null) return;
    clearTimer(entry.timer);
    entry.timer = null;
  }

  function schedulePoll(entry: SharedPoller, delay: number) {
    clearPollTimer(entry);
    if (entry.subscribers.size === 0 || entry.stopped || TERMINAL_DISPATCH_STATES.has(entry.snapshot?.state || "")) return;
    entry.timer = setTimer(() => {
      entry.timer = null;
      void pollSharedDispatch(entry).catch(() => undefined);
    }, Math.max(0, delay));
  }

  async function pollSharedDispatch(entry: SharedPoller): Promise<DispatchStatusSnapshot | null> {
    clearPollTimer(entry);
    if (entry.inFlight) return entry.inFlight;
    if (entry.stopped) return entry.snapshot;
    entry.inFlight = (async () => {
      let nextDelay: number | null = null;
      try {
        // Use a unique query value as well as no-store. Some browser or edge
        // cache layers can still reuse an authenticated GET by URL even when
        // the response advertises no-store; a status poll must never retain a
        // pre-completion snapshot after the extension has uploaded the answer.
        const pollNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const response = await fetchImpl(`/api/chatgpt-bridge/dispatch?id=${encodeURIComponent(entry.id)}&poll=${pollNonce}`, { cache: "no-store" });
        const body = await response.json().catch(() => ({})) as DispatchApiBody;
        if (!response.ok || body.ok !== true) throw errorForResponse(response, body);
        entry.snapshot = snapshotFromUnknown(body.dispatch, entry.id);
        entry.error = null;
        entry.failures = 0;
        publish(entry);
        nextDelay = TERMINAL_DISPATCH_STATES.has(entry.snapshot.state || "") ? null : activePollIntervalMs;
        return entry.snapshot;
      } catch (cause) {
        entry.failures += 1;
        entry.error = cause instanceof Error ? cause.message : "Unable to read dispatch status.";
        if (cause instanceof DispatchStatusError && !cause.retryable) entry.stopped = true;
        else nextDelay = retryDelay(entry.failures);
        publish(entry);
        throw cause;
      } finally {
        // Every success and error schedules from one place. Valid JSON errors
        // therefore cannot silently terminate a status stream.
        entry.inFlight = null;
        const followUpRequested = entry.wakeRequested;
        entry.wakeRequested = false;
        if (entry.subscribers.size === 0 && sharedPollers.get(entry.id) === entry) {
          clearPollTimer(entry);
          sharedPollers.delete(entry.id);
        } else if (followUpRequested && nextDelay !== null) {
          // A completion signal can arrive while the authoritative status read
          // is still in flight. The read may have observed the previous
          // progress state, so make that wake produce one immediate follow-up
          // rather than waiting for the normal active polling interval.
          schedulePoll(entry, 0);
        } else if (nextDelay !== null) {
          schedulePoll(entry, nextDelay);
        }
      }
    })();
    return entry.inFlight;
  }

  function subscribe(id: string, initial: Partial<DispatchStatusSnapshot> | undefined, subscriber: PollSubscriber) {
    const entry = getSharedPoller(id, initial);
    const firstSubscriber = entry.subscribers.size === 0;
    entry.subscribers.add(subscriber);
    subscriber(entry.snapshot, entry.error);
    if (firstSubscriber && !entry.stopped && !TERMINAL_DISPATCH_STATES.has(entry.snapshot?.state || "")) {
      void pollSharedDispatch(entry).catch(() => undefined);
    }
    return () => {
      entry.subscribers.delete(subscriber);
      if (entry.subscribers.size > 0) return;
      clearPollTimer(entry);
      if (!entry.inFlight && sharedPollers.get(id) === entry) sharedPollers.delete(id);
    };
  }

  function refresh(id: string, initial?: Partial<DispatchStatusSnapshot>) {
    return pollSharedDispatch(getSharedPoller(id, initial));
  }

  function wake(id: string, initial?: Partial<DispatchStatusSnapshot>) {
    const entry = getSharedPoller(id, initial);
    if (entry.inFlight) entry.wakeRequested = true;
    return pollSharedDispatch(entry);
  }

  function dispose() {
    for (const entry of sharedPollers.values()) {
      clearPollTimer(entry);
      entry.subscribers.clear();
    }
    sharedPollers.clear();
  }

  return { subscribe, refresh, wake, dispose };
}

export type DispatchWakeEnvironment = {
  window: Pick<Window, "addEventListener" | "removeEventListener" | "location">;
  document: Pick<Document, "addEventListener" | "removeEventListener"> & { visibilityState: DocumentVisibilityState };
};

/** Bind browser lifecycle and extension events to one shared poller wakeup. */
export function bindDispatchWakeEvents(
  dispatchId: string,
  wake: () => void,
  environment?: DispatchWakeEnvironment,
) {
  const view = environment?.window || (typeof window === "undefined" ? null : window);
  const documentRef = environment?.document || (typeof document === "undefined" ? null : document);
  if (!view || !documentRef) return () => undefined;

  const onWindowMessage = (event: MessageEvent) => {
    if (event.source !== view || event.origin !== view.location.origin) return;
    const payload = event.data as { request_id?: unknown; type?: unknown } | null;
    if (!payload || payload.request_id !== dispatchId) return;
    if (payload.type === "JOBHUNT_DISPATCH_ACCEPTED" || payload.type === "JOBHUNT_DISPATCH_REJECTED" || payload.type === "JOBHUNT_DISPATCH_UPDATED") wake();
  };
  const onSignal = (event: Event) => {
    const payload = (event as CustomEvent<{ requestId?: string }>).detail;
    if (!payload?.requestId || payload.requestId === dispatchId) wake();
  };
  const onFocus = () => wake();
  const onVisibility = () => { if (documentRef.visibilityState === "visible") wake(); };
  const onOnline = () => wake();
  view.addEventListener("message", onWindowMessage);
  view.addEventListener("jobhunt:dispatch-signal", onSignal);
  view.addEventListener("focus", onFocus);
  documentRef.addEventListener("visibilitychange", onVisibility);
  view.addEventListener("online", onOnline);
  return () => {
    view.removeEventListener("message", onWindowMessage);
    view.removeEventListener("jobhunt:dispatch-signal", onSignal);
    view.removeEventListener("focus", onFocus);
    documentRef.removeEventListener("visibilitychange", onVisibility);
    view.removeEventListener("online", onOnline);
  };
}
