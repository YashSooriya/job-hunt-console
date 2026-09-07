"use client";

import { useCallback, useEffect, useState } from "react";
import { bindDispatchWakeEvents, createDispatchStatusPoller, type DispatchStatusSnapshot } from "./status-poller";

export type { DispatchStatusSnapshot } from "./status-poller";

const sharedDispatchPoller = createDispatchStatusPoller();

/**
 * Subscribe to one process-wide poller per dispatch id. Components share the
 * same fetch, backoff timer, and latest snapshot; extension signals only wake
 * that shared poller and cannot create parallel status loops.
 */
export function useDispatchStatus(dispatchId: string | null, initial?: Partial<DispatchStatusSnapshot>) {
  const [snapshot, setSnapshot] = useState<DispatchStatusSnapshot | null>(() => dispatchId ? { id: dispatchId, ...initial } : null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!dispatchId) return null;
    return sharedDispatchPoller.refresh(dispatchId, initial);
  }, [dispatchId, initial]);

  useEffect(() => {
    if (!dispatchId) {
      setSnapshot(null);
      setError(null);
      return;
    }
    return sharedDispatchPoller.subscribe(dispatchId, initial, (nextSnapshot, nextError) => {
      setSnapshot(nextSnapshot);
      setError(nextError);
    });
    // Initial values seed a newly-created shared poller only. Recreating the
    // caller's object must not tear down a live subscription and timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatchId]);

  useEffect(() => {
    if (!dispatchId) return;
    return bindDispatchWakeEvents(dispatchId, () => {
      void sharedDispatchPoller.wake(dispatchId, initial).catch(() => undefined);
    });
  }, [dispatchId, initial]);

  return {
    dispatch: snapshot,
    state: snapshot?.state || initial?.state || null,
    response: snapshot?.response || null,
    error,
    refresh,
  };
}
