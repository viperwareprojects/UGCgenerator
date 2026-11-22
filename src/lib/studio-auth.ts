/**
 * Optional site-wide password for hosted deployments.
 *
 * Set STUDIO_PASSWORD (and optionally STUDIO_USER, default "studio") and every page and API
 * route asks for HTTP Basic credentials. Unset = open, which is the local-dev behaviour.
 */

export function studioCredentials(): { user: string; password: string } | null {
  const password = process.env.STUDIO_PASSWORD;
  if (!password) return null;
  return { user: process.env.STUDIO_USER || "studio", password };
}

/** Authorization header for the server calling its own API (e.g. the hands-off pipeline runner). */
export function internalAuthHeaders(): Record<string, string> {
  const c = studioCredentials();
  if (!c) return {};
  return { Authorization: `Basic ${Buffer.from(`${c.user}:${c.password}`).toString("base64")}` };
}

/** True when the request's Basic credentials match (or no password is configured). */
export function isAuthorized(authHeader: string | null): boolean {
  const c = studioCredentials();
  if (!c) return true;
  if (!authHeader?.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = atob(authHeader.slice(6).trim());
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  return safeEqual(decoded.slice(0, idx), c.user) && safeEqual(decoded.slice(idx + 1), c.password);
}

function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
