// Friendly-error translation. Network failures surface as low-level strings
// ("fetch failed", "getaddrinfo ENOTFOUND", "net::ERR_INTERNET_DISCONNECTED",
// etc.) that mean nothing to a user. When we recognize one of those, we swap
// in a plain-English offline message instead.

export const OFFLINE_MESSAGE =
  "You appear to be offline. Check your internet connection and try again.";

// Substrings (lowercased) that indicate a connectivity problem rather than a
// real application error.
const OFFLINE_HINTS = [
  'fetch failed',
  'failed to fetch',
  'getaddrinfo',
  'enotfound',
  'econnrefused',
  'econnreset',
  'ehostunreach',
  'enetunreach',
  'etimedout',
  'timed out',
  'network error',
  'net::err_internet_disconnected',
  'net::err_name_not_resolved',
  'net::err_network_changed',
  'net::err_connection',
  'net::err_address_unreachable',
  'net::err_timed_out',
  'net::err_proxy_connection_failed',
];

export function looksOffline(message: string): boolean {
  const lower = message.toLowerCase();
  return OFFLINE_HINTS.some((h) => lower.includes(h));
}

// Convert any caught error (or pre-built error string) into a user-facing
// message. `offline` lets the renderer pass navigator.onLine === false to force
// the offline message even when the underlying error text is ambiguous.
export function friendlyError(e: unknown, offline = false): string {
  let raw = e instanceof Error ? e.message : String(e);
  // Errors thrown in the main process reach the renderer wrapped by Electron:
  // "Error invoking remote method 'ssw:fetchWeek': Error: <real message>".
  // Strip the plumbing so the banner shows only the real message.
  raw = raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
  if (offline || looksOffline(raw)) return OFFLINE_MESSAGE;
  return raw;
}
