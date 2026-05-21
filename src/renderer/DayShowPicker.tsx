import { useEffect, useRef, useState } from 'react';
import type { PulledShow } from '../shared/types';

type Props = {
  shows: PulledShow[];
  value: string; // selected jobNumber ('' = none)
  disabled?: boolean;
  onChange: (jobNumber: string) => void;
};

// Compact per-day show picker: the closed trigger shows only the gold show
// number; the open list shows "number — name" so the user can tell them apart.
export default function DayShowPicker({ shows, value, disabled, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const pick = (job: string) => {
    onChange(job);
    setOpen(false);
  };

  return (
    <div className="day-show-picker" ref={rootRef}>
      <button
        type="button"
        className="day-show-trigger"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="show-num">{value || '—'}</span>
        <span className="day-show-caret">▾</span>
      </button>
      {open && !disabled && (
        <div className="day-show-pop">
          <button type="button" className="day-show-option" onClick={() => pick('')}>
            <span className="show-name">—</span>
          </button>
          {shows.map((s) => (
            <button
              type="button"
              key={s.jobNumber}
              className={`day-show-option ${s.jobNumber === value ? 'is-selected' : ''}`}
              onClick={() => pick(s.jobNumber)}
            >
              <span className="show-num">{s.jobNumber}</span>
              {s.jobName && <span className="show-name"> — {s.jobName}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
