/* BLC-Calendar — Google Calendar frontend.
 *
 * Design notes:
 * - Token-model OAuth via Google Identity Services (GIS). Access tokens last
 *   ~1 hour, no refresh token (browser-only flow). On 401 we silently re-auth
 *   via tokenClient.requestAccessToken({prompt: ''}).
 * - All state lives at Google. We never persist to localStorage.
 * - All-day events: Google's end.date is exclusive (event covers
 *   [start.date, end.date)). FullCalendar also treats end as exclusive, so
 *   we pass through unchanged on the wire. The editor UI displays the
 *   inclusive end (last day) and converts on save.
 * - Recurring events: events.list({singleEvents: true}) returns instances.
 *   patch/delete on an instance ID affects only that occurrence; the parent
 *   series is not modified.
 */

const COURT_WATCH_BASE = 'http://localhost:8000';

const SCOPES = "https://www.googleapis.com/auth/calendar openid email profile";
const DISCOVERY = "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest";
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

let tokenClient = null;
let gapiReady = false;
let gisReady = false;
let currentToken = null;
let calendar = null;
let calendarsList = [];
const visibleCalendarIds = new Set();

const LS_DATE_UPDATE_MODE = "bcm.dateUpdateMode";
const LS_SIGNED_IN = "bcm.signedInBefore";
const LS_VISIBLE_CALENDARS = "bcm.visibleCalendars";
const LS_TOKEN = "bcm.token";
const DEFAULT_CALENDAR_NAMES = [
  "Court Diary",
  "Delhi Court Holidays",
  "NHAI Diary Bathinda",
  "NHAI Diary Faridkot",
];

const $ = (id) => document.getElementById(id);

let dateUpdateMode = readDateUpdateMode();
let searchQuery = '';
let searchSeq = 0;
let searchAbortCtrl = null;

function readDateUpdateMode() {
  try {
    return localStorage.getItem(LS_DATE_UPDATE_MODE) === "1";
  } catch {
    return false;
  }
}
function writeDateUpdateMode(on) {
  try {
    localStorage.setItem(LS_DATE_UPDATE_MODE, on ? "1" : "0");
  } catch { /* ignore */ }
}

function readVisibleCalendars() {
  try {
    const raw = localStorage.getItem(LS_VISIBLE_CALENDARS);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function writeVisibleCalendars(ids) {
  try {
    localStorage.setItem(LS_VISIBLE_CALENDARS, JSON.stringify(ids));
  } catch { /* ignore */ }
}

// Persist the access token (and its expiry) so reloads inside the ~1-hour
// validity window don't need to re-auth at all. Past expiry, we fall back
// to silent re-auth (prompt: "") which works when third-party cookies for
// accounts.google.com are allowed.
function saveToken(resp) {
  if (!resp || !resp.access_token) return;
  try {
    const expiresIn = Number(resp.expires_in) || 3600;
    // 60-second safety margin so we don't try to use a token Google is
    // about to expire mid-request.
    const expiresAt = Date.now() + Math.max(0, expiresIn - 60) * 1000;
    localStorage.setItem(
      LS_TOKEN,
      JSON.stringify({
        access_token: resp.access_token,
        expires_at: expiresAt,
        scope: resp.scope || "",
      })
    );
  } catch { /* ignore */ }
}
function readToken() {
  try {
    const raw = localStorage.getItem(LS_TOKEN);
    if (!raw) return null;
    const t = JSON.parse(raw);
    if (!t || !t.access_token || !t.expires_at) return null;
    if (Date.now() >= t.expires_at) return null;
    return t;
  } catch {
    return null;
  }
}
function clearToken() {
  try { localStorage.removeItem(LS_TOKEN); } catch {}
}

function dbg(...args) { console.log(...args); }

/* ---------- Bootstrapping ---------- */

function gapiLoaded() {
  dbg("[boot] gapi script loaded");
  gapi.load("client", async () => {
    try {
      await gapi.client.init({ discoveryDocs: [DISCOVERY] });
      gapiReady = true;
      dbg("[boot] gapi.client.init done; gapi.client.calendar =", typeof gapi.client.calendar);
      maybeReady();
    } catch (err) {
      dbg("[boot] gapi init failed:", err);
      showFatal("Google API client failed to initialise.");
    }
  });
}

function gisLoaded() {
  dbg("[boot] gis script loaded");
  const cid = window.APP_CONFIG && window.APP_CONFIG.CLIENT_ID;
  if (!cid || cid.startsWith("PASTE_")) {
    showFatal(
      "Google OAuth Client ID is not configured. Edit config.js and set APP_CONFIG.CLIENT_ID."
    );
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: cid,
    scope: SCOPES,
    callback: () => {}, // overridden per-call
    error_callback: (err) => {
      dbg("[auth] tokenClient error_callback:", err);
      showLoginError(
        "Sign-in did not complete: " +
          (err && (err.message || err.type)) +
          "."
      );
    },
  });
  gisReady = true;
  dbg("[boot] tokenClient initialised");
  maybeReady();
}

function showLoginError(msg) {
  let banner = document.getElementById("login-error");
  if (!banner) {
    banner = document.createElement("p");
    banner.id = "login-error";
    banner.style.cssText =
      "color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;padding:0.6rem 0.75rem;border-radius:6px;margin:0 0 1rem;font-size:0.85rem;text-align:left;";
    const card = document.querySelector(".login-card");
    const btn = document.getElementById("signin-btn");
    if (card && btn) card.insertBefore(banner, btn);
  }
  banner.textContent = msg;
}

function maybeReady() {
  if (gapiReady && gisReady) {
    document.getElementById("signin-btn").disabled = false;
    bootstrapSession();
  }
}

// Sign-in restoration order:
//   1. If a non-expired access token is in localStorage, use it directly —
//      no popup, no iframe, immediate.
//   2. If that fails (token revoked at Google, scope mismatch, etc.) or no
//      token is stored, fall back to silent re-auth via prompt: "" — works
//      when third-party cookies for accounts.google.com are allowed.
//   3. If everything fails, the user sees the sign-in button.
async function bootstrapSession() {
  const saved = readToken();
  if (saved) {
    currentToken = saved;
    gapi.client.setToken({ access_token: saved.access_token });
    try {
      await onSignedIn();
      dbg("[auth] restored session from stored token");
      return;
    } catch (err) {
      console.error("[auth] stored token did not work, clearing:", err);
      clearToken();
      currentToken = null;
      gapi.client.setToken(null);
      // fall through to silent re-auth
    }
  }
  if (localStorage.getItem(LS_SIGNED_IN) === "1") {
    attemptSilentSignIn();
  }
}

// Silent sign-in: GIS can return a fresh access token via a hidden iframe
// (no popup) when the user has already consented and third-party cookies
// for accounts.google.com are allowed. Fails quietly otherwise.
function attemptSilentSignIn() {
  tokenClient.callback = async (resp) => {
    if (!resp || resp.error || !resp.access_token) {
      dbg("[auth] silent re-auth failed:", resp && resp.error);
      return;
    }
    currentToken = resp;
    gapi.client.setToken({ access_token: resp.access_token });
    saveToken(resp);
    try {
      await onSignedIn();
    } catch (err) {
      console.error("[auth] silent onSignedIn failed:", err);
    }
  };
  try {
    tokenClient.requestAccessToken({ prompt: "" });
  } catch (err) {
    console.error("[auth] silent requestAccessToken threw:", err);
  }
}

function showFatal(msg) {
  const card = document.querySelector(".login-card");
  if (card) {
    card.innerHTML =
      "<h1>Setup needed</h1><p class='lead'></p><p class='muted'></p>";
    card.querySelector(".lead").textContent = msg;
    card.querySelector(".muted").textContent =
      "See README.md for setup instructions.";
  }
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.hidden = true), 3000);
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("signin-btn").addEventListener("click", signIn);
  document.getElementById("signout-btn").addEventListener("click", signOut);
  wireEventViewDialog();
  wireDateUpdateDialog();
  wireReportErrorDialog();
  wireInfoDialog();
  wireToggle();
  wireNewCaseDialog();
});

