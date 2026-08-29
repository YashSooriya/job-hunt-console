/**
 * Deliver a dispatch hint to the page bridge with bounded retries. The page
 * content script can be reconnecting while a tab is being restored or while
 * the extension service worker is waking, so a single postMessage is not a
 * reliable handoff. Repeating the same idempotent hint is safe: the bridge
 * claims a dispatch at most once on the server.
 */
export function notifyBridgeHint(hint: unknown) {
  if (!hint || typeof window === "undefined") return;
  const post = () => {
    try {
      window.postMessage(hint, window.location.origin);
    } catch {
      // The page may be navigating or closing. The bounded retry schedule is
      // best-effort and must never turn a successful API response into a UI
      // error.
    }
  };
  post();
  for (const delay of [750, 2000, 5000]) window.setTimeout(post, delay);
}
