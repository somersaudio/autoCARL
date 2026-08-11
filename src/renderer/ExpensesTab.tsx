import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Booking, ExpenseCategory, ExpenseReceipt, ExpenseReport, ExpenseRow, ExpensesCache,
} from '../shared/types';
import { friendlyError } from '../shared/errors';
import {
  COL, COMMENTS_BOX, FINAL_Y, GRAND_Y, HDR, NOTES_BOX, PAGE, ROWS_PER_PAGE, ROW_Y, TOTALS_Y, type Col,
} from '../shared/expense-form-layout';
import sheetPng from './assets/expense-sheet@2x.png';

// The Expense Reports tab: drop receipts in, the app reads them (on-device
// OCR for photos, text extraction for PDF receipts), sorts them into the CT
// form's categories, matches them to gigs by date — then builds the official
// CT Expense Reimbursement Form as a PDF, with the receipts attached as
// pages. Every parsed value stays editable; the OCR is a head start, not an
// authority.

type Props = { bookings: Booking[] };

const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  lodging: 'Lodging',
  airfare: 'Airfare',
  parking: 'Parking',
  carRental: 'Car Rental',
  rideshare: 'Uber/Lyft/Taxi',
  misc: 'Misc.',
};

const MONEY_COLS = ['lodging', 'airfare', 'parking', 'carRental', 'rideshare', 'misc'] as const;

