import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from '@cantoo/pdf-lib';
import type { ExpenseReport, ExpenseRow } from '../shared/types';

// Fills the CT Expense Reimbursement Form. The template
// (resources/expense-template.pdf, exported once from the official Numbers
// sheet) is a FLAT pdf — no AcroForm — so every value is drawn at measured
// coordinates. The numbers below were extracted programmatically from the
// template's own text items and grid lines (pdfjs text positions + raster
// line detection); if the template asset is ever regenerated, re-run that
// measurement rather than nudging constants by eye.
//
// Page space: 1134 × 792 pt, origin bottom-left (pdf-lib convention).

type Col = { l: number; r: number };

// Vertical grid lines of the expense table.
const COL: Record<string, Col> = {
  job:       { l: 80.0,  r: 224.8 },
  desc:      { l: 224.8, r: 331.8 },
  lodging:   { l: 331.8, r: 410.8 },
  airfare:   { l: 410.8, r: 491.8 },
  parking:   { l: 491.8, r: 596.8 },
  carRental: { l: 596.8, r: 677.8 },
  miles:     { l: 677.8, r: 758.8 },
  mileage:   { l: 758.8, r: 839.8 },   // computed: miles × rate
  rideshare: { l: 839.8, r: 924.8 },   // "Uber/Lyft/Taxi"
  misc:      { l: 924.8, r: 990.8 },
  total:     { l: 990.8, r: 1059.8 },
};

// Text baselines of the ten data rows, top to bottom (measured off the
// template's seeded "$ -" placeholders in the Mileage column).
const ROW_Y = [439.6, 424.5, 407.5, 390.4, 373.3, 356.2, 339.1, 322.0, 304.9, 287.8];
const TOTALS_Y = 270.7;   // pink per-column totals row
const GRAND_Y = 253.6;    // pink grand-total cell under the Misc column
const FINAL_Y = 219.4;    // pink reimbursement-total cell beside NOTES

// The template's own accounting format: "$" sits 5.8pt in from the cell's
// left line, the amount right-aligns 13.7pt in from the right line.
const PAD_DOLLAR = 5.8;
const PAD_RIGHT = 13.7;

// Header-field baselines (left-aligned into the gray/blue boxes).
const HDR = {
  date:       { x: 229.0, y: 614.4 },
  name:       { x: 229.0, y: 563.1 },
  employeeId: { x: 229.0, y: 546.6 },
  pm:         { x: 600.5, y: 563.1 },
  lc:         { x: 600.5, y: 530.8 },
  state:      { x: 229.0, y: 512.5 },
  country:    { x: 229.0, y: 495.4 },
};

const COMMENTS = { x: 229.0, y: 236.3, maxWidth: 178, lineHeight: 11, maxLines: 5 };
const NOTES =    { x: 496.5, y: 236.3, maxWidth: 424, lineHeight: 11, maxLines: 5 };

// Cell fills, sampled from the template raster — placeholder "$ -" glyphs are
// baked into the flat pdf, so cells we write get repainted in their own fill
// color first.
const PEACH = rgb(248 / 255, 203 / 255, 173 / 255);
const PINK = rgb(255 / 255, 153 / 255, 255 / 255);

const SIZE_CELL = 8.5;
const SIZE_HDR = 9;

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Repaint a cell's interior (grid lines stay untouched) to cover seeded "$ -".
function cover(page: PDFPage, col: Col, baseline: number, fill: ReturnType<typeof rgb>): void {
  page.drawRectangle({
    x: col.l + 1.2,
    y: baseline - 3.6,
    width: col.r - col.l - 2.4,
    height: 13.2,
    color: fill,
  });
}

