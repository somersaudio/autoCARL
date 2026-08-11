import { app, dialog, shell } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Booking, ExpenseReceipt, ExpenseReport, ExpenseRow, ExpensesCache } from '../shared/types';
import { extractText } from './flight-parser';
import { parseReceiptText } from './receipt-parse';
import { fillExpensePdf, type ReceiptAttachment } from './expense-pdf';
import { readCachedBookings, readContactsCache, readSswWeeksCache } from './store';

const execFileP = promisify(execFile);

// Receipts live as flat files under userData/receipts (our own copies — the
// originals stay wherever the user dropped them from); metadata + report
// drafts live in expenses.json alongside the other caches.
const EXPENSES_FILE = 'expenses.json';
const RECEIPTS_DIR = 'receipts';

function expensesPath(): string { return join(app.getPath('userData'), EXPENSES_FILE); }
function receiptsDir(): string { return join(app.getPath('userData'), RECEIPTS_DIR); }

// Packaged: extraResources puts resources/* at Contents/Resources root.
// Dev: they sit in the repo's resources/ next to package.json.
function resourcePath(...parts: string[]): string {
  return app.isPackaged
    ? join(process.resourcesPath, ...parts)
    : join(app.getAppPath(), 'resources', ...parts);
}

export async function readExpensesCache(): Promise<ExpensesCache> {
  try {
    const raw = await fs.readFile(expensesPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return { receipts: parsed.receipts || [], reports: parsed.reports || [] };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { receipts: [], reports: [] };
    throw e;
  }
}

async function writeExpensesCache(cache: ExpensesCache): Promise<void> {
  await fs.writeFile(expensesPath(), JSON.stringify(cache, null, 2), 'utf8');
}

// ---- intake ----

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);
// Formats sips converts to JPEG on the way in (iPhone photos arrive as HEIC).
const CONVERT_EXTS = new Set(['.heic', '.heif', '.webp', '.tif', '.tiff', '.bmp']);