/* ---------- Auth ---------- */

function signIn() {
  dbg("[auth] signIn() clicked. gapiReady =", gapiReady, "gisReady =", gisReady);
  tokenClient.callback = async (resp) => {
    dbg("[auth] tokenClient callback fired. has access_token =", !!(resp && resp.access_token), "error =", resp && resp.error);
    if (!resp || resp.error) {
      const msg = resp && (resp.error_description || resp.error)
        ? (resp.error_description || resp.error)
        : "no token returned";
      showLoginError("Sign-in failed: " + msg);
      return;
    }
    if (!resp.access_token) {
      showLoginError("Sign-in failed: response had no access token.");
      return;
    }
    currentToken = resp;
    gapi.client.setToken({ access_token: resp.access_token });
    saveToken(resp);
    try { localStorage.setItem(LS_SIGNED_IN, "1"); } catch {}
    dbg("[auth] token stored. calling onSignedIn()...");
    try {
      await onSignedIn();
      dbg("[auth] onSignedIn() returned successfully");
    } catch (err) {
      dbg("[auth] onSignedIn FAILED:", err && (err.stack || err.message || err));
      const errMsg = apiErrorMessage(err);
      showLoginError(
        "Signed in, but loading calendars failed: " + errMsg +
        ". Most likely the Google Calendar API isn't enabled on this Cloud project — visit https://console.cloud.google.com/apis/library/calendar-json.googleapis.com and click Enable."
      );
    }
  };
  const prompt = currentToken ? "" : "consent";
  tokenClient.requestAccessToken({ prompt });
}

function signOut() {
  if (currentToken) {
    google.accounts.oauth2.revoke(currentToken.access_token, () => {});
  }
  currentToken = null;
  gapi.client.setToken(null);
  clearToken();
  try { localStorage.removeItem(LS_SIGNED_IN); } catch {}
  if (calendar) {
    calendar.destroy();
    calendar = null;
  }
  calendarsList = [];
  visibleCalendarIds.clear();
  document.getElementById("calendar-toggles").innerHTML = "";
  document.getElementById("user-email").textContent = "";
  document.getElementById("app").hidden = true;
  document.getElementById("login").hidden = false;
}

function silentReauth() {
  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(resp);
      currentToken = resp;
      gapi.client.setToken({ access_token: resp.access_token });
      saveToken(resp);
      resolve();
    };
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

// Wraps a thunk that performs a Google API call. On 401, transparently
// re-acquires a token (silent prompt) and retries once.
async function call(fn) {
  try {
    return await fn();
  } catch (err) {
    const status = err && (err.status || (err.result && err.result.error && err.result.error.code));
    if (status === 401) {
      try {
        await silentReauth();
        return await fn();
      } catch (err2) {
        throw err2;
      }
    }
    throw err;
  }
}

/* ---------- Post sign-in ---------- */

async function onSignedIn() {
  document.getElementById("login").hidden = true;
  document.getElementById("app").hidden = false;
  await Promise.all([loadUser(), loadCalendars()]);
  initCalendar();
}

async function loadUser() {
  try {
    const resp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: "Bearer " + currentToken.access_token },
    });
    if (!resp.ok) return;
    const info = await resp.json();
    document.getElementById("user-email").textContent = info.email || "";
  } catch {
    /* non-fatal */
  }
}

async function loadCalendars() {
  const resp = await call(() =>
    gapi.client.calendar.calendarList.list({ maxResults: 250 })
  );
  calendarsList = resp.result.items || [];
  // Stable order: primary first, then by summary
  calendarsList.sort((a, b) => {
    if (a.primary && !b.primary) return -1;
    if (b.primary && !a.primary) return 1;
    return (a.summary || "").localeCompare(b.summary || "");
  });
  visibleCalendarIds.clear();
  const saved = readVisibleCalendars();
  if (saved !== null) {
    saved.forEach((id) => {
      if (calendarsList.some((c) => c.id === id)) visibleCalendarIds.add(id);
    });
  } else {
    // First-time user: only the named defaults. If none of the named calendars
    // exist on this account, fall back to whatever Google has marked selected.
    const matched = calendarsList.filter((c) =>
      DEFAULT_CALENDAR_NAMES.includes(c.summary)
    );
    if (matched.length > 0) {
      matched.forEach((c) => visibleCalendarIds.add(c.id));
    } else {
      calendarsList.forEach((c) => {
        if (c.selected !== false) visibleCalendarIds.add(c.id);
      });
    }
  }
  renderCalendarToggles();
}

function renderCalendarToggles() {
  const container = document.getElementById("calendar-toggles");
  container.innerHTML = "";
  calendarsList.forEach((cal) => {
    const label = document.createElement("label");
    label.className = "cal-toggle";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = visibleCalendarIds.has(cal.id);
    cb.addEventListener("change", () => {
      if (cb.checked) visibleCalendarIds.add(cal.id);
      else visibleCalendarIds.delete(cal.id);
      writeVisibleCalendars([...visibleCalendarIds]);
      if (calendar) calendar.refetchEvents();
    });
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = cal.backgroundColor || "#888";
    const name = document.createElement("span");
    name.textContent = cal.summary || cal.id;
    label.append(cb, dot, name);
    container.appendChild(label);
  });
}

/* ---------- Calendar ---------- */

function initCalendar() {
  const el = document.getElementById("calendar");
  calendar = new FullCalendar.Calendar(el, {
    initialView: 'agenda',
    headerToolbar: false,
    nowIndicator: true,
    editable: false,
    selectable: false,
    height: "100%",
    expandRows: true,
    scrollTime: defaultScrollTime(),
    dayMaxEvents: true,
    timeZone: "local",
    views: {
      agenda: {
        type: 'list',
        duration: { days: 7 },
        buttonText: 'Agenda',
      },
    },
    listDayFormat:     { month: 'long', day: 'numeric', year: 'numeric' },
    listDaySideFormat: { weekday: 'long' },
    displayEventEnd: false,
    noEventsContent: () => {
      if (dateUpdateMode) {
        return { html:
          '<div style="padding:1rem; line-height:1.55; max-width:640px; margin:0 auto; color:#374151">' +
          '<div style="font-weight:600; color:#111827; margin-bottom:0.35rem">All dates are updated for today.</div>' +
          '<div style="font-size:0.9rem; color:#4b5563">Select a different range of dates, or turn the Date Update mode off to see the full calendar (or to report an incorrectly updated date).</div>' +
          '</div>'
        };
      }
      return { html: '<div style="padding:1rem; color:#6b7280">No events to display</div>' };
    },
    events: fetchEvents,
    eventClick: (info) => {
      info.jsEvent.preventDefault();
      if (dateUpdateMode) handleDateUpdateClick(info.event);
      else openEventViewDialog(info.event);
    },
    datesSet: updateTitle,
  });
  calendar.render();
  bindToolbar();
  updateTitle();
}

function defaultScrollTime() {
  const now = new Date();
  const h = Math.max(0, now.getHours() - 1);
  return String(h).padStart(2, "0") + ":00:00";
}

function bindToolbar() {
  document.getElementById("btn-prev").onclick = () => calendar.prev();
  document.getElementById("btn-next").onclick = () => calendar.next();
  document.getElementById("btn-today").onclick = () => calendar.today();
  document.getElementById("btn-refresh").onclick = refreshCalendar;
  document.querySelectorAll("[data-view]").forEach((btn) => {
    btn.onclick = () => {
      calendar.changeView(btn.dataset.view);
      document
        .querySelectorAll("[data-view]")
        .forEach((b) => b.classList.toggle("active", b === btn));
    };
  });
  bindEventSearch();
}

