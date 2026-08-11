import type { ExpenseCategory } from '../shared/types';

// Heuristic extraction of merchant / date / amount / category from raw
// receipt text (Vision OCR for photos, pdfjs text for PDF receipts). Pure
// string-in, fields-out — no Electron imports — so it stays trivially
// testable and reusable. Every field degrades gracefully: the user can fix
// anything in the receipt list, so a wrong guess costs one click.

export type ParsedReceipt = {
  merchant: string;
  date: string;              // ISO YYYY-MM-DD, '' when nothing plausible found
  amount: number;            // 0 when nothing plausible found
  category: ExpenseCategory;
};

// Category signals, most-specific first. Rideshare outranks everything —
// "Uber" receipts also mention totals/airports/hotels in dropoff addresses.
const CATEGORY_RULES: Array<{ cat: ExpenseCategory; merchant?: string; re: RegExp }> = [
  { cat: 'rideshare', merchant: 'Uber', re: /\buber\b/i },
  { cat: 'rideshare', merchant: 'Lyft', re: /\blyft\b/i },
  { cat: 'rideshare', re: /\b(taxi|curb|yellow cab|checker cab)\b/i },
  { cat: 'carRental', re: /\b(hertz|avis|enterprise rent|budget rent|national car|alamo|sixt|turo|car rental|rental agreement)\b/i },
  { cat: 'airfare', re: /\b(delta|united airlines|american airlines|southwest|alaska air|jetblue|spirit air|frontier air|hawaiian air|e-?ticket|eticket|airline|airfare)\b/i },
  { cat: 'parking', re: /\b(parking|garage|spothero|parkmobile|laz\b|valet)\b/i },
  { cat: 'lodging', re: /\b(hotel|inn\b|marriott|hilton|hyatt|sheraton|westin|holiday inn|hampton|courtyard|residence inn|embassy suites|doubletree|airbnb|resort|suites|motel|lodge|check-?in|check-?out|room \d|nightly rate)\b/i },
];

const MONEY = /\$?\s?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\b/g;

// Lines whose amount is the one that matters. "Subtotal" is explicitly not a
// total; Uber's "Trip fare" is also pre-fees, so totals win over it.
const TOTAL_LINE = /\b(grand total|amount due|balance due|total charged|total paid|payment received|total)\b/i;
const NOT_TOTAL = /\b(sub-?total|total savings|total items|total qty)\b/i;

// Reward/credit noise. Uber prints "$2.24 / Uber One credits earned" right
// beside the total, and Vision's line order for that two-column layout is
// unstable — the credits amount can land directly AFTER the "Total" label
// while the real total lands BEFORE it. So any amount whose own line OR a
// neighboring line talks about earned credits/rewards is disqualified.
const KILL_NEAR = /\b(credits? earned|uber (one|cash) credits?|rewards?|cash ?back|points earned|you saved|savings)\b/i;
// Card-authorization scrawl ("AX AUTH: 172272 $45.80 ...") — the auth amount
// can differ from the printed total; never read money off these lines.
const KILL_LINE = /\b(auth|authoriz)/i;

// Positive dollar amounts on a line. Amounts preceded by a minus (applied
// credits/refunds, "-$4.41") are not charges and are skipped.
function moneyIn(line: string): number[] {
  const out: number[] = [];
  for (const m of line.matchAll(MONEY)) {
    const before = line.slice(0, m.index).trimEnd().slice(-1);
    if (before === '-' || before === '−' || before === '(') continue;
    out.push(parseFloat(`${m[1].replace(/,/g, '')}.${m[2]}`));
  }
  return out;
}

