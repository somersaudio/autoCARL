// City View's wallpaper: a photo of the city the user's gig is in, from
// Wikimedia Commons. Both apps ask this worker (GET /v1/city-photo), so the
// choice of photo lives in one place.
//
// The cities John works most have a photo picked by hand (CURATED below).
// Any other city falls back to Wikipedia: the city's article, its lead image,
// then the views Wikidata files for it (panorama, night, main image, aerial).
// The first one that makes a decent wallpaper wins: a JPEG photo wider than
// the 1920px it's shown at, landscape but not a strip panorama. A town with
// nothing usable can be pointed at the nearby metro in ALIASES.
//
// Nothing is stored here. The apps keep each answer for a week, so a city
// costs a few Wikimedia calls a week; a KV cache would share its daily write
// allowance with the logins, and this endpoint is open to anyone.
//
// The images themselves are proxied (GET /v1/city-photo/img) rather than
// linked: Wikimedia's thumbnails carry no cache lifetime, so a phone would
// recheck them on every launch, while the copy served here is cached for a
// year. The proxy only fetches Commons thumbnails of the two widths the lookup
// hands out.

const UA = 'AUTOcarl/1.0 (https://somersaudio.com/autocarl; city backgrounds)';
const MIN_WIDTH = 2000;   // wider than 1920, so a 1920px thumbnail exists

type Found = {
  place: string;        // what the photo shows, e.g. "Las Vegas, NV"
  title: string;
  artist: string;
  license: string;
  licenseUrl: string;
  pageUrl: string;      // the file's Commons page
  width: number;        // the original's size
  height: number;
  thumb: string;        // Commons thumbnail path, 1920px wide
  thumbLarge: string;   // 3840px wide, '' when the original is smaller than that
  focus: number;        // horizontal focal point, percent from the left
};

export type CityPhoto = Omit<Found, 'thumb' | 'thumbLarge'> & {
  src: string;
  srcLarge: string;
};

type Place = { city: string; st: string };

const STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

// Every region a gig's place can name: the states, and the places abroad a
// tour reaches that title their towns "City, Region" on Wikipedia.
const REGIONS: Record<string, string> = {
  ...STATES,
  PR: 'Puerto Rico',
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', ON: 'Ontario',
  PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan',
};

// Venue towns with no photo worth a wallpaper, pointed at the metro around
// them. Keys and values are "city|ST", the city lowercased.
const ALIASES: Record<string, string> = {
  'kissimmee|FL': 'orlando|FL',
  'lake buena vista|FL': 'orlando|FL',
  'paradise|NV': 'las vegas|NV',
  'winchester|NV': 'las vegas|NV',
  'rosemont|IL': 'chicago|IL',
  'national harbor|MD': 'washington|DC',
};