function bindEventSearch() {
  const input = $('event-search');
  const clearBtn = $('event-search-clear');
  const closeBtn = $('search-results-close');
  if (!input) return;

  let t;
  const onChange = () => {
    const next = input.value.trim();
    clearBtn.hidden = !next;
    clearTimeout(t);
    t = setTimeout(() => runSearch(next), 250);
  };
  input.addEventListener('input', onChange);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      input.value = '';
      clearBtn.hidden = true;
      clearTimeout(t);
      runSearch('');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(t);
      runSearch(input.value.trim());
    }
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.hidden = true;
    runSearch('');
    input.focus();
  });
  closeBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.hidden = true;
    runSearch('');
  });
}

function showSearchPanel(show) {
  const panel = $('search-results');
  const layout = document.querySelector('main.layout');
  if (!panel || !layout) return;
  panel.hidden = !show;
  layout.style.display = show ? 'none' : '';
}

async function runSearch(qRaw) {
  const q = (qRaw || '').trim();
  searchQuery = q;
  const list = $('search-results-list');
  const summary = $('search-results-summary');
  const countLbl = $('event-search-count');
  countLbl.hidden = true;
  countLbl.textContent = '';

  if (!q) {
    showSearchPanel(false);
    if (searchAbortCtrl) { searchAbortCtrl.abort(); searchAbortCtrl = null; }
    return;
  }

  showSearchPanel(true);
  summary.textContent = `Searching for "${q}"…`;
  list.innerHTML = '<div class="loading">Searching all calendars…</div>';

  if (searchAbortCtrl) searchAbortCtrl.abort();
  searchAbortCtrl = new AbortController();
  const seq = ++searchSeq;

  try {
    const ids = [...visibleCalendarIds];
    const results = await Promise.all(
      ids.map((calId) =>
        call(() =>
          gapi.client.calendar.events.list({
            calendarId: calId,
            q,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 250,
            showDeleted: false,
          })
        ).then((r) => {
          const meta = calendarsList.find((c) => c.id === calId);
          return (r.result.items || []).map((ev) => ({
            id: ev.id,
            calendarId: calId,
            calendarName: meta?.summary || calId,
            backgroundColor: meta?.backgroundColor,
            summary: ev.summary || '',
            location: ev.location || '',
            start: ev.start.dateTime || ev.start.date,
            allDay: !ev.start.dateTime,
          }));
        })
      )
    );
    if (seq !== searchSeq) return;

    const items = results.flat().sort((a, b) => {
      if (!a.start) return 1;
      if (!b.start) return -1;
      return a.start.localeCompare(b.start);
    });

    const truncated = items.length > 100;
    renderSearchResults(q, {
      items: items.slice(0, 100),
      total: items.length,
      truncated,
    });
  } catch (e) {
    if (seq !== searchSeq) return;
    list.innerHTML = `<div class="err">Search failed: ${escapeHtml(e.message || '')}</div>`;
    summary.textContent = 'Search failed';
  }
}

function renderSearchResults(q, data) {
  const summary = $('search-results-summary');
  const list = $('search-results-list');
  const items = Array.isArray(data.items) ? data.items : [];

  if (!items.length) {
    summary.textContent = `No matches for "${q}"`;
    list.innerHTML = '<div class="empty">Try a partial word, the petitioner&rsquo;s surname, or a different spelling.</div>';
    return;
  }
  const total = data.total ?? items.length;
  summary.textContent = total === 1
    ? `1 match for "${q}"`
    : `${items.length}${data.truncated ? '+' : ''} of ${total} matches for "${q}"`;

  const colorById = new Map((calendarsList || []).map((c) => [c.id, c.backgroundColor || '#9ca3af']));

  const frag = document.createDocumentFragment();
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'search-row';
    const startDate = it.start ? new Date(it.start) : null;
    const when = document.createElement('div');
    when.className = 'when';
    if (startDate && !Number.isNaN(startDate.getTime())) {
      const dd = String(startDate.getDate()).padStart(2, '0');
      const mon = startDate.toLocaleString(undefined, { month: 'short' });
      const yr = startDate.getFullYear();
      const wd = startDate.toLocaleString(undefined, { weekday: 'short' });
      when.innerHTML = `${dd} ${mon} ${yr}<span class="weekday">${wd}${it.allDay ? '' : ' · ' + startDate.toLocaleString(undefined, {hour:'2-digit', minute:'2-digit'})}</span>`;
    } else {
      when.textContent = '—';
    }
    const what = document.createElement('div');
    what.className = 'what';
    const title = it.summary || '(no title)';
    what.innerHTML = `<div>${highlight(title, q)}</div>` +
      (it.location ? `<div class="where">${highlight(it.location, q)}</div>` : '');
    const pill = document.createElement('div');
    pill.className = 'cal-pill';
    pill.innerHTML = `<span class="dot" style="background:${escapeAttr(colorById.get(it.calendarId) || it.backgroundColor || '#9ca3af')}"></span>${escapeHtml(it.calendarName || '')}`;
    row.append(when, what, pill);
    row.addEventListener('click', () => openSearchHit(it));
    frag.append(row);
  }
  list.innerHTML = '';
  list.append(frag);
  if (data.truncated) {
    const note = document.createElement('div');
    note.className = 'truncated';
    note.textContent = 'Showing the first 100 hits. Refine your search to narrow further.';
    list.append(note);
  }
}

function openSearchHit(item) {
  if (!item.start) return;
  const d = new Date(item.start);
  if (Number.isNaN(d.getTime())) return;
  const input = $('event-search');
  if (input) input.value = '';
  $('event-search-clear').hidden = true;
  searchQuery = '';
  showSearchPanel(false);
  if (calendar) {
    calendar.gotoDate(d);
    calendar.refetchEvents();
    setTimeout(() => {
      const evs = calendar.getEvents();
      const hit = evs.find((e) => e.id === item.id && e.extendedProps?.calendarId === item.calendarId);
      if (!hit) return;
      if (dateUpdateMode) handleDateUpdateClick(hit);
      else openEventViewDialog(hit);
    }, 250);
  }
}

function highlight(text, q) {
  if (!q) return escapeHtml(text);
  const lower = (text || '').toLowerCase();
  const ql = q.toLowerCase();
  const i = lower.indexOf(ql);
  if (i < 0) return escapeHtml(text);
  return escapeHtml(text.slice(0, i)) +
    '<mark>' + escapeHtml(text.slice(i, i + q.length)) + '</mark>' +
    escapeHtml(text.slice(i + q.length));
}

