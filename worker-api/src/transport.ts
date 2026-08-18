// Transport layer shared by the CARL and SSW ports.
//
// The desktop app rides Electron's network stack, which quietly handles two
// things we must do by hand here: cookie jars across redirect chains, and
// (for SSW) a TLS handshake modern stacks refuse. So:
//   - CookieJar + followRedirects() reimplement Electron's cookie handling.
//   - DirectTransport fetches straight from the Worker (CARL is fine with it).
//   - RelayTransport tunnels through a host-locked PHP relay on Hostinger
//     whose curl is configured to accept SSW's legacy TLS.

export type FetchOpts = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type FetchResult = {
  status: number;
  headers: Record<string, string>;         // lower-cased names; set-cookie EXCLUDED
  setCookies: string[];                     // every Set-Cookie header, verbatim
  text(): Promise<string>;
};

export interface Transport {
  fetch(url: string, opts?: FetchOpts): Promise<FetchResult>;
}

// ---- cookie jar ----------------------------------------------------------

// Minimal jar: name→value per host suffix, enough for CARL/SSW session
// cookies (no attribute honoring beyond Path=/ semantics — matches how the
// desktop's single-partition sessions behaved for these two hosts).
export class CookieJar {
  private store = new Map<string, string>();

  absorb(setCookies: string[]): void {
    for (const sc of setCookies) {
      const first = sc.split(';')[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      // Expired/emptied cookies get dropped.
      if (/expires=Thu, 01 Jan 1970/i.test(sc) || value === '') this.store.delete(name);
      else this.store.set(name, value);
    }
  }

  header(): string {
    return [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get(name: string): string | undefined { return this.store.get(name); }

  toJSON(): Record<string, string> { return Object.fromEntries(this.store); }

  static fromJSON(obj: Record<string, string> | undefined): CookieJar {
    const jar = new CookieJar();
    if (obj) for (const [k, v] of Object.entries(obj)) jar.store.set(k, v);
    return jar;
  }
}

// Follow redirects manually so every hop's Set-Cookie lands in the jar —
// ASP.NET login flows set session cookies on 302s, which fetch's automatic
// redirect handling would apply but not expose to us.
export async function fetchWithJar(
  transport: Transport,
  jar: CookieJar,
  url: string,
  opts: FetchOpts = {},
  maxHops = 6,
): Promise<FetchResult> {
  let current = url;
  let method = opts.method || 'GET';
  let body = opts.body;
  for (let hop = 0; hop < maxHops; hop++) {
    const res = await transport.fetch(current, {
      method,
      body,
      headers: { ...(opts.headers || {}), ...(jar.header() ? { Cookie: jar.header() } : {}) },
    });
    jar.absorb(res.setCookies);
    if (res.status >= 300 && res.status < 400 && res.headers['location']) {
      current = new URL(res.headers['location'], current).toString();
      method = 'GET';               // 302s downgrade to GET, like browsers/Electron
      body = undefined;
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

// ---- direct (Worker fetch) ----------------------------------------------

export class DirectTransport implements Transport {
  async fetch(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers,
      body: opts.body,
      redirect: 'manual',
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { if (k.toLowerCase() !== 'set-cookie') headers[k.toLowerCase()] = v; });
    const setCookies = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    const bodyText = await res.text();
    return { status: res.status, headers, setCookies, text: async () => bodyText };
  }
}

// ---- relay (Hostinger PHP, for SSW's legacy TLS) -------------------------

export class RelayTransport implements Transport {
  constructor(private relayUrl: string, private secret: string) {}

  async fetch(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
    const res = await fetch(this.relayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Key': this.secret },
      body: JSON.stringify({
        url,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        body: opts.body ?? null,
      }),
    });
    if (!res.ok) throw new Error(`relay HTTP ${res.status}`);
    const data = await res.json() as {
      status: number; headers: Record<string, string>; setCookies: string[]; bodyB64: string;
    };
    const bodyText = atob(data.bodyB64 || '');
    // Latin-1 → UTF-8 repair for the base64 round trip.
    const bytes = Uint8Array.from(bodyText, (c) => c.charCodeAt(0));
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return {
      status: data.status,
      headers: Object.fromEntries(Object.entries(data.headers || {}).map(([k, v]) => [k.toLowerCase(), v])),
      setCookies: data.setCookies || [],
      text: async () => decoded,
    };
  }
}

// ---- session persistence --------------------------------------------------

// Cookie jars + tokens survive across Worker invocations in KV, keyed by a
// hash of the credentials, so each API call doesn't pay a fresh login.
export type SessionState = {
  cookies: Record<string, string>;
  token?: string;
  ts: number;
};

export async function sessionKey(service: string, email: string, password: string): Promise<string> {
  const data = new TextEncoder().encode(`${service}\0${email}\0${password}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return `${service}:${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
