// Optional account + sync with Supabase (plain fetch, no SDK).
// The app always works from this device's copy; when signed in, local changes
// upload from the outbox and changes from your other devices download.
import * as DB from './db.js';

const SUPABASE_URL = 'https://wyadiallryxhdpucndve.supabase.co';
// Publishable key: meant to ship in browser code. The database's Row Level
// Security limits every account to its own rows, and signed-out requests get nothing.
const SUPABASE_KEY = 'sb_publishable_9h8nhpmzskqiDjT2v-dZQw_dUsfnR5T';

const SESSION_KEY = 'tally.session';
const OWNER_KEY = 'tally.owner'; // the account this device's data belongs to
const cursorKey = (uid) => `tally.cursor.${uid}`;
const PAGE = 1000;
const OVERLAP_MS = 2 * 60 * 1000; // re-read a little history so late commits aren't missed

const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

class Offline extends Error { constructor() { super('Can’t reach the server. Check your connection.'); } }
class SignedOut extends Error { constructor() { super('Signed out'); } }

// ---------- Status ----------
/** state: off | idle | syncing | ok | offline | error */
export const status = { state: 'off', lastSync: null, error: '' };
const subs = new Set();
export const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
function setStatus(patch) { Object.assign(status, patch); for (const f of subs) f(status); }

// ---------- Session ----------
const session = () => ls.get(SESSION_KEY);
export const user = () => session()?.user ?? null;
/** Signed out because the sign-in expired, not because the user chose to. */
export const expiredFor = () => (!session() && ls.get(OWNER_KEY)) || null;

function saveSession(j) {
  ls.set(SESSION_KEY, {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_at ?? Math.floor(Date.now() / 1000) + j.expires_in,
    user: { id: j.user.id, email: j.user.email },
  });
}

async function call(url, { method = 'GET', body, token, prefer } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        apikey: SUPABASE_KEY,
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new Offline(); }
  const text = await res.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    throw Object.assign(new Error(j?.msg || j?.error_description || j?.message || `Server error ${res.status}`),
      { status: res.status, code: j?.error_code || j?.code || j?.error });
  }
  return j;
}
const auth = (path, opts) => call(`${SUPABASE_URL}/auth/v1/${path}`, opts);

let refreshing = null;
async function token() {
  const s = session();
  if (!s) throw new SignedOut();
  if (s.expires_at - 60 > Date.now() / 1000) return s.access_token;
  refreshing ??= auth('token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s.refresh_token } })
    .then(saveSession, (e) => {
      // A rejected refresh token means the sign-in ended; keep this device's data.
      if (e.status >= 400 && e.status < 500) { ls.set(SESSION_KEY, null); setStatus({ state: 'off' }); throw new SignedOut(); }
      throw e;
    })
    .finally(() => { refreshing = null; });
  await refreshing;
  return session().access_token;
}

const rest = async (path, opts = {}) => call(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, token: await token() });

// ---------- Sync ----------
async function push(uid) {
  const pending = await DB.readPending();
  for (let i = 0; i < pending.length; i += 500) {
    const chunk = pending.slice(i, i + 500);
    await rest('records?on_conflict=user_id,store,id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: chunk.map((e) => ({ user_id: uid, store: e.store, id: String(e.id), data: e.data ?? {}, deleted: e.data == null })),
    });
    await DB.markPushed(chunk);
  }
}