// Accounting-style money cell: template-matching "$" at the left, amount
// right-aligned. Zero writes nothing — the blank form look stays.
function writeMoney(page: PDFPage, font: PDFFont, col: Col, baseline: number, amount: number, coverFill?: ReturnType<typeof rgb>): void {
  if (!amount) return;
  if (coverFill) cover(page, col, baseline, coverFill);
  page.drawText('$', { x: col.l + PAD_DOLLAR, y: baseline, size: SIZE_CELL, font });
  const s = fmtMoney(amount);
  page.drawText(s, { x: col.r - PAD_RIGHT - font.widthOfTextAtSize(s, SIZE_CELL), y: baseline, size: SIZE_CELL, font });
}

function writeCentered(page: PDFPage, font: PDFFont, col: Col, baseline: number, text: string): void {
  if (!text) return;
  const w = font.widthOfTextAtSize(text, SIZE_CELL);
  page.drawText(text, { x: (col.l + col.r) / 2 - w / 2, y: baseline, size: SIZE_CELL, font });
}

// Left-aligned text shrunk-to-fit by truncation with an ellipsis.
function writeClipped(page: PDFPage, font: PDFFont, x: number, baseline: number, text: string, maxWidth: number, size: number): void {
  if (!text) return;
  let s = text;
  while (s && font.widthOfTextAtSize(s, size) > maxWidth) s = s.slice(0, -1);
  if (s !== text) s = `${s.slice(0, -1)}…`;
  page.drawText(s, { x, y: baseline, size, font });
}

// Simple word wrap for the comments / notes boxes.
function writeWrapped(page: PDFPage, font: PDFFont, box: typeof COMMENTS, text: string): void {
  if (!text) return;
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const attempt = cur ? `${cur} ${word}` : word;
    if (font.widthOfTextAtSize(attempt, SIZE_CELL) <= box.maxWidth) { cur = attempt; continue; }
    lines.push(cur);
    cur = word;
    if (lines.length >= box.maxLines) break;
  }
  if (cur && lines.length < box.maxLines) lines.push(cur);
  lines.forEach((line, i) => {
    page.drawText(line, { x: box.x, y: box.y - i * box.lineHeight, size: SIZE_CELL, font });
  });
}

export function mileageDollars(row: ExpenseRow, rate: number): number {
  return Math.round(row.miles * rate * 100) / 100;
}

export function rowTotal(row: ExpenseRow, rate: number): number {
  return row.lodging + row.airfare + row.parking + row.carRental + mileageDollars(row, rate) + row.rideshare + row.misc;
}

// One receipt to append after the form. Images get their own captioned page;
// PDFs are merged in verbatim.
export type ReceiptAttachment = {
  bytes: Uint8Array;
  kind: 'image' | 'pdf';
  isPng: boolean;           // images only — picks embedPng vs embedJpg
  caption: string;          // "Hampton Inn — 2026-09-06 — $1,332.20 (CTLA025403)"
};

/**
 * Fill the CT form with a report and return the finished PDF bytes.
 * Rows overflow onto extra copies of the template page (10 per page);
 * column totals and grand totals land on the last form page only.
 */
