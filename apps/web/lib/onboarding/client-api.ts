export type ApiRecord = Record<string, any>;

function errorText(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/**
 * Read an API response without assuming that every failure is JSON.
 * Cloudflare can generate an HTML error document when a Worker hits a
 * resource limit; attempting response.json() in that case hides the useful
 * HTTP failure behind "Unexpected token '<'".
 */
export async function readApiResponse<T extends ApiRecord = ApiRecord>(response: Response, fallback: string): Promise<T> {
  const body = await response.text();
  let payload: unknown;
  try {
    payload = body.trim() ? JSON.parse(body) : {};
  } catch {
    const ray = response.headers.get("cf-ray");
    const diagnostic = response.status
      ? ` (HTTP ${response.status}${ray ? `, Cloudflare Ray ${ray}` : ""})`
      : "";
    throw new Error(`${fallback}${diagnostic}.`);
  }

  const data = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as ApiRecord
    : {};
  if (!response.ok || data.ok !== true) {
    throw new Error(errorText(data.error, `${fallback} (HTTP ${response.status}).`));
  }
  return data as T;
}