function escapeAttr(s) {
  return String(s || '').replace(/"/g, '&quot;');
}

async function refreshCalendar() {
  if (!calendar) return;
  const btn = document.getElementById("btn-refresh");
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Refreshing…";
  try {
    // Re-pull the calendar list too, in case the user added or removed a
    // calendar elsewhere. User toggles persist through readVisibleCalendars().
    await loadCalendars();
    calendar.refetchEvents();
    showToast("Refreshed");
  } catch (err) {
    console.error(err);
    showToast("Refresh failed: " + apiErrorMessage(err));
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function updateTitle() {
  if (!calendar) return;
  const el = document.getElementById("cal-title");
  const t = calendar.view.title;
  el.textContent = t;
  el.title = t;
}

async function fetchEvents(info, success, failure) {
  try {
    const ids = [...visibleCalendarIds];
    if (ids.length === 0) return success([]);
    const results = await Promise.all(
      ids.map((id) =>
        call(() =>
          gapi.client.calendar.events.list({
            calendarId: id,
            timeMin: info.startStr,
            timeMax: info.endStr,
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 2500,
            showDeleted: false,
          })
        ).then((r) => ({ id, items: r.result.items || [] }))
      )
    );
    const events = [];
    results.forEach(({ id, items }) => {
      const meta = calendarsList.find((c) => c.id === id);
      const bg = meta?.backgroundColor || "#3788d8";
      const fg = meta?.foregroundColor || "#ffffff";
      const writable =
        meta?.accessRole === "owner" || meta?.accessRole === "writer";
      items.forEach((ev) => {
        if (ev.status === "cancelled") return;
        // Date update mode visibility filter:
        //   - always show events whose title starts with "Correct Date"
        //     (these are flags raised via Report error in updating)
        //   - otherwise hide events without the strict PD/ND format
        //   - hide events whose ND already has a date or "NA"
        //   - show only events with empty ND
        if (dateUpdateMode) {
          const startStr = ev.start.dateTime || ev.start.date;
          if (startStr && isDateAfterToday(startStr)) return;
          const title = ev.summary || "";
          if (!title.startsWith("Correct Date")) {
            const parsed = parseCourtFormat(ev.description);
            if (!parsed || parsed.ndState !== "empty") return;
          }
        }
        events.push({
          id: ev.id,
          title: ev.summary || "(no title)",
          start: ev.start.dateTime || ev.start.date,
          end: ev.end ? ev.end.dateTime || ev.end.date : undefined,
          allDay: !ev.start.dateTime,
          backgroundColor: bg,
          borderColor: bg,
          textColor: fg,
          extendedProps: { calendarId: id, raw: ev, writable },
        });
      });
    });
    success(events);
  } catch (err) {
    console.error(err);
    showToast("Failed to load events");
    failure(err);
  }
}

/* ---------- Read-only event view (default mode) ---------- */

function openEventViewDialog(event) {
  const dlg = document.getElementById("event-view-dialog");
  const raw = event.extendedProps.raw;

  dlg.querySelector(".ev-view-title").textContent = event.title || "(no title)";
  dlg.querySelector(".ev-view-when").textContent = formatEventWhen(event);

  const locRow = dlg.querySelector('[data-field="location"]');
  if (raw.location) {
    locRow.hidden = false;
    locRow.querySelector(".ev-view-location").textContent = raw.location;
  } else {
    locRow.hidden = true;
  }

  const descRow = dlg.querySelector('[data-field="description"]');
  if (raw.description) {
    descRow.hidden = false;
    descRow.querySelector(".ev-view-description").innerHTML =
      linkifyDescription(raw.description);
  } else {
    descRow.hidden = true;
  }

  // Report-error button is only useful on calendars we can write to.
  const reportBtn = dlg.querySelector(".btn-report-error");
  reportBtn.hidden = !event.extendedProps.writable;
  reportBtn.disabled = false;

  // Show Last Order: visible only when we can extract the right identifiers
  // from the description for the routing decision (location → court site).
  const showLastBtn = dlg.querySelector(".btn-show-last-order");
  const target = getShowLastOrderTarget(event);
  showLastBtn._target = target;
  showLastBtn.hidden = !target;
  showLastBtn.disabled = false;

  dlg._currentEvent = event;
  dlg.showModal();
}

// Decide which court-status page to open and which identifier to put on the
// clipboard. Returns null when there's nothing actionable.
//   location contains "SCI" → Supreme Court page, copy line 4 (case details)
//   location contains "DHC" → Delhi High Court page, copy line 4
//   otherwise → eCourts CNR search page, copy CNR from line 5
function getShowLastOrderTarget(event) {
  const raw = event.extendedProps.raw;
  const description = raw.description || "";
  const location = (raw.location || "").toUpperCase();
  const lines = description.split(/\r?\n/);
  const line4 = (lines[3] || "").trim();
  const line5 = (lines[4] || "").trim();

  if (location.includes("SCI")) {
    if (!line4) return null;
    return {
      url: "https://www.sci.gov.in/case-status-case-no/",
      copyValue: line4,
      message:
        'Case details copied: "' + line4 + '". Paste into the form on the page that just opened.',
    };
  }
  if (location.includes("DHC")) {
    if (!line4) return null;
    return {
      url: "https://delhihighcourt.nic.in/app/get-case-type-status",
      copyValue: line4,
      message:
        'Case details copied: "' + line4 + '". Paste into the form on the page that just opened.',
    };
  }
  const cnrMatch = line5.match(/^CNR:\s*([A-Z0-9]{16})\b/i);
  if (cnrMatch) {
    const cnr = cnrMatch[1].toUpperCase();
    return {
      url: "https://services.ecourts.gov.in/ecourtindia_v6/",
      copyValue: cnr,
      message:
        "CNR copied: " + cnr + ". Paste into the CNR field on eCourts.",
    };
  }
  return null;
}

function wireEventViewDialog() {
  const dlg = document.getElementById("event-view-dialog");
  dlg.querySelector(".btn-cancel").addEventListener("click", () => dlg.close());
  dlg.querySelector(".btn-close").addEventListener("click", () => dlg.close());
  dlg.querySelector(".btn-show-last-order").addEventListener("click", async () => {
    const btn = dlg.querySelector(".btn-show-last-order");
    const target = btn._target;
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.copyValue);
      showToast(target.message);
    } catch {
      showToast("Could not copy automatically. Copy manually: " + target.copyValue);
    }
    window.open(target.url, "_blank", "noopener,noreferrer");
  });
  dlg.querySelector(".btn-report-error").addEventListener("click", () => {
    const event = dlg._currentEvent;
    if (!event) return;
    openReportErrorDialog(event);
  });
}

function openReportErrorDialog(event) {
  const reportDlg = document.getElementById("report-error-dialog");
  const form = reportDlg.querySelector("form");
  form.correctDate.value = "";
  const errBox = form.querySelector(".dialog-error");
  errBox.hidden = true;
  errBox.textContent = "";
  form.querySelector(".btn-save").disabled = false;
  reportDlg._originatingEvent = event;
  reportDlg.showModal();
}

function wireReportErrorDialog() {
  const reportDlg = document.getElementById("report-error-dialog");
  const form = reportDlg.querySelector("form");
  const errBox = form.querySelector(".dialog-error");

  form.querySelector(".btn-cancel").addEventListener("click", () =>
    reportDlg.close()
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const event = reportDlg._originatingEvent;
    if (!event) return;
    const correctDateYmd = form.correctDate.value;
    if (!correctDateYmd) {
      errBox.textContent = "Pick the correct next date.";
      errBox.hidden = false;
      return;
    }
    errBox.hidden = true;
    errBox.textContent = "";
    const submitBtn = form.querySelector(".btn-save");
    submitBtn.disabled = true;
    try {
      await reportErrorDuplicate(event, correctDateYmd);
      reportDlg.close();
      // Also close the underlying event-view-dialog if it's still up.
      const viewDlg = document.getElementById("event-view-dialog");
      if (viewDlg.open) viewDlg.close();
      if (calendar) calendar.refetchEvents();
      showInfoDialog(
        "Error reported",
        "The error has been reported successfully. A duplicate event has been added on the same date noting the correct next date."
      );
    } catch (err) {
      console.error(err);
      errBox.textContent = "Report failed: " + apiErrorMessage(err);
      errBox.hidden = false;
      submitBtn.disabled = false;
    }
  });
}

