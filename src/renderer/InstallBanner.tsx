import { useEffect, useState } from 'react';
import { installHintFor, type InstallHint } from './install-hint';

// "Add to Home Screen" banner — web build, iOS browser tabs only. Installed
// (standalone) users, Android, and desktop never see it; a dismissal keeps
// it quiet for 60 days.

const DISMISS_KEY = 'autocarl.web.a2hsDismissedAt';
const FORCE_KEY = 'autocarl.web.a2hsForce';   // preview hook: 'safari' | 'other-browser'
const RESHOW_MS = 60 * 24 * 3600 * 1000;

function detect(): InstallHint | null {
  const forced = localStorage.getItem(FORCE_KEY);
  if (forced === 'safari' || forced === 'other-browser') return forced;
  const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) || 0);
  if (Date.now() - dismissedAt < RESHOW_MS) return null;
  const nav = navigator as Navigator & { standalone?: boolean };
  return installHintFor({
    ua: nav.userAgent,
    platform: nav.platform || '',
    maxTouchPoints: nav.maxTouchPoints || 0,
    standalone: nav.standalone === true
      || Boolean(window.matchMedia?.('(display-mode: standalone)').matches),
  });
}

// Apple's share glyph — box with the arrow rising out of it — so the user
// knows exactly which toolbar button the steps mean.
function ShareIcon() {
  return (
    <svg
      className="a2hs-share" width="15" height="15" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 15V3" />
      <path d="M8 7l4-4 4 4" />
      <path d="M7 11H5v10h14V11h-2" />
    </svg>
  );
}

export default function InstallBanner() {
  const [hint, setHint] = useState<InstallHint | null>(null);
  useEffect(() => { setHint(detect()); }, []);
  if (!hint) return null;

  // On iPads Safari keeps the share button top-right, not in a bottom bar.
  const iPad = !/iPhone|iPod/.test(navigator.userAgent);
  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setHint(null);
  };

  return (
    <div className="a2hs-banner" role="dialog" aria-label="Add to Home Screen">
      <div className="a2hs-text">
        <strong>Put AUTOcarl on your Home Screen</strong>
        {hint === 'safari' ? (
          <span>
            Tap the <ShareIcon /> Share button {iPad ? 'at the top right' : 'below'}, then{' '}
            <em>Add to Home Screen</em>. You get the full-screen app, and it updates itself.
          </span>
        ) : (
          <span>
            Open this page in <em>Safari</em>, then tap the <ShareIcon /> Share button and
            choose <em>Add to Home Screen</em>.
          </span>
        )}
      </div>
      <button className="a2hs-close" onClick={dismiss} aria-label="Dismiss">✕</button>
    </div>
  );
}
