import { useEffect, useRef, useState } from 'react';
import type { Booking, FriendEntry, FriendGig, FriendsList } from '../shared/types';
import runnerLogo from './assets/aim-runner.png';
import { normalizeScreenName, SCREEN_NAME_MAX } from '../shared/screen-name';

// The Friends tab, dressed as a 1999 buddy list — beveled chrome, blue title
// bar, groups with (n/total) counts, and away messages. The joke is loving:
// a Win9x window floating on the night-sky theme. All the real machinery
// (mutual consent, requests, coarse schedules) is unchanged underneath.
//
// AIM-to-AUTOcarl mapping:
//   Sign On screen      -> enrollment
//   Buddies group       -> friends on a show WITH you (same job number: the
//                          gig in full) or in the same city at the same time
//                          (a different job number: the server sends only the
//                          city and the days you overlap, never the job). One
//                          show is often split across several CT job numbers.
//   (One list only, no Co-Workers/Offline split. Show-sharers sort first.)
//   Away message        -> the shared show + its city + dates
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

// How often the open Buddy List re-checks the server. Cheap: an unchanged
// list is a bodyless reply (ETag), so this is one small round trip.
const FRIENDS_POLL_MS = 20_000;

type Pane = 'online' | 'setup' | 'customize' | 'screenname';

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

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const upcoming = bookings.filter((b) => parseISOLocal(b.endDate) >= today);

  // Every load is numbered so a slow reply can't overwrite a newer one —
  // a background poll that left before you accepted a request must not
  // land after the reload that followed it. The gate is "newer than the
  // last reply APPLIED", not "the last one dispatched": a poll that fires
  // and fails while your reload is in flight must not swallow the reload.
  const loadGen = useRef(0);
  const appliedGen = useRef(0);
  const loadList = (quiet = false) => {
    const gen = ++loadGen.current;
    window.api.friends.list()
      .then((l) => {
        if (gen <= appliedGen.current) return;
        appliedGen.current = gen;
        setList(l);
        if (l.me?.name) setMyName(l.me.name);
        setError('');   // a list that just loaded is not "failed to load"
      })
      .catch((e) => { if (!quiet) setError(friendlyMsg(e)); });
  };

  const [signedOut, setSignedOut] = useState(false);
  const [acctEmail, setAcctEmail] = useState('');
  const [copiedEmail, setCopiedEmail] = useState(false);
  // Own buddy icon (local preview; the server copy is what friends see).
  const [myAvatar, setMyAvatar] = useState('');
  const avatarInputRef = useRef<HTMLInputElement>(null);
  // Screen Name tab: the draft being edited, and whether the last save landed.
  const [screenDraft, setScreenDraft] = useState('');
  const [screenSaved, setScreenSaved] = useState(false);
  // The box follows your saved name until you start typing; a background
  // list refresh must never overwrite a name you're in the middle of.
  const screenDirty = useRef(false);
  useEffect(() => { if (!screenDirty.current) setScreenDraft(myName); }, [myName]);

  useEffect(() => {
    window.api.friends.status().then((st) => {
      setEnrolled(st.enrolled);
      setMyName(st.name);
      setSignedOut(!!st.signedOut);
      setAcctEmail(st.email || '');
      setMyAvatar(st.avatar || '');
      if (st.enrolled) loadList();
    }).catch(() => setEnrolled(false));
  }, []);

  useEffect(() => {
    if (!name && suggestedName) setName(suggestedName);
  }, [suggestedName]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Nothing on this screen changes by your own hand alone: the request you
  // sent gets accepted on someone else's phone, an invite arrives while
  // you're looking at the list. So while the tab is open and the app is in
  // front, re-check on a timer (an unchanged list is a bodyless reply — see
  // friends.list), and re-check the moment the app comes back to the
  // foreground. Background failures stay silent; the ⟳ button still
  // reports its own.
  useEffect(() => {
    if (!enrolled) return;
    let lastAt = Date.now();
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      lastAt = Date.now();
      loadList(true);
    };
    const onWake = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastAt > 3_000) tick();
    };
    const id = window.setInterval(tick, FRIENDS_POLL_MS);
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [enrolled]);   // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); loadList(); } catch (e) { setError(friendlyMsg(e)); }
    setBusy(false);
  };

  // Buddy icon intake: animated GIFs are stored as-is (re-encoding would
  // freeze them) under a hard size cap; still images are cover-cropped to
  // 96×96 so even a 12MP photo becomes a few KB.
  const onAvatarFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    void run(async () => {
      let dataUri: string;
      if (f.type === 'image/gif') {
        if (f.size > 512 * 1024) throw new Error('That GIF is too big — keep it under 512KB so buddy lists stay quick.');
        dataUri = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(fr.error ?? new Error('read failed'));
          fr.readAsDataURL(f);
        });
      } else if (f.type.startsWith('image/')) {
        const bmp = await createImageBitmap(f).catch(() => null);
        if (!bmp) throw new Error("Couldn't read that image — try a JPG, PNG, or GIF.");
        const SIZE = 96;
        const canvas = document.createElement('canvas');
        canvas.width = SIZE; canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error("Couldn't read that image.");
        const scale = Math.max(SIZE / bmp.width, SIZE / bmp.height);
        const w = bmp.width * scale, h = bmp.height * scale;
        ctx.drawImage(bmp, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
        dataUri = canvas.toDataURL('image/png');
      } else {
        throw new Error('Pick an image or GIF.');
      }
      await window.api.friends.setAvatar(dataUri);
      setMyAvatar(dataUri);
    });
  };

  const saveScreenName = () => {
    const sn = normalizeScreenName(screenDraft);
    if ('error' in sn) { setError(sn.error); return; }
    setScreenSaved(false);
    void run(async () => {
      const saved = await window.api.friends.setName(sn.name);
      // A list load sent before the save still carries the old name; its
      // reply must not land on top of this one.
      appliedGen.current = loadGen.current;
      screenDirty.current = false;
      setMyName(saved);
      setScreenDraft(saved);
      setScreenSaved(true);
    });
  };

  const removeAvatar = () => {
    void run(async () => {
      await window.api.friends.setAvatar('');
      setMyAvatar('');
    });
  };

  // Shared by auto and manual sign-on: adopt the account's real display name
  // and surface it when we attached to an EXISTING account for this email —
  // normal for a second device, and the tripwire if someone else enrolled
  // this email first.
  const applySignOn = (st: Awaited<ReturnType<typeof window.api.friends.enroll>>, typed: string) => {
    setEnrolled(true);
    setMyName(st.name || typed.trim());
    // Reattaching to an existing account (second device) is the normal case
    // and shows no notice; the server still records first-verified sign-ons
    // for auditing.
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
      // Timesheets store "Last, First"; an unusable name (an email, say)
      // falls through to the manual screen rather than becoming the name.
      const auto = normalizeScreenName(autoName);
      autoName = 'name' in auto ? auto.name : '';
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
              placeholder="Your name, like Jane Smith"
              maxLength={60}
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
            shows you're BOTH booked on (job, city, dates) and, when you're in
            the same city at the same time, just that city and those days.
            Nothing else. Both sides must accept.
          </p>
          <div className="aim-actions">
            <button
              className="aim-btn"
              disabled={busy || !name.trim()}
              onClick={() => {
                // A manual attempt also counts as this session's one shot —
                // a late-arriving suggested name must not auto-fire on top.
                const sn = normalizeScreenName(name);
                if ('error' in sn) { setError(sn.error); return; }
                enrollAttemptedThisSession = true;
                void run(() => doEnroll(sn.name));
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
  // The server only ever sends gigs you SHARE (same job number, or same city
  // on overlapping dates), so empty gigs means "no mutual shows" — updatedAt tells that apart from
  // "never shared a schedule at all".
  // ONE list. Friends sharing a show with you float to the top (soonest
  // shared show first); everyone else follows alphabetically.
  const soonestShared = (f: FriendEntry): string => {
    const dates = f.gigs
      .filter((g) => gigOverlapKind(g, upcoming) !== null)
      .map((g) => g.start)
      .sort();
    return dates[0] ?? '';
  };
  const buddies = [...accepted].sort((a, b) => {
    const sa = soonestShared(a);
    const sb = soonestShared(b);
    if (!!sa !== !!sb) return sa ? -1 : 1;
    if (sa && sb && sa !== sb) return sa.localeCompare(sb);
    return a.name.localeCompare(b.name);
  });
  const total = accepted.length;
  const incoming = list?.incoming ?? [];
  const outgoing = list?.outgoing ?? [];

  const toggleGroup = (g: string) => setCollapsed((c) => ({ ...c, [g]: !c[g] }));

  const buddyRow = (f: FriendEntry, offlineStyle = false) => {
    const away = awayMessage(f, upcoming);
    const expanded = expandedBuddy === f.email;
    return (
      <div key={f.email}>
        <div
          className={`aim-buddy${offlineStyle ? ' aim-offline' : ''}`}
          onClick={() => setExpandedBuddy(expanded ? null : f.email)}
          title={expanded ? undefined : 'Click for schedule'}
        >
          <BuddyIcon src={f.avatar} name={f.name} seed={f.email} />
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
                  ? 'No shows together right now. A gig shows here when you\u2019re on the same job, or in the same city on the same dates.'
                  : 'No schedule shared yet.'}
              </div>
            )}
            {[...f.gigs].sort((a, b) => a.start.localeCompare(b.start)).map((g, i) => {
              const k = gigOverlapKind(g, upcoming);
              const where = `${g.city}${g.state ? `, ${g.state}` : ''}`;
              return (
                <div className={`aim-profile-gig${k ? ' is-overlap' : ''}`} key={`${g.jobNumber}-${g.start}-${i}`}>
                  {fmtRange(g.start, g.end)} · {g.jobName ? `${g.jobName} (${where})` : `in ${where}`}
                  {k === 'gig' ? ' \u2014 with you' : k === 'near' ? ' \u2014 same city, same dates' : ''}
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
          Friends
        </button>
        <button className={`aim-tab${pane === 'setup' ? ' is-active' : ''}`} onClick={() => setPane('setup')}>
          List Setup
        </button>
        <button className={`aim-tab${pane === 'customize' ? ' is-active' : ''}`} onClick={() => setPane('customize')}>
          Customize
        </button>
        <button className={`aim-tab${pane === 'screenname' ? ' is-active' : ''}`} onClick={() => setPane('screenname')}>
          Screen Name
        </button>
      </div>

      {pane === 'online' && (
        <div className="aim-list">
          {list && myName.includes('@') && (
            <button className="aim-nudge" onClick={() => setPane('screenname')}>
              Your buddies see your email as your screen name.{' '}
              <b>Set your Screen Name ›</b>
            </button>
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
          <div className="aim-fineprint" style={{ margin: '2px 2px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <BuddyIcon src={myAvatar} name={myName} seed={acctEmail || myName} />
            <span>
              Signed on as <b>{myName}</b>. Friends only ever see the shows
              you share with them, plus just the city and days when you're in
              the same city at the same time. Nothing else.
            </span>
          </div>
          {acctEmail && (
            <>
              <div className="aim-add-row" style={{ marginTop: 8 }}>
                <input
                  className="aim-input"
                  readOnly
                  value={acctEmail}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Your buddy email"
                />
                <button
                  className="aim-btn aim-btn-sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(acctEmail).then(() => {
                      setCopiedEmail(true);
                      window.setTimeout(() => setCopiedEmail(false), 1800);
                    }).catch(() => { /* the field still select-alls on tap */ });
                  }}
                >
                  {copiedEmail ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <div className="aim-fineprint" style={{ margin: '4px 2px' }}>
                Send a coworker this email — it's the one they Add Buddy with
                to find you.
              </div>
            </>
          )}
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

      {pane === 'screenname' && (() => {
        const check = normalizeScreenName(screenDraft);
        const unchanged = 'name' in check && check.name === myName;
        return (
          <div className="aim-list">
            <div className="aim-setup-section">Screen Name</div>
            <div className="aim-fineprint" style={{ margin: '2px 2px 6px' }}>
              The name your buddies see next to your icon. Use the name your
              coworkers know you by.
            </div>
            <div className="aim-add-row">
              <input
                className="aim-input"
                type="text"
                value={screenDraft}
                maxLength={60}
                placeholder="Your name, like Jane Smith"
                onChange={(e) => { screenDirty.current = true; setScreenDraft(e.target.value); setScreenSaved(false); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !unchanged && 'name' in check) saveScreenName(); }}
                disabled={busy}
              />
              <button className="aim-btn" disabled={busy || unchanged || 'error' in check} onClick={saveScreenName}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
            {'error' in check && screenDraft.trim() !== '' && <div className="aim-error">{check.error}</div>}
            {'name' in check && check.name !== screenDraft.replace(/\s+/g, ' ').trim() && (
              <div className="aim-fineprint" style={{ margin: '4px 2px' }}>
                Buddies will see: <b>{check.name}</b>
              </div>
            )}
            {screenSaved && unchanged && (
              <div className="aim-fineprint aim-saved" style={{ margin: '4px 2px' }}>
                Saved! Buddies now see <b>{myName}</b>.
              </div>
            )}
            <div className="aim-fineprint" style={{ margin: '6px 2px', color: '#777' }}>
              Up to {SCREEN_NAME_MAX} characters. A timesheet-style name like
              {' '}&ldquo;Smith, Jane&rdquo; is flipped to &ldquo;Jane Smith&rdquo;.
            </div>
            {error && <div className="aim-error">{error}</div>}
          </div>
        );
      })()}

      {pane === 'customize' && (
        <div className="aim-list">
          <div className="aim-setup-section">Buddy Icon</div>
          <div className="aim-fineprint" style={{ margin: '2px 2px' }}>
            Your icon shows next to your name on your friends' buddy lists.
            A GIF stays animated; photos are cropped square. Need one?{' '}
            <a
              href="https://myoldicons.com"
              target="_blank"
              rel="noreferrer"
              style={{ color: '#003a9e', fontWeight: 600 }}
            >
              Browse classic AIM icons at myoldicons.com
            </a>{' '}
            — save one you like, then Choose Icon.
          </div>
          <div className="aim-avatar-row">
            <BuddyIcon src={myAvatar} name={myName} seed={acctEmail || myName} preview />
            <div className="aim-actions" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/gif,image/png,image/jpeg,image/webp"
                hidden
                onChange={onAvatarFile}
              />
              <button className="aim-btn" disabled={busy} onClick={() => avatarInputRef.current?.click()}>
                {busy ? 'Working…' : myAvatar ? 'Change Icon…' : 'Choose Icon…'}
              </button>
              {myAvatar && (
                <button className="aim-btn" disabled={busy} onClick={removeAvatar}>Remove Icon</button>
              )}
            </div>
          </div>
          {error && <div className="aim-error">{error}</div>}
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
        <button className="aim-refresh" onClick={() => loadList()} disabled={busy}>⟳</button>
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

// ---- default buddy icon ----
// Anyone who hasn't chosen an icon gets their initial in white on a
// gradient. The colour comes from the account email, so a person looks the
// same on every buddy list and keeps their colour if they rename themselves.
const ICON_COLOURS = ['#1e6bd6', '#d6441e', '#2fa84f', '#8e44d6', '#d6961e', '#1e9fd6', '#d61e74', '#56697d'];

function iconColour(seed: string): string {
  const key = seed.trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return ICON_COLOURS[h % ICON_COLOURS.length];
}

function BuddyIcon({ src, name, seed, preview = false }: {
  src?: string | null; name: string; seed: string; preview?: boolean;
}) {
  const cls = preview ? 'aim-avatar-preview' : 'aim-buddy-avatar';
  if (src) return <img className={cls} src={src} alt={preview ? 'Your buddy icon' : ''} />;
  const letter = (name.match(/[A-Za-z0-9]/)?.[0] || seed.match(/[A-Za-z0-9]/)?.[0] || '?').toUpperCase();
  return (
    <span
      className={`${cls} aim-icon-default`}
      style={{ background: `linear-gradient(135deg, ${iconColour(seed || name)} 0%, #222 100%)` }}
      aria-hidden={preview ? undefined : true}
      title={preview ? 'Your default buddy icon. Choose one to replace it.' : undefined}
    >
      {letter}
    </span>
  );
}

// ---- overlap helpers ----
//   'gig'  = the same job number on overlapping dates
//   'near' = a different job number, same city, overlapping dates: usually
//            the same show under another CT office's job number
// Both count as being on a show together.

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

// SSW writes names "Somers, John"; buddy lists read better as "John Somers".
function flipName(n: string): string {
  const m = n.trim().match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2]} ${m[1]}`.trim() : n.trim();
}

// The buddy's "away message": the shared show, or nothing. A gig is only
// ever mentioned when you share it (same job, or same city on the same dates).
function awayMessage(f: FriendEntry, mine: Booking[]): string {
  for (const g of f.gigs) {
    if (gigOverlapKind(g, mine) === 'gig') {
      return `with you on ${g.jobName}${g.city ? ` in ${g.city}` : ''} · ${fmtRange(g.start, g.end)}`;
    }
  }
  for (const g of f.gigs) {
    if (gigOverlapKind(g, mine) === 'near') {
      return `in ${g.city} with you · ${fmtRange(g.start, g.end)}`;
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
