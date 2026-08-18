import { useEffect, useRef, useState } from 'react';
import type { Booking, FriendEntry, FriendGig, FriendsList } from '../shared/types';
import runnerLogo from './assets/aim-runner.png';

// The Friends tab, dressed as a 1999 buddy list — beveled chrome, blue title
// bar, groups with (n/total) counts, and away messages. The joke is loving:
// a Win9x window floating on the night-sky theme. All the real machinery
// (mutual consent, requests, coarse schedules) is unchanged underneath.
//
// AIM-to-AUTOcarl mapping:
//   Sign On screen      -> enrollment
//   Buddies group       -> friends on your show (overlap = same jobNumber)
//   Buddies group       -> friends on a show WITH you (the only case where
//                          gig details are ever revealed — the server sends
//                          nothing but the intersection)
//   Co-Workers group    -> friends sharing schedules, no mutual show right now
//   Offline group       -> friends who haven't shared a schedule yet
//   Away message        -> their next gig (or the overlap line)
//   List Setup tab      -> add friend / pending invites / account

type Props = {
  bookings: Booking[];
  suggestedName: string;
};

// Module scope so they survive remounts: switching tabs mid-attempt must not
// fire a second concurrent enroll (which would take the 409→reissue path,
// mint a duplicate token, and false-alarm the "existing account" tripwire).
let enrollAttemptActive = false;
let enrollAttemptedThisSession = false;

type Pane = 'online' | 'setup';

