import { useEffect, useRef, useState } from 'react';
import type { Booking, FriendEntry, FriendGig, FriendsList } from '../shared/types';
import runnerLogo from './assets/aim-runner.png';
import { normalizeScreenName, SCREEN_NAME_MAX } from '../shared/screen-name';
import { fmtDates, groupBuddies, isoDay, jobTitles, sharedShows } from './buddy-groups';
import PhotoViewer from './PhotoViewer';

// The Friends tab, dressed as a 1999 buddy list — beveled chrome, blue title
// bar, groups with (n/total) counts, and away messages. The joke is loving:
// a Win9x window floating on the night-sky theme. All the real machinery
// (mutual consent, requests, coarse schedules) is unchanged underneath.
//
// AIM-to-AUTOcarl mapping:
//   Sign On screen      -> enrollment
//   Groups              -> your show in progress, or your next one when
//                          you're between shows (the soonest a buddy is on,
//                          see buddy-groups.ts): a group named for the job with
//                          the buddies on it, then "In <city> with you" for
//                          buddies there on the same dates under a job number
//                          of their own (the server sends only the city and
//                          the days you overlap, never the job), then everyone
//                          else under Buddies. One show is often split across
//                          several CT job numbers, so another of yours running
//                          alongside it in the same city gets its own group.
//   Away message        -> just that buddy's own dates at the show
//   Clicking a buddy    -> expands them in place to every show you share,
//                          with a button for their Buddy Info window
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

// The stored C.A.R.L. login changed: the one attempt this session belonged to
// the login before it, so the tab is allowed to try again for the one stored
// now — a corrected password included. An attempt still on the wire keeps its
// place: it finishes or is refused on its own, and taking it away here would
// let a second sign-on go out for the same person and mint a spare token.
export function forgetFriendsSession(): void {
  enrollAttemptedThisSession = false;
}