// Insert a duplicate of `event` in the same calendar on the same date/time,
// with title prefixed "wrong date updated " and description set to the
// correct next date the user provided.
async function reportErrorDuplicate(event, correctDateYmd) {
  const calendarId = event.extendedProps.calendarId;
  const raw = event.extendedProps.raw;
  const oldTitle = (raw.summary || "").trim();
  const newTitle = oldTitle
    ? `Correct Date: ${oldTitle}`
    : `Correct Date:`;
  const correctDdMmYyyy = ymdToDdMmYyyy(correctDateYmd);
  const body = {
    summary: newTitle,
    description: `The correct date should be ${correctDdMmYyyy}`,
  };
  if (raw.location) body.location = raw.location;
  if (raw.colorId) body.colorId = raw.colorId;
  if (raw.transparency) body.transparency = raw.transparency;
  if (raw.visibility) body.visibility = raw.visibility;
  if (raw.reminders) body.reminders = raw.reminders;
  if (event.allDay) {
    body.start = { date: raw.start.date };
    body.end = { date: raw.end.date };
  } else {
    body.start = {
      dateTime: raw.start.dateTime,
      timeZone: raw.start.timeZone || TZ,
    };
    body.end = {
      dateTime: raw.end.dateTime,
      timeZone: raw.end.timeZone || TZ,
    };
  }
  await call(() =>
    gapi.client.calendar.events.insert({ calendarId, resource: body })
  );
}

function showInfoDialog(title, message) {
  const dlg = document.getElementById("info-dialog");
  dlg.querySelector(".info-title").textContent = title;
  dlg.querySelector(".info-message").textContent = message;
  dlg.showModal();
}

function wireInfoDialog() {
  const dlg = document.getElementById("info-dialog");
  dlg.querySelector(".btn-close").addEventListener("click", () => dlg.close());
}

function formatEventWhen(event) {
  const start = event.start;
  const end = event.end || event.start;
  const dateFmt = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timeFmt = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  if (event.allDay) {
    // FullCalendar's end is exclusive — subtract 1 day for display.
    const inclusiveEnd = end ? addDays(end, -1) : start;
    if (sameLocalDate(start, inclusiveEnd)) {
      return `${dateFmt.format(start)} · All day`;
    }
    return `${dateFmt.format(start)} – ${dateFmt.format(inclusiveEnd)} · All day`;
  }

  if (sameLocalDate(start, end)) {
    return `${dateFmt.format(start)} · ${timeFmt.format(start)} – ${timeFmt.format(end)}`;
  }
  return `${dateFmt.format(start)}, ${timeFmt.format(start)} – ${dateFmt.format(end)}, ${timeFmt.format(end)}`;
}

