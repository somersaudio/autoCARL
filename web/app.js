// AUTOcarl mobile — the Bookings tab, as a web app.
//
// The C.A.R.L. calendar link lives ONLY in this phone's localStorage. Every
// refresh sends it to our own ical.php proxy (same origin), which forwards
// the request to CARL and streams the calendar back — the proxy exists only
// because browsers can't fetch CARL cross-origin, and it stores nothing.

const LS_URL = 'autocarl.icalUrl';
const LS_CACHE = 'autocarl.bookings';
const ICAL_RE = /^https:\/\/calendar\.[a-z0-9.-]*carl\.ctus\.live\//i;

const $app = document.getElementById('app');
const $updated = document.getElementById('updatedAt');
const $foot = document.getElementById('footNote');

// ---- one-tap setup links: index.html#cal=<encoded url> ----
(function adoptHashConfig() {
  const m = location.hash.match(/[#&]cal=([^&]+)/);
  if (!m) return;
  const url = decodeURIComponent(m[1]);
  if (ICAL_RE.test(url)) localStorage.setItem(LS_URL, url);
  history.replaceState(null, '', location.pathname + location.search);
})();

// ---- iCal parsing (ported verbatim from the desktop app) ----

function parseIcs(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let current = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { current = {}; continue; }
    if (line === 'END:VEVENT') { if (current) events.push(current); current = null; continue; }
    if (!current) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).split(';')[0];
    current[name] = line.slice(colon + 1);
  }
  return events;
}

