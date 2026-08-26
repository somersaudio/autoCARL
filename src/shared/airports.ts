// City → nearest major airport (IATA), for the travel ribbon on job cards.
//
// A lookup table rather than an API: it's instant, works offline, needs no
// key, and live-events crews cycle through a predictable set of convention
// cities. Unknown cities fall back to the city name, so nothing breaks — the
// ribbon just says "Tulsa" instead of "TUL".

// Cities whose name alone is ambiguous (Portland OR/ME, Columbus OH/GA…).
// Keyed "city|ST" and checked first.
const BY_CITY_STATE: Record<string, string> = {
  'portland|OR': 'PDX', 'portland|ME': 'PWM',
  'columbus|OH': 'CMH', 'columbus|GA': 'CSG',
  'charleston|SC': 'CHS', 'charleston|WV': 'CRW',
  'springfield|IL': 'SPI', 'springfield|MO': 'SGF', 'springfield|MA': 'BDL',
  'kansas city|MO': 'MCI', 'kansas city|KS': 'MCI',
  'aurora|CO': 'DEN', 'aurora|IL': 'ORD',
  'glendale|AZ': 'PHX', 'glendale|CA': 'BUR',
  'richmond|VA': 'RIC', 'richmond|CA': 'SFO',
  'pasadena|CA': 'LAX', 'pasadena|TX': 'IAH',
  'arlington|VA': 'DCA', 'arlington|TX': 'DFW',
  'cambridge|MA': 'BOS',
  'greenville|SC': 'GSP', 'greenville|NC': 'PGV',
  'jackson|MS': 'JAN', 'jackson|WY': 'JAC',
  'auburn|AL': 'ATL', 'auburn|WA': 'SEA',
  // CARL's city token is a bare name, so these can only be told apart by
  // state — a compound key like 'hollywood beach' would never match.
  'hollywood|FL': 'FLL', 'wilmington|NC': 'ILM', 'wilmington|DE': 'PHL',
  'manchester|GB': 'MAN', 'manchester|UK': 'MAN', 'manchester|EN': 'MAN',
};