function sameLocalDate(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/* ---------- Date update mode ---------- */

const DDMMYYYY_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const DDMMYYYY_ANCHORED_RE = /^(\d{2})\.(\d{2})\.(\d{4})(?:\b|$)/;

// Parse the description's first two lines for the strict court-case format.
// Returns null if the format is not satisfied.
//   Line 1: starts with "PD: dd.mm.yyyy" (extra text after the date is allowed)
//   Line 2: starts with "ND:" optionally followed by content
// ndState: "empty" | "date" | "na" | "unknown"
function parseCourtFormat(description) {
  if (!description) return null;
  const lines = String(description).split(/\r?\n/);
  if (lines.length < 2) return null;
  const pdMatch = lines[0].match(/^PD:\s*(\d{2}\.\d{2}\.\d{4})/);
  const ndMatch = lines[1].match(/^ND:\s*(.*)$/);
  if (!pdMatch || !ndMatch) return null;
  const ndRaw = ndMatch[1];
  const ndTrimmed = ndRaw.trim();
  let ndState;
  if (ndTrimmed === "") ndState = "empty";
  else if (DDMMYYYY_ANCHORED_RE.test(ndTrimmed)) ndState = "date";
  else if (/^NA(?:\b|\.|$)/i.test(ndTrimmed)) ndState = "na";
  else ndState = "unknown";
  return { pd: pdMatch[1], ndState, ndRaw, lines };
}

// Splice ["", "For: <text>"] right after the CNR line (line 5). Existing
// descriptions always have a blank line after CNR, so we don't add a
// trailing blank — the original one separates "For:" from what follows.
// Remove each existing "For:" line AND the blank immediately before it
// (the blank we always insert as part of the pair), then re-insert fresh.
// Handles legacy events with multiple For: lines from past bugs.
function insertListedFor(description, text) {
  if (!text) return description;
  const lines = String(description || "").split(/\r?\n/);
  const cleaned = [];
  for (const l of lines) {
    if (/^For:/.test(l)) {
      if (cleaned.length && cleaned[cleaned.length - 1].trim() === "") cleaned.pop();
      continue;
    }
    cleaned.push(l);
  }
  while (cleaned.length < 5) cleaned.push("");
  const before = cleaned.slice(0, 5);
  const after = cleaned.slice(5);
  return [...before, "", `For: ${text}`, ...after].join("\n");
}

// Replace line 2 with a new "ND:" payload. If `payload` is empty, line 2
// becomes "ND:" with no trailing space. The rest of the description is
// preserved exactly.
function setNdLine(description, payload) {
  const lines = String(description || "").split(/\r?\n/);
  while (lines.length < 2) lines.push("");
  lines[1] = payload ? `ND: ${payload}` : `ND:`;
  return lines.join("\n");
}

// Replace the first dd.mm.yyyy in line 1 with a new date string.
// Anything else on line 1 (and lines 3+) is preserved.
function setPdDate(description, newDate) {
  const lines = String(description || "").split(/\r?\n/);
  while (lines.length < 1) lines.push("");
  if (DDMMYYYY_RE.test(lines[0].replace(/^PD:\s*/, "").split(/\s/)[0] || "")) {
    lines[0] = lines[0].replace(/(\d{2}\.\d{2}\.\d{4})/, newDate);
  } else {
    lines[0] = `PD: ${newDate}`;
  }
  return lines.join("\n");
}

// dd.mm.yyyy from a Date or date-like value (uses local time).
function ddMmYyyy(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(dt.getDate())}.${pad(dt.getMonth() + 1)}.${dt.getFullYear()}`;
}

// "yyyy-mm-dd" → "dd.mm.yyyy"
function ymdToDdMmYyyy(s) {
  const [y, m, d] = s.split("-");
  return `${d}.${m}.${y}`;
}

function handleDateUpdateClick(event) {
  const parsed = parseCourtFormat(event.extendedProps.raw.description);
  if (!parsed || parsed.ndState !== "empty") {
    // Should not happen — fetchEvents filters these out — but guard anyway.
    showToast("This event isn't in the PD/ND empty-ND format.");
    return;
  }
  if (!event.extendedProps.writable) {
    showToast("This calendar is read-only — cannot modify events.");
    return;
  }
  openDateUpdateDialog(event);
}

function openDateUpdateDialog(event) {
  const dlg = document.getElementById("date-update-dialog");
  const form = dlg.querySelector("form");

  form.querySelector(".ev-title").textContent = event.title || "(no title)";
  const eventDateStr = ddMmYyyy(event.start);
  form.querySelector(".ev-date").textContent = "Date: " + eventDateStr;
  const loc = event.extendedProps.raw.location || "";
  form.querySelector(".ev-location").textContent = loc ? "Court: " + loc : "";

  const desc = event.extendedProps.raw.description || "";
  const lines = desc.split(/\r?\n/);
  const rawCaseNo = (lines[3] || "").trim();
  const rawLine5  = (lines[4] || "").trim();
  const caseNoEl = form.querySelector(".ev-caseno");
  const cnrEl    = form.querySelector(".ev-cnr");
  const caseNo = rawCaseNo && rawCaseNo !== "<case number>" ? rawCaseNo : "";
  caseNoEl.textContent = caseNo ? "Case No.: " + caseNo : "";
  const cnrMatch = rawLine5.match(/^CNR:\s*([A-Z0-9]{16})\b/i);
  cnrEl.textContent = cnrMatch ? "CNR: " + cnrMatch[1].toUpperCase() : "";

  form.nextDate.value = ymd(event.start);
  form.nextDate.required = true;
  form.nextDate.disabled = false;
  form.noNextDate.checked = false;
  form.naReason.value = "";
  form.querySelector(".na-reason").hidden = true;
  form.querySelector(".next-date-row").hidden = false;
  form.stageTodo.checked = false;
  form.listedFor.value = "";
  form.querySelector(".listed-for").hidden = true;
  form.addTask.checked = false;
  form.taskTitle.value = "";
  form.taskDeadline.value = "";
  form.querySelector(".task-fields").hidden = true;
  const errBox = form.querySelector(".dialog-error");
  errBox.hidden = true;
  errBox.textContent = "";
  const saveBtn = form.querySelector(".btn-save");
  saveBtn.disabled = false;
  saveBtn.textContent = "Update";

  form._currentEvent = event;
  if (!dlg.open) dlg.showModal();
  requestAnimationFrame(() => form.nextDate.focus());
}

function wireDateUpdateDialog() {
  const dlg = document.getElementById("date-update-dialog");
  const form = dlg.querySelector("form");
  const errBox = form.querySelector(".dialog-error");

  dlg.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (!t || t.tagName === "TEXTAREA") return;
    if (t.tagName === "BUTTON" && t.type !== "submit") return;
    if (t.tagName === "INPUT" && t.type === "checkbox") return;
    e.preventDefault();
    const saveBtn = form.querySelector(".btn-save");
    if (saveBtn && !saveBtn.disabled) form.requestSubmit(saveBtn);
  });

  form.noNextDate.addEventListener("change", () => {
    const off = form.noNextDate.checked;
    form.querySelector(".next-date-row").hidden = off;
    form.querySelector(".na-reason").hidden = !off;
    if (off) {
      form.nextDate.required = false;
    } else {
      form.nextDate.required = true;
      form.naReason.value = "";
    }
  });

  form.stageTodo.addEventListener("change", () => {
    const on = form.stageTodo.checked;
    form.querySelector(".listed-for").hidden = !on;
    if (!on) form.listedFor.value = "";
  });

  form.addTask.addEventListener("change", () => {
    const on = form.addTask.checked;
    form.querySelector(".task-fields").hidden = !on;
    if (on) {
      if (!form.taskTitle.value && form.listedFor.value.trim()) {
        form.taskTitle.value = form.listedFor.value.trim();
      }
      if (!form.taskDeadline.value && form.nextDate.value) {
        form.taskDeadline.value = form.nextDate.value;
      }
    } else {
      form.taskTitle.value = "";
      form.taskDeadline.value = "";
    }
  });

  form.querySelector(".btn-cancel").addEventListener("click", () => dlg.close());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const event = form._currentEvent;
    if (!event) return;
    errBox.hidden = true;
    errBox.textContent = "";

    const noNext = form.noNextDate.checked;
    if (!noNext && !form.nextDate.value) {
      errBox.textContent = "Pick a next date or check 'No next date is to be added'.";
      errBox.hidden = false;
      return;
    }
    if (!noNext) {
      const eventYmd = ymd(event.start);
      if (form.nextDate.value <= eventYmd) {
        errBox.textContent = "The next date of hearing should not be in the past.";
        errBox.hidden = false;
        return;
      }
    }

    const stageTodo = form.stageTodo.checked;
    const listedForText = form.listedFor.value.trim();
    if (stageTodo && !listedForText) {
      errBox.textContent = "Type a value for 'Listed for', or uncheck Stage / Add Task / To-Do.";
      errBox.hidden = false;
      return;
    }

    const addTask = form.addTask.checked;
    const taskTitle = form.taskTitle.value.trim();
    const taskDeadline = form.taskDeadline.value;
    if (addTask && (!taskTitle || !taskDeadline)) {
      errBox.textContent = "Add a Task is checked — Task title and Task deadline are both required.";
      errBox.hidden = false;
      return;
    }

    const saveBtn = form.querySelector(".btn-save");
    saveBtn.disabled = true;
    saveBtn.textContent = "Updating…";
    try {
      const result = await saveDateUpdate(event, {
        noNext,
        nextDateYmd: form.nextDate.value,
        naReason: form.naReason.value.trim(),
        listedFor: stageTodo ? listedForText : "",
      });

      if (addTask) {
        const caseTitle = (event.title && event.title !== "(no title)") ? event.title : "";
        const longTitle = caseTitle ? `${taskTitle} in ${caseTitle}` : taskTitle;
        const startDate = parseLocalYmd(taskDeadline);
        const endDate = addDays(startDate, 1);
        try {
          await call(() =>
            gapi.client.calendar.events.insert({
              calendarId: event.extendedProps.calendarId,
              resource: {
                summary: "Task: " + longTitle,
                start: { date: taskDeadline },
                end: { date: ymd(endDate) },
              },
            })
          );
          showToast("Task added to calendar");
        } catch (e) {
          console.error("addTask failed:", e);
          showToast("Saved date — task event failed: " + apiErrorMessage(e));
        }
      }

      if (calendar) calendar.refetchEvents();

      if (result && result.duplicate) {
        const dupStart = new Date(
          result.duplicate.start.dateTime ||
            result.duplicate.start.date + "T00:00:00"
        );
        if (isDateBeforeToday(dupStart)) {
          const cont = confirm(
            `The NDOH entered (${ddMmYyyy(dupStart)}) is in the past; ` +
              `do you want to further update the Next Date of Hearing for this case?`
          );
          if (cont) {
            const synthetic = buildSyntheticEvent(
              result.duplicate,
              result.calendarId
            );
            openDateUpdateDialog(synthetic);
            return;
          }
        }
      }

      dlg.close();
      if (!addTask) showToast("Saved");
    } catch (err) {
      console.error(err);
      if (err && err.rollbackFailed) {
        errBox.textContent = err.message;
      } else {
        errBox.textContent = "Save failed: " + apiErrorMessage(err);
      }
      errBox.hidden = false;
      saveBtn.disabled = false;
      saveBtn.textContent = "Update";
    }
  });
}

async function saveDateUpdate(event, choice) {
  const calendarId = event.extendedProps.calendarId;
  const raw = event.extendedProps.raw;
  const originalDesc = raw.description || "";

  if (choice.noNext) {
    const ndPayload = choice.naReason ? `NA. ${choice.naReason}` : `NA.`;
    const newDesc = setNdLine(originalDesc, ndPayload);
    await call(() =>
      gapi.client.calendar.events.patch({
        calendarId,
        eventId: event.id,
        resource: { description: newDesc },
      })
    );
    return;
  }

  // Path: a next date was picked.
  const nextDateYmd = choice.nextDateYmd;
  const nextDateDdMmYyyy = ymdToDdMmYyyy(nextDateYmd);
  const eventDateDdMmYyyy = ddMmYyyy(event.start);

  // 1) Update the original event's ND.
  const originalNewDesc = setNdLine(originalDesc, nextDateDdMmYyyy);
  await call(() =>
    gapi.client.calendar.events.patch({
      calendarId,
      eventId: event.id,
      resource: { description: originalNewDesc },
    })
  );

  // 2) Insert the duplicate on the picked date with PD updated and ND empty.
  let dupDesc = setPdDate(originalDesc, eventDateDdMmYyyy);
  dupDesc = setNdLine(dupDesc, "");
  if (choice.listedFor) {
    dupDesc = insertListedFor(dupDesc, choice.listedFor);
  }
  const dupBody = buildDuplicateBody(event, raw, nextDateYmd, dupDesc);
  try {
    const insertResp = await call(() =>
      gapi.client.calendar.events.insert({
        calendarId,
        resource: dupBody,
      })
    );
    return { duplicate: insertResp.result, calendarId };
  } catch (err) {
    // Insert failed. Retry the rollback a few times before giving up — a
    // transient failure here would otherwise leave the original event with an
    // ND pointing at a duplicate that doesn't exist.
    let rollbackErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await call(() =>
          gapi.client.calendar.events.patch({
            calendarId,
            eventId: event.id,
            resource: { description: originalDesc },
          })
        );
        rollbackErr = null;
        break;
      } catch (e) {
        rollbackErr = e;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }
    if (rollbackErr) {
      console.error("rollback failed after retries:", rollbackErr);
      const eventLabel = raw.summary || event.id;
      const wrapped = new Error(
        `Save failed and the rollback also failed. The original event "${eventLabel}" may now have an incorrect "next date" entry without a matching duplicate. Please open the event and verify its description manually. (Insert error: ${apiErrorMessage(err)}. Rollback error: ${apiErrorMessage(rollbackErr)}.)`
      );
      wrapped.rollbackFailed = true;
      wrapped.originalError = err;
      wrapped.rollbackError = rollbackErr;
      throw wrapped;
    }
    throw err;
  }
}

// Construct a FullCalendar-shaped event from a freshly-inserted Google event
// so we can feed it back into openDateUpdateDialog without waiting on a
// calendar refetch (which may not include the new event's date in view).
function buildSyntheticEvent(insertedEvent, calendarId) {
  const allDay = !insertedEvent.start.dateTime;
  const startStr =
    insertedEvent.start.dateTime || insertedEvent.start.date + "T00:00:00";
  const endStr = insertedEvent.end
    ? insertedEvent.end.dateTime || insertedEvent.end.date + "T00:00:00"
    : startStr;
  return {
    id: insertedEvent.id,
    title: insertedEvent.summary || "(no title)",
    start: new Date(startStr),
    end: new Date(endStr),
    allDay,
    extendedProps: {
      calendarId,
      raw: insertedEvent,
      writable: true,
    },
  };
}

function isDateBeforeToday(d) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  return date < today;
}

function isDateAfterToday(d) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  return date > today;
}

// Build a Google event body for the duplicate. Preserves title, location,
// description (already rewritten), and times. Same calendar as the original.
function buildDuplicateBody(event, raw, nextDateYmd, dupDesc) {
  const body = {
    summary: raw.summary,
    location: raw.location,
    description: dupDesc,
  };
  // Optional attributes worth preserving.
  if (raw.colorId) body.colorId = raw.colorId;
  if (raw.transparency) body.transparency = raw.transparency;
  if (raw.visibility) body.visibility = raw.visibility;
  if (raw.reminders) body.reminders = raw.reminders;

  if (event.allDay) {
    // Preserve multi-day duration. Google end.date is exclusive.
    const origStartDate = parseLocalYmd(raw.start.date);
    const origEndDate = parseLocalYmd(raw.end.date);
    const durationDays = Math.max(
      1,
      Math.round((origEndDate - origStartDate) / 86400000)
    );
    const newStartDate = parseLocalYmd(nextDateYmd);
    const newEndDate = addDays(newStartDate, durationDays);
    body.start = { date: nextDateYmd };
    body.end = { date: ymd(newEndDate) };
  } else {
    const origStart = new Date(raw.start.dateTime);
    const origEnd = new Date(raw.end.dateTime);
    const [y, m, d] = nextDateYmd.split("-").map(Number);
    const newStart = new Date(
      y, m - 1, d,
      origStart.getHours(),
      origStart.getMinutes(),
      origStart.getSeconds(),
      origStart.getMilliseconds()
    );
    const durationMs = origEnd.getTime() - origStart.getTime();
    const newEnd = new Date(newStart.getTime() + durationMs);
    const tz = (raw.start && raw.start.timeZone) || TZ;
    body.start = { dateTime: newStart.toISOString(), timeZone: tz };
    body.end = { dateTime: newEnd.toISOString(), timeZone: tz };
  }
  // Strip undefined fields so we don't send "field: undefined" to Google.
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
  return body;
}

function parseLocalYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/* ---------- Toggle ---------- */

function wireToggle() {
  const cb = document.getElementById("date-update-toggle");
  cb.checked = dateUpdateMode;
  updateModeHint();
  cb.addEventListener("change", () => {
    dateUpdateMode = cb.checked;
    writeDateUpdateMode(dateUpdateMode);
    updateModeHint();
    if (calendar) calendar.refetchEvents();
  });
}

function updateModeHint() {
  const hint = document.getElementById("mode-hint");
  if (!hint) return;
  hint.textContent = dateUpdateMode
    ? "Click case title to update its next date. Switch OFF to see case details"
    : "Read only and error reporting mode. Switch ON to update dates.";
}

/* ---------- Helpers ---------- */

function ymd(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function apiErrorMessage(err) {
  if (!err) return "unknown error";
  if (err.result && err.result.error && err.result.error.message)
    return err.result.error.message;
  if (err.message) return err.message;
  return "unknown error";
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Escape the text once, then turn http/https URLs in the escaped output into
// anchor tags. Trailing sentence punctuation (.,;:!?)] is kept outside the
// link so it doesn't end up as part of the URL.
function linkifyDescription(text) {
  const urlRe = /(https?:\/\/\S+)/g;
  return escapeHtml(text).replace(urlRe, (matched) => {
    const trail = matched.match(/[.,;:!?)\]]+$/);
    const url = trail ? matched.slice(0, -trail[0].length) : matched;
    const suffix = trail ? trail[0] : "";
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${suffix}`;
  });
}

