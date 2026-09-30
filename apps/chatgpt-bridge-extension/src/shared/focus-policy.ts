export type FocusSurface = {
  windowId: number | null;
  tabId: number | null;
  known: boolean;
};

/**
 * Automatic delivery must not leave the user looking at the ChatGPT helper.
 * This applies equally to a newly-created tab and to a helper tab reused from
 * an earlier request. The caller separately treats a move to an unrelated
 * tab as deliberate user navigation, so this predicate only describes the
 * target helper becoming active.
 */
export function shouldRestoreAfterHelperOpen(initial: FocusSurface, current: FocusSurface, helperTabId: number) {
  return initial.known
    && current.known
    && initial.tabId !== helperTabId
    && current.tabId === helperTabId;
}