// Hand-picked photos, "city|ST" -> Commons file: the cities John has worked
// and the big convention towns, each one looked at. Wide views only, the way
// John likes them: skylines, downtowns and the city from the air, never a
// close-up of one landmark; dusk and night where there's a good one (they sit
// best under the veil). focus is where the subject sits, percent from the
// left, since a phone in portrait shows only a slice.
const CURATED: Record<string, { file: string; focus: number }> = {
  'las vegas|NV': { file: 'Las Vegas Strip from Resorts World February 2023 HDR 2.jpg', focus: 35 },
  'san diego|CA': { file: 'San Diego skyline at dusk from Coronado 2015.jpg', focus: 35 },
  'los angeles|CA': { file: 'Downtown LA at Sunset..jpg', focus: 40 },
  'huntington beach|CA': { file: 'HB Pier by Don Ramey Logan.jpg', focus: 60 },
  'long beach|CA': { file: 'Downtown, Long Beach from Queen Mary (Dusk).JPG', focus: 32 },
  'anaheim|CA': { file: 'DCA from Paradise Pier Hotel 2012.jpg', focus: 55 },
  'san francisco|CA': { file: 'Golden Gate Bridge and San Francisco skyline from Hawk Hill at Blue Hour dllu (cropped).jpg', focus: 78 },
  'san jose|CA': { file: 'San Jose CA skyline at night 2014.jpg', focus: 45 },
  'santa clara|CA': { file: "Levi's Stadium from California's Great Adventure (4059).jpg", focus: 50 },
  'mountain view|CA': { file: 'Google Campus, Mountain View, CA.jpg', focus: 55 },
  'cupertino|CA': { file: 'Aerial view of Apple Park dllu.jpg', focus: 50 },
  'palo alto|CA': { file: 'Stanford University campus from above.jpg', focus: 58 },
  'austin|TX': { file: 'View from Town lake 03.jpg', focus: 52 },
  'san antonio|TX': { file: 'San antonio blue hour.jpg', focus: 68 },
  'dallas|TX': { file: 'Dallas Texas Skyline - Trinity River - Margaret Hunt Hill Bridge.jpg', focus: 60 },
  'houston|TX': { file: 'HoustonTX.jpg', focus: 62 },
  'new orleans|LA': { file: 'New Orleans skyline-02.jpg', focus: 38 },
  'phoenix|AZ': { file: 'Downtown Phoenix Skyline at Night.jpg', focus: 42 },
  'portland|OR': { file: 'Portland from Pittock Mansion October 2019 001.jpg', focus: 48 },
  'seattle|WA': { file: 'Seattle skyline from Kerry Park, evening of 2014-10-19 no. 05.jpg', focus: 32 },
  'denver|CO': { file: 'Denver skyline.jpg', focus: 55 },
  'salt lake city|UT': { file: 'Salt Lake City After Dark from the Avenues.jpg', focus: 35 },
  'green bay|WI': { file: 'Downtown Green Bay.JPG', focus: 60 },
  'chicago|IL': { file: 'Chicago Skyline at Night - Lakefront (54182269176).jpg', focus: 54 },
  'boston|MA': { file: 'The Boston Skyline from Memorial Drive - 2015-07-24 - Flickr - BillDamon.jpg', focus: 22 },
  'lowell|MA': { file: 'Lowell, Massachusetts.jpg', focus: 57 },
  'new york|NY': { file: '2024-11-17-Lower Manhattan-0593.jpg', focus: 62 },
  'philadelphia|PA': { file: 'Center City Philadelphia 2018.jpg', focus: 50 },
  'washington|DC': { file: 'Washington, D.C. - 2007 aerial view.jpg', focus: 46 },
  'indianapolis|IN': { file: 'The city from Wapahani Trail (5071573814).jpg', focus: 40 },
  'orlando|FL': { file: 'Lake Eola Park in Orlando 02.jpg', focus: 40 },
  'miami|FL': { file: 'Night Panorama Miami Florida 5462.jpg', focus: 45 },
  'atlanta|GA': { file: 'Jackson Street Bridge, Atlanta, United States (Unsplash vXtX07KVcE8).jpg', focus: 42 },
  'nashville|TN': { file: 'Nashville skyline 2009.jpg', focus: 22 },
};