async function fetchSince(sinceMs) {
  const filter = sinceMs ? `&updated_at=gt.${encodeURIComponent(new Date(sinceMs - OVERLAP_MS).toISOString())}` : '';
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await rest(`records?select=store,id,data,deleted,updated_at&order=updated_at.asc,store.asc,id.asc&limit=${PAGE}&offset=${offset}${filter}`);
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

const latest = (rows, prev) => rows.reduce((m, r) => Math.max(m, Date.parse(r.updated_at) || 0), prev || 0);

/**
 * First sync of this account on this device. A device with no transactions,
 * schedules or budgets of its own just takes the account's data (no duplicate
 * starter categories); otherwise both sides are merged.
 */
async function firstLink(uid) {
  const remote = await fetchSince(0);
  const local = await DB.loadAll();
  const localHasData = local.transactions.length || local.recurring.length || local.budgets.length;
  let changed;
  if (remote.length && !localHasData) {
    await DB.replaceLocal(remote);
    changed = 1;
  } else {
    changed = await DB.applyRemote(remote);
    await DB.enqueueAll();
    await push(uid);
  }
  ls.set(cursorKey(uid), latest(remote, 0) || 1);
  return changed;
}

let onRemoteChange = () => {};
let running = null;
let again = false;

/** Upload local changes, then download changes from other devices. */
export function sync() {
  if (!session()) return Promise.resolve();
  if (running) { again = true; return running; }
  running = (async () => {
    do { again = false; await syncOnce(); } while (again && session());
  })().finally(() => { running = null; });
  return running;
}

async function syncOnce() {
  if (!navigator.onLine) { setStatus({ state: 'offline' }); return; }
  setStatus({ state: 'syncing', error: '' });
  try {
    const uid = user().id;
    let changed = 0;
    if (ls.get(cursorKey(uid)) == null) changed += await firstLink(uid);
    else await push(uid);
    const cursor = ls.get(cursorKey(uid));
    const rows = await fetchSince(cursor);
    changed += await DB.applyRemote(rows);
    ls.set(cursorKey(uid), latest(rows, cursor));
    setStatus({ state: 'ok', lastSync: Date.now() });
    if (changed) await onRemoteChange();
  } catch (e) {
    if (e instanceof SignedOut) { setStatus({ state: 'off' }); return; }
    console.warn('Sync failed', e);
    setStatus({ state: e instanceof Offline ? 'offline' : 'error', error: e.message });
  }
}

let timer = null;
function schedule() {
  if (!session()) return;
  clearTimeout(timer);
  timer = setTimeout(sync, 800);
}

/** Start background sync. onRemote is called after downloaded changes are saved locally. */
export function init({ onRemote }) {
  onRemoteChange = onRemote;
  DB.onChange(schedule);
  window.addEventListener('online', () => sync());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
  setInterval(() => { if (!document.hidden) sync(); }, 60 * 1000);
  if (session()) { setStatus({ state: 'idle' }); sync(); }
}

// ---------- Account actions ----------
/**
 * Sign in and run the first sync. If this device holds another account's data,
 * confirmSwitch(otherEmail) decides whether to remove it first; resolves false if declined.
 */
export async function signIn(email, password, confirmSwitch) {
  let j;
  try {
    j = await auth('token?grant_type=password', { method: 'POST', body: { email, password } });
  } catch (e) {
    if (e.code === 'invalid_credentials' || e.status === 400) throw new Error('Wrong email or password.');
    throw e;
  }
  const owner = ls.get(OWNER_KEY);
  if (owner && owner.id !== j.user.id) {
    if (!(await confirmSwitch(owner.email))) return false;
    await DB.wipeLocal();
    ls.set(cursorKey(owner.id), null);
  }
  saveSession(j);
  ls.set(OWNER_KEY, { id: j.user.id, email: j.user.email });
  await sync();
  return true;
}

/** Sign out and remove this account's data from the device (it stays in the account). */
export async function signOut() {
  const s = session();
  if (s) auth('logout', { method: 'POST', token: s.access_token }).catch(() => {});
  const owner = ls.get(OWNER_KEY);
  ls.set(SESSION_KEY, null);
  ls.set(OWNER_KEY, null);
  if (owner) ls.set(cursorKey(owner.id), null);
  await DB.wipeLocal();
  setStatus({ state: 'off', lastSync: null, error: '' });
}

export async function changePassword(password) {
  try {
    await auth('user', { method: 'PUT', body: { password }, token: await token() });
  } catch (e) {
    if (e.code === 'same_password') throw new Error('Choose a password different from your current one.');
    if (e.code === 'weak_password') throw new Error(e.message);
    throw e;
  }
}
