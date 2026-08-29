export async function instructionIdempotencyKey(prefix: string, instruction: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(instruction));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}:${hash}`;
}
