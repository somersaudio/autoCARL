import { parseItinerary, type ItineraryLeg } from '../shared/flight-itinerary';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';

// pdfjs-dist requires a worker. We resolve the bundled worker file path via
// CommonJS require so it works in Electron's main process (where there's no
// browser to spawn Web Workers).
const requireCJS = createRequire(import.meta.url);

// Extracted flight details from an itinerary PDF. All fields optional — the
// parser is heuristic and gracefully degrades when the PDF uses a layout we
// don't recognise.
export type ParsedFlights = {
  legs: ParsedLeg[];
  // Convenience aliases for the first / second leg, matching the existing
  // FlightPdf field shape.
  outboundFrom?: string;
  outboundTo?: string;
  outboundDate?: string;
  returnFrom?: string;
  returnTo?: string;
  returnDate?: string;
  legCount: number;
};

export type ParsedLeg = {
  from?: string;
  to?: string;
  date?: string;
};

// Extracts raw text from every page of a PDF on disk. Uses pdfjs-dist's
// legacy build (CommonJS-friendly) so it works in Electron's main process
// without bundler gymnastics. Exported: expenses.ts reuses it for PDF
// receipts (Uber/Lyft emailed receipts have a real text layer).
export async function extractText(localPath: string): Promise<string> {
  const buf = await fs.readFile(localPath);
  // Dynamic import keeps pdfjs out of the cold-start path for users who
  // never open a booking with flights.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Resolve the bundled worker file path. pdfjs requires a workerSrc; in
  // Node/Electron we point it at the file on disk via require.resolve.
  if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
    try {
      pdfjs.GlobalWorkerOptions.workerSrc = requireCJS.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    } catch {
      // Fallback for older pdfjs builds that ship a .js worker.
      pdfjs.GlobalWorkerOptions.workerSrc = requireCJS.resolve('pdfjs-dist/legacy/build/pdf.worker.js');
    }
  }
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
  }).promise;
  const lines: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Items come with positional info; we just want the text in reading order.
    const pageText = (content.items as Array<{ str?: string }>)
      .map((it) => (it && typeof it.str === 'string' ? it.str : ''))
      .join(' ');
    lines.push(pageText);
  }
  return lines.join('\n');
}

/**
 * Layout-aware text extraction for receipt PDFs. Some generators (Uber's
 * emailed receipts among them) atomize the text layer into one item PER
 * GLYPH, so naive item-joining yields "T o t a l $ 1 9 . 1 9" and every
 * keyword and amount pattern dies. This rebuilds visual lines from item
 * coordinates: cluster by baseline y, sort by x, and insert spaces only at
 * real horizontal gaps. Works equally for normal word-per-item PDFs.
 */
export async function extractLayoutText(localPath: string): Promise<string> {
  const buf = await fs.readFile(localPath);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
    try {
      pdfjs.GlobalWorkerOptions.workerSrc = requireCJS.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    } catch {
      pdfjs.GlobalWorkerOptions.workerSrc = requireCJS.resolve('pdfjs-dist/legacy/build/pdf.worker.js');
    }
  }
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
  }).promise;
  // The clustering itself is shared with the web build (shared/pdf-text.ts)
  // so PDFs read identically on both surfaces.
  const { extractLayoutFromPdfDoc } = await import('../shared/pdf-text');
  return extractLayoutFromPdfDoc(doc);
}

// ----- heuristic extraction -----

