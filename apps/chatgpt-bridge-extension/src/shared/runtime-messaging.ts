/**
 * Runtime messaging is one of the few extension APIs that can fail before a
 * Promise is returned.  This happens while Chrome is replacing an MV3
 * service-worker context, and is different from a worker that is merely asleep
 * or temporarily has no receiving listener.  Keep the distinction in one
 * small, dependency-free helper so every content-script entry point follows
 * the same fail-closed rules.
 */

export type RuntimeMessageFailureKind = "context_invalidated" | "worker_unavailable";

export type RuntimeMessageResult<T = unknown> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; kind: RuntimeMessageFailureKind; error: unknown; attempts: number };

export type RuntimeMessageHelper = {
  send<T = unknown>(message: unknown, options?: { retry?: boolean; maxAttempts?: number; timeoutMs?: number }): Promise<RuntimeMessageResult<T>>;
  dispose(): void;
  isDisposed(): boolean;
};

export type RuntimeMessageHelperOptions = {
  sendMessage: (message: unknown) => Promise<unknown> | unknown;
  onContextInvalidated?: () => void;
  maxAttempts?: number;
  /** Maximum time a single Chrome runtime message may stay unresolved. */
  messageTimeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
};

const CONTEXT_INVALIDATION_PATTERNS = [
  /extension context invalidated/i,
  /context was invalidated/i,
  /the extension context has been invalidated/i,
];

export function runtimeMessageFailureKind(error: unknown): RuntimeMessageFailureKind {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return CONTEXT_INVALIDATION_PATTERNS.some((pattern) => pattern.test(message))
    ? "context_invalidated"
    : "worker_unavailable";
}

export function runtimeRetryDelayMs(attempt: number, baseDelayMs = 250, maxDelayMs = 4000) {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const safeBase = Number.isFinite(baseDelayMs) ? Math.max(0, baseDelayMs) : 250;
  const safeMax = Number.isFinite(maxDelayMs) ? Math.max(safeBase, maxDelayMs) : 4000;
  return Math.min(safeMax, safeBase * (2 ** (safeAttempt - 1)));
}

export function createRuntimeMessageHelper(options: RuntimeMessageHelperOptions): RuntimeMessageHelper {
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const defaultMaxAttempts = Number.isFinite(options.maxAttempts) ? Math.max(1, Math.floor(options.maxAttempts as number)) : 4;
  const defaultMessageTimeoutMs = Number.isFinite(options.messageTimeoutMs) ? Math.max(1, Math.floor(options.messageTimeoutMs as number)) : 10000;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 4000;
  let disposed = false;
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  const cancelRetryWaiters = new Map<ReturnType<typeof setTimeout>, () => void>();

  function failure<T>(kind: RuntimeMessageFailureKind, error: unknown, attempts: number): RuntimeMessageResult<T> {
    if (kind === "context_invalidated") {
      // Cleanup is best effort. A recycled content context can throw while
      // removing its listeners, and that must never turn a handled runtime
      // failure into a new unhandled rejection.
      try { options.onContextInvalidated?.(); } catch { /* The context is already being torn down. */ }
    }
    return { ok: false, kind, error, attempts };
  }

  function waitForRetry(delayMs: number) {
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (retry: boolean) => {
        retryTimers.delete(timer);
        cancelRetryWaiters.delete(timer);
        resolve(retry);
      };
      timer = setTimer(() => finish(true), delayMs);
      retryTimers.add(timer);
      cancelRetryWaiters.set(timer, () => finish(false));
      if (disposed) {
        clearTimer(timer);
        finish(false);
      }
    });
  }

  return {
    async send<T = unknown>(message: unknown, sendOptions: { retry?: boolean; maxAttempts?: number; timeoutMs?: number } = {}): Promise<RuntimeMessageResult<T>> {
      if (disposed) return failure<T>("context_invalidated", new Error("The extension context is no longer active."), 0);
      const retry = sendOptions.retry !== false;
      const maxAttempts = Number.isFinite(sendOptions.maxAttempts)
        ? Math.max(1, Math.floor(sendOptions.maxAttempts as number))
        : defaultMaxAttempts;
      let attempts = 0;
      while (!disposed) {
        attempts += 1;
        try {
          const timeoutMs = Number.isFinite(sendOptions.timeoutMs)
            ? Math.max(1, Math.floor(sendOptions.timeoutMs as number))
            : defaultMessageTimeoutMs;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const sendPromise = Promise.resolve().then(() => options.sendMessage(message));
            const timeoutPromise = new Promise<never>((_, reject) => {
              timer = setTimer(() => reject(new Error(`Runtime message timed out after ${timeoutMs} ms.`)), timeoutMs);
            });
            const value = await Promise.race([sendPromise, timeoutPromise]);
            if (timer !== undefined) clearTimer(timer);
            if (disposed) return failure<T>("context_invalidated", new Error("The extension context was disposed while sending a message."), attempts);
            return { ok: true, value: value as T, attempts };
          } finally {
            if (timer !== undefined) clearTimer(timer);
          }
        } catch (error) {
          const kind = runtimeMessageFailureKind(error);
          if (kind === "context_invalidated" || !retry || attempts >= maxAttempts) return failure<T>(kind, error, attempts);
          const shouldRetry = await waitForRetry(runtimeRetryDelayMs(attempts, baseDelayMs, maxDelayMs));
          if (!shouldRetry) return failure<T>("context_invalidated", new Error("The extension context was disposed while retrying a message."), attempts);
        }
      }
      return failure<T>("context_invalidated", new Error("The extension context is no longer active."), attempts);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [timer, cancel] of cancelRetryWaiters) {
        clearTimer(timer);
        cancel();
      }
      retryTimers.clear();
      cancelRetryWaiters.clear();
    },
    isDisposed() {
      return disposed;
    },
  };
}
