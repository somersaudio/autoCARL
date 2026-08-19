// GSA per-diem rate lookup — by venue ZIP when CARL has one, by city/state
// otherwise (venues often aren't assigned until close to the show).
//
// Hits the official GSA per-diem API at api.gsa.gov. Free, requires an
// API key from api.data.gov — we default to "DEMO_KEY" which works without
// registration but is rate-limited (30 req/hour, 50 req/day per IP). For
// heavier use, drop a real key into src/main/secrets.ts as GSA_API_KEY.
//
// We cache real answers (and definitive "no rate" answers) per lookup+year
// in memory for the app's lifetime; transient failures are NOT cached, so
// a rate-limited or offline first sweep can succeed on a later one.

import { net } from 'electron';

let secretsKey: string | undefined;
try {
  // Lazy require so tests / dev without secrets.ts still work.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  secretsKey = (require('./secrets') as { GSA_API_KEY?: string }).GSA_API_KEY;
} catch { /* no secrets.ts override — fall through to DEMO_KEY */ }

const API_KEY = secretsKey || 'DEMO_KEY';

export type GsaRate = {
  meals: number;       // M&IE total
  lodging?: number;    // varies by month — average if unavailable
  city?: string;
  state?: string;
  zip?: string;        // present on zip lookups only
  year: number;
};

const cache = new Map<string, GsaRate | null>();

function fiscalYearForToday(): number {
  // Fed FY starts Oct 1. For Oct-Dec, FY = year + 1.
  const now = new Date();
  return now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url, redirect: 'follow' });
    req.setHeader('accept', 'application/json');
    const chunks: Buffer[] = [];
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode || 0) >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${txt.slice(0, 200)}`));
        try { resolve(JSON.parse(txt)); }
        catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchRates(pathSeg: string, cacheKey: string, extra: Partial<GsaRate>): Promise<GsaRate | null> {
  const year = fiscalYearForToday();
  const key = `${cacheKey}|${year}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  const url = `https://api.gsa.gov/travel/perdiem/v2/rates/${pathSeg}/year/${year}?api_key=${encodeURIComponent(API_KEY)}`;
  try {
    const data = await fetchJson(url) as {
      rates?: Array<{
        rate?: Array<{
          meals?: number;
          months?: { month?: Array<{ value?: number }> };
        }>;
        city?: string;
        state?: string;
      }>;
    };
    const r = data.rates?.[0]?.rate?.[0];
    if (!r || typeof r.meals !== 'number') {
      cache.set(key, null);   // definitive: GSA has no rate for this lookup
      return null;
    }
    // Lodging varies per month — take the average if available, just for
    // info on the featured card (M&IE is what crews actually claim).
    const monthly = r.months?.month || [];
    const lodgings = monthly.map((m) => m.value).filter((v): v is number => typeof v === 'number');
    const lodging = lodgings.length
      ? Math.round(lodgings.reduce((a, b) => a + b, 0) / lodgings.length)
      : undefined;

    const result: GsaRate = {
      meals: r.meals,
      lodging,
      city: data.rates?.[0]?.city,
      state: data.rates?.[0]?.state,
      year,
      ...extra,
    };
    cache.set(key, result);
    return result;
  } catch {
    // Transient (offline, DEMO_KEY rate limit) — don't cache, retry later.
    return null;
  }
}

export async function gsaRateForZip(zip: string): Promise<GsaRate | null> {
  const cleaned = zip.trim().slice(0, 5);
  if (!/^\d{5}$/.test(cleaned)) return null;
  return fetchRates(`zip/${cleaned}`, `zip:${cleaned}`, { zip: cleaned });
}

export async function gsaRateForCity(city: string, state: string): Promise<GsaRate | null> {
  const c = city.trim();
  const st = state.trim().slice(0, 2).toUpperCase();
  if (!c || !/^[A-Z]{2}$/.test(st)) return null;
  return fetchRates(`city/${encodeURIComponent(c)}/state/${st}`, `city:${c.toLowerCase()}|${st}`, {});
}
