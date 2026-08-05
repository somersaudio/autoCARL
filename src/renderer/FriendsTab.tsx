import { useEffect, useState } from 'react';
import type { Booking, FriendEntry, FriendGig, FriendsList } from '../shared/types';

// Full-screen Friends tab: mutual-consent gig sharing. The card version lived
// on the Bookings tab; with a whole screen we can show each friend's actual
// upcoming shows, with the rows that overlap yours called out.

type Props = {
  bookings: Booking[];
  suggestedName: string;
};

export default function FriendsTab({ bookings, suggestedName }: Props) {
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [name, setName] = useState('');
  const [list, setList] = useState<FriendsList | null>(null);
  const [addEmail, setAddEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const upcoming = bookings.filter((b) => parseISOLocal(b.endDate) >= today);

  const loadList = () => {
    window.api.friends.list().then(setList).catch((e) => setError(friendlyMsg(e)));
  };

  useEffect(() => {
    window.api.friends.status().then((st) => {
      setEnrolled(st.enrolled);
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

  if (enrolled === null) return null;

  if (!enrolled) {
    return (
      <div className="card">
        <h3>Friends</h3>
        <p className="subtle" style={{ marginTop: 0, fontSize: 12 }}>
          See when friends are on your show, or working in the same city while
          you're there. Sharing is mutual-consent only: friends you approve see
          your upcoming shows (job, city, dates — nothing more), and you see
          theirs. Turn it off anytime by asking John to remove you.
        </p>
        <div className="row-actions" style={{ gap: 10, alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 1, margin: 0, maxWidth: 260 }}>
            <label>Your name (as coworkers know you)</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
          </div>
          <button
            className="primary"
            disabled={busy || !name.trim()}
            onClick={() => run(async () => {
              await window.api.friends.enroll(name);
              setEnrolled(true);
            })}
          >
            {busy ? 'Turning on…' : 'Turn on Friends'}
          </button>
        </div>
        {error && <div className="banner error" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    );
  }

  const hasRequests = !!list && (list.incoming.length > 0 || list.outgoing.length > 0);

  return (
    <>
      {hasRequests && (
        <div className="card">
          <h3>Requests</h3>
          {list!.incoming.map((r) => (
            <div className="friend-row" key={r.email}>
              <div className="friend-main">
                <span className="friend-name">{r.name}</span>
                <span className="subtle friend-status">wants to connect · {r.email}</span>
              </div>
              <button className="primary friend-btn" disabled={busy}
                onClick={() => run(() => window.api.friends.respond(r.email, true))}>Accept</button>
              <button className="secondary friend-btn" disabled={busy}
                onClick={() => run(() => window.api.friends.respond(r.email, false))}>Decline</button>
            </div>
          ))}
          {list!.outgoing.map((r) => (
            <div className="friend-row" key={r.email}>
              <div className="friend-main">
                <span className="friend-name subtle">{r.email}</span>
                <span className="subtle friend-status">invited · waiting for them to accept</span>
              </div>
              <button className="link friend-btn" disabled={busy}
                onClick={() => run(() => window.api.friends.remove(r.email))}>✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Friends</h3>
          <button className="link" onClick={loadList} disabled={busy}>Refresh</button>
        </div>

        {list && list.accepted.length === 0 && (
          <p className="subtle" style={{ fontSize: 12, margin: '8px 0 2px' }}>
            No friends yet — add a coworker below. They approve you on their end
            before either of you sees anything.
          </p>
        )}

        {list?.accepted.map((f) => (
          <FriendBlock key={f.email} friend={f} mine={upcoming} busy={busy}
            onRemove={() => run(() => window.api.friends.remove(f.email))} />
        ))}
      </div>

      <div className="card">
        <h3>Add a friend</h3>
        <p className="subtle" style={{ marginTop: 0, fontSize: 12 }}>
          Enter the email they use for C.A.R.L. Nothing is shared until they accept.
        </p>
        <div className="row-actions" style={{ gap: 8 }}>
          <input
            className="friend-add-input"
            type="email"
            placeholder="coworker@email.com"
            value={addEmail}
            onChange={(e) => setAddEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && addEmail.trim()) run(async () => { await window.api.friends.request(addEmail.trim()); setAddEmail(''); }); }}
            disabled={busy}
          />
          <button className="secondary" disabled={busy || !addEmail.trim()}
            onClick={() => run(async () => { await window.api.friends.request(addEmail.trim()); setAddEmail(''); })}>
            Add friend
          </button>
        </div>
        {error && <div className="banner error" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </>
  );
}

// One friend: name, best-overlap summary, and their upcoming shows with the
// overlapping rows marked.
function FriendBlock({ friend, mine, busy, onRemove }: {
  friend: FriendEntry; mine: Booking[]; busy: boolean; onRemove: () => void;
}) {
  const gigs = [...friend.gigs].sort((a, b) => a.start.localeCompare(b.start));
  const summary = bestOverlap(friend, mine);
  return (
    <div className="friend-block">
      <div className="friend-row" style={{ borderTop: 'none', paddingBottom: 4 }}>
        <div className="friend-main">
          <span className="friend-name">{friend.name}</span>
          <span className={summary ? `friend-status friend-${summary.kind}` : 'subtle friend-status'}>
            {summary ? summary.label
              : gigs.length === 0 ? 'No schedule shared yet'
              : 'No overlapping shows'}
          </span>
        </div>
        <button className="link friend-btn" title={`Remove ${friend.name}`} disabled={busy}
          onClick={onRemove}>✕</button>
      </div>
      {gigs.map((g) => {
        const kind = gigOverlapKind(g, mine);
        return (
          <div className={`friend-gig-row${kind ? ` is-${kind}` : ''}`} key={`${g.jobNumber}-${g.start}`}>
            <span className="show-num friend-gig-num">{g.jobNumber}</span>
            <span className="friend-gig-name">{g.jobName}</span>
            <span className="subtle">{g.city}{g.city && g.state ? ', ' : ''}{g.state}</span>
            <span className="subtle friend-gig-dates">{fmtRange(g.start, g.end)}</span>
            {kind === 'gig' && <span className="friend-tag friend-tag-gig">with you</span>}
            {kind === 'near' && <span className="friend-tag">near you</span>}
          </div>
        );
      })}
    </div>
  );
}

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

function bestOverlap(friend: FriendEntry, mine: Booking[]):
  { kind: 'gig' | 'near'; label: string } | null {
  for (const g of friend.gigs) {
    for (const b of mine) {
      if (g.jobNumber && g.jobNumber === b.jobNumber && g.start <= b.endDate && b.startDate <= g.end) {
        return { kind: 'gig', label: `With you on ${b.jobName} · ${fmtRange(g.start, g.end)}` };
      }
    }
  }
  for (const g of friend.gigs) {
    for (const b of mine) {
      const sameCity = g.city && b.city
        && g.city.toLowerCase() === b.city.toLowerCase()
        && g.state.toLowerCase().slice(0, 2) === b.state.toLowerCase().slice(0, 2);
      if (sameCity && g.start <= b.endDate && b.startDate <= g.end) {
        return { kind: 'near', label: `In ${g.city} while you're there · ${fmtRange(g.start, g.end)}` };
      }
    }
  }
  return null;
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