// The booking's city and state, tidied: CARL sends states both as codes and
// spelled out ("TX", "TEXAS"), and none at all for most shows abroad. A
// region this doesn't know is dropped, leaving the city's own name.
export function normalizePlace(city: string, state: string): Place | null {
  const c = city.trim().replace(/\s+/g, ' ');
  if (!c || c.length > 60 || !/^[\p{L}\p{M} .'’-]+$/u.test(c)) return null;
  const s = state.trim().replace(/\./g, '').toLowerCase();
  const st = s
    ? Object.keys(REGIONS).find((code) => code.toLowerCase() === s || REGIONS[code].toLowerCase() === s) || ''
    : '';
  return { city: c, st };
}

const keyOf = (p: Place) => `${p.city.toLowerCase()}|${p.st}`;

function fromKey(key: string): Place {
  const [city, st] = key.split('|');
  return { city: city.replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase()), st };
}

// The Wikipedia article to try for a place. With a region it's only that
// region's town (big cities' "City, State" titles redirect to them), never
// the bare name: a bare "London" is the one in England.
function articleTitle(p: Place): string {
  if (p.st === 'DC' && /^washington( dc)?$/i.test(p.city)) return 'Washington, D.C.';
  return REGIONS[p.st] ? `${p.city}, ${REGIONS[p.st]}` : p.city;
}

async function wiki<T>(host: string, params: Record<string, string>): Promise<T> {
  const u = new URL(`https://${host}/w/api.php`);
  u.searchParams.set('format', 'json');
  u.searchParams.set('formatversion', '2');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u.toString(), { headers: { 'User-Agent': UA, 'Api-User-Agent': UA } });
  if (!r.ok) throw new Error(`${host} HTTP ${r.status}`);
  // MediaWiki reports its own failures with a 200 and an `error` member. Read
  // as an empty answer, a hiccup would pass for "this city has no photo".
  const body = await r.json() as T & { error?: { code?: string } };
  if (body && typeof body === 'object' && 'error' in body) throw new Error(`${host} API ${body.error?.code || 'error'}`);
  return body;
}

type PagesResult = {
  query?: {
    pages?: Array<{
      title: string;
      missing?: boolean;
      pageimage?: string;
      pageprops?: { wikibase_item?: string; disambiguation?: string };
    }>;
  };
};

// The city's article: its lead image and its Wikidata item.
async function article(p: Place): Promise<{ lead: string; qid: string } | null> {
  const res = await wiki<PagesResult>('en.wikipedia.org', {
    action: 'query',
    redirects: '1',
    prop: 'pageimages|pageprops',
    piprop: 'name',
    ppprop: 'wikibase_item|disambiguation',
    titles: articleTitle(p),
  });
  const page = res.query?.pages?.[0];
  if (!page || page.missing || page.pageprops?.disambiguation !== undefined) return null;
  return { lead: page.pageimage || '', qid: page.pageprops?.wikibase_item || '' };
}

type ClaimsResult = {
  entities?: Record<string, {
    claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>>;
  }>;
};

// Wikidata's image properties, in the order they're tried after the lead
// image: panoramic view, nighttime view, image, aerial view.
const VIEW_PROPS = ['P4291', 'P3451', 'P18', 'P8592'];

async function wikidataViews(qid: string): Promise<string[]> {
  if (!/^Q\d+$/.test(qid)) return [];
  const res = await wiki<ClaimsResult>('www.wikidata.org', {
    action: 'wbgetentities', ids: qid, props: 'claims',
  });
  const claims = res.entities?.[qid]?.claims || {};
  return VIEW_PROPS.flatMap((prop) => (claims[prop] || [])
    .map((c) => c.mainsnak?.datavalue?.value)
    .filter((v): v is string => typeof v === 'string'));
}

type InfoResult = {
  query?: {
    normalized?: Array<{ from: string; to: string }>;
    pages?: Array<{
      title: string;
      missing?: boolean;
      imageinfo?: Array<{
        width: number;
        height: number;
        mime: string;
        thumburl?: string;
        responsiveUrls?: Record<string, string>;
        descriptionurl?: string;
        extmetadata?: Record<string, { value?: unknown }>;
      }>;
    }>;
  };
};

const fileTitle = (name: string) => `File:${name.replace(/^File:/i, '').replace(/_/g, ' ').trim()}`;