function icalDateToIso(s) {
  const m = (s || '').match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function addDaysIso(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function eventToBooking(ev) {
  const parts = (ev.SUMMARY || '').split(' - ');
  if (parts.length < 3) return null;
  const startDate = icalDateToIso(ev.DTSTART);
  const endExclusive = icalDateToIso(ev.DTEND);
  if (!startDate || !endExclusive) return null;
  const desc = (ev.DESCRIPTION || '').replace(/\\n/g, '\n').replace(/\\,/g, ',');
  const fields = {};
  for (const line of desc.split('\n')) {
    const sep = line.indexOf(' - ');
    if (sep > 0) fields[line.slice(0, sep).trim()] = line.slice(sep + 3).trim();
  }
  const location = ev.LOCATION || '';
  const [cityRaw, stateRaw] = location.split(',').map((s) => s.trim());
  return {
    bookingId: ev.UID || '',
    jobNumber: parts[0].trim(),
    jobName: parts.slice(1, -1).join(' - ').trim(),
    status: parts[parts.length - 1].trim(),
    position: (fields['Position'] || '').replace(/^[A-Za-z0-9]+\s*-\s*/, ''),
    projectManager: fields['Project Manager'] || '',
    laborCoordinator: fields['Labor Coordinator'] || '',
    city: cityRaw || '',
    state: stateRaw || '',
    startDate,
    endDate: addDaysIso(endExclusive, -1),
  };
}

// ---- date helpers (local-midnight safe, as on desktop) ----

function parseISOLocal(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmtRange(start, end) {
  const f = (iso) => { const [, m, d] = iso.split('-'); return `${+m}/${+d}`; };
  return start === end ? f(start) : `${f(start)} – ${f(end)}`;
}

function relativeWhen(start, end) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const s = parseISOLocal(start);
  const e = parseISOLocal(end);
  const day = 86400000;
  if (today < s) {
    const diff = Math.round((s - today) / day);
    return diff === 1 ? 'Starts tomorrow' : `Starts in ${diff} days`;
  }
  if (today > e) return 'Wrapped';
  const idx = Math.round((today - s) / day) + 1;
  const total = Math.round((e - s) / day) + 1;
  if (today.getTime() === e.getTime()) return total === 1 ? 'Today only' : 'Last day';
  return `Day ${idx} of ${total}`;
}

// ---- rendering ----

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function renderSetup(msg) {
  $updated.textContent = '';
  $app.innerHTML = `
    <div class="card setup">
      <h3>Set up AUTOcarl</h3>
      ${msg ? `<div class="error-banner">${esc(msg)}</div>` : ''}
      <p>Paste your C.A.R.L. calendar link. It stays on this phone — nothing is stored anywhere else.</p>
      <p class="subtle" style="font-size:12.5px">In C.A.R.L., open your crew calendar and copy the
      <em>iCal / calendar subscription</em> link — it starts with
      <code>https://calendar.prod.carl.ctus.live/</code>. If you use the desktop app, ask it for your link.</p>
      <label for="icalIn">Calendar link</label>
      <input id="icalIn" type="url" inputmode="url" autocomplete="off" autocapitalize="off"
             placeholder="https://calendar.prod.carl.ctus.live/…">
      <button class="btn" id="saveUrl">Save &amp; load bookings</button>
    </div>`;
  document.getElementById('saveUrl').onclick = () => {
    const url = document.getElementById('icalIn').value.trim();
    if (!ICAL_RE.test(url)) {
      renderSetup("That doesn't look like a CARL calendar link — it should start with https://calendar.prod.carl.ctus.live/");
      return;
    }
    localStorage.setItem(LS_URL, url);
    refresh();
  };
}

function bookingRow(b) {
  const bits2 = [
    fmtRange(b.startDate, b.endDate),
    b.city ? `${b.city}, ${b.state}` : '',
    b.position, b.projectManager && `PM: ${b.projectManager}`,
    b.laborCoordinator && `LC: ${b.laborCoordinator}`,
  ].filter(Boolean).join(' · ');
  return `
    <div class="row">
      <div class="line1">
        <span class="jobnum">${esc(b.jobNumber)}</span>
        <span class="name">${esc(b.jobName)}</span>
        ${b.status ? `<span class="chip">${esc(b.status)}</span>` : ''}
      </div>
      <div class="line2">${esc(bits2)}</div>
    </div>`;
}

let showPast = false;

function render(bookings, fetchedAt, errorMsg) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const upcoming = bookings
    .filter((b) => parseISOLocal(b.endDate) >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const past = bookings
    .filter((b) => parseISOLocal(b.endDate) < today)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
  const featured = upcoming[0] || null;
  const rest = upcoming.slice(1);

  let html = '';
  if (errorMsg) html += `<div class="error-banner">${esc(errorMsg)}</div>`;

  if (featured) {
    html += `
      <div class="card featured">
        <div class="jobnum">${esc(featured.jobNumber)}</div>
        <div class="name">${esc(featured.jobName)}</div>
        <div class="whenrow">
          <span class="pill">${esc(relativeWhen(featured.startDate, featured.endDate))}</span>
          <span>${esc(fmtRange(featured.startDate, featured.endDate))}</span>
          ${featured.city ? `<span class="subtle">· ${esc(featured.city)}, ${esc(featured.state)}</span>` : ''}
        </div>
        <div class="fgrid">
          ${featured.position ? `<div><div class="lbl">Position</div><div class="val">${esc(featured.position)}</div></div>` : ''}
          ${featured.status ? `<div><div class="lbl">Status</div><div class="val">${esc(featured.status)}</div></div>` : ''}
          ${featured.projectManager ? `<div><div class="lbl">Project Manager</div><div class="val">${esc(featured.projectManager)}</div></div>` : ''}
          ${featured.laborCoordinator ? `<div><div class="lbl">Labor Coord</div><div class="val">${esc(featured.laborCoordinator)}</div></div>` : ''}
        </div>
      </div>`;
  } else if (!errorMsg) {
    html += `<div class="card"><p class="subtle">No upcoming bookings on the calendar.</p></div>`;
  }

  if (rest.length) {
    html += `<div class="card"><h3>Upcoming</h3><div class="rows">${rest.map(bookingRow).join('')}</div></div>`;
  }

  if (past.length) {
    html += `
      <div class="card">
        <button class="pastbar" id="pastToggle">
          <span>Past</span><span>${showPast ? '▾' : past.length}</span>
        </button>
        ${showPast ? `<div class="rows" style="margin-top:8px">${past.map(bookingRow).join('')}</div>` : ''}
      </div>`;
  }

  html += `<div class="refresh-row"><button class="btn btn-quiet" id="refreshBtn">Refresh</button></div>`;

  $app.innerHTML = html;
  const pt = document.getElementById('pastToggle');
  if (pt) pt.onclick = () => { showPast = !showPast; render(bookings, fetchedAt, errorMsg); };
  document.getElementById('refreshBtn').onclick = () => refresh();

  $updated.textContent = fetchedAt
    ? `Updated ${new Date(fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : '';
  $foot.innerHTML = `AUTOcarl · <a href="#" id="resetLink" style="color:inherit">change calendar link</a>`;
  document.getElementById('resetLink').onclick = (e) => {
    e.preventDefault();
    localStorage.removeItem(LS_URL);
    renderSetup();
  };
}

// ---- data flow ----

function readCache() {
  try { return JSON.parse(localStorage.getItem(LS_CACHE)) || null; } catch { return null; }
}

async function refresh() {
  const url = localStorage.getItem(LS_URL);
  if (!url) { renderSetup(); return; }

  // Paint the cache instantly, then refresh live — same feel as the desktop.
  const cached = readCache();
  if (cached) render(cached.bookings, cached.fetchedAt, null);
  else $app.innerHTML = '<div class="card"><p class="subtle">Loading bookings…</p></div>';

  try {
    const res = await fetch(`api/ical.php?u=${encodeURIComponent(url)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status === 502 ? 'CARL didn’t answer — try again in a minute.' : `HTTP ${res.status}`);
    const text = await res.text();
    if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('That link didn’t return a calendar — check it and try again.');
    const bookings = parseIcs(text).map(eventToBooking).filter(Boolean);
    const fetchedAt = new Date().toISOString();
    localStorage.setItem(LS_CACHE, JSON.stringify({ bookings, fetchedAt }));
    render(bookings, fetchedAt, null);
  } catch (e) {
    const c = readCache();
    const msg = `Couldn't refresh: ${e.message || e}` + (c ? ' — showing last saved.' : '');
    if (c) render(c.bookings, c.fetchedAt, msg);
    else render([], null, msg);
  }
}

// ---- starfield (lightweight: static positions, gentle twinkle) ----

(function starfield() {
  const canvas = document.getElementById('stars');
  const ctx = canvas.getContext('2d');
  let stars = [];
  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round((innerWidth * innerHeight) / 9000);
    stars = Array.from({ length: n }, () => ({
      x: Math.random() * innerWidth,
      y: Math.random() * innerHeight,
      r: 0.4 + Math.random() * 1.1,
      p: Math.random() * Math.PI * 2,
      s: 0.4 + Math.random() * 1.2,
      warm: Math.random() < 0.18,
    }));
  }
  size();
  addEventListener('resize', size);
  let last = 0;
  function tick(t) {
    if (document.hidden) { requestAnimationFrame(tick); return; }
    if (t - last < 90) { requestAnimationFrame(tick); return; }   // ~11fps is plenty for twinkle
    last = t;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const st of stars) {
      const a = 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(st.p + t / 1000 * st.s));
      ctx.globalAlpha = a;
      ctx.fillStyle = st.warm ? '#ffd9a0' : '#cdd6f4';
      ctx.beginPath();
      ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();

refresh();
