import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Booking, ExpenseCategory, ExpenseReceipt, ExpenseReport, ExpenseRow, ExpensesCache,
} from '../shared/types';
import { friendlyError } from '../shared/errors';

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

  useEffect(() => {
    window.api.expenses.getCached().then(setCache)
      .catch((e) => setError(friendlyError(e, !navigator.onLine)));
  }, []);

  // Default the gig dropdown to the most recent gig holding receipts (falling
  // back to the most recent gig). Runs until something is selected, then
  // leaves the user's choice alone.
  useEffect(() => {
    if (selectedGig || !cache || !bookings.length) return;
    const withReceipts = new Set(cache.receipts.map((r) => r.bookingId).filter(Boolean));
    const sorted = bookings.slice().sort((a, b) => b.startDate.localeCompare(a.startDate));
    const pick = sorted.find((b) => withReceipts.has(b.bookingId)) || sorted[0];
    if (pick) setSelectedGig(pick.bookingId);
  }, [selectedGig, cache, bookings]);

  // Draft edits persist automatically (debounced) so flipping to Timesheet to
  // check something doesn't throw away a half-adjusted report.
  useEffect(() => {
    if (!draft) return;
    const t = window.setTimeout(() => {
      window.api.expenses.saveReport(draft).then(setCache).catch(() => {});
    }, 700);
    return () => window.clearTimeout(t);
  }, [draft]);

  const bookingById = useMemo(() => {
    const m = new Map<string, Booking>();
    for (const b of bookings) m.set(b.bookingId, b);
    return m;
  }, [bookings]);

  const receipts = cache?.receipts ?? [];

  // The gig receipts get filed under: the open draft's gig if one is open,
  // otherwise the builder dropdown's selection.
  const activeBookingId = useMemo(() => {
    if (draft) {
      for (const row of draft.rows) {
        const b = bookings.find((x) => x.jobNumber && x.jobNumber === row.jobNumber);
        if (b) return b.bookingId;
      }
    }
    return selectedGig;
  }, [draft, bookings, selectedGig]);

  // Mirror a receipt change into the open draft so the form row tracks the
  // receipt list live: subtract the old contribution, add the new one.
  // `before` null = freshly dropped receipt; `after` null = deleted.
  // Edits only re-apply if the receipt was already counted in some row —
  // receipts outside this draft stay outside it.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const syncDraft = (before: ExpenseReceipt | null, after: ExpenseReceipt | null) => {
    setDraft((d) => {
      if (!d) return d;
      const rows = d.rows.slice();
      let touched = false;
      let hadSlot = !before;
      if (before) {
        const i = rows.findIndex((r) => r.receiptIds.includes(before.id));
        if (i >= 0) {
          hadSlot = true;
          rows[i] = {
            ...rows[i],
            [before.category]: Math.max(0, round2(rows[i][before.category] - before.amount)),
            receiptIds: rows[i].receiptIds.filter((x) => x !== before.id),
          };
          touched = true;
        }
      }
      if (after && hadSlot) {
        const b = bookings.find((x) => x.bookingId === after.bookingId);
        const i = b ? rows.findIndex((r) => r.jobNumber === b.jobNumber) : -1;
        if (i >= 0) {
          rows[i] = {
            ...rows[i],
            [after.category]: round2(rows[i][after.category] + after.amount),
            receiptIds: [...rows[i].receiptIds, after.id],
          };
          touched = true;
        }
      }
      return touched ? { ...d, rows } : d;
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
    if (draft) window.api.expenses.removeReport(draft.id).then(setCache).catch(() => {});
    setDraft(null);
    setExportedPath(null);
  };

  // ---- receipts for display ----
  // Reports are always per-gig, so the list shows just the active gig's
  // receipts — switching the dropdown switches the list. Receipts from
  // before this flow (no gig recorded) surface below with a one-click adopt.
  const activeBooking = bookingById.get(activeBookingId);
  const activeReceipts = receipts.filter((r) => r.bookingId === activeBookingId);
  const unassigned = receipts.filter((r) => !r.bookingId);

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

      {/* ---- receipt intake ---- */}
      <div
        className={`card exp-drop ${dragOver ? 'is-over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className="exp-drop-title">{busy ? 'Reading receipts…' : 'Drop receipts here'}</div>
        <div className="subtle exp-drop-sub">
          Photos or PDFs — hotel folios, Uber/Lyft receipts, parking stubs. The app reads
          each one, sets the amount and column, and files it under the gig chosen below.
        </div>
        <button className="secondary" onClick={browse} disabled={busy}>Browse…</button>
      </div>

      {/* ---- report builder / editor ---- */}
      {!draft ? (
        <div className="card">
          <h3>New Expense Report</h3>
          <div className="subtle exp-hint">
            Pick a gig — its receipts fill the form's columns and miles come from your
            timesheets. Everything is editable before export, and rows for more gigs
            can be added in the editor.
          </div>
          <div className="exp-actions">
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
                return (
                  <option
                    key={b.bookingId}
                    value={b.bookingId}
                    title={`${b.jobNumber} · ${fmtRange(b.startDate, b.endDate)}`}
                  >
                    {b.jobName}{n > 0 ? ` · ${n} receipt${n === 1 ? '' : 's'}` : ''}
                  </option>
                );
              })}
            </select>
            <button className="primary" onClick={buildDraft} disabled={!selectedGig || !bookingById.has(selectedGig)}>
              Build report
            </button>
            {cache.reports.length > 0 && (
              <span className="exp-saved">
                {cache.reports.slice().reverse().map((rep) => (
                  <button key={rep.id} className="link" onClick={() => { setDraft(rep); setExportedPath(null); }}>
                    {rep.date || 'draft'} · {rep.rows.map((r) => r.jobNumber).filter(Boolean).slice(0, 2).join(', ') || 'empty'}
                  </button>
                ))}
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="card">
          <h3>CT Expense Reimbursement Form</h3>
          <div className="exp-form-grid">
            <div className="field"><label>Date</label>
              <input value={draft.date} onChange={(e) => patchDraft({ date: e.target.value })} /></div>
            <div className="field"><label>Name</label>
              <input value={draft.name} onChange={(e) => patchDraft({ name: e.target.value })} /></div>
            <div className="field"><label>Employee ID</label>
              <input value={draft.employeeId} onChange={(e) => patchDraft({ employeeId: e.target.value })} /></div>
            <div className="field"><label>Project Manager</label>
              <input value={draft.projectManager} onChange={(e) => patchDraft({ projectManager: e.target.value })} /></div>
            <div className="field"><label>Labor Coordinator</label>
              <input value={draft.laborCoordinator} onChange={(e) => patchDraft({ laborCoordinator: e.target.value })} /></div>
            <div className="field"><label>State Worked In</label>
              <input value={draft.stateWorkedIn} onChange={(e) => patchDraft({ stateWorkedIn: e.target.value })} /></div>
            <div className="field"><label>Country/Location</label>
              <input value={draft.countryWorkedIn} onChange={(e) => patchDraft({ countryWorkedIn: e.target.value })} /></div>
            <div className="field"><label>Mileage rate $/mi</label>
              <input
                defaultValue={draft.mileageRate.toFixed(2)}
                inputMode="decimal"
                onBlur={(e) => {
                  const v = parseFloat(e.target.value);
                  if (isFinite(v) && v >= 0) patchDraft({ mileageRate: v });
                }}
              /></div>
          </div>

          <div className="exp-table-wrap">
            <table className="exp-table">
              <thead>
                <tr>
                  <th>Job#</th><th>Description</th><th>Lodging</th><th>Airfare</th><th>Parking</th>
                  <th>Car Rental</th><th title="Mileage $ is computed at miles × rate">Miles</th><th>Uber/Lyft/Taxi</th><th>Misc.</th>
                  <th>Total</th><th />
                </tr>
              </thead>
              <tbody>
                {draft.rows.map((row, i) => (
                  <tr key={`${draft.id}-${i}`}>
                    <td><input className="exp-cell exp-cell-job" defaultValue={row.jobNumber}
                      onBlur={(e) => patchRow(i, { jobNumber: e.target.value })} /></td>
                    <td><input className="exp-cell exp-cell-desc" defaultValue={row.description}
                      onBlur={(e) => patchRow(i, { description: e.target.value })} /></td>
                    {MONEY_COLS.slice(0, 4).map((k) => (
                      <td key={k}><input className="exp-cell exp-cell-money" defaultValue={row[k] ? row[k].toFixed(2) : ''}
                        inputMode="decimal" placeholder="—"
                        onBlur={(e) => {
                          const v = parseFloat(e.target.value.replace(/[$,]/g, ''));
                          patchRow(i, { [k]: isFinite(v) && v >= 0 ? v : 0 } as Partial<ExpenseRow>);
                        }} /></td>
                    ))}
                    <td><input className="exp-cell exp-cell-miles" defaultValue={row.miles || ''}
                      inputMode="numeric" placeholder="—"
                      title={row.miles ? `Mileage: ${usd(mileageDollars(row, draft.mileageRate))}` : 'Miles driven — mileage $ lands on the form'}
                      onBlur={(e) => {
                        const v = parseInt(e.target.value, 10);
                        patchRow(i, { miles: isFinite(v) && v >= 0 ? v : 0 });
                      }} /></td>
                    {MONEY_COLS.slice(4).map((k) => (
                      <td key={k}><input className="exp-cell exp-cell-money" defaultValue={row[k] ? row[k].toFixed(2) : ''}
                        inputMode="decimal" placeholder="—"
                        onBlur={(e) => {
                          const v = parseFloat(e.target.value.replace(/[$,]/g, ''));
                          patchRow(i, { [k]: isFinite(v) && v >= 0 ? v : 0 } as Partial<ExpenseRow>);
                        }} /></td>
                    ))}
                    <td className="exp-computed">{usd(rowTotal(row, draft.mileageRate))}</td>
                    <td><button className="link exp-x" title="Remove row"
                      onClick={() => patchDraft({ rows: draft.rows.filter((_, j) => j !== i) })}>×</button></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={9} className="exp-computed exp-grand-label">Total</td>
                  <td className="exp-computed exp-grand">{usd(draft.rows.reduce((a, r) => a + rowTotal(r, draft.mileageRate), 0))}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          <button className="link" onClick={() => patchDraft({
            rows: [...draft.rows, {
              jobNumber: '', description: '', lodging: 0, airfare: 0, parking: 0,
              carRental: 0, miles: 0, rideshare: 0, misc: 0, receiptIds: [],
            }],
          })}>+ add row</button>

          <div className="exp-form-grid exp-form-grid-wide">
            <div className="field"><label>Comments</label>
              <textarea rows={2} value={draft.comments} onChange={(e) => patchDraft({ comments: e.target.value })} /></div>
            <div className="field"><label>Notes</label>
              <textarea rows={2} value={draft.notes} onChange={(e) => patchDraft({ notes: e.target.value })} /></div>
          </div>

          <label className="exp-attach">
            <input
              type="checkbox"
              checked={draft.attachReceipts}
              onChange={(e) => patchDraft({ attachReceipts: e.target.checked })}
            />
            Attach receipts as pages after the form
          </label>

          <div className="exp-actions">
            <button className="primary" onClick={exportPdf} disabled={exportBusy}>
              {exportBusy ? 'Exporting…' : 'Export PDF'}
            </button>
            <button className="secondary" onClick={() => { setDraft(null); setExportedPath(null); }}>Close</button>
            <button className="link exp-x" onClick={discardDraft}>Delete report</button>
            {exportedPath && <span className="subtle exp-exported">Saved — revealed in Finder</span>}
          </div>
        </div>
      )}
      {/* ---- receipt list: the active gig's receipts only ---- */}
      {(activeReceipts.length > 0 || unassigned.length > 0) && (
        <div className="card">
          <h3>
            Receipts
            {activeBooking && (
              <span className="exp-h-gig subtle"> — {activeBooking.jobNumber} · {activeBooking.jobName}</span>
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
    <div className="exp-receipt-row">
      <span className="exp-kind" title={r.merchant ? `${r.merchant} — ${r.originalName}` : r.originalName}>{r.kind === 'pdf' ? '📄' : '🧾'}</span>
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
      {onAdopt && <button className="link exp-adopt" onClick={onAdopt}>{adoptLabel}</button>}
      <span className="exp-row-spacer" />
      <button className="link exp-view" title="Open receipt" onClick={() => window.api.expenses.openReceipt(r.id)}>view</button>
      <button
        className={`link exp-x ${armedId === r.id ? 'is-armed' : ''}`}
        title={armedId === r.id ? 'Click again to delete' : 'Delete receipt'}
        onClick={() => onRemove(r.id)}
      >{armedId === r.id ? 'sure?' : '×'}</button>
    </div>
  );
}
