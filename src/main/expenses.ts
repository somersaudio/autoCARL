import { app, dialog, shell } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Booking, ExpenseReceipt, ExpenseReport, ExpenseRow, ExpensesCache, IngestOutcome } from '../shared/types';
import { extractLayoutText } from './flight-parser';
import { parseReceiptText } from '../shared/receipt-parse';
import { fillExpensePdf } from '../shared/expense-pdf';
import {
  BAD_FORMAT_SKIP_REASON, MAX_RECEIPT_PDF_PAGES, PAYROLL_EMAIL, applyReceiptPatch,
  assembleDraftReport, expenseMailDraft, formFileName, imageBytesToPdf, matchBooking,
  multiPageSkipReason, orderedReceipts, receiptFileName, sanitizeReport,
} from '../shared/expense-logic';
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

// macOS shows the "control Mail" consent prompt exactly ONCE per app — a
// Don't Allow can never be re-asked from code. Closest thing to a second
// chance: a dialog whose button lands the user directly on the Automation
// pane, one toggle away from fixed.
async function explainAutomationDenial(): Promise<never> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Open System Settings', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'AUTOcarl isn\'t allowed to control Mail',
    detail: 'macOS only asks once, so flip the switch by hand: System Settings → Privacy & Security → Automation → AUTOcarl → Mail. Then click Export to Mail again.',
  });
  if (response === 0) {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation');
  }
  throw new Error('Mail access is switched off for AUTOcarl — enable it under Automation, then try again.');
}

// A file refused on purpose — the message is shown to the user verbatim.
class SkipFile extends Error {}

