import { useEffect, useState } from 'react';
import type { UserSettings } from '../shared/types';
import { FILING_STATUSES, FILING_STATUS_LABELS, TAX_YEAR, type FilingStatus } from '../shared/taxes';
import { THEMES } from './themes';
import PasswordInput from './PasswordInput';
import { privateLinksFor } from './private-links';

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: (next: UserSettings) => void;
  // "I don't submit timesheets through C.A.R.L." — hides timesheet-only
  // sections and offers the way back.
  sswSkipped: boolean;
  onEnableSsw: () => void;
  // Full sign-out: clears logins and returns to setup.
  onLogout: () => void;
};

type SaveState = { tone: 'idle' | 'ok' | 'err' | 'busy'; message: string };
const IDLE: SaveState = { tone: 'idle', message: '' };

type Tab = 'general' | 'earnings' | 'theme';

export default function SettingsModal({ open, onClose, onSaved, sswSkipped, onEnableSsw, onLogout }: Props) {
  // Logging out clears logins — destructive enough for a two-click arm.
  const [logoutArmed, setLogoutArmed] = useState(false);
  // "Saved!" flash beside whichever Save was clicked; n keys the animation
  // so saving again replays it.
  const [savedFlash, setSavedFlash] = useState<{ tab: 'general' | 'earnings'; n: number } | null>(null);
  // Which tab is showing. Persists across open/close within a session, matching
  // how the main Bookings/Timesheet tabs behave.
  const [tab, setTab] = useState<Tab>('general');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [autofillPerDiem, setAutofillPerDiem] = useState(true);
  const [tsEmail, setTsEmail] = useState('');      // empty string = use SSW's value
  const [theme, setTheme] = useState('default');
  const [busy, setBusy] = useState(false);

  // Earnings-estimate inputs. Empty string = unset (stored as 0).
  const [basePay, setBasePay] = useState('');
  const [subtractTaxes, setSubtractTaxes] = useState(false);
  const [perDiemInTotal, setPerDiemInTotal] = useState(true);
  const [retirement, setRetirement] = useState('');
  const [filingStatus, setFilingStatus] = useState<FilingStatus>('single');
  const [stateRate, setStateRate] = useState('');
  const [earningsBusy, setEarningsBusy] = useState(false);

  const [carlEmail, setCarlEmail] = useState('');
  // The SAVED login, kept apart from the editable field above so typing an
  // address into the C.A.R.L. box can't conjure someone else's private links.
  const [accountEmail, setAccountEmail] = useState('');
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
      setTsEmail(s.timesheetEmail);
      setTheme(s.theme);
      setBasePay(s.basePayDayRate > 0 ? String(s.basePayDayRate) : '');
      setSubtractTaxes(s.subtractTaxes);
      setPerDiemInTotal(s.perDiemInTotal);
      setRetirement(s.retirementPct > 0 ? String(s.retirementPct) : '');
      setFilingStatus(s.filingStatus);
      setStateRate(s.stateTaxRatePct > 0 ? String(s.stateTaxRatePct) : '');
    });
    window.api.settings.getCredentials().then((c) => {
      setCarlEmail(c.carlEmail);
      setAccountEmail(c.carlEmail);
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

  const flash = (tab: 'general' | 'earnings') =>
    setSavedFlash((f) => ({ tab, n: (f?.n ?? 0) + 1 }));

  const saveDefaults = async () => {
    setBusy(true);
    const next = await window.api.settings.update({
      defaultStartTime: start,
      defaultEndTime: end,
      autofillPerDiem,
      // The General daily-rate field is gone (the Earnings tab's base pay is
      // the one people mean) — saving here also clears any old stored SSW
      // override so it can't keep rewriting timesheets invisibly.
      defaultDailyRate: 0,
      timesheetEmail: tsEmail.trim(),
    });
    setBusy(false);
    onSaved(next);
    // Let "Saved!" register before the modal goes away.
    flash('general');
    window.setTimeout(onClose, 900);
  };

  // Parse a numeric text field, clamping to [0, max]. Empty / garbage → 0,
  // which is the "unset" sentinel everywhere downstream.
  const num = (s: string, max: number): number => {
    const n = parseFloat(s);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(n, max);
  };

  const saveEarnings = async () => {
    setEarningsBusy(true);
    const next = await window.api.settings.update({
      basePayDayRate: num(basePay, 1_000_000),
      subtractTaxes,
      perDiemInTotal,
      retirementPct: num(retirement, 100),
      filingStatus,
      stateTaxRatePct: num(stateRate, 100),
    });
    setEarningsBusy(false);
    onSaved(next);
    flash('earnings');
  };

  // Checkbox applies immediately so the estimate on the bookings card updates
  // without a Save round-trip, matching how per diem and theme behave.
  const toggleSubtractTaxes = async (checked: boolean) => {
    setSubtractTaxes(checked);
    const next = await window.api.settings.update({ subtractTaxes: checked });
    onSaved(next);
  };

  const togglePerDiemInTotal = async (checked: boolean) => {
    setPerDiemInTotal(checked);
    const next = await window.api.settings.update({ perDiemInTotal: checked });
    onSaved(next);
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

        <div className="settings-tabs">
          <button
            className={`tab ${tab === 'general' ? 'is-active' : ''}`}
            onClick={() => setTab('general')}
          >General</button>
          <button
            className={`tab ${tab === 'earnings' ? 'is-active' : ''}`}
            onClick={() => setTab('earnings')}
          >Earnings &amp; Tax</button>
          <button
            className={`tab ${tab === 'theme' ? 'is-active' : ''}`}
            onClick={() => setTab('theme')}
          >Theme</button>
        </div>

        {tab === 'general' && sswSkipped && (<>
        <h3 style={{ marginTop: 18 }}>Timesheets</h3>
        <p className="subtle" style={{ marginTop: 0, fontSize: 12 }}>
          You told AUTOcarl you don't submit timesheets through C.A.R.L., so
          the Timesheet tab and its settings are hidden.
        </p>
        <button className="secondary" onClick={onEnableSsw}>
          I submit timesheets now — set up SSW
        </button>
        </>)}

        {tab === 'general' && !sswSkipped && (<>
        {/* ---- Timesheet defaults ---- */}
        <h3 style={{ marginTop: 18 }}>Timesheet defaults</h3>
        <p className="subtle" style={{ marginTop: 0, fontSize: 12 }}>
          Start/end are autofilled on worked days you haven't edited yet.
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
          <label>Email on the timesheet</label>
          <input
            type="email"
            value={tsEmail}
            onChange={(e) => setTsEmail(e.target.value)}
            placeholder={sswEmail || 'leave blank to keep SSW\u2019s address'}
            disabled={busy}
          />
        </div>
        <p className="subtle" style={{ marginTop: 4, fontSize: 12 }}>
          Goes in the Email field of every timesheet you save. Leave it blank to keep
          whatever SSW already has on your record — this is separate from the address
          you log in with.
        </p>
        <div className="row-actions" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          {savedFlash?.tab === 'general' && <span className="save-flash" key={savedFlash.n}>Saved!</span>}
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

        {/* ---- Personal links: only ever rendered for their own login ---- */}
        {privateLinksFor(accountEmail).length > 0 && (
          <>
            <h3 style={{ marginTop: 22 }}>Your Links</h3>
            {privateLinksFor(accountEmail).map((link) => (
              <div key={link.href} style={{ marginTop: 8 }}>
                <a
                  className="private-link"
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {link.label}
                  <span className="private-link-go">Open ›</span>
                </a>
                {link.note && (
                  <p className="subtle" style={{ margin: '4px 2px 0', fontSize: 12 }}>{link.note}</p>
                )}
              </div>
            ))}
          </>
        )}

        </>)}

        {/* ---- Earnings tab: base pay + everything tax ---- */}
        {tab === 'earnings' && (<>
        <p className="subtle" style={{ marginTop: 18, fontSize: 12 }}>
          Your base pay, used to project what an upcoming gig is worth. Estimates only —
          this is never sent to SSW and doesn't affect what you submit.
        </p>
        <div className="field" style={{ margin: '10px 0 0' }}>
          <label>Base pay — day rate ($)</label>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="1"
            value={basePay}
            onChange={(e) => setBasePay(e.target.value)}
            placeholder="0"
            disabled={earningsBusy}
          />
        </div>
        <div className="row-actions" style={{ gap: 12, alignItems: 'flex-end', marginTop: 10 }}>
          <div className="field" style={{ flex: 1, margin: 0 }}>
            <label>401k contribution (%)</label>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              max="100"
              step="0.01"
              value={retirement}
              onChange={(e) => setRetirement(e.target.value)}
              placeholder="0"
              disabled={earningsBusy}
            />
          </div>
          <div className="field" style={{ flex: 1, margin: 0 }}>
            <label>State tax rate (%)</label>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              max="100"
              step="0.01"
              value={stateRate}
              onChange={(e) => setStateRate(e.target.value)}
              placeholder="0"
              disabled={earningsBusy}
            />
          </div>
        </div>
        <p className="subtle" style={{ marginTop: 4, fontSize: 12 }}>
          Leave state at 0 if you're in TX, FL, NV, WA, TN, SD, WY, AK or NH.
        </p>

        <label className="row-actions" style={{ gap: 8, alignItems: 'center', cursor: 'pointer', marginTop: 12 }}>
          <input
            type="checkbox"
            checked={subtractTaxes}
            onChange={(e) => toggleSubtractTaxes(e.target.checked)}
          />
          <span>Subtract estimated taxes from the total</span>
        </label>

        {/* Withholding is computed per bi-weekly check, the way payroll does
            it (annualize the check, apply the year's brackets, divide back).
            That needs no income history — just the filing status. */}
        {subtractTaxes && (
          <div className="tax-detail">
            <p className="subtle" style={{ marginTop: 0, fontSize: 12 }}>
              Taxes are figured per bi-weekly paycheck, the same way payroll does it —
              heavy checks withhold at a higher rate, quiet ones lower. Uses the
              real {TAX_YEAR} brackets and your filing status; no other numbers needed.
            </p>
            <div className="field" style={{ margin: '10px 0 0' }}>
              <label>Filing status</label>
              <select
                value={filingStatus}
                onChange={(e) => setFilingStatus(e.target.value as FilingStatus)}
                disabled={earningsBusy}
              >
                {FILING_STATUSES.map((st) => (
                  <option key={st} value={st}>{FILING_STATUS_LABELS[st]}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        <label className="row-actions" style={{ gap: 8, alignItems: 'center', cursor: 'pointer', marginTop: 12 }}>
          <input
            type="checkbox"
            checked={perDiemInTotal}
            onChange={(e) => togglePerDiemInTotal(e.target.checked)}
          />
          <span>Include Per Diem in Total, instead of showing it separate</span>
        </label>

        <p className="subtle" style={{ marginTop: 10, fontSize: 12 }}>
          401k comes out pre-tax, so income tax is figured after it — but Social Security and
          Medicare still apply to the full amount. Per diem is a reimbursement — never taxed,
          whether it's folded into the paycheck total or listed as its own + line.
        </p>
        <div className="row-actions" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          {savedFlash?.tab === 'earnings' && <span className="save-flash" key={savedFlash.n}>Saved!</span>}
          <button className="primary" onClick={saveEarnings} disabled={earningsBusy}>
            {earningsBusy ? 'Saving…' : 'Save'}
          </button>
        </div>
        </>)}

        {tab === 'general' && (<>
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
        {!sswSkipped && (<>
        <h3 style={{ marginTop: 22 }}>Timesheet login (SSW)</h3>
        <p className="subtle" style={{ fontSize: 12, margin: '2px 0 6px' }}>
          Your CT timesheet account on ctts.ctus.com — not your C.A.R.L.
          login. Forgot it?{' '}
          <a href="https://ctts.ctus.com/SpreadsheetWeb/PasswordReset.aspx" target="_blank" rel="noreferrer" style={{ color: 'var(--ct-gold)' }}>
            Reset it here
          </a>{' '}
          or check your saved passwords for "ctus".
        </p>
        <div className="field" style={{ margin: '6px 0' }}>
          <label>Login (username or email)</label>
          <input type="text" value={sswEmail} onChange={(e) => setSswEmail(e.target.value)} autoComplete="username" autoCapitalize="off" />
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
        </>)}

        {/* ---- Logout ---- */}
        <div style={{ marginTop: 26, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <button
            className="logout-btn"
            onClick={() => {
              if (!logoutArmed) {
                setLogoutArmed(true);
                window.setTimeout(() => setLogoutArmed(false), 4000);
                return;
              }
              onLogout();
            }}
          >
            {logoutArmed ? 'Log out — erase saved logins? Click again' : 'Log Out'}
          </button>
        </div>
        </>)}

        {tab === 'theme' && (<>
        <h3 style={{ marginTop: 18 }}>Theme</h3>
        <p className="subtle" style={{ marginTop: 0, fontSize: 12 }}>
          Applies instantly — no Save needed.
        </p>
        <div className="field" style={{ margin: '6px 0 0', maxWidth: 260 }}>
          <select value={theme} onChange={(e) => changeTheme(e.target.value)}>
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
        </>)}

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
