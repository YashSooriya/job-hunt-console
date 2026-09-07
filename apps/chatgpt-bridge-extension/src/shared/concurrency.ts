/**
 * The browser-side concurrency policy is deliberately pure. Keeping the
 * timing and classification rules here makes them usable by the background
 * worker, the content adapter, and tests without importing Chrome globals.
 */
export const DEFAULT_GENERATION_CONCURRENCY = 2 as const;
export const REDUCED_GENERATION_CONCURRENCY = 1 as const;
export const RATE_LIMIT_FALLBACK_DELAY_SECONDS = 300 as const;
export const RATE_LIMIT_MIN_DELAY_SECONDS = 30 as const;
export const RATE_LIMIT_MAX_DELAY_SECONDS = 1800 as const;
export const MANUAL_GENERATION_DEFER_SECONDS = 15 as const;
export const MAX_MANUAL_GENERATION_DEFERRALS = 5 as const;

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Keep a server/UI supplied delay inside the safe rate-limit window. */
export function clampRateLimitDelaySeconds(value: unknown, fallback = RATE_LIMIT_FALLBACK_DELAY_SECONDS): number {
  const candidate = finiteNumber(value) ?? fallback;
  return Math.min(RATE_LIMIT_MAX_DELAY_SECONDS, Math.max(RATE_LIMIT_MIN_DELAY_SECONDS, Math.ceil(candidate)));
}

/**
 * Parse only an explicit relative retry duration from visible ChatGPT text.
 * Clock times and dates are intentionally ignored because the page timezone
 * and locale are not reliable enough to turn them into a safe delay.
 */
export function parseRetryAfterSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const context = text.match(/(?:retry|try again|wait|resume|available)[^.!?\n]{0,140}/i)?.[0] || "";
  if (!context) return null;
  let total = 0;
  let found = false;
  for (const match of context.matchAll(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/gi)) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) continue;
    const unit = match[2].toLowerCase();
    const multiplier = unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1;
    total += amount * multiplier;
    found = true;
  }
  return found && total > 0 ? Math.ceil(total) : null;
}

export function generationLimit(backoffUntil: unknown, configured: number = DEFAULT_GENERATION_CONCURRENCY, nowMs = Date.now()): 1 | 2 {
  const until = typeof backoffUntil === "string" ? Date.parse(backoffUntil) : finiteNumber(backoffUntil);
  if (until !== null && Number.isFinite(until) && until > nowMs) return REDUCED_GENERATION_CONCURRENCY;
  return configured >= DEFAULT_GENERATION_CONCURRENCY ? DEFAULT_GENERATION_CONCURRENCY : REDUCED_GENERATION_CONCURRENCY;
}

export function shouldStopAfterManualGenerationDeferrals(deferralCount: unknown): boolean {
  const count = finiteNumber(deferralCount) ?? 0;
  return count >= MAX_MANUAL_GENERATION_DEFERRALS;
}

export function isRateLimitCode(value: unknown): boolean {
  return typeof value === "string" && /rate[_ -]?limit|too[_ -]?many[_ -]?requests/i.test(value);
}

export function isManualGenerationBusyCode(value: unknown): boolean {
  return value === "already_generating";
}
