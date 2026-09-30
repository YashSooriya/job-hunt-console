"use client";

import { useCallback, useEffect, useState } from "react";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LocalBridgeStatus = {
  available: boolean;
  paired: boolean;
  deviceId: string | null;
  extensionVersion: string | null;
  extensionBuildId: string | null;
  lastHeartbeatAt: string | null;
  lastHeartbeatError: string | null;
  error: string | null;
};

const unavailableStatus: LocalBridgeStatus = {
  available: false,
  paired: false,
  deviceId: null,
  extensionVersion: null,
  extensionBuildId: null,
  lastHeartbeatAt: null,
  lastHeartbeatError: null,
  error: "extension_unavailable",
};

function requestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function boundedText(value: unknown, maximum: number) {
  return typeof value === "string" && value.trim() ? value.slice(0, maximum) : null;
}

function statusFromMessage(value: unknown, expectedRequestId: string): LocalBridgeStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.type !== "JOBHUNT_BRIDGE_STATUS" || message.version !== 1 || message.requestId !== expectedRequestId) return null;
  const status = message.status && typeof message.status === "object" && !Array.isArray(message.status)
    ? message.status as Record<string, unknown>
    : {};
  const deviceId = UUID_PATTERN.test(String(status.deviceId || "")) ? String(status.deviceId) : null;
  return {
    available: true,
    paired: status.paired === true && Boolean(deviceId),
    deviceId,
    extensionVersion: boundedText(status.extensionVersion, 40),
    extensionBuildId: boundedText(status.extensionBuildId, 160),
    lastHeartbeatAt: boundedText(status.lastHeartbeatAt, 64),
    lastHeartbeatError: boundedText(status.lastHeartbeatError, 240),
    error: boundedText(status.error, 240),
  };
}

export function requestLocalBridgeStatus(timeoutMs = 2500): Promise<LocalBridgeStatus> {
  if (typeof window === "undefined") return Promise.resolve(unavailableStatus);
  const id = requestId();
  return new Promise((resolve) => {
    let settled = false;
    let timer: number | null = null;
    const finish = (status: LocalBridgeStatus) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", listener);
      if (timer !== null) window.clearTimeout(timer);
      resolve(status);
    };
    const listener = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const status = statusFromMessage(event.data, id);
      if (status) finish(status);
    };
    window.addEventListener("message", listener);
    try {
      window.postMessage({ type: "JOBHUNT_BRIDGE_STATUS_REQUEST", version: 1, requestId: id }, window.location.origin);
    } catch {
      finish(unavailableStatus);
      return;
    }
    timer = window.setTimeout(() => finish(unavailableStatus), Math.max(500, timeoutMs));
  });
}

export function useLocalBridgeStatus(intervalMs = 10000) {
  const [status, setStatus] = useState<LocalBridgeStatus>(unavailableStatus);
  const refresh = useCallback(async () => {
    const next = await requestLocalBridgeStatus();
    setStatus(next);
    return next;
  }, []);
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const run = async () => {
      if (document.visibilityState === "hidden") return;
      const next = await requestLocalBridgeStatus();
      if (!cancelled) setStatus(next);
    };
    const stopTimer = () => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const startTimer = () => {
      stopTimer();
      if (!cancelled && document.visibilityState !== "hidden") timer = window.setInterval(() => { void run(); }, intervalMs);
    };
    const onVisibilityChange = () => {
      stopTimer();
      if (document.visibilityState !== "hidden") {
        void run();
        startTimer();
      }
    };
    if (document.visibilityState !== "hidden") {
      void run();
      startTimer();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs]);
  return { status, refresh };
}
