import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from '@cantoo/pdf-lib';
import type { ExpenseReport, ExpenseRow } from '../shared/types';

// Fills the CT Expense Reimbursement Form. The template
// (resources/expense-template.pdf, exported once from the official Numbers
// sheet) is a FLAT pdf — no AcroForm — so every value is drawn at measured
// coordinates from shared/expense-form-layout (one source of truth with the
// renderer's on-sheet editor). Page space: 1134 × 792 pt, origin
// bottom-left (pdf-lib convention).

import {
  COL, COMMENTS_BOX as COMMENTS, FILL_PEACH, FILL_PINK, FINAL_Y, GRAND_Y, HDR,
  NOTES_BOX as NOTES, PAD_DOLLAR, PAD_RIGHT, ROW_Y, TOTALS_Y, type Col,
} from '../shared/expense-form-layout';

const PEACH = rgb(FILL_PEACH[0] / 255, FILL_PEACH[1] / 255, FILL_PEACH[2] / 255);
const PINK = rgb(FILL_PINK[0] / 255, FILL_PINK[1] / 255, FILL_PINK[2] / 255);

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

/**
 * Fill the CT form with a report and return the finished PDF bytes.
 * Rows overflow onto extra copies of the template page (10 per page);
 * column totals and grand totals land on the last form page only.
 */
export async function fillExpensePdf(
  templateBytes: Uint8Array,
  report: ExpenseReport,
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

  return doc.save();
}
