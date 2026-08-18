// Pure expense-report logic shared by the desktop main process
// (src/main/expenses.ts) and the web shim (src/web/api-shim.ts), so both
// surfaces assign receipts, sanitize input, and assemble drafts identically.
// Everything here is string/array arithmetic — no Node, no DOM, no Electron.

import type {
  Booking, ExpenseReceipt, ExpenseReport, ExpenseRow, SswWeek,
} from './types';

export const CATEGORIES = new Set(['lodging', 'airfare', 'parking', 'carRental', 'rideshare', 'misc']);

// The form's own column order — receipts lists and report rows follow it.
export const CAT_ORDER = ['lodging', 'airfare', 'parking', 'carRental', 'rideshare', 'misc'];

export const FILE_LABEL: Record<string, string> = {
  lodging: 'Lodging', airfare: 'Airfare', parking: 'Parking',
  carRental: 'Car Rental', rideshare: 'Uber-Lyft-Taxi', misc: 'Misc',
};

// A single receipt legitimately runs a page or three (Uber's PDFs add a
// trip-details page). Bigger stacks read as many receipts in one file.
export const MAX_RECEIPT_PDF_PAGES = 3;

export function multiPageSkipReason(pages: number): string {
  return `has ${pages} pages — that looks like several receipts combined into one file. Add each receipt as its own photo or PDF so every line gets the right amount.`;
}

export const BAD_FORMAT_SKIP_REASON =
  `isn't a format the app can read — use a photo (JPG, PNG, HEIC) or a PDF.`;

// Date-based gig match: the receipt's date falls inside a booking's range
// (±1 day for red-eyes and late checkouts). Overlapping bookings → the
// shortest range wins; no date or no hit → unassigned.
export function matchBooking(date: string, bookings: Booking[]): string {
  if (!date) return '';
  const t = new Date(`${date}T12:00:00`).getTime();
  const DAY = 86400_000;
  let best: Booking | null = null;
  let bestSpan = Infinity;
  for (const b of bookings) {
    const start = new Date(`${b.startDate}T00:00:00`).getTime() - DAY;
    const end = new Date(`${b.endDate}T23:59:59`).getTime() + DAY;
    if (t < start || t > end) continue;
    const span = end - start;
    if (span < bestSpan) { best = b; bestSpan = span; }
  }
  return best?.bookingId || '';
}

export function emptyRow(jobNumber: string, description: string): ExpenseRow {
  return {
    jobNumber, description,
    lodging: 0, airfare: 0, parking: 0, carRental: 0,
    miles: 0, rideshare: 0, misc: 0,
    receiptIds: [],
  };
}

export function todayMDY(): string {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

/**
 * Prefill a report the way the user would by hand: one form line per receipt
 * (itemized, never aggregated), ordered by the form's column order then
 * amount ascending; miles pulled off the cached timesheets (SswDay.miles on
 * days booked to that job number) as their own line; identity/PM/LC/state
 * from what the app already knows. Everything stays editable in the UI.
 */
export function assembleDraftReport(
  bookingIds: string[],
  bookings: Booking[],
  receipts: ExpenseReceipt[],
  weeks: Record<string, SswWeek>,
): ExpenseReport {
  const chosen = bookingIds
    .map((id) => bookings.find((b) => b.bookingId === id))
    .filter((b): b is Booking => Boolean(b));

  // Identity from the newest cached timesheet.
  const latestWeek = Object.values(weeks).sort((a, b) => b.weekStartDate.localeCompare(a.weekStartDate))[0];

  const rows: ExpenseRow[] = [];
  const milesCounted = new Set<string>();   // one bookingId's jobNumber = count once
  for (const b of chosen) {
    const gigReceipts = receipts
      .filter((r) => r.bookingId === b.bookingId && r.amount > 0)
      .sort((x, y) => CAT_ORDER.indexOf(x.category) - CAT_ORDER.indexOf(y.category) || x.amount - y.amount);
    for (const r of gigReceipts) {
      const row = emptyRow(b.jobNumber, r.description || '');
      row[r.category] = r.amount;
      row.receiptIds.push(r.id);
      rows.push(row);
    }
    // Timesheet miles get their own line — there's no receipt for driving.
    if (!milesCounted.has(b.jobNumber)) {
      milesCounted.add(b.jobNumber);
      let miles = 0;
      for (const week of Object.values(weeks)) {
        for (const day of week.days) {
          if (day.job === b.jobNumber && day.miles) miles += day.miles;
        }
      }
      if (miles > 0) {
        const row = emptyRow(b.jobNumber, '');
        row.miles = miles;
        rows.push(row);
      }
    }
  }

  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    bookingId: chosen[0]?.bookingId ?? '',
    date: todayMDY(),
    name: latestWeek?.name || '',
    // SSW's employeeId field actually stores the user's EMAIL; the numeric
    // CT id — what the form wants — is userId (the header's "ID 10634").
    employeeId: latestWeek?.userId || '',
    projectManager: uniq(chosen.map((b) => b.projectManager)).join(' / '),
    laborCoordinator: uniq(chosen.map((b) => b.laborCoordinator)).join(' / '),
    stateWorkedIn: uniq(chosen.map((b) => b.state)).join(', '),
    countryWorkedIn: 'USA',
    mileageRate: 0.70,
    comments: '',
    notes: '',
    rows,
  };
}

