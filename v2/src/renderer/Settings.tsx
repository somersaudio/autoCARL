import { useEffect, useState } from 'react';
import type { UserSettings } from '../shared/types';
import PasswordInput from './PasswordInput';

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: (next: UserSettings) => void;
};

type SaveState = { tone: 'idle' | 'ok' | 'err' | 'busy'; message: string };
const IDLE: SaveState = { tone: 'idle', message: '' };

export default function SettingsModal({ open, onClose, onSaved }: Props) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [autofillPerDiem, setAutofillPerDiem] = useState(true);
  const [dailyRate, setDailyRate] = useState('');  // empty string = use SSW's value
  const [theme, setTheme] = useState('default');
  const [busy, setBusy] = useState(false);

  const [carlEmail, setCarlEmail] = useState('');
  const [carlPassword, setCarlPassword] = useState('');
  const [carlState, setCarlState] = useState<SaveState>(IDLE);

  const [sswEmail, setSswEmail] = useState('');
  const [sswPassword, setSswPassword] = useState('');
  const [sswState, setSswState] = useState<SaveState>(IDLE);

  useEffect(() => {
    if (!open) return;
    window.api.settings.get().then((s) => {
      setStart(s.defaultStartTime);
      setEnd(s.defaultEndTime);
      setAutofillPerDiem(s.autofillPerDiem);
      setDailyRate(s.defaultDailyRate > 0 ? String(s.defaultDailyRate) : '');
      setTheme(s.theme);
    });
    window.api.settings.getCredentials().then((c) => {
      setCarlEmail(c.carlEmail);
      setSswEmail(c.sswEmail);
    });
    // Clear any leftover password state and feedback when re-opening.
    setCarlPassword('');
    setSswPassword('');
    setCarlState(IDLE);
    setSswState(IDLE);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const saveDefaults = async () => {
    setBusy(true);
    const parsedRate = parseFloat(dailyRate);
    const next = await window.api.settings.update({
      defaultStartTime: start,
      defaultEndTime: end,
      autofillPerDiem,
      defaultDailyRate: Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : 0,
    });
    setBusy(false);
    onSaved(next);
    onClose();
  };

  const togglePerDiem = async (checked: boolean) => {
    setAutofillPerDiem(checked);
    const next = await window.api.settings.update({ autofillPerDiem: checked });
    onSaved(next);
  };

  // Theme is applied immediately on change — no Save click needed — so the
  // user sees the effect (rain background, colors) the moment they pick it.
  const changeTheme = async (id: string) => {
    setTheme(id);
    const next = await window.api.settings.update({ theme: id });
    onSaved(next);
  };

  const saveCarl = async () => {
    setCarlState({ tone: 'busy', message: 'Testing login…' });
    const r = await window.api.settings.updateCarlCredentials(carlEmail, carlPassword);
    if (r.ok) {
      setCarlState({ tone: 'ok', message: '✓ Saved. CARL login works.' });
      setCarlPassword('');
    } else {
      setCarlState({ tone: 'err', message: r.error });
    }
  };

  const saveSsw = async () => {
    setSswState({ tone: 'busy', message: 'Testing login…' });
    const r = await window.api.settings.updateSswCredentials(sswEmail, sswPassword);
    if (r.ok) {
      setSswState({ tone: 'ok', message: '✓ Saved. SSW login works.' });
      setSswPassword('');
    } else {
      setSswState({ tone: 'err', message: r.error });
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="row-between">
          <h2 style={{ margin: 0 }}>Settings</h2>
          <button className="link" onClick={onClose}>✕</button>
        </div>

        {/* ---- Timesheet defaults ---- */}
        <h3 style={{ marginTop: 18 }}>Timesheet defaults</h3>
        <p className="subtle" style={{ marginTop: 0, fontSize: 12 }}>
          Start/end are autofilled on worked days you haven't edited yet. Daily rate, when set, overwrites SSW's stored rate on every save.
        </p>
        <div className="row-actions" style={{ gap: 12, alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 1, margin: 0 }}>
            <label>Start</label>
            <input type="text" value={start} onChange={(e) => setStart(e.target.value)} placeholder="8:00 am" disabled={busy} />
          </div>
          <div className="field" style={{ flex: 1, margin: 0 }}>
            <label>End</label>
            <input type="text" value={end} onChange={(e) => setEnd(e.target.value)} placeholder="6:00 pm" disabled={busy} />
          </div>
        </div>
        <div className="field" style={{ margin: '10px 0 0' }}>
          <label>Daily rate ($)</label>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="1"
            value={dailyRate}
            onChange={(e) => setDailyRate(e.target.value)}
            placeholder="0"
            disabled={busy}
          />
        </div>
        <div className="row-actions" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <button className="primary" onClick={saveDefaults} disabled={busy || !start || !end}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>

        {/* ---- Per diem autofill ---- */}
        <h3 style={{ marginTop: 22 }}>Per diem</h3>
        <label className="row-actions" style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={autofillPerDiem}
            onChange={(e) => togglePerDiem(e.target.checked)}
          />
          <span>Auto-fill per diem from GSA federal rates</span>
        </label>
        <p className="subtle" style={{ marginTop: 4, fontSize: 12 }}>
          When off, AUTOcarl leaves the per diem field blank for you to type in manually.
        </p>

        {/* ---- CARL credentials ---- */}
        <h3 style={{ marginTop: 22 }}>C.A.R.L. login</h3>
        <div className="field" style={{ margin: '6px 0' }}>
          <label>Email</label>
          <input type="email" value={carlEmail} onChange={(e) => setCarlEmail(e.target.value)} autoComplete="username" />
        </div>
        <div className="field" style={{ margin: '6px 0' }}>
          <label>Password</label>
          <PasswordInput
            value={carlPassword}
            onChange={setCarlPassword}
            placeholder="Enter to update"
            autoComplete="current-password"
          />
        </div>
        <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
          <button
            className="primary"
            onClick={saveCarl}
            disabled={carlState.tone === 'busy' || !carlEmail || !carlPassword}
          >
            {carlState.tone === 'busy' ? 'Testing…' : 'Update C.A.R.L.'}
          </button>
        </div>
        {carlState.message && <CredStatus state={carlState} />}

        {/* ---- SSW credentials ---- */}
        <h3 style={{ marginTop: 22 }}>SSW login</h3>
        <div className="field" style={{ margin: '6px 0' }}>
          <label>Email</label>
          <input type="email" value={sswEmail} onChange={(e) => setSswEmail(e.target.value)} autoComplete="username" />
        </div>
        <div className="field" style={{ margin: '6px 0' }}>
          <label>Password</label>
          <PasswordInput
            value={sswPassword}
            onChange={setSswPassword}
            placeholder="Enter to update"
            autoComplete="current-password"
          />
        </div>
        <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
          <button
            className="primary"
            onClick={saveSsw}
            disabled={sswState.tone === 'busy' || !sswEmail || !sswPassword}
          >
            {sswState.tone === 'busy' ? 'Testing…' : 'Update SSW'}
          </button>
        </div>
        {sswState.message && <CredStatus state={sswState} />}

        {/* ---- Digital Rain theme toggle ---- */}
        <h3 style={{ marginTop: 22 }}>Theme</h3>
        <label className="row-actions" style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={theme === 'digital-rain'}
            onChange={(e) => changeTheme(e.target.checked ? 'digital-rain' : 'default')}
          />
          <span>Digital Rain</span>
        </label>

        <div className="row-actions" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
          <button className="link" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function CredStatus({ state }: { state: SaveState }) {
  const cls =
    state.tone === 'ok' ? 'banner-inline success'
    : state.tone === 'err' ? 'banner error'
    : 'subtle';
  return (
    <div className={cls} style={{ marginTop: 6, fontSize: 12 }}>
      {state.message}
    </div>
  );
}
