/**
 * Retry only a read-only response lookup after its content-script message
 * channel drops. The caller is responsible for ensuring `check` can never
 * submit or edit anything; `recover` may only re-establish that reader.
 */
export async function runReadOnlyCheckWithRecovery<T>(input: {
  check: () => Promise<T>;
  recover: (attempt: number, error: unknown) => Promise<boolean>;
  maxAttempts?: number;
  retryDelayMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<T> {
  const maxAttempts = Number.isSafeInteger(input.maxAttempts)
    ? Math.max(1, Math.min(3, input.maxAttempts as number))
    : 3;
  const retryDelayMs = Number.isSafeInteger(input.retryDelayMs)
    ? Math.max(0, Math.min(2000, input.retryDelayMs as number))
    : 350;
  const wait = input.wait || ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown = new Error("The read-only ChatGPT response check did not complete.");

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await input.check();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      try {
        const recovered = await input.recover(attempt, error);
        if (!recovered) break;
      } catch (recoveryError) {
        lastError = recoveryError;
        break;
      }
      if (retryDelayMs > 0) await wait(retryDelayMs);
    }
  }

  throw lastError;
}