async function ingestOne(srcPath: string, bookings: Booking[], assignTo?: string): Promise<ExpenseReceipt | null> {
  const ext = extname(srcPath).toLowerCase();
  const id = randomUUID();
  await fs.mkdir(receiptsDir(), { recursive: true });

  let file: string;
  let kind: 'image' | 'pdf';
  let text: string;
  if (ext === '.pdf') {
    // One receipt per file, enforced: a multi-page PDF is almost always a
    // combined statement of many receipts, and parsing it as one receipt
    // produces a single junk amount. Refuse it with an explanation instead.
    const bytes = new Uint8Array(await fs.readFile(srcPath));
    let pages = 1;
    try {
      const { PDFDocument: PDFDoc } = await import('@cantoo/pdf-lib');
      pages = (await PDFDoc.load(bytes, { ignoreEncryption: true })).getPageCount();
    } catch { /* unreadable structure — let text extraction have a try */ }
    if (pages > MAX_RECEIPT_PDF_PAGES) {
      throw new SkipFile(multiPageSkipReason(pages));
    }
    kind = 'pdf';
    file = join(receiptsDir(), `${id}.pdf`);
    await fs.writeFile(file, bytes);
    text = await extractLayoutText(file).catch(() => '');
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
    throw new SkipFile(BAD_FORMAT_SKIP_REASON);
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

export async function addReceiptFiles(paths: string[], assignTo?: string): Promise<IngestOutcome> {
  const { bookings } = await readCachedBookings();
  const cache = await readExpensesCache();
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const p of paths) {
    try {
      const receipt = await ingestOne(p, bookings, assignTo);
      if (receipt) cache.receipts.push(receipt);
    } catch (e) {
      const name = basename(p);
      if (e instanceof SkipFile) {
        skipped.push({ name, reason: e.message });
      } else {
        console.warn('[expenses] ingest failed for', p, e instanceof Error ? e.message : e);
        skipped.push({ name, reason: `couldn't be read (${e instanceof Error ? e.message : 'unknown error'}).` });
      }
    }
  }
  await writeExpensesCache(cache);
  return { cache, skipped };
}

export async function pickReceiptFiles(assignTo?: string): Promise<IngestOutcome | null> {
  const res = await dialog.showOpenDialog({
    title: 'Add receipts',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Receipts', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'tif', 'tiff', 'bmp'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return addReceiptFiles(res.filePaths, assignTo);
}

export async function updateReceipt(id: string, patch: Partial<ExpenseReceipt>): Promise<ExpensesCache> {
  const cache = await readExpensesCache();
  const r = cache.receipts.find((x) => x.id === id);
  if (!r) return cache;
  applyReceiptPatch(r, patch);   // field-by-field — renderer input is untrusted
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

/**
 * Prefill a report from what the app already knows. The assembly itself is
 * shared with the web build (shared/expense-logic.ts) so drafts come out
 * identical on both surfaces; this wrapper just feeds it the local caches.
 */
export async function buildDraftReport(bookingIds: string[]): Promise<ExpenseReport> {
  const [{ bookings }, cache, weeks] = await Promise.all([
    readCachedBookings(), readExpensesCache(), readSswWeeksCache(),
  ]);
  await readContactsCache().catch(() => ({}));   // reserved: venue-based fields later
  return assembleDraftReport(bookingIds, bookings, cache.receipts, weeks);
}

export async function saveReport(report: ExpenseReport): Promise<ExpensesCache> {
  const clean = sanitizeReport(report);
  const cache = await readExpensesCache();
  // One report PER GIG: saving upserts by bookingId (and by id, covering
  // reports saved before the gig link existed). Every gig's in-progress
  // report survives app restarts; the picker brings it back.
  cache.reports = [
    ...cache.reports.filter((r) => r.id !== clean.id && !(clean.bookingId && r.bookingId === clean.bookingId)),
    clean,
  ];
  await writeExpensesCache(cache);
  return cache;
}

/**
 * Clean slate for one gig: delete every receipt filed under it (stored
 * copies included) and its report. The renderer rebuilds an empty sheet
 * immediately after, so the gig returns to its untouched state.
 */
export async function resetGig(bookingId: string, reportId?: string): Promise<ExpensesCache> {
  const cache = await readExpensesCache();
  if (!bookingId && !reportId) return cache;
  for (const r of cache.receipts) {
    if (bookingId && r.bookingId === bookingId) await fs.rm(r.file, { force: true }).catch(() => {});
  }
  cache.receipts = cache.receipts.filter((r) => !bookingId || r.bookingId !== bookingId);
  cache.reports = cache.reports.filter(
    (r) => !(reportId && r.id === reportId) && !(bookingId && r.bookingId === bookingId),
  );
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

// Wrap a receipt image in a single-page letter PDF, fitted within margins.
// The PDF math is shared with the web build (shared/expense-logic.ts).
async function imageToPdf(imagePath: string, outPath: string): Promise<void> {
  const bytes = new Uint8Array(await fs.readFile(imagePath));
  await fs.writeFile(outPath, await imageBytesToPdf(bytes, imagePath.toLowerCase().endsWith('.png')));
}

/**
 * Write the export bundle into `dir`: the filled CT form PDF plus every
 * receipt referenced by the report as its own PDF — images converted, PDF
 * receipts copied — numbered in form-line order so file 03 is line 3's
 * receipt. Returns the written paths, form first.
 */
async function writeReportBundle(clean: ExpenseReport, dir: string): Promise<string[]> {
  const template = new Uint8Array(await fs.readFile(resourcePath('expense-template.pdf')));
  const formBytes = await fillExpensePdf(template, clean);
  const formPath = join(dir, formFileName(clean));
  await fs.writeFile(formPath, formBytes);
  const files = [formPath];

  const cache = await readExpensesCache();
  const ordered = orderedReceipts(clean, cache.receipts);
  let n = 0;
  for (const r of ordered) {
    n += 1;
    const name = receiptFileName(n, r);
    try {
      if (r.kind === 'pdf') await fs.copyFile(r.file, join(dir, name));
      else await imageToPdf(r.file, join(dir, name));
      files.push(join(dir, name));
    } catch (e) {
      // A missing stored copy shouldn't sink the export — the form and the
      // other receipts still land.
      console.warn('[expenses] receipt export failed:', name, e instanceof Error ? e.message : e);
    }
  }
  return files;
}

export async function exportReport(report: ExpenseReport): Promise<{ path: string } | null> {
  const clean = sanitizeReport(report);
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose a folder for the report and receipts',
    buttonLabel: 'Export Here',
    defaultPath: app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory'],
  });
  const dir = filePaths?.[0];
  if (canceled || !dir) return null;
  await writeReportBundle(clean, dir);
  await saveReport(clean);                        // exported = worth keeping
  await shell.openPath(dir);
  return { path: dir };
}

/**
 * Draft the report as an email in Apple Mail: recipients are the gig's PM
 * and LC (emails the CARL sweep scraped) plus payroll, with the form PDF
 * attached first and every receipt PDF after it, in form-line order. The
 * draft opens visible in Mail for the user to review and send — nothing is
 * sent automatically.
 */
export async function mailReport(report: ExpenseReport): Promise<void> {
  const clean = sanitizeReport(report);
  const dir = await fs.mkdtemp(join(app.getPath('temp'), 'autocarl-expense-'));
  const files = await writeReportBundle(clean, dir);

  const { bookings } = await readCachedBookings();
  const booking = bookings.find((b) => b.bookingId === clean.bookingId);
  const contacts = booking ? (await readContactsCache())[booking.bookingId] : undefined;
  const recipients = [...new Set(
    [contacts?.pmEmail, contacts?.lcEmail, PAYROLL_EMAIL].filter((e): e is string => !!e && /@/.test(e)),
  )];

  const { subject, body } = expenseMailDraft(booking ?? null, clean.name);

  // AppleScript strings understand \n; escape backslashes + quotes and
  // strip real newlines so nothing can break out of the literal.
  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ');
  const script = [
    'tell application "Mail"',
    `  set msg to make new outgoing message with properties {subject:"${esc(subject)}", content:"${body}", visible:true}`,
    '  tell msg',
    ...recipients.map((r) => `    make new to recipient at end of to recipients with properties {address:"${esc(r)}"}`),
    '    tell content',
    ...files.flatMap((f) => [
      `      make new attachment with properties {file name:POSIX file "${esc(f)}"} at after the last paragraph`,
      '      delay 0.2',
    ]),
    '    end tell',
    '  end tell',
    '  activate',
    'end tell',
  ].join('\n');
  // Users who live in Outlook or webmail may have Mail.app with no account
  // configured — drafting would dump them into Mail's setup wizard with a
  // cryptic failure. Check first and explain, pointing at the folder export.
  try {
    const { stdout } = await execFileP('/usr/bin/osascript', ['-e', 'tell application "Mail" to count of accounts'], { timeout: 20_000 });
    if (parseInt(stdout.trim(), 10) === 0) {
      throw new Error('Apple Mail has no email account set up on this Mac. Add one in Mail → Settings → Accounts, or use Export to Folder and attach the files in the mail app you normally use.');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/-1743|not authori[sz]ed/i.test(msg)) {
      await explainAutomationDenial();
    }
    if (/no email account/i.test(msg)) throw e;
    // Any other pre-check hiccup: fall through and let the draft attempt
    // speak for itself rather than blocking on a flaky probe.
    console.warn('[expenses] Mail account pre-check inconclusive:', msg);
  }

  const scriptPath = join(dir, 'mail.applescript');
  await fs.writeFile(scriptPath, script, 'utf8');
  try {
    await execFileP('/usr/bin/osascript', [scriptPath], { timeout: 60_000 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/-1743|not authori[sz]ed/i.test(msg)) {
      await explainAutomationDenial();
    }
    throw new Error(`Couldn't create the Mail draft: ${msg}`);
  }
  await saveReport(clean);                        // mailed = worth keeping
}