// Pick the amount that is most plausibly the receipt's total. OCR of
// two-column receipts interleaves labels and values in unreliable order, so
// instead of trusting sequence, every candidate amount is scored by the
// company it keeps:
//   100  a total keyword on its own line
//    60  a total-keyword label on the line directly above or below
//    50  a "Payments" anchor on the line above (Uber repeats the total there)
//     0  nothing — falls back to the largest surviving amount
// Ties go to the larger amount (a total is never smaller than a line item).
function parseAmount(lines: string[]): number {
  type Cand = { amount: number; i: number };
  const cands: Cand[] = [];
  lines.forEach((line, i) => {
    if (KILL_LINE.test(line)) return;
    for (const amount of moneyIn(line)) {
      if (amount > 0) cands.push({ amount, i });
    }
  });
  const nearKill = (i: number) =>
    KILL_NEAR.test(lines[i])
    || (i > 0 && KILL_NEAR.test(lines[i - 1]))
    || (i + 1 < lines.length && KILL_NEAR.test(lines[i + 1]));
  const alive = cands.filter((c) => !nearKill(c.i));
  const pool = alive.length ? alive : cands;
  if (!pool.length) return 0;

  const isTotalLabel = (s: string) => TOTAL_LINE.test(s) && !NOT_TOTAL.test(s);
  let best = pool[0];
  let bestScore = -1;
  for (const c of pool) {
    let score = 0;
    if (isTotalLabel(lines[c.i])) score = 100;
    else if (
      (c.i > 0 && isTotalLabel(lines[c.i - 1]))
      || (c.i + 1 < lines.length && isTotalLabel(lines[c.i + 1]))
    ) score = 60;
    else if (c.i > 0 && /\bpayments?\b/i.test(lines[c.i - 1])) score = 50;
    if (score > bestScore || (score === bestScore && c.amount > best.amount)) {
      best = c;
      bestScore = score;
    }
  }
  if (bestScore > 0) return best.amount;
  return Math.max(...pool.map((c) => c.amount));
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y: number, m: number, d: number): string {
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// A receipt date is plausible if it's within roughly the last 13 months or
// a couple of months out (hotel folios can carry future checkout dates).
function plausible(isoDate: string): boolean {
  if (!isoDate) return false;
  const t = new Date(`${isoDate}T12:00:00`).getTime();
  const now = Date.now();
  return t > now - 400 * 86400_000 && t < now + 60 * 86400_000;
}

function parseDate(text: string): string {
  const candidates: string[] = [];
  // 09/06/2026, 9-6-26
  for (const m of text.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/g)) {
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    candidates.push(iso(y, parseInt(m[1], 10), parseInt(m[2], 10)));
  }
  // 2026-09-06
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    candidates.push(iso(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)));
  }
  // September 6, 2026 / Sep 6 2026
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})\b/g)) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) candidates.push(iso(parseInt(m[3], 10), mo, parseInt(m[2], 10)));
  }
  // 6 September 2026
  for (const m of text.matchAll(/\b(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})\b/g)) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) candidates.push(iso(parseInt(m[3], 10), mo, parseInt(m[1], 10)));
  }
  return candidates.find(plausible) || '';
}

// Lines that can't be a merchant name: greetings, urls, order numbers,
// addresses, card lines. The first surviving line wins — receipts lead with
// the business name.
const NOT_MERCHANT = /\b(receipt|invoice|thank|thanks|welcome|order|customer|copy|www\.|http|@|visa|mastercard|amex|debit|credit|cash|change due|tel:|phone|fax)\b/i;

function parseMerchant(lines: string[]): string {
  for (const line of lines.slice(0, 8)) {
    const letters = (line.match(/[A-Za-z]/g) || []).length;
    if (letters < 3 || line.length > 48) continue;
    if (NOT_MERCHANT.test(line)) continue;
    if (/^\d/.test(line.trim())) continue;                  // street numbers, dates
    return line.trim();
  }
  return '';
}

export function parseReceiptText(text: string, originalName: string): ParsedReceipt {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const haystack = `${originalName}\n${text}`;

  let category: ExpenseCategory = 'misc';
  let merchant = '';
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(haystack)) {
      category = rule.cat;
      if (rule.merchant) merchant = rule.merchant;
      break;
    }
  }
  if (!merchant) merchant = parseMerchant(lines);
  if (!merchant) merchant = originalName.replace(/\.[a-z0-9]+$/i, '');

  return {
    merchant,
    date: parseDate(text),
    amount: parseAmount(lines),
    category,
  };
}