export default function FriendsTab({ bookings, suggestedName }: Props) {
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [myName, setMyName] = useState('');
  const [name, setName] = useState('');
  const [list, setList] = useState<FriendsList | null>(null);
  const [pane, setPane] = useState<Pane>('online');
  const [addEmail, setAddEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expandedBuddy, setExpandedBuddy] = useState<string | null>(null);
  // Pending removal awaiting confirmation. Removing is mutual and immediate
  // with no undo, so it gets a period-appropriate confirm dialog.
  const [confirmRemove, setConfirmRemove] = useState<
    { email: string; label: string; kind: 'buddy' | 'invite' } | null
  >(null);
  // Set when sign-on attached to an EXISTING account for this email (second
  // device). Shown once — it's also the tripwire if someone else enrolled
  // this email first.
  const [linkedNotice, setLinkedNotice] = useState<string>('');

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const upcoming = bookings.filter((b) => parseISOLocal(b.endDate) >= today);

  const loadList = () => {
    window.api.friends.list().then(setList).catch((e) => setError(friendlyMsg(e)));
  };

  const [signedOut, setSignedOut] = useState(false);
  const [acctEmail, setAcctEmail] = useState('');

  useEffect(() => {
    window.api.friends.status().then((st) => {
      setEnrolled(st.enrolled);
      setMyName(st.name);
      setSignedOut(!!st.signedOut);
      setAcctEmail(st.email || '');
      if (st.enrolled) loadList();
    }).catch(() => setEnrolled(false));
  }, []);

  useEffect(() => {
    if (!name && suggestedName) setName(suggestedName);
  }, [suggestedName]);   // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); loadList(); } catch (e) { setError(friendlyMsg(e)); }
    setBusy(false);
  };

  // Shared by auto and manual sign-on: adopt the account's real display name
  // and surface it when we attached to an EXISTING account for this email —
  // normal for a second device, and the tripwire if someone else enrolled
  // this email first.
  const applySignOn = (st: Awaited<ReturnType<typeof window.api.friends.enroll>>, typed: string) => {
    setEnrolled(true);
    setMyName(st.name || typed.trim());
    if (st.linkedExisting) {
      const when = st.linkedExisting.accountCreatedAt
        ? ` (created ${new Date(st.linkedExisting.accountCreatedAt).toLocaleDateString()})`
        : '';
      setLinkedNotice(
        `Signed on to your existing friends account "${st.name}"${when}. ` +
        'If you never enrolled anywhere before, that account isn’t yours — tell John right away.',
      );
    }
  };

  // One enroll at a time, across remounts. A prior attempt may also have
  // finished while this tab was unmounted, so re-check status before
  // enrolling — enrolling twice would take the 409→reissue path and
  // false-alarm the "existing account" notice for our own account.
  const doEnroll = async (typed: string) => {
    if (enrollAttemptActive) return;
    enrollAttemptActive = true;
    try {
      const st0 = await window.api.friends.status();
      if (st0.enrolled) {
        setEnrolled(true);
        setMyName(st0.name);
        setSignedOut(false);
        return;
      }
      const st = await window.api.friends.enroll(typed);
      applySignOn(st, typed);
      setSignedOut(false);
    } finally {
      enrollAttemptActive = false;
    }
  };

  // Auto sign-on: being logged into AUTOcarl IS being on the buddy list.
  // One attempt per session. The screen name comes from the loaded
  // timesheet when there is one, else from the SSW identity lookup (works
  // on a fresh login with no cached weeks — SSW stores "Somers, John",
  // which flips to "John Somers"). The manual Sign On screen remains only
  // as the fallback when identity can't be found anywhere.
  const autoTried = useRef(false);
  useEffect(() => {
    if (enrolled !== false || signedOut) return;   // signed out on purpose stays out
    if (autoTried.current || enrollAttemptedThisSession || enrollAttemptActive || busy) return;
    autoTried.current = true;
    enrollAttemptedThisSession = true;
    void run(async () => {
      let autoName = suggestedName.trim();
      if (!autoName) {
        const ident = await window.api.ssw.identity().catch(() => null);
        autoName = flipName(ident?.name || '');
      }
      if (autoName) setName((cur) => cur || autoName);   // prefill the fallback screen
      if (!autoName) {
        // Nothing to sign on with (brand-new user, or SSW unreachable) —
        // fall back to the manual screen, and let a later-arriving
        // suggestedName re-try automatically.
        autoTried.current = false;
        enrollAttemptedThisSession = false;
        return;
      }
      await doEnroll(autoName);
    });
  }, [enrolled, suggestedName]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (enrolled === null) return null;

  // ---------- Sign On (enrollment) ----------
  if (!enrolled) {
    return (
      <div className="aim-window aim-signon">
        <div className="aim-titlebar">
          <span className="aim-titlebar-icon"><RunnerIcon size={12} /></span>
          <span>Sign On</span>
        </div>
        <AimBanner />
        <div className="aim-body">
          <div className="aim-field">
            <label>Screen Name</label>
            <input
              className="aim-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="aim-field">
            <label>Password</label>
            <input className="aim-input" type="password" value="hunter2" disabled readOnly />
            <span className="aim-fineprint">(relax — there is no password)</span>
          </div>
          <p className="aim-fineprint" style={{ maxWidth: 240 }}>
            You sign in with your C.A.R.L. login{acctEmail ? <> (<b>{acctEmail}</b>)</> : null} —
            it proves who you are, no extra password. Friends only ever see
            shows you're BOTH booked on — job, city, dates of the shared gig,
            nothing else. Both sides must accept.
          </p>
          <div className="aim-actions">
            <button
              className="aim-btn"
              disabled={busy || !name.trim()}
              onClick={() => {
                // A manual attempt also counts as this session's one shot —
                // a late-arriving suggested name must not auto-fire on top.
                enrollAttemptedThisSession = true;
                void run(() => doEnroll(name));
              }}
            >
              {busy ? 'Signing On…' : 'Sign On'}
            </button>
          </div>
          {error && <div className="aim-error">{error}</div>}
        </div>
      </div>
    );
  }

  // ---------- Buddy List ----------
  const accepted = list?.accepted ?? [];
  // The server only ever sends gigs you SHARE (intersection by job number),
  // so empty gigs means "no mutual shows" — updatedAt tells that apart from
  // "never shared a schedule at all".
  const buddies = accepted.filter((f) => overlapKindForFriend(f, upcoming) === 'gig');
  const coworkers = accepted.filter((f) => overlapKindForFriend(f, upcoming) !== 'gig' && f.updatedAt);
  const offline = accepted.filter((f) => overlapKindForFriend(f, upcoming) !== 'gig' && !f.updatedAt);
  const total = accepted.length;
  const incoming = list?.incoming ?? [];
  const outgoing = list?.outgoing ?? [];

  const toggleGroup = (g: string) => setCollapsed((c) => ({ ...c, [g]: !c[g] }));

  const buddyRow = (f: FriendEntry, offlineStyle = false) => {
    const kind = overlapKindForFriend(f, upcoming);
    const away = awayMessage(f, upcoming);
    const expanded = expandedBuddy === f.email;
    return (
      <div key={f.email}>
        <div
          className={`aim-buddy${offlineStyle ? ' aim-offline' : ''}`}
          onClick={() => setExpandedBuddy(expanded ? null : f.email)}
          title={expanded ? undefined : 'Click for schedule'}
        >
          {kind === 'gig' && (
            <span className="plane-icon aim-buddy-plane" style={{ width: 16, backgroundColor: '#003a9e' }} />
          )}
          <span className="aim-buddy-name">{f.name}</span>
          <button
            className="aim-x"
            title={`Remove ${f.name}`}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              setConfirmRemove({ email: f.email, label: f.name, kind: 'buddy' });
            }}
          >×</button>
        </div>
        {away && !expanded && <div className="aim-away">{away}</div>}
        {expanded && (
          <div className="aim-profile">
            {f.gigs.length === 0 && (
              <div className="aim-away">
                {f.updatedAt
                  ? 'No shows together right now — gigs only show when you\u2019re both on them.'
                  : 'No schedule shared yet.'}
              </div>
            )}
            {[...f.gigs].sort((a, b) => a.start.localeCompare(b.start)).map((g) => {
              const k = gigOverlapKind(g, upcoming);
              return (
                <div className={`aim-profile-gig${k ? ' is-overlap' : ''}`} key={`${g.jobNumber}-${g.start}`}>
                  {fmtRange(g.start, g.end)} · {g.jobName} ({g.city}{g.state ? `, ${g.state}` : ''})
                  {k === 'gig' ? ' — with you' : k === 'near' ? ' — near you' : ''}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const group = (label: string, members: FriendEntry[], offlineStyle = false) => (
    <div className="aim-group">
      <button className="aim-group-header" onClick={() => toggleGroup(label)}>
        <span className="aim-tri">{collapsed[label] ? '▶' : '▼'}</span>
        <span className={label === 'Buddies' ? 'aim-group-hl' : ''}>
          {label} ({members.length}/{total})
        </span>
      </button>
      {!collapsed[label] && members.map((f) => buddyRow(f, offlineStyle))}
    </div>
  );

  return (
    <div className="aim-window">
      <div className="aim-titlebar">
        <span className="aim-titlebar-icon"><RunnerIcon size={12} /></span>
        <span>{myName ? `${myName}'s Buddy List` : 'Buddy List'} ...</span>
      </div>
      <div className="aim-menubar">
        <span>My C.A.R.L.</span>
      </div>
      <AimBanner />
      <div className="aim-tabs">
        <button className={`aim-tab${pane === 'online' ? ' is-active' : ''}`} onClick={() => setPane('online')}>
          Online
        </button>
        <button className={`aim-tab${pane === 'setup' ? ' is-active' : ''}`} onClick={() => setPane('setup')}>
          List Setup
        </button>
      </div>

      {pane === 'online' && (
        <div className="aim-list">
          {linkedNotice && (
            <div className="aim-away" style={{ padding: '6px 8px' }}>
              {linkedNotice}{' '}
              <button className="aim-x" title="Dismiss" onClick={() => setLinkedNotice('')}>×</button>
            </div>
          )}
          {incoming.length > 0 && (
            <div className="aim-group">
              <div className="aim-group-header as-static">
                <span className="aim-tri">▼</span>
                <span className="aim-group-hl">Wants to be your Buddy ({incoming.length})</span>
              </div>
              {incoming.map((r) => (
                <div className="aim-buddy" key={r.email} title={r.email}>
                  <span className="aim-buddy-name">{r.name}</span>
                  <span className="aim-req-btns">
                    <button className="aim-btn aim-btn-sm" disabled={busy}
                      onClick={() => run(() => window.api.friends.respond(r.email, true))}>Accept</button>
                    <button className="aim-btn aim-btn-sm" disabled={busy}
                      onClick={() => run(() => window.api.friends.respond(r.email, false))}>Decline</button>
                  </span>
                </div>
              ))}
            </div>
          )}
          {group('Buddies', buddies)}
          {group('Co-Workers', coworkers)}
          {group('Offline', offline, true)}
          {total === 0 && incoming.length === 0 && (
            <div className="aim-away" style={{ marginTop: 8 }}>
              Your buddy list is empty. Head to List Setup to add a coworker.
            </div>
          )}
        </div>
      )}

      {pane === 'setup' && (
        <div className="aim-list">
          <div className="aim-setup-section">Add a Buddy</div>
          <div className="aim-add-row">
            <input
              className="aim-input"
              type="email"
              placeholder="coworker@email.com"
              value={addEmail}
              onChange={(e) => setAddEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && addEmail.trim()) run(async () => { await window.api.friends.request(addEmail.trim()); setAddEmail(''); }); }}
              disabled={busy}
            />
            <button className="aim-btn aim-btn-sm" disabled={busy || !addEmail.trim()}
              onClick={() => run(async () => { await window.api.friends.request(addEmail.trim()); setAddEmail(''); })}>
              Add Buddy
            </button>
          </div>
          <div className="aim-fineprint" style={{ margin: '4px 2px 10px' }}>
            The email they use for C.A.R.L. Nothing is shared until they accept.
          </div>
          {outgoing.length > 0 && (
            <>
              <div className="aim-setup-section">Pending Invites</div>
              {outgoing.map((r) => (
                <div className="aim-buddy aim-offline" key={r.email}>
                  <span className="aim-buddy-name">{r.email}</span>
                  <button className="aim-x" title="Cancel invite" disabled={busy}
                    onClick={() => setConfirmRemove({ email: r.email, label: r.email, kind: 'invite' })}>×</button>
                </div>
              ))}
            </>
          )}
          <div className="aim-setup-section">Account</div>
          <div className="aim-fineprint" style={{ margin: '2px 2px' }}>
            Signed on as <b>{myName}</b>. Friends only ever see the shows
            you share with them — nothing else.
          </div>
          <div className="aim-actions" style={{ marginTop: 8 }}>
            <button
              className="aim-btn"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  setBusy(true); setError('');
                  try {
                    await window.api.friends.signOut();
                    setEnrolled(false);
                    setSignedOut(true);
                    setList(null);
                    setPane('online');
                    setLinkedNotice('');
                  } catch (e) {
                    setError(friendlyMsg(e));
                  }
                  setBusy(false);
                })();
              }}
            >
              {busy ? 'Signing Off…' : 'Sign Out'}
            </button>
          </div>
          <div className="aim-fineprint" style={{ margin: '4px 2px' }}>
            Signing out hides your shows from friends. Sign back in any time
            with your C.A.R.L. login — your buddy list will be waiting.
          </div>
        </div>
      )}

      {confirmRemove && (
        <div className="aim-modal-backdrop" onClick={() => setConfirmRemove(null)}>
          <div className="aim-window aim-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="aim-titlebar">
              <span className="aim-titlebar-icon"><RunnerIcon size={12} /></span>
              <span>{confirmRemove.kind === 'buddy' ? 'Remove Buddy' : 'Cancel Invite'}</span>
            </div>
            <div className="aim-dialog-body">
              <span className="aim-dialog-bang">!</span>
              <div>
                {confirmRemove.kind === 'buddy' ? (
                  <>
                    Remove <b>{confirmRemove.label}</b> from your buddy list?
                    <div className="aim-fineprint" style={{ marginTop: 6 }}>
                      You'll each disappear from the other's list, and one of you
                      has to send a new request to reconnect.
                    </div>
                  </>
                ) : (
                  <>
                    Cancel your invite to <b>{confirmRemove.label}</b>?
                    <div className="aim-fineprint" style={{ marginTop: 6 }}>
                      They won't see the request anymore. You can send another later.
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className="aim-dialog-actions">
              <button
                className="aim-btn"
                disabled={busy}
                onClick={() => {
                  const email = confirmRemove.email;
                  setConfirmRemove(null);
                  void run(() => window.api.friends.remove(email));
                }}
              >{confirmRemove.kind === 'buddy' ? 'Remove' : 'Cancel Invite'}</button>
              <button className="aim-btn" onClick={() => setConfirmRemove(null)}>
                {confirmRemove.kind === 'buddy' ? 'Cancel' : 'Keep It'}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <div className="aim-error">{error}</div>}
      <div className="aim-statusbar">
        <span>{total} buddies</span>
        <button className="aim-refresh" onClick={loadList} disabled={busy}>⟳</button>
      </div>
    </div>
  );
}

// The banner: blue field, yellow runner, and the wordmark that keeps this on
// the right side of a trademark lawyer's desk.
function AimBanner() {
  return (
    <div className="aim-banner">
      <RunnerIcon size={44} />
      <div className="aim-banner-text">
        <span className="aim-banner-carl">C.A.R.L.</span>
        <span className="aim-banner-sub">Buddy<br />List<span className="aim-tm">™</span></span>
      </div>
    </div>
  );
}

// The yellow running man, allegedly late for load-in. Sized by height and left
// to work out its own width so the artwork's 250x279 proportions survive at
// both call sites — the 12px titlebar and the 44px banner.
function RunnerIcon({ size }: { size: number }) {
  return (
    <img
      src={runnerLogo}
      alt=""
      aria-hidden="true"
      style={{ height: size, width: 'auto', display: 'block' }}
    />
  );
}

// ---- overlap helpers (same rules as before the makeover) ----

function gigOverlapKind(g: FriendGig, mine: Booking[]): 'gig' | 'near' | null {
  for (const b of mine) {
    if (g.jobNumber && g.jobNumber === b.jobNumber && g.start <= b.endDate && b.startDate <= g.end) {
      return 'gig';
    }
  }
  for (const b of mine) {
    const sameCity = g.city && b.city
      && g.city.toLowerCase() === b.city.toLowerCase()
      && g.state.toLowerCase().slice(0, 2) === b.state.toLowerCase().slice(0, 2);
    if (sameCity && g.start <= b.endDate && b.startDate <= g.end) return 'near';
  }
  return null;
}

function overlapKindForFriend(f: FriendEntry, mine: Booking[]): 'gig' | 'near' | null {
  let best: 'gig' | 'near' | null = null;
  for (const g of f.gigs) {
    const k = gigOverlapKind(g, mine);
    if (k === 'gig') return 'gig';
    if (k === 'near') best = 'near';
  }
  return best;
}

// SSW writes names "Somers, John"; buddy lists read better as "John Somers".
function flipName(n: string): string {
  const m = n.trim().match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2]} ${m[1]}`.trim() : n.trim();
}

// The buddy's "away message": the shared show, or nothing. Privacy model:
// a gig is only ever mentioned when you're BOTH on it.
function awayMessage(f: FriendEntry, mine: Booking[]): string {
  for (const g of f.gigs) {
    if (gigOverlapKind(g, mine) === 'gig') {
      return `with you on ${g.jobName} · ${fmtRange(g.start, g.end)}`;
    }
  }
  return '';
}

function fmtRange(start: string, end: string): string {
  const f = (iso: string) => {
    const [, m, d] = iso.split('-');
    return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
  };
  return start === end ? f(start) : `${f(start)} – ${f(end)}`;
}

function parseISOLocal(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function friendlyMsg(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
}
