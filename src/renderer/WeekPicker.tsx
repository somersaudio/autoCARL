import { useEffect, useMemo, useRef, useState } from 'react';

type Props = {
  value: string; // Monday in "YYYY-MM-DD"
  onChange: (mondayISO: string) => void;
};

function parseISO(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toISO(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function mondayOf(d: Date): Date {
  const day = d.getDay(); // Sun=0..Sat=6
  const diff = day === 0 ? -6 : 1 - day;
  const out = new Date(d);
  out.setDate(d.getDate() + diff);
  return out;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS_MON_FIRST = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

export default function WeekPicker({ value, onChange }: Props) {
  const selectedMonday = useMemo(() => parseISO(value), [value]);
  const [open, setOpen] = useState(false);
  // Month currently being viewed in the popover (1st of that month).
  const [viewMonth, setViewMonth] = useState(() => new Date(selectedMonday.getFullYear(), selectedMonday.getMonth(), 1));
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Re-anchor view when value changes (e.g. parent updates it from elsewhere).
  useEffect(() => {
    setViewMonth(new Date(selectedMonday.getFullYear(), selectedMonday.getMonth(), 1));
  }, [selectedMonday.getFullYear(), selectedMonday.getMonth()]);

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Build the calendar grid: rows of 7 days, Monday-first, padded so the
  // first row's Monday is on or before the 1st of the month.
  const cells = useMemo(() => {
    const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
    const gridStart = mondayOf(first);
    const rows: Date[][] = [];
    let cursor = new Date(gridStart);
    for (let r = 0; r < 6; r++) {
      const row: Date[] = [];
      for (let c = 0; c < 7; c++) {
        row.push(new Date(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
      rows.push(row);
      // Stop early if we've already passed the month and finished the week.
      if (row[6].getMonth() !== viewMonth.getMonth() && row[0].getMonth() !== viewMonth.getMonth()) {
        if (r >= 4) break;
      }
    }
    return rows;
  }, [viewMonth]);

  const selectMonday = (d: Date) => {
    const m = mondayOf(d);
    onChange(toISO(m));
    setOpen(false);
  };

  const triggerLabel = `${MONTHS[selectedMonday.getMonth()].slice(0, 3)} ${selectedMonday.getDate()}, ${selectedMonday.getFullYear()}`;

  return (
    <div className="week-picker" ref={rootRef}>
      <button type="button" className="week-picker-trigger" onClick={() => setOpen((o) => !o)}>
        Week of {triggerLabel}
      </button>
      {open && (
        <div className="week-picker-pop">
          <div className="week-picker-header">
            <button
              type="button"
              className="week-picker-nav"
              onClick={() => setViewMonth((v) => new Date(v.getFullYear(), v.getMonth() - 1, 1))}
              aria-label="Previous month"
            >‹</button>
            <span>{MONTHS[viewMonth.getMonth()]} {viewMonth.getFullYear()}</span>
            <button
              type="button"
              className="week-picker-nav"
              onClick={() => setViewMonth((v) => new Date(v.getFullYear(), v.getMonth() + 1, 1))}
              aria-label="Next month"
            >›</button>
          </div>
          <div className="week-picker-grid">
            {WEEKDAYS_MON_FIRST.map((w, i) => (
              <div key={i} className="week-picker-dow">{w}</div>
            ))}
            {cells.flatMap((row, ri) => {
              const rowMonday = row[0];
              const isSelectedRow = sameDay(rowMonday, selectedMonday);
              const isHoveredRow = hoveredRow === ri;
              return row.map((d, ci) => {
                const isMonday = ci === 0;
                const inMonth = d.getMonth() === viewMonth.getMonth();
                const cls = [
                  'week-picker-day',
                  isMonday ? 'is-monday' : 'is-other-day',
                  !inMonth ? 'is-out-of-month' : '',
                  isSelectedRow ? 'is-selected' : '',
                  isHoveredRow ? 'is-row-hover' : '',
                ].filter(Boolean).join(' ');
                return (
                  <button
                    type="button"
                    key={`${rowMonday.getTime()}-${ci}`}
                    className={cls}
                    onClick={() => selectMonday(rowMonday)}
                    onMouseEnter={() => setHoveredRow(ri)}
                    onMouseLeave={() => setHoveredRow((h) => (h === ri ? null : h))}
                    tabIndex={isMonday ? 0 : -1}
                  >
                    {d.getDate()}
                  </button>
                );
              });
            })}
          </div>
        </div>
      )}
    </div>
  );
}
