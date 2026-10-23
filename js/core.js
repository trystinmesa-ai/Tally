// Pure helpers: money (integer cents), local calendar dates, totals,
// budgets and recurring schedules. No DOM, no storage — unit-testable in Node.

// ---------- Money ----------
export const MAX_CENTS = 99_999_999_99; // $99,999,999.99

/** Parse user text like "12", "12.5", "$1,234.56" into integer cents. */
export function parseAmount(input, { allowZero = false } = {}) {
  const s = String(input ?? '').trim().replace(/[$,\s]/g, '');
  if (s === '') return { ok: false, error: 'Enter an amount' };
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] === undefined || m[2] === ''))) {
    if (/^\d*\.\d{3,}$/.test(s)) return { ok: false, error: 'Use at most 2 decimal places' };
    return { ok: false, error: 'Enter a valid amount, like 12.50' };
  }
  const dollars = m[1] === '' ? 0 : parseInt(m[1], 10);
  const frac = (m[2] ?? '').padEnd(2, '0');
  const cents = dollars * 100 + (frac ? parseInt(frac, 10) : 0);
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return { ok: false, error: 'That amount is too large' };
  if (cents <= 0 && !allowZero) return { ok: false, error: 'Amount must be more than $0' };
  return { ok: true, cents };
}

function groupDigits(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Exact formatting from integer cents. sign: 'auto' (− only), 'always' (+/−), 'none'. */
export function fmt(cents, { sign = 'auto', whole = false } = {}) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const d = Math.trunc(abs / 100);
  const c = abs % 100;
  let body = '$' + groupDigits(d) + (whole && c === 0 ? '' : '.' + String(c).padStart(2, '0'));
  if (sign === 'none') return body;
  if (neg) return '−' + body;
  if (sign === 'always' && cents > 0) return '+' + body;
  return body;
}

/** Rounded to whole dollars, for dense tables. */
export function fmtDollars(cents, opts = {}) {
  return fmt(Math.round(cents / 100) * 100, { ...opts, whole: true });
}

/** Short label for charts: $850, $3.2k, $1.4M */
export function fmtCompact(cents) {
  const v = Math.abs(cents) / 100;
  const neg = cents < 0 ? '−' : '';
  if (v < 1000) return neg + '$' + (Number.isInteger(v) ? v : Math.round(v));
  if (v < 1e6) return neg + '$' + trim1(v / 1000) + 'k';
  return neg + '$' + trim1(v / 1e6) + 'M';
}
function trim1(x) { const r = Math.round(x * 10) / 10; return r >= 100 ? String(Math.round(r)) : String(r); }

export function centsToInput(cents) {
  return Math.trunc(cents / 100) + '.' + String(cents % 100).padStart(2, '0');
}

// ---------- Dates (local calendar strings "YYYY-MM-DD") ----------
const pad = (n) => String(n).padStart(2, '0');
export const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; }
export function dateFromLocal(d = new Date()) { return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
export const todayStr = () => dateFromLocal(new Date());
export const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
export function isValidYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const { y, m, d } = parseYmd(s);
  return y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}
/** Local noon avoids any DST edge case when doing day arithmetic. */
export const toDate = (s) => { const { y, m, d } = parseYmd(s); return new Date(y, m - 1, d, 12); };
export function addDays(s, n) { const dt = toDate(s); dt.setDate(dt.getDate() + n); return dateFromLocal(dt); }
export const monthKey = (s) => s.slice(0, 7);
export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
export function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  return [ymd(y, m, 1), ymd(y, m, daysInMonth(y, m))];
}
export const yearRange = (y) => [`${y}-01-01`, `${y}-12-31`];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
export function monthLabel(ym, short = false) {
  const [y, m] = ym.split('-').map(Number);
  return (short ? MONTHS[m - 1].slice(0, 3) : MONTHS[m - 1]) + ' ' + y;
}
export const monthName = (m, short = false) => short ? MONTHS[m - 1].slice(0, 3) : MONTHS[m - 1];
export function dayLabel(s, today = todayStr()) {
  if (s === today) return 'Today';
  if (s === addDays(today, -1)) return 'Yesterday';
  if (s === addDays(today, 1)) return 'Tomorrow';
  const dt = toDate(s);
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (s.slice(0, 4) !== today.slice(0, 4)) opts.year = 'numeric';
  return dt.toLocaleDateString('en-US', opts);
}
export function shortDate(s, today = todayStr()) {
  const opts = { month: 'short', day: 'numeric' };
  if (s.slice(0, 4) !== today.slice(0, 4)) opts.year = 'numeric';
  return toDate(s).toLocaleDateString('en-US', opts);
}
export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---------- Totals ----------
/** How an expense's amount is allocated to categories (split or single). */
export function allocations(tx) {
  if (tx.type === 'expense' && Array.isArray(tx.splits) && tx.splits.length) return tx.splits;
  return [{ categoryId: tx.categoryId, amount: tx.amount }];
}

