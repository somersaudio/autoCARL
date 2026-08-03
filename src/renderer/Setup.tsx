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
  const [icalUrl, setIcalUrl] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [busy, setBusy] = useState(false);

  const errorMessage = status.stage === 'error' && status.from === 'carl' ? status.message : null;

  const submit = async () => {
    setBusy(true);
    const result = showManual
      ? await window.api.setup.saveCarlWithUrl(email, password, icalUrl)
      : await window.api.setup.saveCarl(email, password);
    setBusy(false);
    // If auto-discover failed, auto-expand the manual form so the next click works.
    if (result.stage === 'error' && result.from === 'carl' && !showManual) {
      setShowManual(true);
    }
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

      {showManual && (
        <div className="field">
          <label>iCal URL</label>
          <input
            type="text"
            value={icalUrl}
            onChange={(e) => setIcalUrl(e.target.value)}
            placeholder="https://calendar.prod.carl.ctus.live/MYTP-..."
            disabled={busy}
          />
          <p className="subtle" style={{ marginTop: 4, fontSize: 11 }}>
            In CARL, click <b>Calendar Instructions</b> at the top by Timesheets and Crew. Copy that URL and paste it here.
          </p>
        </div>
      )}

      {errorMessage && <div className="banner error">{errorMessage}</div>}

      <button
        className="primary"
        onClick={submit}
        disabled={busy || !email || !password || (showManual && !icalUrl)}
      >
        {busy ? 'Connecting…' : 'Continue'}
      </button>

      {!showManual && (
        <button
          className="link"
          onClick={() => setShowManual(true)}
          style={{ marginLeft: 8 }}
        >
          Paste iCal URL manually
        </button>
      )}

      <p className="subtle" style={{ marginTop: 12, fontSize: 12 }}>
        Your password is stored only in your OS keychain.
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
      <h2>Step 2 of 2 — Connect to SSW timesheets</h2>
      <p className="subtle">
        Your SSW login is separate from C.A.R.L. We use it to push hours back
        — your password lives only in your OS keychain.
      </p>

      <div className="field">
        <label>SSW email</label>
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
        <label>SSW password</label>
        <PasswordInput
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          disabled={busy}
        />
      </div>

      {errorMessage && <div className="banner error">{errorMessage}</div>}

      <button className="primary" onClick={submit} disabled={busy || !email || !password}>
        {busy ? 'Saving…' : 'Finish setup'}
      </button>
    </div>
  );
}