// How often the open Buddy List re-checks the server. Cheap: an unchanged
// list is a bodyless reply (ETag), so this is one small round trip.
const FRIENDS_POLL_MS = 20_000;
// Set on this device when the "saved at the old, smaller size" note is hidden.
const ICON_SOFT_HIDDEN_KEY = 'autocarl.buddyIconSoftNoteHidden';

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
  // Buddies expanded in place to every show you share (by email).
  const [openBuddies, setOpenBuddies] = useState<Record<string, boolean>>({});
  // The buddy whose Buddy Info window is open (by email), or null.
  const [profileEmail, setProfileEmail] = useState<string | null>(null);
  // A buddy icon open full screen from Buddy Info, or null.
  const [fullIcon, setFullIcon] = useState<{ src: string; name: string } | null>(null);
  useEffect(() => {
    if (!profileEmail) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setProfileEmail(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [profileEmail]);
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
        setIconSoft(!!l.me?.iconSoft);
        setError('');   // a list that just loaded is not "failed to load"
      })
      .catch((e) => { if (!quiet) setError(friendlyMsg(e)); });
  };

  const [signedOut, setSignedOut] = useState(false);
  const [acctEmail, setAcctEmail] = useState('');
  const [copiedEmail, setCopiedEmail] = useState(false);
  // Own buddy icon (local preview; the server copy is what friends see).
  const [myAvatar, setMyAvatar] = useState('');
  // Whether the icon buddies see is one saved before icons kept their
  // resolution: soft in Buddy Info, and only choosing the original picture
  // again fixes it. The service checks its own copy, so every device agrees.
  // The note can be hidden, since a picture that really is 96px, or one whose
  // original is gone, can't be improved.
  const [iconSoft, setIconSoft] = useState(false);
  const [iconSoftHidden, setIconSoftHidden] = useState(() => {
    try { return localStorage.getItem(ICON_SOFT_HIDDEN_KEY) === '1'; } catch { return false; }
  });
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

  // `refresh` goes off for a job that can finish with no buddy list to load:
  // asking for one while signed out answers "Friends is not turned on", which
  // is nothing gone wrong and does not belong on the Sign On screen.
  const run = async (fn: () => Promise<void>, refresh = true) => {
    setBusy(true); setError('');
    try { await fn(); if (refresh) loadList(); } catch (e) { setError(friendlyMsg(e)); }
    setBusy(false);
  };

  // Buddy icon intake: animated GIFs are stored as-is (re-encoding would
  // freeze them) under a hard size cap; still images are cropped square and
  // kept sharp enough for Buddy Info (see stillIconDataUri).
  const onAvatarFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    void run(async () => {
      let dataUri: string;
      if (f.type === 'image/gif') {
        if (f.size > 200 * 1024) throw new Error('That GIF is too big — keep it under 200KB so buddy lists stay quick.');
        dataUri = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(fr.error ?? new Error('read failed'));
          fr.readAsDataURL(f);
        });
      } else if (f.type.startsWith('image/')) {
        const bmp = await createImageBitmap(f).catch(() => null);
        if (!bmp) throw new Error("Couldn't read that image — try a JPG, PNG, or GIF.");
        try {
          dataUri = stillIconDataUri(bmp);
        } finally {
          bmp.close();
        }
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
      loadList();
    }, false);
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
  // on overlapping dates), so empty gigs means "no mutual shows" — updatedAt
  // tells that apart from "never shared a schedule at all".
  const groups = groupBuddies(accepted, upcoming, isoDay(today));
  const jobGroupNames = jobTitles(groups.jobs.map((j) => ({
    name: j.show.jobName || j.show.jobNumber, jobNumber: j.show.jobNumber,
  })));
  const total = accepted.length;
  const profileBuddy = profileEmail ? accepted.find((x) => x.email === profileEmail) ?? null : null;
  const incoming = list?.incoming ?? [];
  const outgoing = list?.outgoing ?? [];

  const toggleGroup = (g: string) => setCollapsed((c) => ({ ...c, [g]: !c[g] }));
  const toggleBuddy = (email: string) => setOpenBuddies((o) => ({ ...o, [email]: !o[email] }));

  // Every show you share with a buddy, for their expanded row and their
  // Buddy Info window alike.
  const sharedList = (f: FriendEntry) => {
    const shows = sharedShows(groups.shared.get(f.email) ?? []);
    if (shows.length === 0) {
      return (
        <div className="aim-shared-none">
          {f.updatedAt
            ? 'No shows together coming up. A show lists here when you’re on the same job, or in the same city on the same dates.'
            : 'No schedule shared yet.'}
        </div>
      );
    }
    return shows.map((sh) => (
      <div className="aim-shared-show" key={sh.key}>
        <div className="aim-shared-title">{sh.title}</div>
        {sh.lines.map((line, i) => <div className="aim-shared-when" key={i}>{line}</div>)}
      </div>
    ));
  };

  // `dates` is the buddy's own dates at the show their group is named for.
  const buddyRow = (f: FriendEntry, dates?: FriendGig[]) => {
    const open = !!openBuddies[f.email];
    return (
      <div key={f.email}>
        <div
          className={`aim-buddy${open ? ' is-open' : ''}`}
          onClick={() => toggleBuddy(f.email)}
          title={open ? undefined : 'Click for your shows together'}
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
        {dates && dates.length > 0 && <div className="aim-away aim-buddy-dates">{fmtDates(dates)}</div>}
        {open && (
          <div className="aim-profile aim-shared">
            {sharedList(f)}
            <button className="aim-btn aim-btn-sm" onClick={() => setProfileEmail(f.email)}>Buddy Info</button>
          </div>
        )}
      </div>
    );
  };

  const group = (id: string, label: string, rows: JSX.Element[], highlight = false) => (
    <div className="aim-group" key={id}>
      <button className="aim-group-header" onClick={() => toggleGroup(id)}>
        <span className="aim-tri">{collapsed[id] ? '▶' : '▼'}</span>
        <span className={highlight ? 'aim-group-hl' : ''}>
          {label} ({rows.length}/{total})
        </span>
      </button>
      {!collapsed[id] && rows}
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
          {groups.jobs.map((j, i) => group(
            `job:${j.show.jobNumber}`,
            jobGroupNames[i],
            j.members.map((p) => buddyRow(p.buddy, p.dates)),
            i === 0,
          ))}
          {groups.town && group(
            `town:${groups.town.show.bookingId}`,
            `In ${groups.town.show.city} with you`,
            groups.town.members.map((p) => buddyRow(p.buddy, p.dates)),
            groups.jobs.length === 0,
          )}
          {(groups.rest.length > 0 || (groups.jobs.length === 0 && !groups.town)) && group(
            'Buddies',
            'Buddies',
            groups.rest.map((f) => buddyRow(f)),
            groups.jobs.length === 0 && !groups.town,
          )}
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
          {iconSoft && !iconSoftHidden && (
            <div className="aim-fineprint" style={{ margin: '4px 2px', color: '#7a4b00' }}>
              Your icon was saved at the old, smaller size, so it looks soft when a
              buddy opens your Buddy Info. Choose the original picture again to make
              it sharp.{' '}
              <button
                type="button"
                style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: '#003a9e', textDecoration: 'underline', cursor: 'pointer' }}
                onClick={() => {
                  setIconSoftHidden(true);
                  try { localStorage.setItem(ICON_SOFT_HIDDEN_KEY, '1'); } catch { /* hidden for this session only */ }
                }}
              >Hide</button>
            </div>
          )}
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

      {profileBuddy && (() => {
        const f = profileBuddy;
        const close = () => setProfileEmail(null);
        return (
          <div className="aim-modal-backdrop" onClick={close}>
            <div
              className="aim-window aim-dialog aim-buddy-info"
              role="dialog"
              aria-label={`Buddy Info: ${f.name}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="aim-titlebar">
                <span className="aim-titlebar-icon"><RunnerIcon size={12} /></span>
                <span className="aim-titlebar-text">Buddy Info: {f.name}</span>
                <button className="aim-titlebar-close" aria-label="Close" onClick={close}>×</button>
              </div>
              <div className="aim-buddy-info-head">
                <BuddyIcon
                  src={f.avatar}
                  name={f.name}
                  seed={f.email}
                  profile
                  onOpen={f.avatar ? () => setFullIcon({ src: f.avatar!, name: f.name }) : undefined}
                />
                <div className="aim-buddy-info-who">
                  <div className="aim-buddy-info-name">{f.name}</div>
                </div>
              </div>
              <div className="aim-profile aim-buddy-info-gigs">
                {sharedList(f)}
              </div>
              <div className="aim-dialog-actions">
                <button className="aim-btn" onClick={close}>Close</button>
              </div>
            </div>
          </div>
        );
      })()}

      {fullIcon && (
        <PhotoViewer
          src={fullIcon.src}
          alt={`${fullIcon.name}'s buddy icon`}
          crispUpTo={PIXEL_ART_MAX}
          onClose={() => setFullIcon(null)}
        />
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

// ---- buddy icon from a still image ----
// Buddy Info shows an icon 96px across, and a phone paints each of those
// pixels with two or three of its own, so an icon stored at 96px was
// stretched up to three times over and looked soft. A still image is cropped
// square and kept at up to 288px, never enlarged past what was uploaded.
// A photo is saved as JPEG on white, which keeps a 288px photo to a few dozen
// KB. A picture with see-through parts stays PNG, since on white it would
// show a white square on a highlighted buddy row, and so does anything 128px
// or smaller, tiny either way. Every buddy list carries every buddy's icon,
// so an unusually heavy result steps down in quality, then in size.
const ICON_MAX_SIDE = 288;
const ICON_SMALL_SIDE = 128;
const ICON_BUDGET = 150_000;   // characters of data URI
// An icon this small or smaller is pixel art (a classic AIM icon is about
// 48px) and has no bigger copy anywhere; see BuddyIcon.
const PIXEL_ART_MAX = 64;

function stillIconDataUri(bmp: ImageBitmap): string {
  const draw = (side: number, white: boolean): HTMLCanvasElement => {
    const canvas = document.createElement('canvas');
    canvas.width = side; canvas.height = side;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Couldn't read that image.");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (white) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, side, side); }
    const scale = Math.max(side / bmp.width, side / bmp.height);
    const w = bmp.width * scale, h = bmp.height * scale;
    ctx.drawImage(bmp, (side - w) / 2, (side - h) / 2, w, h);
    return canvas;
  };
  const side = Math.min(ICON_MAX_SIDE, bmp.width, bmp.height);
  if (side <= ICON_SMALL_SIDE) return draw(side, false).toDataURL('image/png');
  const sides = [side, 240, 192].filter((x, i, all) => x <= side && all.indexOf(x) === i);
  const plain = draw(side, false);
  if (hasSeeThrough(plain)) {
    for (const s of sides) {
      const png = (s === side ? plain : draw(s, false)).toDataURL('image/png');
      if (png.length <= ICON_BUDGET) return png;
    }
    return draw(ICON_SMALL_SIDE, false).toDataURL('image/png');
  }
  let out = '';
  for (const s of sides) {
    const canvas = draw(s, true);
    for (const quality of [0.9, 0.8, 0.7]) {
      out = canvas.toDataURL('image/jpeg', quality);
      if (out.length <= ICON_BUDGET) return out;
    }
  }
  return out;
}

function hasSeeThrough(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
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

// `onOpen`, for Buddy Info: the icon is a button that opens it full screen.
function BuddyIcon({ src, name, seed, preview = false, profile = false, onOpen }: {
  src?: string | null; name: string; seed: string; preview?: boolean; profile?: boolean;
  onOpen?: () => void;
}) {
  const cls = profile ? 'aim-avatar-profile' : preview ? 'aim-avatar-preview' : 'aim-buddy-avatar';
  const alt = preview ? 'Your buddy icon' : profile ? `${name}'s buddy icon` : '';
  // Buddy Info blows an icon up to about 96px. Smoothing turns a classic
  // 50px AIM icon to mush at that size, and no sharper copy exists, so a
  // pixel-art-sized icon is drawn with hard pixels at a whole-number scale
  // instead: 50px shows at 100px, each source pixel an even 2x2 block.
  const [pixelArt, setPixelArt] = useState<{ src: string; size: number } | null>(null);
  if (src) {
    const pixelSize = pixelArt && pixelArt.src === src ? pixelArt.size : null;
    const img = (
      <img
        className={`${cls}${pixelSize ? ' is-pixel-art' : ''}`}
        src={src}
        alt={alt}
        style={pixelSize ? { width: pixelSize, height: pixelSize } : undefined}
        onLoad={profile ? (e) => {
          const n = Math.max(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);
          if (n > 0 && n <= PIXEL_ART_MAX) setPixelArt({ src, size: n * Math.max(2, Math.round(96 / n)) });
        } : undefined}
      />
    );
    if (!onOpen) return img;
    return (
      <button
        type="button"
        className="aim-avatar-open"
        onClick={onOpen}
        aria-label={`View ${name}'s buddy icon full screen`}
        title="View full screen"
      >
        {img}
      </button>
    );
  }
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

// SSW writes names "Somers, John"; buddy lists read better as "John Somers".
function flipName(n: string): string {
  const m = n.trim().match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2]} ${m[1]}`.trim() : n.trim();
}

function parseISOLocal(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function friendlyMsg(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
}
