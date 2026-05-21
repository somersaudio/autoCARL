import { useEffect, useState } from 'react';
import type { AppConfig, CredService, Theme } from '../shared/types';

type Props = {
  config: AppConfig;
  onChange: () => Promise<void>;
};

export default function Settings({ config, onChange }: Props) {
  const [carlUser, setCarlUser] = useState(config.carlUsername);
  const [carlPass, setCarlPass] = useState('');
  const [hasCarlPass, setHasCarlPass] = useState(false);

  const [sswUser, setSswUser] = useState(config.sswUsername);
  const [sswPass, setSswPass] = useState('');
  const [hasSswPass, setHasSswPass] = useState(false);

  const [defaults, setDefaults] = useState(config.weeklyDefaults);

  const [banner, setBanner] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    if (config.carlUsername) window.api.credentials.has('carl', config.carlUsername).then(setHasCarlPass);
    if (config.sswUsername) window.api.credentials.has('ssw', config.sswUsername).then(setHasSswPass);
  }, [config.carlUsername, config.sswUsername]);

  const flash = (kind: 'success' | 'error' | 'info', text: string, ms = 3500) => {
    setBanner({ kind, text });
    setTimeout(() => setBanner(null), ms);
  };

  const setTheme = async (theme: Theme) => {
    await window.api.config.update({ theme });
    await onChange();
  };

  const saveCreds = async (service: CredService, username: string, password: string) => {
    const trimmed = username.trim();
    if (service === 'carl') await window.api.config.update({ carlUsername: trimmed });
    else await window.api.config.update({ sswUsername: trimmed });

    if (password) {
      await window.api.credentials.save(service, trimmed, password);
      if (service === 'carl') {
        setCarlPass('');
        setHasCarlPass(true);
      } else {
        setSswPass('');
        setHasSswPass(true);
      }
    }
    await onChange();
    flash('success', 'Saved.');
  };

  const clearCreds = async (service: CredService, username: string) => {
    if (!username) return;
    await window.api.credentials.clear(service, username);
    if (service === 'carl') setHasCarlPass(false);
    else setHasSswPass(false);
    flash('success', 'Password cleared from keychain.');
  };

  const saveDefaults = async () => {
    await window.api.config.update({ weeklyDefaults: defaults });
    await onChange();
    flash('success', 'Defaults saved.');
  };

  return (
    <>
      {banner && <div className={`banner ${banner.kind}`}>{banner.text}</div>}

      <div className="card">
        <h2>Appearance</h2>
        <div className="theme-toggle">
          <button className={config.theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}>
            Dark
          </button>
          <button className={config.theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}>
            Light
          </button>
        </div>
      </div>

      <div className="card">
        <h2>C.A.R.L. login</h2>
        <p className="subtle">Used to read your shows + profile. Password stored in OS keychain.</p>
        <div className="row">
          <div>
            <label>Email</label>
            <input type="email" value={carlUser} onChange={(e) => setCarlUser(e.target.value)} placeholder="you@example.com" />
          </div>
          <div>
            <label>Password {hasCarlPass && <span className="subtle">(saved)</span>}</label>
            <input
              type="password"
              placeholder={hasCarlPass ? '••••••••' : 'Enter to save'}
              value={carlPass}
              onChange={(e) => setCarlPass(e.target.value)}
            />
          </div>
        </div>
        <button className="primary" onClick={() => saveCreds('carl', carlUser, carlPass)}>Save</button>
        {hasCarlPass && (
          <button className="danger" style={{ marginLeft: 8 }} onClick={() => clearCreds('carl', config.carlUsername)}>
            Clear
          </button>
        )}
      </div>

      <div className="card">
        <h2>SpreadsheetWeb login</h2>
        <p className="subtle">Used to submit timesheets. Different username — usually NOT your email.</p>
        <div className="row">
          <div>
            <label>Username</label>
            <input type="text" value={sswUser} onChange={(e) => setSswUser(e.target.value)} placeholder="Your SpreadsheetWeb username" />
          </div>
          <div>
            <label>Password {hasSswPass && <span className="subtle">(saved)</span>}</label>
            <input
              type="password"
              placeholder={hasSswPass ? '••••••••' : 'Enter to save'}
              value={sswPass}
              onChange={(e) => setSswPass(e.target.value)}
            />
          </div>
        </div>
        <button className="primary" onClick={() => saveCreds('ssw', sswUser, sswPass)}>Save</button>
        {hasSswPass && (
          <button className="danger" style={{ marginLeft: 8 }} onClick={() => clearCreds('ssw', config.sswUsername)}>
            Clear
          </button>
        )}
      </div>

      <div className="card">
        <h2>Submit Hours</h2>
        <p className="subtle">
          Scheduled days from C.A.R.L. (show start through travel return) get pre-filled
          with 8:00 AM – 6:00 PM and per-diem (when the show has it). Unscheduled days
          stay blank.
        </p>
        <div className="field">
          <label>
            <input
              type="checkbox"
              checked={config.autoApplySchedule}
              onChange={async (e) => {
                await window.api.config.update({ autoApplySchedule: e.target.checked });
                await onChange();
              }}
            />{' '}
            Auto-fill scheduled days from C.A.R.L.
          </label>
        </div>
        <div className="field">
          <label>
            <input
              type="checkbox"
              checked={config.hideMealBreak}
              onChange={async (e) => {
                await window.api.config.update({ hideMealBreak: e.target.checked });
                await onChange();
              }}
            />{' '}
            Hide meal break fields
          </label>
        </div>
      </div>

      <div className="card">
        <h2>Pay</h2>
        <div className="field">
          <label>Daily rate ($)</label>
          <input
            type="number"
            step="any"
            min="0"
            placeholder="e.g. 715"
            value={defaults.dailyRate ?? ''}
            onChange={(e) =>
              setDefaults({ ...defaults, dailyRate: e.target.value === '' ? null : Number(e.target.value) })
            }
          />
          <p className="subtle" style={{ marginTop: 4 }}>
            Filled into the timesheet's Daily Rate field. Leave blank to skip.
          </p>
        </div>
        <button className="primary" onClick={saveDefaults}>Save</button>
      </div>
    </>
  );
}
