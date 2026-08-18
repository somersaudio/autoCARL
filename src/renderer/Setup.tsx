import { useState } from 'react';
import type { SetupStatus } from '../shared/types';
import PasswordInput from './PasswordInput';

type Props = {
  status: SetupStatus;
  onChange: (status: SetupStatus) => void;
};

export default function Setup({ status, onChange }: Props) {
  // SetupStatus is two screens in one component; route on the stage. CARL
  // first (gives us the iCal URL), SSW second (gives us the write path).
  if (status.stage === 'needs-ssw-credentials'
      || (status.stage === 'error' && status.from === 'ssw')) {
    return <SswForm status={status} onChange={onChange} />;
  }
  return <CarlForm status={status} onChange={onChange} />;
}

function CarlForm({ status, onChange }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const errorMessage = status.stage === 'error' && status.from === 'carl' ? status.message : null;

  const submit = async () => {
    setBusy(true);
    // The calendar feed is discovered from the login — users never see or
    // paste an iCal link.
    const result = await window.api.setup.saveCarl(email, password);
    setBusy(false);
    onChange(result);
  };

  return (
    <div className="card">
      <h2>Step 1 of 2 — Connect to C.A.R.L.</h2>
      <p className="subtle">
        Enter your C.A.R.L. login once. We'll discover your calendar feed and
        cache it — after this, your schedule loads instantly.
      </p>

      <div className="field">
        <label>Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="username"
          disabled={busy}
        />
      </div>
      <div className="field">
        <label>Password</label>
        <PasswordInput
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          disabled={busy}
        />
      </div>

      {errorMessage && <div className="banner error">{errorMessage}</div>}

      <button
        className="primary"
        onClick={submit}
        disabled={busy || !email || !password}
      >
        {busy ? 'Connecting…' : 'Continue'}
      </button>

      <p className="subtle" style={{ marginTop: 12, fontSize: 12 }}>
        Your password is stored only {(window as unknown as { __AUTOCARL_WEB__?: boolean }).__AUTOCARL_WEB__ ? 'in this browser' : 'in your OS keychain'}.
      </p>
    </div>
  );
}

function SswForm({ status, onChange }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const result = await window.api.setup.saveSsw(email, password);
    setBusy(false);
    onChange(result);
  };

  const errorMessage = status.stage === 'error' && status.from === 'ssw' ? status.message : null;

  return (
    <div className="card">
      <h2>Step 2 of 2 — Timesheet login (SSW)</h2>
      <p className="subtle">
        This is your CT <b>timesheet</b> account on ctts.ctus.com — a
        different login from C.A.R.L. We use it to push your hours; the
        password lives only {(window as unknown as { __AUTOCARL_WEB__?: boolean }).__AUTOCARL_WEB__ ? 'in this browser' : 'in your OS keychain'}.
      </p>

      <div className="field">
        <label>Timesheet (SSW) login</label>
        <input
          type="text"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="username or email"
          autoComplete="username"
          autoCapitalize="off"
          disabled={busy}
        />
      </div>
      <div className="field">
        <label>Timesheet (SSW) password</label>
        <PasswordInput
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          disabled={busy}
        />
      </div>

      <p className="subtle" style={{ fontSize: 12 }}>
        Can't remember it? It's the login you use on timesheet day — most
        people have it saved: iPhone → Settings → Passwords, search
        "ctus"; Mac → Safari → Settings → Passwords. Or{' '}
        <a href="https://ctts.ctus.com/SpreadsheetWeb/PasswordReset.aspx" target="_blank" rel="noreferrer" style={{ color: 'var(--ct-gold)' }}>
          reset your SSW password
        </a>{' '}
        — enter your email there and it sends you a new one. Still stuck?
        Your labor coordinator can help.
      </p>

      {errorMessage && <div className="banner error">{errorMessage}</div>}

      <button className="primary" onClick={submit} disabled={busy || !email || !password}>
        {busy ? 'Saving…' : 'Finish setup'}
      </button>
    </div>
  );
}
