"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "jobhunt.diagnostics.visible";
const CHANGE_EVENT = "jobhunt:diagnostics-visibility-change";
let fallbackVisibility = false;

function readVisibility() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return fallbackVisibility;
  }
}

function subscribe(onStoreChange: () => void) {
  function handleStorage(event: StorageEvent) {
    if (event.key === STORAGE_KEY) onStoreChange();
  }

  window.addEventListener("storage", handleStorage);
  window.addEventListener(CHANGE_EVENT, onStoreChange);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(CHANGE_EVENT, onStoreChange);
  };
}

export function setDiagnosticsVisible(visible: boolean) {
  fallbackVisibility = visible;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(visible));
  } catch {
    // The control still works for the current page in privacy-restricted browsers.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useDiagnosticsVisibility() {
  return useSyncExternalStore(subscribe, readVisibility, () => false);
}