/* ---------- Add a New Case ---------- */

function wireNewCaseDialog() {
  const openBtn = $('new-case-btn');
  if (!openBtn) return;
  const dlg  = $('new-case-dialog');
  const form = $('new-case-form');
  const errBox = $('new-case-error');

  openBtn.addEventListener('click', () => {
    form.reset();
    populateCalendarSelect(form.calendarId);
    form.date.value = ymd(new Date());
    form.prevDate.value = '';
    form.prevNA.checked = true;
    form.querySelector('.prev-date-row').hidden = true;
    form.courtLocOther.hidden = true;
    form.courtLocOther.required = false;
    const sugg = $('court-suggestion');
    if (sugg) { sugg.hidden = true; $('court-suggestion-text').textContent = ''; }
    errBox.hidden = true; errBox.textContent = '';
    form.querySelector('button[type="submit"]').disabled = false;
    dlg.showModal();
    requestAnimationFrame(() => form.cnr.focus());
  });

  form.querySelector('.btn-cancel').addEventListener('click', () => dlg.close());

  // NA checkbox — toggle the date picker
  form.prevNA.addEventListener('change', () => {
    const off = form.prevNA.checked;
    form.querySelector('.prev-date-row').hidden = off;
    if (off) form.prevDate.value = '';
  });

  // Court location — toggle "Others" free-text input
  form.courtLoc.addEventListener('change', () => {
    const isOther = form.courtLoc.value === '__other__';
    form.courtLocOther.hidden = !isOther;
    if (isOther) form.courtLocOther.required = true;
    else { form.courtLocOther.required = false; form.courtLocOther.value = ''; }
  });

  // CNR → auto-fill District for Delhi CNRs (chars 1-2 = DL, chars 3-4 = district code)
  const CNR_DL_DISTRICT = {
    CT: 'C', ET: 'E', ND: 'ND', NT: 'N', NE: 'NE',
    NW: 'NW', SH: 'Shahdara', ST: 'S', SE: 'SE', SW: 'SW', WT: 'W',
  };
  form.cnr.addEventListener('input', () => {
    const v = (form.cnr.value || '').trim().toUpperCase();
    if (v.length < 4 || v.slice(0, 2) !== 'DL') return;
    const dd = CNR_DL_DISTRICT[v.slice(2, 4)];
    if (!dd) return;
    if (form.districtInit.value && form.districtInit.value !== dd) return;
    form.districtInit.value = dd;
  });

  // CNR Lookup button → court-watch
  $('cnr-lookup-btn').addEventListener('click', async () => {
    const cnr = form.cnr.value.trim().toUpperCase();
    if (!/^[A-Za-z0-9]{16}$/.test(cnr)) {
      errBox.textContent = 'Type the 16-character CNR before looking up.';
      errBox.hidden = false;
      return;
    }
    errBox.hidden = true; errBox.textContent = '';
    const btn = $('cnr-lookup-btn');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Looking up…';
    try {
      const res = await fetch(
        `${COURT_WATCH_BASE}/api/case-lookup?cnr=${encodeURIComponent(cnr)}`,
        { credentials: 'omit' }
      );
      if (res.status === 404) { openCnrNotFoundChooser(cnr, form, errBox); return; }
      let data = null;
      try { data = await res.json(); } catch {}
      if (!res.ok) throw new Error((data && data.detail) || `HTTP ${res.status}`);
      applyCnrLookupData(data, form);
      showToast('CNR looked up — fill the Court fields from the eCourts hint, then click Add.');
    } catch (e) {
      const isNetwork = e instanceof TypeError;
      errBox.textContent = isNetwork
        ? `Could not reach court-watch at ${COURT_WATCH_BASE} — make sure it is running.`
        : 'Lookup failed: ' + e.message + '. Fill the form manually.';
      errBox.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.hidden = true; errBox.textContent = '';

    const calendarId  = form.calendarId.value;
    const petitioner  = form.petitioner.value.trim();
    const respondent  = form.respondent.value.trim();
    const summary     = (petitioner && respondent) ? `${petitioner} v. ${respondent}` : '';
    const roomNo      = form.roomNo.value.trim();
    const courtLocSel = form.courtLoc.value;
    const courtLoc    = courtLocSel === '__other__' ? form.courtLocOther.value.trim() : courtLocSel;
    const judgeName   = form.judgeName.value.trim();
    const judgeDesig  = form.judgeDesignation.value.trim();
    const distInit    = form.districtInit.value.trim();
    const location    = [roomNo, courtLoc, judgeName, judgeDesig].filter(Boolean).join(', ')
                        + (distInit ? ` (${distInit})` : '');
    const date        = form.date.value;
    const cnr         = form.cnr.value.trim().toUpperCase();
    const weRepr      = form.weRepresent.value.trim();
    const caseNo      = form.caseNo.value.trim();
    const prevNA      = form.prevNA.checked;
    const prevDate    = form.prevDate.value;

    if (!calendarId || !petitioner || !respondent || !roomNo || !courtLoc
        || !judgeName || !judgeDesig || !date || !cnr || !weRepr) {
      errBox.textContent = 'Calendar, Petitioner, Respondent, Room #, Court location, Judge name, Designation, Date, CNR, and We represent are all required.';
      errBox.hidden = false; return;
    }
    if (!/^[A-Za-z0-9]{16}$/.test(cnr)) {
      errBox.textContent = 'CNR must be exactly 16 alphanumeric characters.';
      errBox.hidden = false; return;
    }
    if (!prevNA && !prevDate) {
      errBox.textContent = "Pick a previous date, or check 'NA — no previous date'.";
      errBox.hidden = false; return;
    }
    if (!prevNA && prevDate >= ymd(new Date())) {
      errBox.textContent = 'Previous date should be in the past.';
      errBox.hidden = false; return;
    }

    const pdValue     = prevNA ? 'NA' : `${ymdToDdMmYyyy(prevDate)} (not in diary)`;
    const description = buildNewCaseDescription({ pd: pdValue, caseNo, cnr, weRepresent: weRepr });

    const resource = {
      summary, location, description,
      start: { dateTime: `${date}T10:00:00+05:30`, timeZone: 'Asia/Kolkata' },
      end:   { dateTime: `${date}T11:00:00+05:30`, timeZone: 'Asia/Kolkata' },
    };

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await gapi.client.calendar.events.insert({ calendarId, resource });
      dlg.close();
      showToast('Case added');
      if (calendar) calendar.refetchEvents();
    } catch (err) {
      errBox.textContent = 'Failed to add case: ' + apiErrorMessage(err);
      errBox.hidden = false;
      submitBtn.disabled = false;
    }
  });
}