export async function fillExpensePdf(
  templateBytes: Uint8Array,
  report: ExpenseReport,
  attachments: ReceiptAttachment[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(templateBytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const rows = report.rows;

  // Extra form pages for overflow, copied from the pristine template.
  const pageCount = Math.max(1, Math.ceil(rows.length / ROW_Y.length));
  for (let p = 1; p < pageCount; p++) {
    const donor = await PDFDocument.load(templateBytes);
    const [copied] = await doc.copyPages(donor, [0]);
    doc.addPage(copied);
  }

  const rate = report.mileageRate;
  for (let p = 0; p < pageCount; p++) {
    const page = doc.getPage(p);

    // Header fields repeat on every page so continuations stand alone.
    writeClipped(page, font, HDR.date.x, HDR.date.y, report.date, 175, SIZE_HDR);
    writeClipped(page, font, HDR.name.x, HDR.name.y, report.name, 175, SIZE_HDR);
    writeClipped(page, font, HDR.employeeId.x, HDR.employeeId.y, report.employeeId, 175, SIZE_HDR);
    writeClipped(page, font, HDR.pm.x, HDR.pm.y, report.projectManager, 155, SIZE_HDR);
    writeClipped(page, font, HDR.lc.x, HDR.lc.y, report.laborCoordinator, 155, SIZE_HDR);
    writeClipped(page, font, HDR.state.x, HDR.state.y, report.stateWorkedIn, 175, SIZE_HDR);
    writeClipped(page, font, HDR.country.x, HDR.country.y, report.countryWorkedIn, 175, SIZE_HDR);

    const pageRows = rows.slice(p * ROW_Y.length, (p + 1) * ROW_Y.length);
    pageRows.forEach((row, i) => {
      const y = ROW_Y[i];
      writeCentered(page, font, COL.job, y, row.jobNumber);
      writeClipped(page, font, COL.desc.l + 4, y, row.description, COL.desc.r - COL.desc.l - 8, SIZE_CELL);
      writeMoney(page, font, COL.lodging, y, row.lodging);
      writeMoney(page, font, COL.airfare, y, row.airfare);
      writeMoney(page, font, COL.parking, y, row.parking);
      writeMoney(page, font, COL.carRental, y, row.carRental);
      if (row.miles) writeCentered(page, font, COL.miles, y, String(row.miles));
      writeMoney(page, font, COL.mileage, y, mileageDollars(row, rate), PEACH);
      writeMoney(page, font, COL.rideshare, y, row.rideshare);
      writeMoney(page, font, COL.misc, y, row.misc);
      writeMoney(page, font, COL.total, y, rowTotal(row, rate), PINK);
    });
  }

  // Column + grand totals on the last form page.
  const last = doc.getPage(pageCount - 1);
  const sum = (f: (r: ExpenseRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  writeMoney(last, font, COL.lodging, TOTALS_Y, sum((r) => r.lodging), PINK);
  writeMoney(last, font, COL.airfare, TOTALS_Y, sum((r) => r.airfare), PINK);
  writeMoney(last, font, COL.parking, TOTALS_Y, sum((r) => r.parking), PINK);
  writeMoney(last, font, COL.carRental, TOTALS_Y, sum((r) => r.carRental), PINK);
  writeMoney(last, font, COL.mileage, TOTALS_Y, sum((r) => mileageDollars(r, rate)), PINK);
  writeMoney(last, font, COL.rideshare, TOTALS_Y, sum((r) => r.rideshare), PINK);
  writeMoney(last, font, COL.misc, TOTALS_Y, sum((r) => r.misc), PINK);
  const grand = sum((r) => rowTotal(r, rate));
  writeMoney(last, font, COL.misc, GRAND_Y, grand, PINK);
  writeMoney(last, font, COL.misc, FINAL_Y, grand, PINK);
  writeWrapped(last, font, COMMENTS, report.comments);
  writeWrapped(last, font, NOTES, report.notes);

  // Receipts, appended after the form pages.
  for (const att of attachments) {
    try {
      if (att.kind === 'pdf') {
        const donor = await PDFDocument.load(att.bytes);
        const copied = await doc.copyPages(donor, donor.getPageIndices());
        for (const pg of copied) doc.addPage(pg);
        continue;
      }
      const img = att.isPng ? await doc.embedPng(att.bytes) : await doc.embedJpg(att.bytes);
      const page = doc.addPage([612, 792]);   // letter portrait
      const maxW = 612 - 72;
      const maxH = 792 - 108;                 // room for the caption line
      const scale = Math.min(maxW / img.width, maxH / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: (612 - w) / 2, y: 792 - 36 - h, width: w, height: h });
      page.drawText(att.caption, {
        x: 36, y: 30, size: 10, font, color: rgb(0.25, 0.25, 0.25),
      });
    } catch (e) {
      // A single unreadable receipt shouldn't sink the whole export.
      console.warn('[expenses] skipped attachment:', e instanceof Error ? e.message : e);
    }
  }

  return doc.save();
}
