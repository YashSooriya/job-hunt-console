export type RemoteDispatchStatus = {
  id?: unknown;
  state?: unknown;
};

/**
 * A permanent local upload warning may outlive a server completion when the
 * response was accepted but local cleanup failed. Reconcile that record with
 * a read-only status request before showing it as permanently stuck. This
 * helper has no send/upload callback by design.
 */
export async function reconcileBlockedCapturedResult(args: {
  expectedRequestId: string;
  readRemoteStatus: () => Promise<RemoteDispatchStatus>;
  clearLocalRecord: () => Promise<unknown>;
}) {
  const remote = await args.readRemoteStatus();
  if (remote.id !== args.expectedRequestId || typeof remote.state !== "string") {
    throw new Error("The server returned a mismatched dispatch during captured-result reconciliation.");
  }
  if (remote.state !== "completed") return false;
  await args.clearLocalRecord();
  return true;
}
