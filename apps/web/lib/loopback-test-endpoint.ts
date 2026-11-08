/**
 * Test provider endpoints are opt-in, development-only, and loopback-only.
 * This keeps local integration fixtures from silently becoming production
 * service overrides or a route to an arbitrary network host.
 */
export function loopbackTestUrl(environmentName: string) {
  const configured = process.env[environmentName];
  if (!configured) return null;
  if (process.env.NODE_ENV !== "development" || process.env.JOBHUNT_TEST_AUTH !== "true") {
    throw new Error(`${environmentName} is available only in explicit local test-auth development mode.`);
  }
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`${environmentName} must be a valid loopback HTTP URL.`);
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) {
    throw new Error(`${environmentName} must use loopback HTTP without credentials, query, or fragment.`);
  }
  return url.toString().replace(/\/+$/, "");
}

export function loopbackTestOrigin(environmentName: string) {
  const endpoint = loopbackTestUrl(environmentName);
  if (!endpoint) return null;
  const url = new URL(endpoint);
  if (url.pathname !== "/") throw new Error(`${environmentName} must be an origin without a path.`);
  return url.origin;
}