const AIRPORT_RE = /\b([A-Z]{3})\b/g;
const DATE_RES: RegExp[] = [
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*[,\s]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i,
  /\b\d{1,2}[-\s](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?[-\s]\d{2,4}\b/i,
];

// Common English words that signal a departure or arrival event. We use them
// to anchor where each leg starts in the document text.
const DEPART_RE = /\bdepart(?:ure|ures|ing|s)?\b/i;
const ARRIVE_RE = /\barriv(?:al|als|ing|es|e)\b/i;

// Reasonable "near" window when grouping airport+date around a keyword.
const NEAR_CHARS = 200;

function findFirstDateNear(text: string, fromIdx: number): string | undefined {
  const window = text.slice(fromIdx, fromIdx + NEAR_CHARS);
  for (const re of DATE_RES) {
    const m = window.match(re);
    if (m) return m[0];
  }
  return undefined;
}

function findFirstAirportNear(text: string, fromIdx: number): string | undefined {
  const window = text.slice(fromIdx, fromIdx + NEAR_CHARS);
  const m = window.match(AIRPORT_RE);
  if (!m) return undefined;
  // Skip common English 3-letter false positives that occur in airline docs.
  const blacklist = new Set([
    'AND', 'THE', 'FOR', 'YOU', 'PNR', 'PDF', 'PNG', 'JPG', 'USD',
    'ETA', 'EDT', 'EST', 'CST', 'CDT', 'MST', 'MDT', 'PST', 'PDT',
    'INC', 'LLC', 'WWW', 'COM', 'NET', 'ORG', 'GOV', 'TBD', 'TBA',
    'GMT', 'UTC', 'CT', 'AM', 'PM', 'JFK', // JFK is valid but keep for safety
  ]);
  for (const code of m) {
    if (!blacklist.has(code)) return code;
  }
  return undefined;
}

// Pair each "depart" anchor with the matching "arrive" that follows it, and
// collect from/to/date for each leg. The PDF reading order isn't perfect, so
// we fall back to nearby-text scans when the depart anchor doesn't yield a
// clean airport pair.
function extractLegs(text: string): ParsedLeg[] {
  const legs: ParsedLeg[] = [];
  const seenStarts = new Set<number>();
  const departIter = text.matchAll(new RegExp(DEPART_RE, 'gi'));
  for (const match of departIter) {
    const idx = match.index ?? -1;
    if (idx < 0 || seenStarts.has(idx)) continue;
    seenStarts.add(idx);
    const from = findFirstAirportNear(text, idx);
    const date = findFirstDateNear(text, Math.max(0, idx - 80)) || findFirstDateNear(text, idx);
    // Find the matching arrive AFTER this depart.
    const arriveMatch = ARRIVE_RE.exec(text.slice(idx));
    let to: string | undefined;
    if (arriveMatch) {
      const arriveIdx = idx + arriveMatch.index;
      to = findFirstAirportNear(text, arriveIdx);
    }
    legs.push({ from, to, date });
  }
  return legs;
}

// Airline-agnostic fallback: scan all 3-letter codes in order, dedupe
// consecutive runs, and treat each transition between distinct codes as a
// leg. Works for any PDF whose itinerary shows airports in travel order —
// regardless of whether it labels them "DEPARTS/ARRIVES", "Outbound/Return",
// "Going/Coming back", or just "AUS → LAS".
const AIRPORT_FALSE_POSITIVES = new Set([
  // English words that look like IATA codes
  'AND', 'THE', 'FOR', 'YOU', 'OUR', 'NOT', 'BUT', 'NEW', 'OLD', 'NON',
  'WAS', 'ARE', 'HAS', 'HAD', 'CAN', 'WHO', 'WHY', 'HOW', 'OUT', 'OFF',
  'ONE', 'TWO', 'AGE', 'AGO', 'ALL', 'ANY', 'BIG', 'BIT', 'BOX', 'BUY',
  'CAR', 'BUS', 'TAX', 'FEE', 'PIN', 'ZIP', 'SEE', 'SAY', 'SET', 'GET',
  // Common acronyms
  'USD', 'USA', 'PNR', 'PDF', 'PNG', 'JPG', 'API', 'INC', 'LLC', 'CO',
  'WWW', 'COM', 'NET', 'ORG', 'GOV', 'TBD', 'TBA', 'TBC', 'CEO', 'CFO',
  'CTO', 'COO', 'CTS', 'CTUS', 'WIFI',
  // Time zones
  'ETA', 'EDT', 'EST', 'CST', 'CDT', 'MST', 'MDT', 'PST', 'PDT',
  'GMT', 'UTC',
  // Air-travel jargon that masquerades as codes
  'AM', 'PM', 'BAG', 'PASS', 'SEAT', 'TRIP', 'TIME', 'DATE', 'GATE',
  'TAX', 'FEE',
]);

function extractLegsByAirportPairs(text: string): ParsedLeg[] {
  // 1. Collect candidate codes with their text position.
  type CodePos = { code: string; idx: number };
  const positions: CodePos[] = [];
  const seenIdx = new Set<number>();
  for (const m of text.matchAll(AIRPORT_RE)) {
    if (m.index === undefined || seenIdx.has(m.index)) continue;
    seenIdx.add(m.index);
    if (AIRPORT_FALSE_POSITIVES.has(m[1])) continue;
    positions.push({ code: m[1], idx: m.index });
  }

  // 2. Dedupe consecutive identical codes (e.g. "AUS Austin, TX - AUS"
  //    appears repeatedly within a single leg block).
  const condensed: CodePos[] = [];
  for (const p of positions) {
    if (condensed.length === 0 || condensed[condensed.length - 1].code !== p.code) {
      condensed.push(p);
    }
  }

  // 3. Each transition between distinct codes is a candidate leg. Look for
  //    a nearby date to assign as the leg's travel date.
  const legs: ParsedLeg[] = [];
  for (let i = 0; i + 1 < condensed.length; i++) {
    const from = condensed[i];
    const to = condensed[i + 1];
    if (from.code === to.code) continue;
    const start = Math.max(0, from.idx - 120);
    const end = Math.min(text.length, to.idx + 120);
    const window = text.slice(start, end);
    let date: string | undefined;
    for (const re of DATE_RES) {
      const m = window.match(re);
      if (m) { date = m[0]; break; }
    }
    legs.push({ from: from.code, to: to.code, date });
  }
  return legs;
}

// Journeys (day-level flights, connections collapsed) via the shared
// itinerary parser — the web build runs the identical code on text it
// pulls through the worker.
export async function parseItineraryLegs(localPath: string): Promise<ItineraryLeg[]> {
  try {
    const text = await extractText(localPath);
    if (!text || text.length < 20) return [];
    return parseItinerary(text).legs;
  } catch {
    return [];
  }
}

export async function parseFlightPdf(localPath: string): Promise<ParsedFlights | null> {
  try {
    const text = await extractText(localPath);
    if (!text || text.length < 20) {
      try {
        const { appendFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { app } = await import('electron');
        appendFileSync(join(app.getPath('userData'), 'autocarl-sweep.log'),
          `${new Date().toISOString()} flight-parser: extractText empty for ${localPath} (len=${text?.length ?? 0})\n`);
      } catch { /* */ }
      return null;
    }

    // Run BOTH strategies — the depart/arrive anchor pass is more accurate
    // when an airline labels its sections (Southwest's "DEPARTS AUS / ARRIVES
    // LAS"), but many airlines (Delta, United, JetBlue, American) don't use
    // those words. The airport-pair pass is airline-agnostic.
    const dedupe = (ls: ParsedLeg[]): ParsedLeg[] => {
      const key = (l: ParsedLeg) => `${l.from || ''}|${l.to || ''}`;
      const seen = new Set<string>();
      return ls.filter((l) => {
        const k = key(l);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };

    const anchorLegs = dedupe(extractLegs(text).filter((l) => l.from && l.to));
    const pairLegs = dedupe(extractLegsByAirportPairs(text));

    // Whichever strategy yields more complete legs wins. Tie-break to the
    // anchor pass since it's more semantically accurate.
    let legs: ParsedLeg[] = anchorLegs.length >= pairLegs.length ? anchorLegs : pairLegs;
    if (legs.length === 0) legs = pairLegs;

    // Cap at 4 legs — anything more is probably noise from the PDF.
    legs = legs.slice(0, 4);

    // Travel dates often live in the PDF header ("Departing 5/26/26 ...
    // Returning 6/4/26"), not adjacent to the leg blocks. Pull those
    // explicitly and assign by position when the leg-level date is missing.
    const headerOut = text.match(/\b(?:departing|outbound)[\s:]*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    const headerRet = text.match(/\b(?:returning|return|inbound)[\s:]*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (legs[0] && !legs[0].date && headerOut) legs[0].date = headerOut[1];
    if (legs[1] && !legs[1].date && headerRet) legs[1].date = headerRet[1];

    const result: ParsedFlights = {
      legs,
      legCount: legs.length,
      outboundFrom: legs[0]?.from,
      outboundTo: legs[0]?.to,
      outboundDate: legs[0]?.date,
      returnFrom: legs[1]?.from,
      returnTo: legs[1]?.to,
      returnDate: legs[1]?.date,
    };
    try {
      const { appendFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { app } = await import('electron');
      appendFileSync(join(app.getPath('userData'), 'autocarl-sweep.log'),
        `${new Date().toISOString()} flight-parser: ${localPath.split('/').pop()} → legs=${result.legCount} outFrom=${result.outboundFrom || '?'} outTo=${result.outboundTo || '?'} retFrom=${result.returnFrom || '?'} retTo=${result.returnTo || '?'}\n`);
    } catch { /* */ }
    return result;
  } catch (e) {
    try {
      const { appendFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { app } = await import('electron');
      appendFileSync(join(app.getPath('userData'), 'autocarl-sweep.log'),
        `${new Date().toISOString()} flight-parser: THROW for ${localPath}: ${e instanceof Error ? (e.stack || e.message) : String(e)}\n`);
    } catch { /* */ }
    return null;
  }
}