// The first of `files` that makes a wallpaper, described. `strict` applies
// the shape rules; a hand-picked file only has to exist and be big enough.
async function firstUsable(files: string[], place: string, focus: number, strict: boolean): Promise<Found | null> {
  const titles = [...new Set(files.filter(Boolean).map(fileTitle))].slice(0, 12);
  if (titles.length === 0) return null;
  const res = await wiki<InfoResult>('commons.wikimedia.org', {
    action: 'query',
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: '1920',
    iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|ObjectName',
    titles: titles.join('|'),
  });
  const q = res.query || {};
  for (const t of titles) {
    const title = q.normalized?.find((n) => n.from === t)?.to ?? t;
    const info = q.pages?.find((pg) => pg.title === title && !pg.missing)?.imageinfo?.[0];
    if (!info) continue;
    const aspect = info.width / Math.max(1, info.height);
    if (info.mime !== 'image/jpeg' || info.width < MIN_WIDTH) continue;
    if (strict && (aspect < 1.3 || aspect > 2.2)) continue;
    const thumb = thumbPath(info.thumburl);
    if (!thumb) continue;
    const meta = info.extmetadata || {};
    const text = (k: string) => plain(meta[k]?.value);
    return {
      place,
      title: text('ObjectName') || title.replace(/^File:/, '').replace(/\.[a-z]+$/i, ''),
      artist: text('Artist'),
      license: text('LicenseShortName'),
      licenseUrl: text('LicenseUrl'),
      pageUrl: info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      width: info.width,
      height: info.height,
      thumb,
      thumbLarge: info.width >= 3840 ? thumbPath(info.responsiveUrls?.['2']) || '' : '',
      focus,
    };
  }
  return null;
}

// A Commons thumbnail path at one of the two widths the lookup asks for.
// Nothing in a segment may be a backslash, and the path has to be one a URL
// parser leaves as it is: fetch() reads "\" as "/" and resolves "..", which
// would otherwise walk a checked path anywhere on Wikimedia's image hosts.
const THUMB_PATH = /^\/wikipedia\/commons\/thumb\/[0-9a-f]\/[0-9a-f]{2}\/[^/?#\\]+\/(1920|3840)px-[^/?#\\]+$/;

function isThumbPath(path: string): boolean {
  if (!THUMB_PATH.test(path)) return false;
  try {
    return new URL(path, 'https://thumb.wikimedia.org').pathname === path;
  } catch {
    return false;
  }
}

function thumbPath(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/(^|\.)wikimedia\.org$/.test(u.hostname)) return null;
    return isThumbPath(u.pathname) ? u.pathname : null;
  } catch {
    return null;
  }
}

// Commons metadata is HTML ("<a href=…>Eric Kilby</a>"); keep the words.
function plain(v: unknown): string {
  if (typeof v !== 'string') return '';
  const text = v
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

async function lookup(p: Place): Promise<Found | null> {
  const label = p.st ? `${p.city}, ${p.st}` : p.city;
  const picked = CURATED[keyOf(p)];
  if (picked) {
    const photo = await firstUsable([picked.file], label, picked.focus, false);
    if (photo) return photo;
  }
  const page = await article(p);
  if (!page) return null;
  const views = page.qid ? await wikidataViews(page.qid) : [];
  return firstUsable([page.lead, ...views], label, 50, true);
}

function present(s: Found, origin: string): CityPhoto {
  const { thumb, thumbLarge, ...rest } = s;
  const img = (path: string) => `${origin}/v1/city-photo/img?p=${encodeURIComponent(path)}`;
  return { ...rest, src: img(thumb), srcLarge: thumbLarge ? img(thumbLarge) : '' };
}

export async function cityPhoto(city: string, state: string, origin: string): Promise<CityPhoto | null> {
  const asked = normalizePlace(city, state);
  if (!asked) return null;
  const alias = ALIASES[keyOf(asked)];
  const found = await lookup(alias ? fromKey(alias) : asked);
  return found ? present(found, origin) : null;
}

// GET /v1/city-photo/img?p=<image path>: the image, cached for a year.
export async function cityPhotoImage(path: string): Promise<Response> {
  if (!isThumbPath(path)) return new Response('bad path', { status: 400 });
  for (const host of ['thumb.wikimedia.org', 'upload.wikimedia.org']) {
    const up = await fetch(`https://${host}${path}`, { headers: { 'User-Agent': UA } });
    const type = up.headers.get('content-type') || '';
    if (!up.ok || !type.startsWith('image/')) continue;
    return new Response(up.body, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
  return new Response('not found', { status: 502 });
}