function populateCalendarSelect(selectEl) {
  selectEl.innerHTML = '';
  const writable = (calendarsList || []).filter(
    (c) => c.accessRole === 'owner' || c.accessRole === 'writer'
  );
  if (!writable.length) {
    const opt = document.createElement('option');
    opt.textContent = '(no writable calendars)';
    opt.disabled = true;
    selectEl.appendChild(opt);
    return;
  }
  const preferred = writable.find((c) => c.summary === 'Court Diary') || writable[0];
  for (const cal of writable) {
    const opt = document.createElement('option');
    opt.value = cal.id;
    opt.textContent = cal.summary || cal.id;
    if (cal.id === preferred.id) opt.setAttribute('selected', '');
    selectEl.appendChild(opt);
  }
  selectEl.value = preferred.id;
}

function applyCnrLookupData(data, form) {
  let petName = data.petitioner || '';
  let resName = data.respondent || '';
  if ((!petName || !resName) && data.title) {
    const m = data.title.match(/^(.+?)\s+v\.?s?\.?\s+(.+)$/i);
    if (m) { petName = petName || m[1].trim(); resName = resName || m[2].trim(); }
  }
  if (petName && !form.petitioner.value) form.petitioner.value = petName;
  if (resName && !form.respondent.value) form.respondent.value = resName;
  const caseNo = [data.case_type, data.registration_number].filter(Boolean).join('/');
  if (caseNo && !form.caseNo.value) form.caseNo.value = caseNo;
  const sugg = $('court-suggestion');
  const suggText = $('court-suggestion-text');
  if (data.court) { suggText.textContent = data.court; sugg.hidden = false; }
  else { sugg.hidden = true; suggText.textContent = ''; }
}

function openCnrNotFoundChooser(cnr, form, errBox) {
  const dlg = $('cnr-not-found-dialog');
  $('cnr-nf-cnr').textContent = cnr;

  function replace(btn) {
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    return fresh;
  }
  const q = replace($('cnr-nf-queue'));
  const m = replace($('cnr-nf-manual'));

  q.addEventListener('click', async () => {
    dlg.close();
    try {
      const fd = new FormData();
      fd.set('cnrs', cnr);
      await fetch(`${COURT_WATCH_BASE}/queue/bulk`, {
        method: 'POST', body: fd, credentials: 'omit',
      });
    } catch (e) { console.error('queue add failed:', e); }
    window.open(`${COURT_WATCH_BASE}/queue`, '_blank', 'noopener');
    showToast('Added to Court-Watch queue. Solve the captcha there, then click Lookup again.');
  });

  m.addEventListener('click', () => {
    dlg.close();
    showToast('Fill the form by hand — Lookup is skipped.');
  });

  if (!dlg.open) dlg.showModal();
}

function buildNewCaseDescription({ pd, caseNo, cnr, weRepresent }) {
  return [
    `PD: ${pd}`,
    'ND:',
    '',
    caseNo || '<case number>',
    `CNR: ${cnr}`,
    '',
    `We represent: ${weRepresent}`,
    '',
    'VC Link:',
    '',
    '',
    'Meeting ID: ',
    '',
    'Court Reader:',
    '',
    '',
    '',
    'Court email:',
    '',
  ].join('\n');
}