/** Totals for transactions whose date falls in [start, end] (inclusive strings). */
export function summarize(txs, start, end) {
  let income = 0, spending = 0, count = 0;
  const spendByCat = new Map(), incomeByCat = new Map();
  for (const t of txs) {
    if (t.date < start || t.date > end) continue;
    count++;
    const target = t.type === 'income' ? incomeByCat : spendByCat;
    if (t.type === 'income') income += t.amount; else spending += t.amount;
    for (const a of allocations(t)) target.set(a.categoryId, (target.get(a.categoryId) || 0) + a.amount);
  }
  return { income, spending, net: income - spending, count, spendByCat, incomeByCat };
}

/** Percent change, or null when there's no meaningful base. */
export function pctChange(prev, cur) {
  if (!prev) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

export function pctLabel(p) {
  if (p === null || p === undefined || !isFinite(p)) return '';
  if (p > 0 && p < 0.5) return '<1%';
  return Math.round(p) + '%';
}

// ---------- Splits ----------
export function validateSplits(splits, total) {
  if (!splits || splits.length < 2) return 'Add at least two categories to split';
  const seen = new Set();
  let sum = 0;
  for (const s of splits) {
    if (!s.categoryId) return 'Choose a category for each part';
    if (seen.has(s.categoryId)) return 'Use each category only once';
    seen.add(s.categoryId);
    if (!Number.isSafeInteger(s.amount) || s.amount <= 0) return 'Each part needs an amount above $0';
    sum += s.amount;
  }
  if (sum !== total) return sum < total ? `${fmt(total - sum)} left to assign` : `Parts are ${fmt(sum - total)} over the total`;
  return null;
}

// ---------- Budgets ----------
// Budget entries: {categoryId, month:'YYYY-MM', limit: cents|null}. A limit
// applies from its month onward until a later entry; null = removed.
export function effectiveBudget(entries, categoryId, ym) {
  let best = null;
  for (const e of entries) {
    if (e.categoryId !== categoryId || e.month > ym) continue;
    if (!best || e.month > best.month) best = e;
  }
  return best && best.limit !== null && best.limit !== undefined ? best.limit : null;
}

export function budgetStatus(spent, limit) {
  const remaining = limit - spent;
  const over = spent > limit;
  const pct = limit > 0 ? (spent / limit) * 100 : (spent > 0 ? Infinity : 0);
  return { spent, limit, remaining, over, pct };
}

// ---------- Recurring ----------
// Schedule: {freq:'weekly'|'monthly'|'yearly', startDate, day (1-31, monthly/yearly),
//            paused, handled: {'YYYY-MM-DD': {s:'confirmed'|'skipped', txId?}}}
export function occurrenceAt(rec, k) {
  const { y, m, d } = parseYmd(rec.startDate);
  if (rec.freq === 'weekly') return addDays(rec.startDate, 7 * k);
  const day = rec.day || d;
  if (rec.freq === 'yearly') { const yy = y + k; return ymd(yy, m, Math.min(day, daysInMonth(yy, m))); }
  const t = y * 12 + (m - 1) + k;
  const yy = Math.floor(t / 12), mm = (t % 12) + 1;
  return ymd(yy, mm, Math.min(day, daysInMonth(yy, mm)));
}

/** All occurrence dates from startDate up to `until` (inclusive). */
export function occurrencesUntil(rec, until, cap = 600) {
  const out = [];
  for (let k = 0; k < cap; k++) {
    const o = occurrenceAt(rec, k);
    if (o > until) break;
    if (o >= rec.startDate) out.push(o);
  }
  return out;
}

/** Unconfirmed, unskipped occurrences up to `until`. Paused schedules have none. */
export function pendingOccurrences(rec, until) {
  if (rec.paused) return [];
  const h = rec.handled || {};
  return occurrencesUntil(rec, until).filter((o) => !h[o]);
}

/** First occurrence that hasn't been handled (for display), or null. */
export function nextPending(rec, cap = 600) {
  const h = rec.handled || {};
  for (let k = 0; k < cap; k++) {
    const o = occurrenceAt(rec, k);
    if (o >= rec.startDate && !h[o]) return o;
  }
  return null;
}

/** First occurrence on/after `date`, keeping the schedule's cadence. */
export function firstOnOrAfter(rec, date, cap = 2000) {
  for (let k = 0; k < cap; k++) {
    const o = occurrenceAt(rec, k);
    if (o >= date && o >= rec.startDate) return o;
  }
  return null;
}

export function describeCadence(rec) {
  const { m, d } = parseYmd(rec.startDate);
  const day = rec.day || d;
  if (rec.freq === 'weekly') return 'Weekly on ' + toDate(rec.startDate).toLocaleDateString('en-US', { weekday: 'long' }) + 's';
  if (rec.freq === 'yearly') return `Yearly on ${monthName(m, true)} ${day}`;
  return `Monthly on the ${ordinal(day)}` + (day >= 29 ? ' (or last day)' : '');
}

export function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