async function ocrImage(path: string): Promise<string> {
  try {
    const { stdout } = await execFileP(resourcePath('bin', 'receipt-ocr'), [path], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    console.warn('[expenses] OCR failed:', e instanceof Error ? e.message : e);
    return '';
  }
}

// Date-based gig match: the receipt's date falls inside a booking's range
// (±1 day for red-eyes and late checkouts). Overlapping bookings → the
// shortest range wins; no date or no hit → unassigned.
function matchBooking(date: string, bookings: Booking[]): string {
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

async function ingestOne(srcPath: string, bookings: Booking[], assignTo?: string): Promise<ExpenseReceipt | null> {
  const ext = extname(srcPath).toLowerCase();
  const id = randomUUID();
  await fs.mkdir(receiptsDir(), { recursive: true });

  let file: string;
  let kind: 'image' | 'pdf';
  let text: string;
  if (ext === '.pdf') {
    kind = 'pdf';
    file = join(receiptsDir(), `${id}.pdf`);
    await fs.copyFile(srcPath, file);
    text = await extractText(file).catch(() => '');
  } else if (IMAGE_EXTS.has(ext)) {
    kind = 'image';
    file = join(receiptsDir(), `${id}${ext === '.jpeg' ? '.jpg' : ext}`);
    await fs.copyFile(srcPath, file);
    text = await ocrImage(file);
  } else if (CONVERT_EXTS.has(ext)) {
    kind = 'image';
    file = join(receiptsDir(), `${id}.jpg`);
    await execFileP('/usr/bin/sips', ['-s', 'format', 'jpeg', srcPath, '--out', file], { timeout: 30_000 });
    text = await ocrImage(file);
  } else {
    return null;                                            // not a receipt format we know
  }

  const parsed = parseReceiptText(text, basename(srcPath));
  // The gig the user has selected in the UI wins outright — dropping a
  // receipt while a gig is chosen IS the assignment. Date-matching is the
  // fallback for the no-selection path.
  const pinned = assignTo && bookings.some((b) => b.bookingId === assignTo) ? assignTo : '';
  return {
    id,
    addedAt: new Date().toISOString(),
    file,
    originalName: basename(srcPath),
    kind,
    merchant: parsed.merchant,
    date: parsed.date,
    amount: parsed.amount,
    description: '',
    category: parsed.category,
    bookingId: pinned || matchBooking(parsed.date, bookings),
    ocrText: text,
  };
}

export async function addReceiptFiles(paths: string[], assignTo?: string): Promise<ExpensesCache> {
  const { bookings } = await readCachedBookings();
  const cache = await readExpensesCache();
  for (const p of paths) {
    const receipt = await ingestOne(p, bookings, assignTo).catch((e) => {
      console.warn('[expenses] ingest failed for', p, e instanceof Error ? e.message : e);
      return null;
    });
    if (receipt) cache.receipts.push(receipt);
  }
  await writeExpensesCache(cache);
  return cache;
}

export async function pickReceiptFiles(assignTo?: string): Promise<ExpensesCache | null> {
  const res = await dialog.showOpenDialog({
    title: 'Add receipts',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Receipts', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'tif', 'tiff', 'bmp'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return addReceiptFiles(res.filePaths, assignTo);
}

const CATEGORIES = new Set(['lodging', 'airfare', 'parking', 'carRental', 'rideshare', 'misc']);

export async function updateReceipt(id: string, patch: Partial<ExpenseReceipt>): Promise<ExpensesCache> {
  const cache = await readExpensesCache();
  const r = cache.receipts.find((x) => x.id === id);
  if (!r) return cache;
  // Field-by-field, renderer input is untrusted.
  if (typeof patch.merchant === 'string') r.merchant = patch.merchant.slice(0, 80);
  if (typeof patch.description === 'string') r.description = patch.description.slice(0, 120);
  if (typeof patch.date === 'string' && /^(\d{4}-\d{2}-\d{2})?$/.test(patch.date)) r.date = patch.date;
  if (typeof patch.amount === 'number' && isFinite(patch.amount) && patch.amount >= 0) {
    r.amount = Math.round(patch.amount * 100) / 100;
  }
  if (typeof patch.category === 'string' && CATEGORIES.has(patch.category)) r.category = patch.category;
  if (typeof patch.bookingId === 'string') r.bookingId = patch.bookingId;
  await writeExpensesCache(cache);
  return cache;
}

export async function removeReceipt(id: string): Promise<ExpensesCache> {
  const cache = await readExpensesCache();
  const r = cache.receipts.find((x) => x.id === id);
  if (r) await fs.rm(r.file, { force: true }).catch(() => {});
  cache.receipts = cache.receipts.filter((x) => x.id !== id);
  await writeExpensesCache(cache);
  return cache;
}

export async function openReceipt(id: string): Promise<void> {
  const cache = await readExpensesCache();
  const r = cache.receipts.find((x) => x.id === id);
  if (!r) return;
  const err = await shell.openPath(r.file);
  if (err) throw new Error(err);
}

// ---- report drafts ----

function emptyRow(jobNumber: string, description: string): ExpenseRow {
  return {
    jobNumber, description,
    lodging: 0, airfare: 0, parking: 0, carRental: 0,
    miles: 0, rideshare: 0, misc: 0,
    receiptIds: [],
  };
}

function todayMDY(): string {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

/**
 * Prefill a report the way the user would by hand: one row per gig, receipts
 * summed into their category columns, miles pulled off the cached timesheets
 * (SswDay.miles on days booked to that job number), identity/PM/LC/state from
 * what the app already knows. Everything stays editable in the renderer.
 */
export async function buildDraftReport(bookingIds: string[]): Promise<ExpenseReport> {
  const [{ bookings }, cache, weeks] = await Promise.all([
    readCachedBookings(), readExpensesCache(), readSswWeeksCache(),
  ]);
  await readContactsCache().catch(() => ({}));   // reserved: venue-based fields later

  const chosen = bookingIds
    .map((id) => bookings.find((b) => b.bookingId === id))
    .filter((b): b is Booking => Boolean(b));

  // Identity from the newest cached timesheet.
  const latestWeek = Object.values(weeks).sort((a, b) => b.weekStartDate.localeCompare(a.weekStartDate))[0];

  // One form line per receipt — reports are itemized, never aggregated.
  // Receipts order matches the receipts list: category (by its column
  // label, A-Z), then amount low to high.
  const CAT_ORDER = ['airfare', 'carRental', 'lodging', 'misc', 'parking', 'rideshare'];
  const rows: ExpenseRow[] = [];
  const milesCounted = new Set<string>();   // one bookingId's jobNumber = count once
  for (const b of chosen) {
    const gigReceipts = cache.receipts
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
    id: randomUUID(),
    createdAt: new Date().toISOString(),
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
    attachReceipts: true,
    rows,
  };
}

function sanitizeReport(report: ExpenseReport): ExpenseReport {
  const num = (v: unknown) => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : 0);
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    id: str(report.id, 40) || randomUUID(),
    createdAt: str(report.createdAt, 40) || new Date().toISOString(),
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
    attachReceipts: report.attachReceipts !== false,
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

export async function saveReport(report: ExpenseReport): Promise<ExpensesCache> {
  const clean = sanitizeReport(report);
  const cache = await readExpensesCache();
  // One report at a time, by design: the in-progress draft IS the report
  // list. Saving replaces whatever was there; the renderer restores it as
  // the open draft on next visit.
  cache.reports = [clean];
  await writeExpensesCache(cache);
  return cache;
}

export async function removeReport(id: string): Promise<ExpensesCache> {
  const cache = await readExpensesCache();
  cache.reports = cache.reports.filter((r) => r.id !== id);
  await writeExpensesCache(cache);
  return cache;
}

// ---- export ----

export async function exportReport(report: ExpenseReport): Promise<{ path: string } | null> {
  const clean = sanitizeReport(report);
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export expense report',
    defaultPath: join(app.getPath('downloads'), `CT Expense Report ${clean.date.replace(/\//g, '-') || 'draft'}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;

  const cache = await readExpensesCache();
  const attachments: ReceiptAttachment[] = [];
  if (clean.attachReceipts) {
    const wanted = new Set(clean.rows.flatMap((r) => r.receiptIds));
    for (const r of cache.receipts) {
      if (!wanted.has(r.id)) continue;
      try {
        attachments.push({
          bytes: new Uint8Array(await fs.readFile(r.file)),
          kind: r.kind,
          isPng: r.file.toLowerCase().endsWith('.png'),
          caption: [r.merchant, r.date, r.amount ? `$${r.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '']
            .filter(Boolean).join('  —  '),
        });
      } catch { /* stored copy missing — skip, the form itself still exports */ }
    }
  }

  const template = new Uint8Array(await fs.readFile(resourcePath('expense-template.pdf')));
  const bytes = await fillExpensePdf(template, clean, attachments);
  await fs.writeFile(filePath, bytes);
  await saveReport(clean);                        // exported = worth keeping
  shell.showItemInFolder(filePath);
  return { path: filePath };
}
