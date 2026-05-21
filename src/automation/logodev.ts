import { LOGODEV_PUBLISHABLE, LOGODEV_SECRET } from '../main/secrets';

// Resolve a show's company name to a logo, fetched server-side and returned as
// a data URI so the API keys never reach the renderer. Cached per company query
// for the session. Returns null when nothing usable is found (UI hides it).

const cache = new Map<string, string | null>();

// Pull a searchable company token from a job name like
// "Google I/O '26 - Tracks Audio Labor" → "Google".
function companyQuery(jobName: string): string {
  const beforeDash = (jobName.split(/\s[-–—]\s/)[0] || jobName).trim();
  const firstWord = beforeDash.split(/\s+/)[0] || '';
  return firstWord.replace(/[^A-Za-z0-9&]/g, '');
}

async function searchDomain(query: string): Promise<string | null> {
  if (!LOGODEV_SECRET) return null;
  try {
    const res = await fetch(`https://api.logo.dev/search?q=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${LOGODEV_SECRET}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ domain?: string }>;
    return Array.isArray(data) && data[0]?.domain ? data[0].domain : null;
  } catch {
    return null;
  }
}

async function fetchLogoDataUri(domain: string): Promise<string | null> {
  if (!LOGODEV_PUBLISHABLE) return null;
  try {
    const url = `https://img.logo.dev/${encodeURIComponent(domain)}?token=${LOGODEV_PUBLISHABLE}&size=64&format=png&retina=true`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export async function getShowLogo(jobName: string): Promise<string | null> {
  const query = companyQuery(jobName);
  if (!query) return null;
  if (cache.has(query)) return cache.get(query) ?? null;

  const domain = await searchDomain(query);
  const dataUri = domain ? await fetchLogoDataUri(domain) : null;
  cache.set(query, dataUri);
  return dataUri;
}