function usd(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// "9/6 – 9/11" from a pair of ISO dates, for the gig-picker hover tooltips.
function fmtRange(start: string, end: string): string {
  const f = (iso: string) => {
    const [, m, d] = iso.split('-');
    return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
  };
  return start === end ? f(start) : `${f(start)} – ${f(end)}`;
}

function mileageDollars(row: ExpenseRow, rate: number): number {
  return Math.round(row.miles * rate * 100) / 100;
}

function rowTotal(row: ExpenseRow, rate: number): number {
  return MONEY_COLS.reduce((a, k) => a + row[k], 0) + mileageDollars(row, rate);
}

export default function ExpensesTab({ bookings }: Props) {
  const [cache, setCache] = useState<ExpensesCache | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ExpenseReport | null>(null);
  const [selectedGig, setSelectedGig] = useState('');
  const [armedId, setArmedId] = useState<string | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const armTimer = useRef<number | null>(null);
  // The form renders at 1134pt native and scales down to whatever width the
  // card offers, so the whole sheet is visible at the default window size.
  const sheetWrapRef = useRef<HTMLDivElement | null>(null);
  const [sheetScale, setSheetScale] = useState(1);

  useEffect(() => {
    window.api.expenses.getCached().then(setCache)
      .catch((e) => setError(friendlyError(e, !navigator.onLine)));
  }, []);

  // Default the gig dropdown to the most recent gig holding receipts (falling
  // back to the most recent gig). Runs until something is selected, then
  // leaves the user's choice alone.
  useEffect(() => {
    if (selectedGig || !cache || !bookings.length) return;
    // Default to the newest gig that has anything going — receipts or a
    // saved report — else simply the newest gig.
    const busy = new Set([
      ...cache.receipts.map((r) => r.bookingId),
      ...cache.reports.map((r) => draftGigId(r)),
    ].filter(Boolean));
    const sorted = bookings.slice().sort((a, b) => b.startDate.localeCompare(a.startDate));
    const pick = sorted.find((b) => busy.has(b.bookingId)) || sorted[0];
    if (pick) setSelectedGig(pick.bookingId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGig, cache, bookings]);

  // The picker drives the workspace: switching gigs swaps in that gig's
  // saved report (or none). Same-gig runs are left alone so in-flight edits
  // and auto-saves never get clobbered.
  useEffect(() => {
    if (!cache || !selectedGig) return;
    if (draft && draftGigId(draft) === selectedGig) return;
    const rep = cache.reports.find((r) => draftGigId(r) === selectedGig) || null;
    // Reports saved before the gig link existed get stamped on open —
    // without this, deleting every row erases the report's inferred
    // identity mid-edit and this effect resurrects the stale saved copy.
    setDraft(rep && !rep.bookingId ? { ...rep, bookingId: selectedGig } : rep);
    setExportedPath(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGig, cache]);

  // Draft edits persist automatically (debounced) so flipping to Timesheet to
  // check something doesn't throw away a half-adjusted report.
  useEffect(() => {
    if (!draft) return;
    const t = window.setTimeout(() => {
      window.api.expenses.saveReport(draft).then(setCache).catch(() => {});
    }, 700);
    return () => window.clearTimeout(t);
  }, [draft]);

  useEffect(() => {
    const el = sheetWrapRef.current;
    if (!el) return;
    const measure = () => setSheetScale(Math.min(1, el.clientWidth / PAGE.width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [draft?.id]);

  const bookingById = useMemo(() => {
    const m = new Map<string, Booking>();
    for (const b of bookings) m.set(b.bookingId, b);
    return m;
  }, [bookings]);

  // The gig a report belongs to: the stored link, with a jobNumber fallback
  // for reports saved before the link existed.
  const draftGigId = (rep: ExpenseReport): string => {
    if (rep.bookingId) return rep.bookingId;
    for (const row of rep.rows) {
      const b = bookings.find((x) => x.jobNumber && x.jobNumber === row.jobNumber);
      if (b) return b.bookingId;
    }
    return '';
  };

  const receipts = cache?.receipts ?? [];

  // The picker at the top of the tab is the single source of truth for
  // which gig receipts get filed under and shown for.
  const activeBookingId = selectedGig;

  // The selected gig's brand logo fronts the picker (same lookup the
  // booking cards use); falls back to a plain "Gig" label.
  const [gigLogo, setGigLogo] = useState<string | null>(null);
  useEffect(() => {
    const b = bookingById.get(selectedGig);
    if (!b) { setGigLogo(null); return; }
    let cancelled = false;
    window.api.logo.forJob(b.jobName)
      .then((uri) => { if (!cancelled) setGigLogo(uri); })
      .catch(() => { if (!cancelled) setGigLogo(null); });
    return () => { cancelled = true; };
  }, [selectedGig, bookingById]);

  // Mirror a receipt change into the open draft. Rows and receipts are 1:1
  // — every receipt owns exactly one form line — so: a fresh drop appends a
  // line, an edit updates its line in place, a deletion takes the line with
  // it. `before` null = freshly dropped; `after` null = deleted.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const syncDraft = (before: ExpenseReceipt | null, after: ExpenseReceipt | null) => {
    setDraft((d) => {
      if (!d) return d;
      const rows = d.rows.slice();
      if (before) {
        const i = rows.findIndex((r) => r.receiptIds.includes(before.id));
        if (i < 0) return d;                    // not on this draft
        if (!after) {                           // deleted → its line goes too
          rows.splice(i, 1);
          return { ...d, rows };
        }
        const r = { ...rows[i] };
        r[before.category] = Math.max(0, round2(r[before.category] - before.amount));
        r[after.category] = round2(r[after.category] + after.amount);
        // The receipt's description box authors the line; sheet-side edits
        // survive unless the receipt's own description actually changed.
        if (before.description !== after.description) r.description = after.description;
        rows[i] = r;
        return { ...d, rows };
      }
      if (after) {                              // fresh drop → new line
        const b = bookings.find((x) => x.bookingId === after.bookingId);
        if (!b || draftGigId(d) !== after.bookingId) return d;
        rows.push({
          jobNumber: b.jobNumber,
          description: after.description || '',
          lodging: 0, airfare: 0, parking: 0, carRental: 0,
          miles: 0, rideshare: 0, misc: 0,
          [after.category]: after.amount,
          receiptIds: [after.id],
        });
        return { ...d, rows };
      }
      return d;
    });
  };

  // ---- intake ----

  const ingest = async (paths: string[]) => {
    if (!paths.length) return;
    setBusy(true);
    setError(null);
    try {
      const prevIds = new Set(receipts.map((r) => r.id));
      const c = await window.api.expenses.addFiles(paths, activeBookingId || undefined);
      setCache(c);
      for (const r of c.receipts) if (!prevIds.has(r.id)) syncDraft(null, r);
    } catch (e) {
      setError(friendlyError(e, !navigator.onLine));
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => { try { return window.api.expenses.pathForFile(f); } catch { return ''; } })
      .filter(Boolean);
    void ingest(paths);
  };

  const browse = async () => {
    setBusy(true);
    setError(null);
    try {
      const prevIds = new Set(receipts.map((r) => r.id));
      const c = await window.api.expenses.pickFiles(activeBookingId || undefined);
      if (c) {
        setCache(c);
        for (const r of c.receipts) if (!prevIds.has(r.id)) syncDraft(null, r);
      }
    } catch (e) {
      setError(friendlyError(e, !navigator.onLine));
    } finally {
      setBusy(false);
    }
  };

  // ---- receipt edits ----

  const patchReceipt = (id: string, patch: Partial<ExpenseReceipt>) => {
    const before = receipts.find((r) => r.id === id) || null;
    window.api.expenses.updateReceipt(id, patch).then((c) => {
      setCache(c);
      const after = c.receipts.find((r) => r.id === id) || null;
      if (before && after) syncDraft(before, after);
    }).catch(() => {});
  };

  const armRemove = (id: string) => {
    if (armedId === id) {
      if (armTimer.current) window.clearTimeout(armTimer.current);
      setArmedId(null);
      const before = receipts.find((r) => r.id === id) || null;
      window.api.expenses.removeReceipt(id).then((c) => {
        setCache(c);
        if (before) syncDraft(before, null);
      }).catch(() => {});
      return;
    }
    setArmedId(id);
    if (armTimer.current) window.clearTimeout(armTimer.current);
    armTimer.current = window.setTimeout(() => setArmedId(null), 3500);
  };

  // ---- report drafting ----

  const buildDraft = async () => {
    if (!selectedGig || !bookingById.has(selectedGig)) return;
    setError(null);
    try {
      setDraft(await window.api.expenses.buildDraft([selectedGig]));
      setExportedPath(null);
    } catch (e) {
      setError(friendlyError(e, !navigator.onLine));
    }
  };

  const patchDraft = (patch: Partial<ExpenseReport>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  const patchRow = (i: number, patch: Partial<ExpenseRow>) => {
    setDraft((d) => {
      if (!d) return d;
      const rows = d.rows.slice();
      rows[i] = { ...rows[i], ...patch };
      return { ...d, rows };
    });
  };

  const exportPdf = async () => {
    if (!draft) return;
    setExportBusy(true);
    setError(null);
    try {
      const res = await window.api.expenses.exportReport(draft);
      if (res) {
        setExportedPath(res.path);
        setCache(await window.api.expenses.getCached());
      }
    } catch (e) {
      setError(friendlyError(e, !navigator.onLine));
    } finally {
      setExportBusy(false);
    }
  };

  const discardDraft = () => {
    if (!draft) return;
    window.api.expenses.removeReport(draft.id).then((c) => {
      setCache(c);
      setDraft(null);
      setExportedPath(null);
    }).catch(() => {});
  };

  // ---- receipts for display ----
  // Reports are always per-gig, so the list shows just the active gig's
  // receipts — switching the dropdown switches the list. Receipts from
  // before this flow (no gig recorded) surface below with a one-click adopt.
  const activeBooking = bookingById.get(activeBookingId);
  // Category A→Z (as labeled), then price low→high within each category.
  const receiptOrder = (a: ExpenseReceipt, b: ExpenseReceipt) =>
    CATEGORY_LABEL[a.category].localeCompare(CATEGORY_LABEL[b.category]) || a.amount - b.amount;
  const activeReceipts = receipts.filter((r) => r.bookingId === activeBookingId).sort(receiptOrder);
  const unassigned = receipts.filter((r) => !r.bookingId).sort(receiptOrder);

  // Adopt a gig-less receipt onto the active gig — and into the open
  // report, exactly as if it had just been dropped.
  const adoptReceipt = (id: string) => {
    if (!activeBookingId) return;
    window.api.expenses.updateReceipt(id, { bookingId: activeBookingId }).then((c) => {
      setCache(c);
      const after = c.receipts.find((r) => r.id === id) || null;
      if (after) syncDraft(null, after);
    }).catch(() => {});
  };

  const gigOptions = useMemo(
    () => bookings.slice().sort((a, b) => b.startDate.localeCompare(a.startDate)),
    [bookings],
  );

  const receiptCountFor = (bookingId: string) => receipts.filter((r) => r.bookingId === bookingId).length;

  if (!cache) {
    return <div className="expenses"><p className="subtle">{error ?? 'Loading…'}</p></div>;
  }

  return (
    <div className="expenses">
      {error && <div className="banner error">{error}</div>}

      {/* ---- gig picker: everything below follows this choice ---- */}
      <div className="card exp-gig-bar">
        {gigLogo
          ? <img src={gigLogo} alt="" className="exp-gig-logo" />
          : <span className="exp-gig-label subtle">Gig</span>}
        <select
          className="exp-in exp-gig-select"
          value={selectedGig}
          onChange={(e) => setSelectedGig(e.target.value)}
          // Hovering the closed control shows the selected gig's dates —
          // same-named bookings (split for billing) tell apart this way
          // without cluttering the labels.
          title={(() => {
            const b = bookingById.get(selectedGig);
            return b ? `${b.jobNumber} · ${fmtRange(b.startDate, b.endDate)}` : undefined;
          })()}
        >
          {gigOptions.length === 0 && <option value="">No gigs on the calendar yet</option>}
          {gigOptions.map((b) => {
            const n = receiptCountFor(b.bookingId);
            const hasReport = (cache?.reports ?? []).some((r) => draftGigId(r) === b.bookingId);
            return (
              <option
                key={b.bookingId}
                value={b.bookingId}
                title={`${b.jobNumber} · ${fmtRange(b.startDate, b.endDate)}`}
              >
                {b.jobName}{n > 0 ? ` · ${n} receipt${n === 1 ? '' : 's'}` : ''}{hasReport ? ' · report' : ''}
              </option>
            );
          })}
        </select>
      </div>

      {/* ---- receipt intake ---- */}
      <div
        className={`card exp-drop ${dragOver ? 'is-over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className="exp-drop-title">{busy ? 'Reading receipts…' : 'Drop receipts here'}</div>
        <button className="secondary" onClick={browse} disabled={busy}>Browse…</button>
      </div>

      {/* ---- receipt list: the active gig's receipts only ---- */}
      {(activeReceipts.length > 0 || unassigned.length > 0) && (
        <div className="card">
          <h3>
            Receipts
            {activeBooking && (
              <><span className="subtle"> — </span><span className="exp-h-gig">{activeBooking.jobNumber} · {activeBooking.jobName}</span></>
            )}
          </h3>
          {activeReceipts.map((r) => (
            <ReceiptRow key={r.id} r={r} armedId={armedId}
              onPatch={patchReceipt} onRemove={armRemove} />
          ))}
          {activeReceipts.length === 0 && (
            <div className="subtle exp-hint">None on this gig yet — drop some above.</div>
          )}
          {unassigned.length > 0 && (
            <>
              <div className="exp-group-h">From before — not on a gig</div>
              {unassigned.map((r) => (
                <ReceiptRow key={r.id} r={r} armedId={armedId}
                  onPatch={patchReceipt} onRemove={armRemove}
                  onAdopt={activeBooking ? () => adoptReceipt(r.id) : undefined}
                  adoptLabel={activeBooking ? `add to ${activeBooking.jobNumber}` : undefined} />
              ))}
            </>
          )}
        </div>
      )}

      {/* ---- report builder / editor ---- */}
      {!(draft && draftGigId(draft) === selectedGig) ? (
        <div className="card">
          <h3>New Expense Report</h3>
          <div className="subtle exp-hint">
            This gig's receipts fill the form's columns — one line each — and miles
            come from your timesheets. Everything is editable before export.
          </div>
          <div className="exp-actions">
            <button className="primary" onClick={buildDraft} disabled={!selectedGig || !bookingById.has(selectedGig)}>
              Build report
            </button>
          </div>
        </div>
      ) : (
        <div className="card">
          <h3>CT Expense Reimbursement Form</h3>
          <div className="sheet-wrap" ref={sheetWrapRef}>
            {(() => {
              const pages = Math.max(1, Math.ceil(draft.rows.length / ROWS_PER_PAGE));
              return Array.from({ length: pages }, (_, p) => (
                <FormSheet
                  key={`${draft.id}-p${p}`}
                  draft={draft}
                  startIndex={p * ROWS_PER_PAGE}
                  isFirst={p === 0}
                  isLast={p === pages - 1}
                  scale={sheetScale}
                  onPatchDraft={patchDraft}
                  onPatchRow={patchRow}
                  onRemoveRow={(gi) => patchDraft({ rows: draft.rows.filter((_, k) => k !== gi) })}
                />
              ));
            })()}
          </div>
          <div className="exp-actions">
            <button className="primary" onClick={exportPdf} disabled={exportBusy}>
              {exportBusy ? 'Exporting…' : 'Export Report & Receipts'}
            </button>
            <button className="link exp-x" onClick={discardDraft}>Delete report</button>
            {exportedPath && <span className="subtle exp-exported">Exported — folder opened</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// One receipt line: what it is, what it cost, nothing else — the gig is
// implied by the card it sits in. Unassigned leftovers get an adopt link.
function ReceiptRow({ r, armedId, onPatch, onRemove, onAdopt, adoptLabel }: {
  r: ExpenseReceipt;
  armedId: string | null;
  onPatch: (id: string, patch: Partial<ExpenseReceipt>) => void;
  onRemove: (id: string) => void;
  onAdopt?: () => void;
  adoptLabel?: string;
}) {
  return (
    <div className="exp-receipt-row" title={r.merchant ? `${r.merchant} — ${r.originalName}` : r.originalName}>
      <select
        className="exp-in exp-in-cat"
        value={r.category}
        onChange={(e) => onPatch(r.id, { category: e.target.value as ExpenseCategory })}
      >
        {Object.entries(CATEGORY_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
      </select>
      <input
        className="exp-in exp-in-amount"
        defaultValue={r.amount ? r.amount.toFixed(2) : ''}
        placeholder="0.00"
        inputMode="decimal"
        onBlur={(e) => {
          const v = parseFloat(e.target.value.replace(/[$,]/g, ''));
          if (isFinite(v) && v >= 0 && v !== r.amount) onPatch(r.id, { amount: v });
        }}
      />
      <input
        className="exp-in exp-in-desc"
        defaultValue={r.description || ''}
        placeholder="Description/Reason"
        onBlur={(e) => { if (e.target.value !== (r.description || '')) onPatch(r.id, { description: e.target.value }); }}
      />
      {onAdopt && <button className="link exp-adopt" onClick={onAdopt}>{adoptLabel}</button>}
      <button className="link exp-view" title="Open receipt" onClick={() => window.api.expenses.openReceipt(r.id)}>view</button>
      <button
        className={`link exp-x ${armedId === r.id ? 'is-armed' : ''}`}
        title={armedId === r.id ? 'Click again to delete' : 'Delete receipt'}
        onClick={() => onRemove(r.id)}
      >{armedId === r.id ? 'sure?' : '×'}</button>
    </div>
  );
}

// ---------- the on-sheet form editor ----------
//
// The report is edited ON the actual CT form: a raster of the same template
// the export stamps (assets/expense-sheet@2x.png, displayed 1134×792 so CSS
// px map 1:1 onto PDF points) with edit fields absolutely positioned inside
// the form's own cells via shared/expense-form-layout. What you see here is
// what fillExpensePdf produces, cell for cell.

// Baseline (PDF, origin bottom-left) → CSS top for a 17px-tall field.
const SHEET_FIELD_OFFSET = 12.5;
function sheetTop(y: number): number {
  return PAGE.height - y - SHEET_FIELD_OFFSET;
}

function fmt2(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// A computed (read-only) money cell, painted in the cell's own fill so the
// template's seeded "$ -" underneath disappears — mirrors export's cover().
function SheetComputed({ col, y, amount, pink }: { col: Col; y: number; amount: number; pink?: boolean }) {
  if (!amount) return null;
  return (
    <span
      className={`sheet-cell ${pink ? 'is-pink' : 'is-peach'}`}
      style={{ left: col.l + 1.5, top: sheetTop(y) - 1, width: col.r - col.l - 3 }}
    >
      <span>$</span><span>{fmt2(amount)}</span>
    </span>
  );
}

function SheetMoneyInput({ col, y, value, onCommit }: {
  col: Col; y: number; value: number; onCommit: (v: number) => void;
}) {
  return (
    <input
      key={`v${value}`}
      className="sheet-in sheet-in-right"
      style={{ left: col.l + 2, top: sheetTop(y), width: col.r - col.l - 14 }}
      defaultValue={value ? value.toFixed(2) : ''}
      inputMode="decimal"
      onBlur={(e) => {
        const v = parseFloat(e.target.value.replace(/[$,]/g, ''));
        const next = isFinite(v) && v >= 0 ? v : 0;
        // Same-value blurs are dropped — a reused input unmounting during a
        // row splice must not commit its stale contents into the row that
        // shifted under it.
        if (next !== value) onCommit(next);
      }}
    />
  );
}

function FormSheet({ draft, startIndex, isFirst, isLast, scale, onPatchDraft, onPatchRow, onRemoveRow }: {
  draft: ExpenseReport;
  startIndex: number;
  isFirst: boolean;
  isLast: boolean;
  scale: number;
  onPatchDraft: (patch: Partial<ExpenseReport>) => void;
  onPatchRow: (i: number, patch: Partial<ExpenseRow>) => void;
  onRemoveRow: (i: number) => void;
}) {
  const rate = draft.mileageRate;
  const rows = draft.rows.slice(startIndex, startIndex + ROWS_PER_PAGE);
  const sum = (f: (r: ExpenseRow) => number) => draft.rows.reduce((a, r) => a + f(r), 0);
  const grand = draft.rows.reduce((a, r) => a + rowTotal(r, rate), 0);

  // Header fields edit on the first sheet; continuation sheets mirror them
  // read-only (the export repeats them on every page).
  const hdr = (key: keyof typeof HDR, width: number, value: string, patch: (v: string) => void) => {
    const { x, y } = HDR[key];
    return isFirst ? (
      <input
        className="sheet-in"
        style={{ left: x - 2, top: sheetTop(y), width }}
        value={value}
        onChange={(e) => patch(e.target.value)}
      />
    ) : (
      <span className="sheet-static" style={{ left: x, top: sheetTop(y) }}>{value}</span>
    );
  };

  const MONEY: Array<[Col, keyof Pick<ExpenseRow, 'lodging' | 'airfare' | 'parking' | 'carRental' | 'rideshare' | 'misc'>]> = [
    [COL.lodging, 'lodging'], [COL.airfare, 'airfare'], [COL.parking, 'parking'],
    [COL.carRental, 'carRental'], [COL.rideshare, 'rideshare'], [COL.misc, 'misc'],
  ];

  return (
    <div className="sheet-outer" style={{ height: PAGE.height * scale + 14 }}>
    <div className="sheet" style={{ backgroundImage: `url(${sheetPng})`, transform: `scale(${scale})` }}>
      {hdr('date', 182, draft.date, (v) => onPatchDraft({ date: v }))}
      {hdr('name', 182, draft.name, (v) => onPatchDraft({ name: v }))}
      {hdr('employeeId', 182, draft.employeeId, (v) => onPatchDraft({ employeeId: v }))}
      {hdr('pm', 160, draft.projectManager, (v) => onPatchDraft({ projectManager: v }))}
      {hdr('lc', 160, draft.laborCoordinator, (v) => onPatchDraft({ laborCoordinator: v }))}
      {hdr('state', 182, draft.stateWorkedIn, (v) => onPatchDraft({ stateWorkedIn: v }))}
      {hdr('country', 182, draft.countryWorkedIn, (v) => onPatchDraft({ countryWorkedIn: v }))}

      {rows.map((row, i) => {
        const gi = startIndex + i;
        const y = ROW_Y[i];
        return (
          <span key={row.receiptIds[0] ? `rc-${row.receiptIds[0]}` : `m-${gi}`}>
            <input
              key={`j${row.jobNumber}`}
              className="sheet-in sheet-in-center"
              style={{ left: COL.job.l + 2, top: sheetTop(y), width: COL.job.r - COL.job.l - 4 }}
              defaultValue={row.jobNumber}
              onBlur={(e) => { if (e.target.value !== row.jobNumber) onPatchRow(gi, { jobNumber: e.target.value }); }}
            />
            <input
              key={`d${row.description}`}
              className="sheet-in"
              style={{ left: COL.desc.l + 3, top: sheetTop(y), width: COL.desc.r - COL.desc.l - 6 }}
              defaultValue={row.description}
              onBlur={(e) => { if (e.target.value !== row.description) onPatchRow(gi, { description: e.target.value }); }}
            />
            {MONEY.map(([col, k]) => (
              <SheetMoneyInput key={k} col={col} y={y} value={row[k]}
                onCommit={(v) => onPatchRow(gi, { [k]: v } as Partial<ExpenseRow>)} />
            ))}
            <input
              key={`m${row.miles}`}
              className="sheet-in sheet-in-center"
              style={{ left: COL.miles.l + 2, top: sheetTop(y), width: COL.miles.r - COL.miles.l - 4 }}
              defaultValue={row.miles || ''}
              inputMode="numeric"
              title={row.miles ? `Mileage: $${fmt2(mileageDollars(row, rate))}` : 'Miles driven'}
              onBlur={(e) => {
                const v = parseInt(e.target.value, 10);
                const next = isFinite(v) && v >= 0 ? v : 0;
                if (next !== row.miles) onPatchRow(gi, { miles: next });
              }}
            />
            <SheetComputed col={COL.mileage} y={y} amount={mileageDollars(row, rate)} />
            <SheetComputed col={COL.total} y={y} amount={rowTotal(row, rate)} pink />
            <button
              className="sheet-x"
              title="Remove row"
              style={{ left: COL.total.r + 6, top: sheetTop(y) - 1 }}
              onClick={() => onRemoveRow(gi)}
            >×</button>
          </span>
        );
      })}

      {isLast && (
        <>
          <SheetComputed col={COL.lodging} y={TOTALS_Y} amount={sum((r) => r.lodging)} pink />
          <SheetComputed col={COL.airfare} y={TOTALS_Y} amount={sum((r) => r.airfare)} pink />
          <SheetComputed col={COL.parking} y={TOTALS_Y} amount={sum((r) => r.parking)} pink />
          <SheetComputed col={COL.carRental} y={TOTALS_Y} amount={sum((r) => r.carRental)} pink />
          <SheetComputed col={COL.mileage} y={TOTALS_Y} amount={sum((r) => mileageDollars(r, rate))} pink />
          <SheetComputed col={COL.rideshare} y={TOTALS_Y} amount={sum((r) => r.rideshare)} pink />
          <SheetComputed col={COL.misc} y={TOTALS_Y} amount={sum((r) => r.misc)} pink />
          <SheetComputed col={COL.misc} y={GRAND_Y} amount={grand} pink />
          <SheetComputed col={COL.misc} y={FINAL_Y} amount={grand} pink />
          <textarea
            className="sheet-area"
            style={{ left: COMMENTS_BOX.x - 2, top: sheetTop(COMMENTS_BOX.y), width: 182, height: 72 }}
            value={draft.comments}
            placeholder="Comments"
            onChange={(e) => onPatchDraft({ comments: e.target.value })}
          />
          <textarea
            className="sheet-area"
            style={{ left: NOTES_BOX.x - 2, top: sheetTop(NOTES_BOX.y), width: 429, height: 72 }}
            value={draft.notes}
            placeholder="Notes"
            onChange={(e) => onPatchDraft({ notes: e.target.value })}
          />
        </>
      )}
    </div>
    </div>
  );
}
