import { LOGODEV_PUBLISHABLE, LOGODEV_SECRET } from './secrets';

// Resolve a show's company to a logo (data URI), fetched server-side so the
// API keys never reach the renderer. Session-cached per company-query.

// Some shows are branded by the EVENT, not the company — map those to the
// company the logo API should be asked for.
const ALIAS_RULES: Array<[RegExp, string]> = [
  // nVIDIA's GPU Technology Conference: "GTC", "GTC26", "GTC DC"…
  [/^GTC\d*$/i, 'NVIDIA'],
  // Elon Musk's AI company is a SEPARATE brand from X itself, and a bare
  // "X" query lands on x.com.
  [/^X\s*AI$/i, 'xAI'],
  // Internal CT job codes that name no company at all.
  [/^CC\d+$/i, 'Apple'],
  // Abbreviations a search can't resolve on its own — the letters never
  // appear in the company's real name.
  [/^BofA$/i, 'Bank of America'],
  [/^AMAT$/i, 'Applied Materials'],
];

function applyAlias(query: string): string {
  for (const [pattern, company] of ALIAS_RULES) if (pattern.test(query)) return company;
  return query;
}

const cache = new Map<string, string | null>();

// The leading ONE and TWO words of a job name. One word alone is often a
// plain English word — "Live Nation Leadership Conference" searched as
// "Live" returns Microsoft, who own live.com — so a second, more specific
// query is kept in reserve.
function companyQueries(jobName: string): string[] {
  const beforeDash = (jobName.split(/\s[-–—]\s/)[0] || jobName).trim();
  const words = beforeDash.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const take of [1, 2]) {
    const q = applyAlias(
      words.slice(0, take).join(' ').replace(/[^A-Za-z0-9& ]/g, '').trim(),
    );
    if (q && !out.includes(q)) out.push(q);
  }
  return out;
}

function tokens(s: string): string[] {
  return (s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Does the hit have anything to do with what we asked for? Logo.dev always
// returns its best guess, so a query that matches nothing still comes back
// with a confident wrong answer. Tokens under three characters are ignored:
// "X" would match half the internet.
function hitRelates(name: string, domain: string, query: string): boolean {
  const hay = new Set([...tokens(name), ...tokens(domain)]);
  return tokens(query).some((t) => t.length >= 3 && hay.has(t));
}

async function searchTop(query: string): Promise<{ name: string; domain: string } | null> {
  if (!LOGODEV_SECRET) return null;
  try {
    const res = await fetch(`https://api.logo.dev/search?q=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${LOGODEV_SECRET}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ name?: string; domain?: string }>;
    const top = Array.isArray(data) ? data[0] : null;
    return top?.domain ? { name: top.name || '', domain: top.domain } : null;
  } catch { return null; }
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
  } catch { return null; }
}

export async function getJobLogo(jobName: string): Promise<string | null> {
  const queries = companyQueries(jobName);
  if (queries.length === 0) return null;
  const key = queries.join('|');
  if (cache.has(key)) return cache.get(key) ?? null;

  // Only a hit that actually relates to its query is used. Logo.dev always
  // answers with SOMETHING, and a confident wrong brand on a job card is
  // worse than no logo at all — "America" returns American Express, which is
  // not who the America PAC show is for. Anything a search genuinely can't
  // resolve belongs in ALIAS_RULES above.
  let domain: string | null = null;
  for (const q of queries) {
    const hit = await searchTop(q);
    if (hit && hitRelates(hit.name, hit.domain, q)) { domain = hit.domain; break; }
  }
  const dataUri = domain ? await fetchLogoDataUri(domain) : null;
  cache.set(key, dataUri);
  return dataUri;
}