// Field-by-field receipt patch — UI input is untrusted. Mutates `r`.
export function applyReceiptPatch(r: ExpenseReceipt, patch: Partial<ExpenseReceipt>): void {
  if (typeof patch.merchant === 'string') r.merchant = patch.merchant.slice(0, 80);
  if (typeof patch.description === 'string') r.description = patch.description.slice(0, 120);
  if (typeof patch.date === 'string' && /^(\d{4}-\d{2}-\d{2})?$/.test(patch.date)) r.date = patch.date;
  if (typeof patch.amount === 'number' && isFinite(patch.amount) && patch.amount >= 0) {
    r.amount = Math.round(patch.amount * 100) / 100;
  }
  if (typeof patch.category === 'string' && CATEGORIES.has(patch.category)) r.category = patch.category;
  if (typeof patch.bookingId === 'string') r.bookingId = patch.bookingId;
}

export function sanitizeReport(report: ExpenseReport): ExpenseReport {
  const num = (v: unknown) => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : 0);
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    id: str(report.id, 40) || crypto.randomUUID(),
    createdAt: str(report.createdAt, 40) || new Date().toISOString(),
    bookingId: str(report.bookingId, 64),
    date: str(report.date, 20),
    name: str(report.name, 60),
    employeeId: str(report.employeeId, 30),
    projectManager: str(report.projectManager, 80),
    laborCoordinator: str(report.laborCoordinator, 80),
    stateWorkedIn: str(report.stateWorkedIn, 60),
    countryWorkedIn: str(report.countryWorkedIn, 60),
    mileageRate: typeof report.mileageRate === 'number' && isFinite(report.mileageRate) && report.mileageRate >= 0
      ? Math.min(report.mileageRate, 10) : 0.70,
    comments: str(report.comments, 600),
    notes: str(report.notes, 1200),
    rows: (Array.isArray(report.rows) ? report.rows : []).slice(0, 60).map((r) => ({
      jobNumber: str(r.jobNumber, 20),
      description: str(r.description, 120),
      lodging: num(r.lodging), airfare: num(r.airfare), parking: num(r.parking),
      carRental: num(r.carRental), rideshare: num(r.rideshare), misc: num(r.misc),
      miles: typeof r.miles === 'number' && isFinite(r.miles) && r.miles >= 0 ? Math.round(r.miles) : 0,
      receiptIds: (Array.isArray(r.receiptIds) ? r.receiptIds : []).filter((x) => typeof x === 'string').slice(0, 100),
    })),
  };
}

// The expense email itself — recipients' shape and the message template are
// shared so the desktop Mail draft and the phone's compose card say exactly
// the same thing.
export const PAYROLL_EMAIL = 'payroll@ctus.com';

// Sign-off with the first name alone: SSW writes names "Somers, John", and
// a paycheck-style full name reads stiff at the bottom of an email.
function firstName(n: string): string {
  const t = n.trim();
  const m = t.match(/^[^,]+,\s*(.+)$/);
  return ((m ? m[1] : t).trim().split(/\s+/)[0] || t);
}

export function expenseMailDraft(
  booking: { jobNumber: string; jobName: string } | null,
  name: string,
): { subject: string; body: string } {
  const showLabel = booking ? `${booking.jobName} (${booking.jobNumber})` : 'the show';
  const subject = booking
    ? `Expense Report - ${booking.jobNumber} ${booking.jobName} - ${name}`
    : `Expense Report - ${name}`;
  const body = `Attached is my expense report for ${showLabel}, with the receipts.\n\nThanks,\n${firstName(name)}\n\n`;
  return { subject, body };
}

export function safeName(s: string): string {
  return s.replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

// The exported bundle's filenames, identical on both surfaces: the filled
// form first, then receipts numbered in form-line order so file 03 is
// line 3's receipt.
export function formFileName(report: ExpenseReport): string {
  return `CT Expense Report ${safeName(report.date.replace(/\//g, '-')) || 'draft'}.pdf`;
}

export function receiptFileName(n: number, r: ExpenseReceipt): string {
  const desc = (r.description || r.merchant || '').trim();
  return safeName(
    `Receipt ${String(n).padStart(2, '0')} - ${FILE_LABEL[r.category] || 'Receipt'} $${r.amount.toFixed(2)}`
    + (desc ? ` - ${desc.slice(0, 40)}` : ''),
  ) + '.pdf';
}

// Receipts referenced by the report, in form-line order.
export function orderedReceipts(report: ExpenseReport, receipts: ExpenseReceipt[]): ExpenseReceipt[] {
  const out: ExpenseReceipt[] = [];
  for (const row of report.rows) {
    for (const id of row.receiptIds) {
      const r = receipts.find((x) => x.id === id);
      if (r) out.push(r);
    }
  }
  return out;
}

// Wrap a receipt image in a single-page letter PDF, fitted within margins.
// Takes and returns bytes — the caller owns all I/O.
export async function imageBytesToPdf(bytes: Uint8Array, isPng: boolean): Promise<Uint8Array> {
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const doc = await PDFDocument.create();
  const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const page = doc.addPage([612, 792]);
  const maxW = 612 - 72;
  const maxH = 792 - 72;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = img.width * scale;
  const h = img.height * scale;
  page.drawImage(img, { x: (612 - w) / 2, y: (792 - h) / 2, width: w, height: h });
  return doc.save();
}