// Unique-enough city names. Suburbs map to the airport people actually fly.
const BY_CITY: Record<string, string> = {
  // ---- California ----
  'san francisco': 'SFO', 'south san francisco': 'SFO', 'burlingame': 'SFO',
  'daly city': 'SFO', 'napa': 'SFO', 'berkeley': 'OAK', 'oakland': 'OAK',
  'san jose': 'SJC', 'santa clara': 'SJC', 'mountain view': 'SJC',
  'palo alto': 'SJC', 'sunnyvale': 'SJC', 'cupertino': 'SJC',
  'menlo park': 'SFO', 'redwood city': 'SFO', 'san mateo': 'SFO',
  'santa cruz': 'SJC', 'monterey': 'MRY', 'sacramento': 'SMF',
  'los angeles': 'LAX', 'hollywood': 'LAX', 'century city': 'LAX',
  'santa monica': 'LAX', 'culver city': 'LAX', 'inglewood': 'LAX',
  'el segundo': 'LAX', 'beverly hills': 'LAX', 'universal city': 'BUR',
  'burbank': 'BUR', 'anaheim': 'SNA', 'irvine': 'SNA', 'costa mesa': 'SNA',
  'newport beach': 'SNA', 'long beach': 'LGB', 'san diego': 'SAN',
  'carlsbad': 'SAN', 'coronado': 'SAN', 'la jolla': 'SAN', 'chula vista': 'SAN',
  'palm springs': 'PSP', 'palm desert': 'PSP', 'rancho mirage': 'PSP',
  'indian wells': 'PSP', 'ontario': 'ONT', 'riverside': 'ONT',
  'santa barbara': 'SBA', 'fresno': 'FAT', 'bakersfield': 'BFL',
  // ---- Nevada / Arizona / Utah / Colorado ----
  'las vegas': 'LAS', 'henderson': 'LAS', 'paradise': 'LAS', 'reno': 'RNO',
  'phoenix': 'PHX', 'scottsdale': 'PHX', 'tempe': 'PHX', 'mesa': 'PHX',
  'chandler': 'PHX', 'tucson': 'TUS', 'sedona': 'PHX',
  'salt lake city': 'SLC', 'park city': 'SLC', 'provo': 'SLC',
  'denver': 'DEN', 'broomfield': 'DEN', 'boulder': 'DEN', 'englewood': 'DEN',
  'colorado springs': 'COS', 'aspen': 'ASE', 'vail': 'EGE', 'avon': 'EGE',
  // ---- Texas ----
  'austin': 'AUS', 'round rock': 'AUS', 'san antonio': 'SAT',
  'dallas': 'DFW', 'fort worth': 'DFW', 'irving': 'DFW', 'plano': 'DFW',
  'frisco': 'DFW', 'grapevine': 'DFW', 'richardson': 'DFW', 'addison': 'DFW',
  'houston': 'IAH', 'the woodlands': 'IAH', 'sugar land': 'IAH',
  'galveston': 'IAH', 'el paso': 'ELP', 'corpus christi': 'CRP',
  // ---- Northeast ----
  'boston': 'BOS', 'foxborough': 'BOS', 'quincy': 'BOS', 'somerville': 'BOS',
  'new york': 'JFK', 'manhattan': 'JFK', 'brooklyn': 'JFK', 'queens': 'JFK',
  'bronx': 'JFK', 'long island city': 'LGA', 'white plains': 'HPN',
  'newark': 'EWR', 'jersey city': 'EWR', 'atlantic city': 'ACY',
  'stamford': 'LGA', 'hartford': 'BDL', 'new haven': 'BDL',
  'providence': 'PVD', 'newport': 'PVD', 'portsmouth': 'MHT',
  'manchester': 'MHT', 'burlington': 'BTV', 'albany': 'ALB',
  'syracuse': 'SYR', 'rochester': 'ROC', 'buffalo': 'BUF',
  'philadelphia': 'PHL', 'king of prussia': 'PHL', 'wilmington': 'PHL',
  'pittsburgh': 'PIT', 'harrisburg': 'MDT', 'allentown': 'ABE',
  'baltimore': 'BWI', 'national harbor': 'DCA', 'washington': 'DCA',
  'bethesda': 'DCA', 'alexandria': 'DCA', 'reston': 'IAD', 'herndon': 'IAD',
  'tysons': 'IAD', 'mclean': 'IAD',
  // ---- Southeast ----
  'atlanta': 'ATL', 'marietta': 'ATL', 'alpharetta': 'ATL', 'athens': 'ATL',
  'savannah': 'SAV', 'augusta': 'AGS', 'macon': 'MCN',
  'orlando': 'MCO', 'kissimmee': 'MCO', 'lake buena vista': 'MCO',
  'miami': 'MIA', 'miami beach': 'MIA', 'coral gables': 'MIA',
  'fort lauderdale': 'FLL', 'boca raton': 'FLL',
  'west palm beach': 'PBI', 'palm beach': 'PBI', 'tampa': 'TPA',
  'st petersburg': 'TPA', 'clearwater': 'TPA', 'sarasota': 'SRQ',
  'fort myers': 'RSW', 'naples': 'RSW', 'jacksonville': 'JAX',
  'key west': 'EYW', 'tallahassee': 'TLH', 'gainesville': 'GNV',
  'daytona beach': 'DAB', 'charlotte': 'CLT', 'raleigh': 'RDU',
  'durham': 'RDU', 'cary': 'RDU', 'greensboro': 'GSO', 'asheville': 'AVL',
  'columbia': 'CAE', 'myrtle beach': 'MYR',
  'hilton head': 'HHH', 'nashville': 'BNA', 'knoxville': 'TYS',
  'chattanooga': 'CHA', 'memphis': 'MEM', 'louisville': 'SDF',
  'lexington': 'LEX', 'birmingham': 'BHM', 'huntsville': 'HSV',
  'montgomery': 'MGM', 'mobile': 'MOB', 'new orleans': 'MSY',
  'baton rouge': 'BTR', 'shreveport': 'SHV', 'little rock': 'LIT',
  'norfolk': 'ORF', 'virginia beach': 'ORF', 'williamsburg': 'PHF',
  // ---- Midwest ----
  'chicago': 'ORD', 'rosemont': 'ORD', 'schaumburg': 'ORD', 'evanston': 'ORD',
  'oak brook': 'ORD', 'naperville': 'ORD', 'mccormick place': 'ORD',
  'detroit': 'DTW', 'dearborn': 'DTW', 'ann arbor': 'DTW',
  'grand rapids': 'GRR', 'traverse city': 'TVC',
  'minneapolis': 'MSP', 'st paul': 'MSP', 'bloomington': 'MSP',
  'milwaukee': 'MKE', 'green bay': 'GRB', 'madison': 'MSN',
  'indianapolis': 'IND', 'fort wayne': 'FWA', 'south bend': 'SBN',
  'cleveland': 'CLE', 'akron': 'CAK', 'cincinnati': 'CVG', 'dayton': 'DAY',
  'toledo': 'TOL', 'st louis': 'STL', 'omaha': 'OMA', 'lincoln': 'LNK',
  'des moines': 'DSM', 'cedar rapids': 'CID', 'wichita': 'ICT',
  'oklahoma city': 'OKC', 'tulsa': 'TUL', 'fargo': 'FAR', 'sioux falls': 'FSD',
  // ---- Northwest / Pacific ----
  'seattle': 'SEA', 'bellevue': 'SEA', 'redmond': 'SEA', 'tacoma': 'SEA',
  'kirkland': 'SEA', 'spokane': 'GEG', 'boise': 'BOI', 'eugene': 'EUG',
  'billings': 'BIL', 'bozeman': 'BZN', 'missoula': 'MSO',
  'anchorage': 'ANC', 'honolulu': 'HNL', 'maui': 'OGG', 'kona': 'KOA',
  'albuquerque': 'ABQ', 'santa fe': 'ABQ', 'san juan': 'SJU',
  // ---- International ----
  'toronto': 'YYZ', 'vancouver': 'YVR', 'montreal': 'YUL', 'calgary': 'YYC',
  'ottawa': 'YOW', 'edmonton': 'YEG', 'mexico city': 'MEX', 'cancun': 'CUN',
  'guadalajara': 'GDL', 'monterrey': 'MTY', 'london': 'LHR', 'paris': 'CDG',
  'amsterdam': 'AMS', 'frankfurt': 'FRA', 'munich': 'MUC', 'berlin': 'BER',
  'hamburg': 'HAM', 'cologne': 'CGN', 'dusseldorf': 'DUS', 'stuttgart': 'STR',
  'barcelona': 'BCN', 'madrid': 'MAD', 'lisbon': 'LIS', 'rome': 'FCO',
  'milan': 'MXP', 'venice': 'VCE', 'florence': 'FLR', 'dublin': 'DUB',
  'edinburgh': 'EDI', 'zurich': 'ZRH',
  'geneva': 'GVA', 'vienna': 'VIE', 'brussels': 'BRU', 'copenhagen': 'CPH',
  'stockholm': 'ARN', 'oslo': 'OSL', 'helsinki': 'HEL', 'prague': 'PRG',
  'warsaw': 'WAW', 'budapest': 'BUD', 'istanbul': 'IST', 'dubai': 'DXB',
  'abu dhabi': 'AUH', 'doha': 'DOH', 'riyadh': 'RUH', 'tel aviv': 'TLV',
  'singapore': 'SIN', 'hong kong': 'HKG', 'tokyo': 'NRT', 'osaka': 'KIX',
  'seoul': 'ICN', 'shanghai': 'PVG', 'beijing': 'PEK', 'taipei': 'TPE',
  'bangkok': 'BKK', 'mumbai': 'BOM', 'delhi': 'DEL', 'bangalore': 'BLR',
  'sydney': 'SYD', 'melbourne': 'MEL', 'brisbane': 'BNE', 'auckland': 'AKL',
  'sao paulo': 'GRU', 'rio de janeiro': 'GIG', 'buenos aires': 'EZE',
  'santiago': 'SCL', 'lima': 'LIM', 'bogota': 'BOG', 'panama city': 'PTY',
};

function normalize(city: string): string {
  return city
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\bsaint\b/g, 'st')
    .replace(/\s+/g, ' ')
    .trim();
}

// The IATA code for a city, or null when we don't know it.
export function airportFor(city: string | undefined, state?: string): string | null {
  const c = normalize(city || '');
  if (!c) return null;
  const st = (state || '').trim().toUpperCase().slice(0, 2);
  return BY_CITY_STATE[`${c}|${st}`] ?? BY_CITY[c] ?? null;
}

// What to print for a place: its airport code, else the city itself, else ''.
export function placeLabel(city: string | undefined, state?: string): string {
  return airportFor(city, state) || (city || '').trim();
}

// Accepts anything the user types in Settings and keeps it only if it looks
// like an IATA code.
export function cleanAirportCode(raw: string): string {
  const up = (raw || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  return up.length === 3 ? up : '';
}
