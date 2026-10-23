import * as C from './core.js';
import * as DB from './db.js';
import * as Cloud from './cloud.js';
import { h, sv, icon, replace, clear, openSheet, closeAllSheets, sheetOpen, confirmDialog, toast } from './ui.js';

// ---------- Constants ----------
export const PALETTE = ['#86A9D6', '#8FC3A0', '#DDB46F', '#D9908A', '#B39CD8', '#72BFC2', '#D4A383', '#A9B771', '#C893B6', '#9DA5AF'];
const STARTER = {
  expense: [['Housing', 0], ['Groceries', 1], ['Dining', 2], ['Transportation', 5], ['Bills & Utilities', 4], ['Shopping', 8], ['Health', 3], ['Fun', 7], ['Other', 9]],
  income: [['Paycheck', 1], ['Gift', 4], ['Other Income', 9]],
};
const MAX_RINGS = 5;

// ---------- State ----------
const S = {
  cats: [], txs: [], recs: [], budgets: [], meta: {},
  view: 'home',
  period: { mode: 'month', ym: C.monthKey(C.todayStr()), y: Number(C.todayStr().slice(0, 4)) },
  budgetYm: C.monthKey(C.todayStr()),
  f: { q: '', type: 'all', cat: 'all', range: 'all', from: '', to: '' },
};
window.__tally = S; // handy for debugging in the console; never sent anywhere.

const catById = (id) => S.cats.find((c) => c.id === id);
const catName = (id) => catById(id)?.name ?? 'Uncategorized';
const catColor = (id) => catById(id)?.color ?? '#77777e';
const activeCats = (kind, keepId) => S.cats.filter((c) => c.kind === kind && (!c.archived || c.id === keepId))
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
const today = () => C.todayStr();
const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0));

function setMeta(key, value) { S.meta[key] = value; return DB.put('meta', { key, value }); }

/** Keep the app fixed to the screen like a native app: no pinch zoom (iOS ignores user-scalable=no). */
function lockZoom() {
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
}

async function requestPersistence() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}
}

function fail(e) {
  console.error(e);
  toast('Something went wrong saving. Please try again.');
}

// ---------- Boot ----------
async function loadState() {
  const d = await DB.loadAll();
  S.cats = d.categories; S.txs = d.transactions; S.recs = d.recurring; S.budgets = d.budgets;
  S.meta = Object.fromEntries(d.meta.map((m) => [m.key, m.value]));
  if (!S.meta.seeded) await seedCategories();
}

const typingInApp = () => {
  const a = document.activeElement;
  return a && document.getElementById('app').contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);
};

/** Reload after sync changed local data. Sheets keep working; the screen behind them redraws. */
async function reloadFromDb() {
  await loadState();
  if (!typingInApp()) render();
}

async function init() {
  lockZoom();
  try {
    await loadState();
  } catch (e) {
    console.error(e);
    replace(document.getElementById('app'), h('div', { class: 'screen' }, h('div', { class: 'card empty' },
      h('h3', { text: 'Storage is unavailable' }),
      h('p', { text: 'Tally couldn’t open on-device storage. Private Browsing or blocked website data can cause this.' }))));
    return;
  }
  render();
  Cloud.init({ onRemote: reloadFromDb });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !sheetOpen()) render(); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
}

async function seedCategories() {
  const list = [];
  for (const kind of ['expense', 'income']) {
    STARTER[kind].forEach(([name, color], i) => list.push({ id: C.uid(), kind, name, color: PALETTE[color], order: i, archived: false, createdAt: Date.now() }));
  }
  await DB.putMany('categories', list);
  S.cats = list;
  await setMeta('seeded', true);
}

// ---------- Rendering shell ----------
function render() {
  const app = document.getElementById('app');
  const scrollY = window.scrollY;
  const view = { home: renderHome, activity: renderActivity, recurring: renderRecurring, budgets: renderBudgets }[S.view]();
  replace(app, view);
  renderTabbar();
  window.scrollTo(0, scrollY);
}

function go(view) {
  if (S.view === view) { window.scrollTo(0, 0); }
  S.view = view;
  render();
  window.scrollTo(0, 0);
}

function needsAttentionCount() {
  const t = today();
  return S.recs.reduce((n, r) => n + C.pendingOccurrences(r, t).length, 0);
}

function renderTabbar() {
  const n = needsAttentionCount();
  const tab = (id, label, ic, badge) => h('button', { class: 'tab', 'aria-current': S.view === id ? 'page' : null, onclick: () => go(id) },
    icon(ic), h('span', { text: label }), badge ? h('span', { class: 'badge', 'aria-label': `${badge} need confirmation`, text: String(badge) }) : null);
  replace(document.getElementById('tabbar'), h('nav', { 'aria-label': 'Main' },
    tab('home', 'Overview', 'home'),
    tab('activity', 'Transactions', 'list'),
    h('button', { class: 'tab add', 'aria-label': 'New transaction', onclick: () => openTxForm() }, h('span', { class: 'plus' }, icon('plus'))),
    tab('recurring', 'Recurring', 'repeat', n),
    tab('budgets', 'Budgets', 'budget'),
  ));
}

const topbar = (title, ...right) => h('header', { class: 'topbar' }, h('h1', { text: title }), h('div', { style: 'display:flex;gap:4px' }, right));
const settingsBtn = () => h('button', { class: 'icon-btn', 'aria-label': 'Settings', onclick: openSettings }, icon('settings'));

// ---------- Overview ----------
function periodInfo(p = S.period) {
  if (p.mode === 'month') {
    const [start, end] = C.monthRange(p.ym);
    const prevYm = C.addMonths(p.ym, -1);
    const [ps, pe] = C.monthRange(prevYm);
    return { start, end, ps, pe, label: C.monthLabel(p.ym), short: C.monthLabel(p.ym, true), prevLabel: C.monthLabel(prevYm), prevShort: C.monthName(Number(prevYm.slice(5)), true), noun: 'month' };
  }
  const [start, end] = C.yearRange(p.y);
  const [ps, pe] = C.yearRange(p.y - 1);
  return { start, end, ps, pe, label: String(p.y), short: String(p.y), prevLabel: String(p.y - 1), prevShort: String(p.y - 1), noun: 'year' };
}

function shiftPeriod(n) {
  if (S.period.mode === 'month') S.period.ym = C.addMonths(S.period.ym, n); else S.period.y += n;
  render();
}

function renderHome() {
  const p = S.period;
  const info = periodInfo();
  const sum = C.summarize(S.txs, info.start, info.end);
  const prev = C.summarize(S.txs, info.ps, info.pe);
  const isCurrent = p.mode === 'month' ? p.ym === C.monthKey(today()) : p.y === Number(today().slice(0, 4));
  const pending = needsAttentionCount();

  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' },
    h('button', { 'aria-pressed': String(p.mode === 'month'), onclick: () => { p.mode = 'month'; if (p.ym.slice(0, 4) !== String(p.y)) p.ym = (String(p.y) === today().slice(0, 4) ? C.monthKey(today()) : `${p.y}-12`); render(); } }, 'Monthly'),
    h('button', { 'aria-pressed': String(p.mode === 'year'), onclick: () => { p.mode = 'year'; p.y = Number(p.ym.slice(0, 4)); render(); } }, 'Yearly'));

  const nav = h('div', { class: 'period' },
    h('button', { class: 'icon-btn', 'aria-label': `Previous ${info.noun}`, onclick: () => shiftPeriod(-1) }, icon('left')),
    h('div', { class: 'label', 'aria-live': 'polite' }, info.label,
      !isCurrent ? h('div', null, h('button', { class: 'link-btn small', style: 'min-height:28px;padding:2px 0;font-size:13px;font-weight:500', onclick: () => { p.ym = C.monthKey(today()); p.y = Number(today().slice(0, 4)); render(); } }, p.mode === 'month' ? 'Back to this month' : 'Back to this year')) : null),
    h('button', { class: 'icon-btn', 'aria-label': `Next ${info.noun}`, onclick: () => shiftPeriod(1) }, icon('right')));

  const parts = [topbar('Overview', settingsBtn()), seg, nav];

  if (pending) parts.push(h('button', { class: 'banner', onclick: () => go('recurring') },
    h('span', { class: 'dotx' }), h('span', { class: 't', text: `${pending} recurring ${pending === 1 ? 'item needs' : 'items need'} your confirmation` }), icon('right')));

  if (shouldShowInstallTip()) parts.push(installTip());

  // Summary card
  parts.push(h('section', { class: 'card', 'aria-label': `Totals for ${info.label}` },
    h('div', { class: 'net-label', text: `Net for ${info.label}` }),
    h('div', { class: 'net-value num', text: C.fmt(sum.net, { sign: 'always' }) }),
    h('div', { class: 'summary' },
      h('div', { class: 'figures' },
        h('div', null,
          h('div', { class: 'fig-row' }, h('span', { class: 'k' }, h('span', { class: 'swatch-in' }), 'Income'), h('span', { class: 'v num', text: C.fmt(sum.income) })),
          h('div', { class: 'fig-row' }, h('span', { class: 'k' }, h('span', { class: 'swatch-out' }), 'Spending'), h('span', { class: 'v num', text: C.fmt(sum.spending) })))),
      h('div', { class: 'bars' }, barsChart(sum.income, sum.spending, info.short))),
    h('p', { class: 'hint', style: 'margin-top:10px', text: 'Net = income − spending for this period. It isn’t a balance.' })));

  if (!S.txs.length) {
    parts.push(h('section', { class: 'card empty' },
      h('h3', { text: 'Add your first transaction' }),
      h('p', { text: 'Log what comes in and what goes out. Your overview fills in as you go.' }),
      h('div', { style: 'display:flex;gap:10px;justify-content:center' },
        h('button', { class: 'btn primary', onclick: () => openTxForm(null, { type: 'expense' }) }, 'Add expense'),
        h('button', { class: 'btn', onclick: () => openTxForm(null, { type: 'income' }) }, 'Add income'))));
    return h('main', { class: 'screen' }, parts);
  }

  parts.push(ringsCard(sum, info));
  parts.push(compareCard(sum, prev, info));
  parts.push(trendCard());
  parts.push(recentCard(info));
  return h('main', { class: 'screen' }, parts);
}

function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
function shouldShowInstallTip() { return isIOS() && !isStandalone() && !S.meta.installTipDismissed; }
function installTip() {
  return h('div', { class: 'card small', style: 'padding:14px 16px' },
    h('div', { class: 'row-between' }, h('strong', { text: 'Use Tally like an app' }),
      h('button', { class: 'icon-btn', style: 'width:36px;height:36px', 'aria-label': 'Dismiss tip', onclick: () => { setMeta('installTipDismissed', true); render(); } }, icon('close'))),
    h('p', { class: 'muted', style: 'margin:4px 0 0', text: 'In Safari, tap Share, then “Add to Home Screen.” Note: data entered here in Safari is kept separately from the Home Screen app, so pick one place to use it.' }));
}

function barsChart(income, spending, label) {
  const W = 128, H = 156, base = 122, maxH = 88, bw = 40, x1 = 14, x2 = 74;
  const max = Math.max(income, spending);
  const hgt = (v) => (max === 0 || v === 0 ? 0 : Math.max(2, (v / max) * maxH));
  const hi = hgt(income), hs = hgt(spending);
  return sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Income ${C.fmt(income)} and spending ${C.fmt(spending)} in ${label}` },
    sv('line', { x1: 6, x2: W - 6, y1: base + 0.5, y2: base + 0.5, stroke: '#3a3a40', 'stroke-width': 1 }),
    hi ? sv('rect', { x: x1, y: base - hi, width: bw, height: hi, rx: 5, fill: 'var(--income)' }) : null,
    hs ? sv('rect', { x: x2 + 0.75, y: base - hs + 0.75, width: bw - 1.5, height: Math.max(hs - 0.75, 1), rx: 5, fill: 'var(--spend-fill)', stroke: 'var(--spend-line)', 'stroke-width': 1.5 }) : null,
    sv('text', { x: x1 + bw / 2, y: base - hi - 7, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 600, fill: 'var(--text)', text: C.fmtCompact(income) }),
    sv('text', { x: x2 + bw / 2, y: base - hs - 7, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 600, fill: 'var(--text)', text: C.fmtCompact(spending) }),
    sv('text', { x: x1 + bw / 2, y: base + 17, 'text-anchor': 'middle', 'font-size': 12, fill: 'var(--muted)', text: 'In' }),
    sv('text', { x: x2 + bw / 2, y: base + 17, 'text-anchor': 'middle', 'font-size': 12, fill: 'var(--muted)', text: 'Out' }),
    sv('text', { x: W / 2, y: H - 2, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--faint)', text: label }));
}

// --- Category rings ---
function ringItems(sum, info) {
  const items = [];
  const monthly = S.period.mode === 'month';
  const ids = new Set([...sum.spendByCat.keys()]);
  if (monthly) for (const c of S.cats) if (c.kind === 'expense' && C.effectiveBudget(S.budgets, c.id, S.period.ym) !== null) ids.add(c.id);
  for (const id of ids) {
    const spent = sum.spendByCat.get(id) || 0;
    const limit = monthly ? C.effectiveBudget(S.budgets, id, S.period.ym) : null;
    if (spent === 0 && limit === null) continue;
    const mode = limit !== null ? 'budget' : 'share';
    const frac = mode === 'budget' ? (limit > 0 ? spent / limit : spent > 0 ? Infinity : 0) : sum.spending ? spent / sum.spending : 0;
    items.push({ id, name: catName(id), color: catColor(id), spent, limit, mode, frac });
  }
  items.sort((a, b) => b.spent - a.spent || (a.limit === null) - (b.limit === null) || a.name.localeCompare(b.name));
  return items;
}

function ringMeaning(it, totalLabel) {
  if (it.mode === 'budget') {
    if (it.spent > it.limit) return [h('span', { class: 'tag tag-budget', text: 'Budget' }), h('span', { class: 'over', text: `Over by ${C.fmt(it.spent - it.limit)}` }), h('span', { text: `of ${C.fmt(it.limit)} limit` })];
    return [h('span', { class: 'tag tag-budget', text: 'Budget' }), h('span', { text: `${C.pctLabel(it.frac * 100)} of ${C.fmt(it.limit)} · ${C.fmt(it.limit - it.spent)} left` })];
  }
  return [h('span', { class: 'tag', text: 'Share' }), h('span', { text: `${C.pctLabel(it.frac * 100)} of ${totalLabel} spending` })];
}

function ringsSvg(items, total) {
  const size = 220, cx = 110, w = 13, step = 18, outer = 103;
  const kids = [];
  items.forEach((it, i) => {
    const r = outer - i * step;
    const circ = 2 * Math.PI * r;
    const f = Math.min(it.frac, 1);
    kids.push(sv('circle', { cx, cy: cx, r, fill: 'none', stroke: it.color, 'stroke-opacity': 0.18, 'stroke-width': w }));
    if (f > 0) {
      kids.push(sv('circle', { cx, cy: cx, r, fill: 'none', stroke: it.color, 'stroke-width': w, 'stroke-linecap': f >= 1 ? 'butt' : 'round',
        'stroke-dasharray': f >= 1 ? 'none' : `${Math.max(f * circ, 0.01)} ${circ}`, transform: `rotate(-90 ${cx} ${cx})` }));
    }
    if (it.mode === 'budget' && it.spent > it.limit) {
      // Over budget: ring stays full (never wraps) and gets a warning outline + marker.
      kids.push(sv('circle', { cx, cy: cx, r: r + w / 2 + 1, fill: 'none', stroke: 'var(--warn)', 'stroke-width': 1.5 }));
      kids.push(sv('circle', { cx, cy: cx, r: r - w / 2 - 1, fill: 'none', stroke: 'var(--warn)', 'stroke-width': 1.5 }));
      kids.push(sv('circle', { cx, cy: cx - r, r: 4.5, fill: 'var(--warn)', stroke: '#0b0b0c', 'stroke-width': 2 }));
    }
  });
  const innerR = outer - (items.length - 1) * step - w / 2;
  const showCenter = innerR > 26;
  return sv('svg', { viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': 'Category rings: ' + items.map((it) => `${it.name} ${C.fmt(it.spent)}`).join(', ') },
    kids,
    showCenter ? sv('text', { x: cx, y: cx + 2, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 700, fill: 'var(--text)', text: C.fmtCompact(total) }) : null,
    showCenter ? sv('text', { x: cx, y: cx + 17, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--muted)', text: 'spent' }) : null);
}

function ringsCard(sum, info) {
  const items = ringItems(sum, info);
  const card = h('section', { class: 'card', 'aria-labelledby': 'rings-h' },
    h('div', { class: 'card-title' }, h('h2', { id: 'rings-h', text: 'Spending by category' }), h('span', { class: 'sub', text: info.label })));
  if (!items.length) {
    card.append(h('div', { class: 'empty', style: 'padding:12px' }, h('p', { text: `No spending in ${info.label}.` }),
      h('button', { class: 'btn sm', onclick: () => openTxForm(null, { type: 'expense' }) }, 'Add an expense')));
    return card;
  }
  const top = items.slice(0, MAX_RINGS);
  const totalLabel = S.period.mode === 'month' ? 'this month’s' : 'this year’s';
  card.append(h('div', { class: 'rings-wrap' }, ringsSvg(top, sum.spending),
    h('ul', { class: 'legend' }, top.map((it, i) => h('li', null,
      h('span', { class: 'dot', style: `background:${it.color}` }),
      h('span', { class: 'name' }, it.name, h('span', { class: 'sr-only', text: `, ring ${i + 1} from outside` })),
      h('span', { class: 'amt num', text: C.fmt(it.spent) }),
      h('span', { class: 'meaning' }, ringMeaning(it, totalLabel)))))));
  const anyBudget = top.some((it) => it.mode === 'budget');
  card.append(h('p', { class: 'ring-key', text: S.period.mode === 'year'
    ? 'Outer ring is the largest category. In yearly view, each ring shows that category’s share of the year’s spending.'
    : anyBudget
      ? 'BUDGET rings fill toward the category’s monthly limit and stop at full when you go over (marked with an outline). SHARE rings show the category’s portion of all spending this month.'
      : 'Each ring shows the category’s share of this month’s spending. Set a budget to make a ring track a monthly limit instead.' }));
  card.append(h('button', { class: 'btn sm block', style: 'margin-top:12px', onclick: () => openBreakdown(sum, info) },
    items.length > MAX_RINGS ? `View all ${items.length} categories` : 'Category breakdown'));
  return card;
}

function openBreakdown(sum, info) {
  const items = ringItems(sum, info);
  const totalLabel = S.period.mode === 'month' ? 'this month’s' : 'this year’s';
  const incomes = [...sum.incomeByCat].sort((a, b) => b[1] - a[1]);
  const body = h('div', null,
    h('div', { class: 'section-label', style: 'margin-top:4px', text: `Spending · ${C.fmt(sum.spending)}` }),
    items.length ? h('ul', { class: 'legend', style: 'margin-top:0' }, items.map((it) => h('li', null,
      h('span', { class: 'dot', style: `background:${it.color}` }), h('span', { class: 'name', text: it.name }),
      h('span', { class: 'amt num', text: C.fmt(it.spent) }),
      h('span', { class: 'meaning' }, ringMeaning(it, totalLabel),
        it.mode === 'budget' && sum.spending ? h('span', { class: 'faint', text: `· ${C.pctLabel((it.spent / sum.spending) * 100)} of spending` }) : null))))
      : h('p', { class: 'muted', text: 'No spending in this period.' }),
    h('div', { class: 'section-label', text: `Income · ${C.fmt(sum.income)}` }),
    incomes.length ? h('ul', { class: 'legend', style: 'margin-top:0' }, incomes.map(([id, amt]) => h('li', null,
      h('span', { class: 'dot', style: `background:${catColor(id)}` }), h('span', { class: 'name', text: catName(id) }),
      h('span', { class: 'amt num', text: C.fmt(amt) }),
      h('span', { class: 'meaning', text: `${C.pctLabel((amt / sum.income) * 100)} of income` }))))
      : h('p', { class: 'muted', text: 'No income in this period.' }));
  openSheet({ title: `Categories · ${info.label}`, body });
}

// --- Comparison ---
function compareCard(sum, prev, info) {
  const row = (label, cur, before, kind) => {
    const d = cur - before;
    let text;
    if (cur === 0 && before === 0) text = `None in either period`;
    else if (d === 0) text = `Same as ${info.prevShort}`;
    else {
      text = `${d > 0 ? 'Up' : 'Down'} ${C.fmt(Math.abs(d))}`;
      const pc = kind === 'net' ? null : C.pctChange(before, cur);
      if (pc !== null) text += ` (${C.pctLabel(Math.abs(pc))})`;
      text += before === 0 && kind !== 'net' ? ` · none in ${info.prevShort}` : ` from ${C.fmt(before, { sign: kind === 'net' ? 'always' : 'auto' })}`;
    }
    return h('div', { class: 'cmp-row' }, h('span', { class: 'k', text: label }),
      h('span', { class: 'v num', text: C.fmt(cur, { sign: kind === 'net' ? 'always' : 'auto' }) }), h('span', { class: 'd', text }));
  };
  return h('section', { class: 'card', 'aria-labelledby': 'cmp-h' },
    h('div', { class: 'card-title' }, h('h2', { id: 'cmp-h', text: `Compared with ${info.prevLabel}` })),
    row('Income', sum.income, prev.income, 'income'),
    row('Spending', sum.spending, prev.spending, 'spending'),
    row('Net', sum.net, prev.net, 'net'));
}

// --- Month-by-month report ---
function trendCard() {
  const p = S.period;
  let months, title;
  if (p.mode === 'month') { months = [...Array(6)].map((_, i) => C.addMonths(p.ym, i - 5)).reverse(); title = 'Last 6 months'; }
  else { months = [...Array(12)].map((_, i) => `${p.y}-${String(i + 1).padStart(2, '0')}`); title = `Months of ${p.y}`; }
  const rows = months.map((ym) => {
    const [s, e] = C.monthRange(ym);
    const m = C.summarize(S.txs, s, e);
    const sel = p.mode === 'month' && ym === p.ym;
    return h('button', { class: 'trend-row num' + (sel ? ' sel' : ''), 'aria-label': `${C.monthLabel(ym)}: income ${C.fmt(m.income)}, spending ${C.fmt(m.spending)}, net ${C.fmt(m.net, { sign: 'always' })}. Open month.`,
      onclick: () => { p.mode = 'month'; p.ym = ym; render(); window.scrollTo(0, 0); } },
      h('span', { class: 'm', text: C.monthName(Number(ym.slice(5)), true) + (p.mode === 'month' && ym.slice(0, 4) !== p.ym.slice(0, 4) ? ' ’' + ym.slice(2, 4) : '') }),
      h('span', { text: C.fmtDollars(m.income) }), h('span', { text: C.fmtDollars(m.spending) }),
      h('span', { style: 'font-weight:600', text: C.fmtDollars(m.net, { sign: 'always' }) }));
  });
  return h('section', { class: 'card', 'aria-labelledby': 'trend-h' },
    h('div', { class: 'card-title' }, h('h2', { id: 'trend-h', text: title }), h('span', { class: 'sub', text: 'rounded to $1' })),
    h('div', { class: 'trend-row head', 'aria-hidden': 'true' }, h('span', { class: 'm', text: '' }), h('span', { text: 'In' }), h('span', { text: 'Out' }), h('span', { text: 'Net' })),
    rows);
}

function recentCard(info) {
  const list = S.txs.filter((t) => t.date >= info.start && t.date <= info.end).sort(byDateDesc);
  const card = h('section', { class: 'card', 'aria-labelledby': 'recent-h' },
    h('div', { class: 'card-title' }, h('h2', { id: 'recent-h', text: 'Recent' }), h('span', { class: 'sub', text: info.label })));
  if (!list.length) {
    card.append(h('p', { class: 'muted', style: 'margin:0', text: `Nothing recorded in ${info.label}.` }));
    return card;
  }
  card.append(h('ul', { class: 'tx-list' }, list.slice(0, 5).map((t) => h('li', null, txRow(t, { showDate: true })))));
  card.append(h('button', { class: 'btn sm block', style: 'margin-top:8px', onclick: () => {
    S.f = { q: '', type: 'all', cat: 'all', range: 'custom', from: info.start, to: info.end }; go('activity');
  } }, `See all ${list.length} in ${info.label}`));
  return card;
}

function txRow(t, { showDate = false, catFilter = null } = {}) {
  const split = t.type === 'expense' && Array.isArray(t.splits) && t.splits.length > 1;
  const cid = split ? null : t.categoryId;
  const color = split ? '#c9c9ce' : catColor(cid);
  const initial = split ? '÷' : (catName(cid)[0] || '?').toUpperCase();
  let meta = split ? `Split · ${t.splits.length} categories` : catName(cid);
  if (split && catFilter && catFilter !== 'all') {
    const part = t.splits.find((s) => s.categoryId === catFilter);
    if (part) meta = `Split · ${C.fmt(part.amount)} in ${catName(catFilter)}`;
  }
  if (showDate) meta = C.shortDate(t.date) + ' · ' + meta;
  if (t.recurringId) meta += ' · Recurring';
  if (t.note) meta += ' · ' + t.note;
  const amt = t.type === 'income' ? C.fmt(t.amount, { sign: 'always' }) : C.fmt(t.amount);
  return h('button', { class: 'tx', onclick: () => openTxForm(t), 'aria-label': `${t.name}, ${t.type === 'income' ? 'income' : 'expense'} ${C.fmt(t.amount)}, ${meta}. Edit.` },
    h('span', { class: 'avatar', style: `background:${color}`, 'aria-hidden': 'true', text: initial }),
    h('span', { class: 'body' }, h('div', { class: 'title', text: t.name }), h('div', { class: 'meta', text: meta })),
    h('span', { class: 'amt num' + (t.type === 'income' ? ' in' : ''), text: amt }));
}

// ---------- Transactions ----------
function rangeBounds(f) {
  const t = today();
  const ym = C.monthKey(t);
  switch (f.range) {
    case 'month': return C.monthRange(ym);
    case 'lastmonth': return C.monthRange(C.addMonths(ym, -1));
    case 'year': return C.yearRange(Number(t.slice(0, 4)));
    case '30': return [C.addDays(t, -29), t];
    case 'custom': return [C.isValidYmd(f.from) ? f.from : '0000-01-01', C.isValidYmd(f.to) ? f.to : '9999-12-31'];
    default: return ['0000-01-01', '9999-12-31'];
  }
}

function filterTxs(f) {
  const [start, end] = rangeBounds(f);
  const q = f.q.trim().toLowerCase();
  return S.txs.filter((t) => {
    if (t.date < start || t.date > end) return false;
    if (f.type !== 'all' && t.type !== f.type) return false;
    if (f.cat !== 'all' && !C.allocations(t).some((a) => a.categoryId === f.cat)) return false;
    if (q) {
      const hay = [t.name, t.note, ...C.allocations(t).map((a) => catName(a.categoryId)), C.fmt(t.amount)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort(byDateDesc);
}

function renderActivity() {
  const f = S.f;
  const results = h('div', { id: 'tx-results' });
  const refresh = () => replace(results, activityResults());

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search name, note or category', value: f.q, 'aria-label': 'Search transactions', enterkeyhint: 'search', autocomplete: 'off',
    oninput: (e) => { f.q = e.target.value; refresh(); } });
  const typeSeg = h('div', { class: 'seg full', role: 'group', 'aria-label': 'Type' },
    [['all', 'All'], ['expense', 'Spending'], ['income', 'Income']].map(([v, l]) =>
      h('button', { 'aria-pressed': String(f.type === v), onclick: () => { f.type = v; if (f.cat !== 'all' && f.type !== 'all' && catById(f.cat)?.kind !== f.type) f.cat = 'all'; render(); } }, l)));
  const catOptions = [h('option', { value: 'all', text: 'All categories' })];
  for (const kind of ['expense', 'income']) {
    if (f.type !== 'all' && f.type !== kind) continue;
    const g = h('optgroup', { label: kind === 'expense' ? 'Spending' : 'Income' });
    for (const c of S.cats.filter((c) => c.kind === kind).sort((a, b) => a.name.localeCompare(b.name))) g.append(h('option', { value: c.id, text: c.name + (c.archived ? ' (archived)' : '') }));
    catOptions.push(g);
  }
  const catSel = h('select', { class: 'input', 'aria-label': 'Category', onchange: (e) => { f.cat = e.target.value; refresh(); } }, catOptions);
  catSel.value = f.cat;
  const rangeSel = h('select', { class: 'input', 'aria-label': 'Date range', onchange: (e) => {
    f.range = e.target.value;
    if (f.range === 'custom' && !f.from) { const [s, en] = C.monthRange(C.monthKey(today())); f.from = s; f.to = en; }
    render();
  } }, [['all', 'All dates'], ['month', 'This month'], ['lastmonth', 'Last month'], ['30', 'Last 30 days'], ['year', 'This year'], ['custom', 'Custom range']].map(([v, l]) => h('option', { value: v, text: l })));
  rangeSel.value = f.range;
  const custom = f.range === 'custom' ? [
    h('div', null, h('label', { class: 'small muted', for: 'f-from', text: 'From' }), h('input', { id: 'f-from', class: 'input', type: 'date', value: f.from, onchange: (e) => { f.from = e.target.value; refresh(); } })),
    h('div', null, h('label', { class: 'small muted', for: 'f-to', text: 'To' }), h('input', { id: 'f-to', class: 'input', type: 'date', value: f.to, onchange: (e) => { f.to = e.target.value; refresh(); } })),
  ] : [];
  const anyFilter = f.q || f.type !== 'all' || f.cat !== 'all' || f.range !== 'all';
  refresh();
  return h('main', { class: 'screen' },
    topbar('Transactions', settingsBtn()),
    h('div', { class: 'search' }, icon('search'), search),
    h('div', { class: 'filters' }, typeSeg, catSel, rangeSel, custom,
      anyFilter ? h('button', { class: 'btn sm ghost full', onclick: () => { S.f = { q: '', type: 'all', cat: 'all', range: 'all', from: '', to: '' }; render(); } }, 'Clear filters') : null),
    results);
}

function activityResults() {
  const f = S.f;
  const list = filterTxs(f);
  if (!S.txs.length) return h('div', { class: 'card empty' }, h('h3', { text: 'No transactions yet' }),
    h('p', { text: 'Everything you add shows up here, grouped by date.' }),
    h('button', { class: 'btn primary', onclick: () => openTxForm() }, 'New transaction'));
  if (!list.length) return h('div', { class: 'card empty' }, h('p', { text: 'No transactions match these filters.' }));
  let inc = 0, out = 0;
  for (const t of list) {
    const amt = f.cat === 'all' ? t.amount : C.allocations(t).filter((a) => a.categoryId === f.cat).reduce((s, a) => s + a.amount, 0);
    if (t.type === 'income') inc += amt; else out += amt;
  }
  const groups = [];
  let cur = null;
  for (const t of list) {
    if (!cur || cur.date !== t.date) { cur = { date: t.date, items: [] }; groups.push(cur); }
    cur.items.push(t);
  }
  return h('div', null,
    h('div', { class: 'result-sum num' }, h('span', { text: `${list.length} transaction${list.length === 1 ? '' : 's'}` }),
      h('span', { text: `In ${C.fmt(inc)} · Out ${C.fmt(out)}${f.cat !== 'all' ? ' (this category)' : ''}` })),
    groups.map((g) => h('section', null,
      h('h3', { class: 'day-head' }, h('span', { text: C.dayLabel(g.date) }), h('span', { class: 'num', text: /^(Today|Yesterday|Tomorrow)$/.test(C.dayLabel(g.date)) ? C.shortDate(g.date) : '' })),
      h('ul', { class: 'tx-list group' }, g.items.map((t) => h('li', null, txRow(t, { catFilter: f.cat })))))));
}

// ---------- Recurring ----------
function recurringBuckets() {
  const t = today();
  const horizon = C.addDays(t, 30);
  const due = [], upcoming = [];
  for (const r of S.recs) {
    for (const o of C.pendingOccurrences(r, horizon)) {
      const item = { rec: r, date: o };
      if (o <= t) due.push(item); else upcoming.push(item);
    }
  }
  const sort = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.rec.name.localeCompare(b.rec.name));
  return { due: due.sort(sort), upcoming: upcoming.sort(sort) };
}

function occRow({ rec, date }) {
  const t = today();
  const overdue = date < t;
  const status = overdue ? `Overdue · was due ${C.shortDate(date)}` : date === t ? 'Due today' : C.dayLabel(date);
  return h('button', { class: 'tx', onclick: () => openConfirmOcc(rec, date), 'aria-label': `${rec.name}, ${C.fmt(rec.amount)}, ${status}. Review and confirm.` },
    h('span', { class: 'avatar', style: `background:${catColor(rec.categoryId)}`, 'aria-hidden': 'true', text: (catName(rec.categoryId)[0] || '?').toUpperCase() }),
    h('span', { class: 'body' }, h('div', { class: 'title', text: rec.name }),
      h('div', { class: 'meta', style: overdue ? 'color:var(--overdue)' : date === t ? 'color:var(--due)' : '', text: status + ' · ' + catName(rec.categoryId) })),
    h('span', { class: 'amt num' + (rec.type === 'income' ? ' in' : ''), text: rec.type === 'income' ? C.fmt(rec.amount, { sign: 'always' }) : C.fmt(rec.amount) }));
}

function renderRecurring() {
  const { due, upcoming } = recurringBuckets();
  const parts = [topbar('Recurring', h('button', { class: 'icon-btn', 'aria-label': 'New schedule', onclick: () => openRecForm() }, icon('plus')), settingsBtn())];
  if (!S.recs.length) {
    parts.push(h('div', { class: 'card empty' }, h('h3', { text: 'No recurring items' }),
      h('p', { text: 'For bills or paychecks that repeat, choose “Repeat” when adding a transaction, or create a schedule here. Each occurrence waits for you to confirm it before it counts in your totals.' }),
      h('button', { class: 'btn primary', onclick: () => openRecForm() }, 'New schedule')));
    return h('main', { class: 'screen' }, parts);
  }
  parts.push(h('p', { class: 'hint', style: 'margin:0 4px', text: 'Scheduled items don’t count toward your totals until you confirm them.' }));
  parts.push(h('div', { class: 'section-label', text: 'Needs confirmation' }));
  parts.push(due.length ? h('ul', { class: 'tx-list group' }, due.map((it) => h('li', null, occRow(it))))
    : h('div', { class: 'group muted', style: 'padding:16px', text: 'You’re all caught up.' }));
  parts.push(h('div', { class: 'section-label', text: 'Upcoming · next 30 days' }));
  parts.push(upcoming.length ? h('ul', { class: 'tx-list group' }, upcoming.map((it) => h('li', null, occRow(it))))
    : h('div', { class: 'group muted', style: 'padding:16px', text: 'Nothing scheduled in the next 30 days.' }));
  parts.push(h('div', { class: 'section-label', text: 'Schedules' }));
  const recs = [...S.recs].sort((a, b) => (a.paused - b.paused) || a.name.localeCompare(b.name));
  parts.push(h('ul', { class: 'tx-list group' }, recs.map((r) => {
    const next = r.paused ? null : C.nextPending(r);
    const meta = C.describeCadence(r) + ' · ' + (r.paused ? 'Paused' : next ? `Next ${C.shortDate(next)}` : 'No upcoming');
    return h('li', null, h('button', { class: 'tx', onclick: () => openRecForm(r), 'aria-label': `${r.name}, ${C.fmt(r.amount)}, ${meta}. Edit schedule.` },
      h('span', { class: 'avatar', style: `background:${catColor(r.categoryId)};${r.paused ? 'opacity:.4' : ''}`, 'aria-hidden': 'true', text: (catName(r.categoryId)[0] || '?').toUpperCase() }),
      h('span', { class: 'body' }, h('div', { class: 'title', text: r.name }), h('div', { class: 'meta', text: meta })),
      h('span', { class: 'amt num' + (r.type === 'income' ? ' in' : ''), text: r.type === 'income' ? C.fmt(r.amount, { sign: 'always' }) : C.fmt(r.amount) })));
  })));
  return h('main', { class: 'screen' }, parts);
}

function openConfirmOcc(rec, occDate) {
  const amount = h('input', { class: 'input num', id: 'occ-amt', inputmode: 'decimal', value: C.centsToInput(rec.amount), autocomplete: 'off' });
  const date = h('input', { class: 'input', id: 'occ-date', type: 'date', value: occDate });
  const amtErr = h('div', { class: 'err', role: 'alert' });
  const dateErr = h('div', { class: 'err', role: 'alert' });
  let busy = false;
  const confirmBtn = h('button', { class: 'btn primary', onclick: async () => {
    if (busy) return;
    const a = C.parseAmount(amount.value);
    amtErr.textContent = a.ok ? '' : a.error; amount.classList.toggle('invalid', !a.ok);
    const dOk = C.isValidYmd(date.value);
    dateErr.textContent = dOk ? '' : 'Choose a date'; date.classList.toggle('invalid', !dOk);
    if (!a.ok || !dOk) return;
    busy = true; confirmBtn.disabled = true;
    const now = Date.now();
    const tx = { id: C.uid(), type: rec.type, amount: a.cents, name: rec.name, date: date.value, categoryId: rec.categoryId, splits: null, note: rec.note || '', recurringId: rec.id, occurrenceDate: occDate, createdAt: now, updatedAt: now };
    try {
      const updated = await DB.confirmOccurrence(rec.id, occDate, tx);
      S.txs.push(tx);
      Object.assign(rec, updated);
      requestPersistence();
      s.close(); render();
      toast(`${rec.name} added to ${C.monthLabel(C.monthKey(tx.date))}`);
    } catch (e) {
      if (e instanceof DB.AlreadyHandled) { s.close(); await reloadRecs(); toast('That occurrence was already handled'); return; }
      busy = false; confirmBtn.disabled = false; fail(e);
    }
  } }, 'Confirm');
  const s = openSheet({
    title: `Confirm ${rec.name}`, dismissOnBackdrop: false,
    body: h('div', null,
      h('p', { class: 'muted', style: 'margin:0', text: `Scheduled for ${C.dayLabel(occDate)}${occDate !== today() ? '' : ''} · ${catName(rec.categoryId)} · ${rec.type === 'income' ? 'Income' : 'Expense'}` }),
      h('p', { class: 'hint', text: 'Adjust the amount or date if the real one was different. It will count in your totals once confirmed.' }),
      h('div', { class: 'field' }, h('label', { for: 'occ-amt', text: 'Amount' }), amount, amtErr),
      h('div', { class: 'field' }, h('label', { for: 'occ-date', text: 'Transaction date' }), date, dateErr),
      h('button', { class: 'link-btn', style: 'margin-top:12px', onclick: () => { s.close(); openRecForm(rec); } }, 'Edit schedule')),
    foot: [h('button', { class: 'btn', onclick: async () => {
      if (busy) return; busy = true;
      try {
        const updated = await DB.setOccurrenceState(rec.id, occDate, { s: 'skipped' });
        Object.assign(rec, updated); s.close(); render();
        toast(`Skipped ${C.shortDate(occDate)}`, { actionLabel: 'Undo', onAction: async () => {
          const u = await DB.setOccurrenceState(rec.id, occDate, null); Object.assign(rec, u); render();
        } });
      } catch (e) { busy = false; if (e instanceof DB.AlreadyHandled) { s.close(); await reloadRecs(); } else fail(e); }
    } }, 'Skip'), confirmBtn],
  });
}

async function reloadRecs() { const d = await DB.loadAll(); S.recs = d.recurring; S.txs = d.transactions; render(); }

// ---------- Budgets ----------
function renderBudgets() {
  const ym = S.budgetYm;
  const [start, end] = C.monthRange(ym);
  const sum = C.summarize(S.txs, start, end);
  const cats = S.cats.filter((c) => c.kind === 'expense' && (!c.archived || sum.spendByCat.get(c.id) || C.effectiveBudget(S.budgets, c.id, ym) !== null))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  const withB = [], without = [];
  for (const c of cats) {
    const limit = C.effectiveBudget(S.budgets, c.id, ym);
    const spent = sum.spendByCat.get(c.id) || 0;
    (limit === null ? without : withB).push({ c, limit, spent });
  }
  const isCur = ym === C.monthKey(today());
  const parts = [topbar('Budgets', settingsBtn()),
    h('div', { class: 'period', style: 'margin-top:0' },
      h('button', { class: 'icon-btn', 'aria-label': 'Previous month', onclick: () => { S.budgetYm = C.addMonths(ym, -1); render(); } }, icon('left')),
      h('div', { class: 'label', 'aria-live': 'polite' }, C.monthLabel(ym),
        !isCur ? h('div', null, h('button', { class: 'link-btn', style: 'min-height:28px;padding:2px 0;font-size:13px;font-weight:500', onclick: () => { S.budgetYm = C.monthKey(today()); render(); } }, 'Back to this month')) : null),
      h('button', { class: 'icon-btn', 'aria-label': 'Next month', onclick: () => { S.budgetYm = C.addMonths(ym, 1); render(); } }, icon('right')))];

  if (!withB.length) {
    parts.push(h('div', { class: 'card empty' }, h('h3', { text: 'Budgets are optional' }),
      h('p', { text: 'Set a monthly limit on any spending category to see how much is left. Tally works fine without them.' })));
  } else {
    const tl = withB.reduce((s, b) => s + b.limit, 0), ts = withB.reduce((s, b) => s + b.spent, 0);
    parts.push(h('section', { class: 'card' },
      h('div', { class: 'row-between' }, h('span', { class: 'muted', text: 'Budgeted' }), h('strong', { class: 'num', text: C.fmt(tl) })),
      h('div', { class: 'row-between', style: 'margin-top:6px' }, h('span', { class: 'muted', text: 'Spent in these categories' }), h('strong', { class: 'num', text: C.fmt(ts) })),
      h('div', { class: 'row-between', style: 'margin-top:6px' }, h('span', { class: 'muted', text: ts > tl ? 'Over overall' : 'Left overall' }), h('strong', { class: 'num' + (ts > tl ? ' over' : ''), text: C.fmt(Math.abs(tl - ts)) }))));
    parts.push(h('div', { class: 'section-label', text: 'Your budgets' }));
    parts.push(h('div', { class: 'group', style: 'padding:6px 16px' }, withB.map(({ c, limit, spent }) => {
      const st = C.budgetStatus(spent, limit);
      const w = st.over ? 100 : limit > 0 ? (spent / limit) * 100 : 0;
      return h('button', { class: 'budget', onclick: () => openBudgetForm(c, ym), 'aria-label': `${c.name}: spent ${C.fmt(spent)} of ${C.fmt(limit)}. ${st.over ? 'Over by ' + C.fmt(-st.remaining) : C.fmt(st.remaining) + ' left'}. Edit budget.` },
        h('div', { class: 'top' }, h('span', { class: 'nm' }, h('span', { class: 'dot', style: `width:12px;height:12px;border-radius:6px;background:${c.color};flex:0 0 12px` }), h('span', { text: c.name })),
          h('span', { class: 'lim num', text: `${C.fmt(spent)} of ${C.fmt(limit)}` })),
        h('div', { class: 'track' + (st.over ? ' over' : ''), role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(Math.min(w, 100)) },
          h('div', { class: 'fill', style: `width:${Math.min(w, 100)}%;background:${c.color}` })),
        h('div', { class: 'bot num' }, st.over
          ? h('span', { class: 'over', text: `Over by ${C.fmt(-st.remaining)}` })
          : h('span', { text: `${C.fmt(st.remaining)} left` }),
          h('span', { text: limit > 0 ? `${C.pctLabel(st.pct) || '0%'} used` : '$0 limit' })));
    })));
  }
  parts.push(h('div', { class: 'section-label', text: withB.length ? 'No budget' : 'Spending categories' }));
  parts.push(h('div', { class: 'group', style: 'padding:2px 16px' }, without.length ? h('ul', { class: 'settings-list' }, without.map(({ c, spent }) => h('li', null,
    h('button', { onclick: () => openBudgetForm(c, ym), 'aria-label': `${c.name}, ${C.fmt(spent)} spent. Set budget.` },
      h('span', { class: 'dot', style: `background:${c.color}` }), h('span', { class: 'grow', text: c.name }),
      h('span', { class: 'muted num small', text: `${C.fmt(spent)} spent` }), h('span', { class: 'tag', text: 'Set' })))))
    : h('p', { class: 'muted', text: 'Every category has a budget.' })));
  return h('main', { class: 'screen' }, parts);
}

function openBudgetForm(cat, ym) {
  const existing = C.effectiveBudget(S.budgets, cat.id, ym);
  const [s0, e0] = C.monthRange(ym);
  const spent = C.summarize(S.txs, s0, e0).spendByCat.get(cat.id) || 0;
  const input = h('input', { class: 'num', id: 'b-amt', inputmode: 'decimal', placeholder: '0.00', autocomplete: 'off', value: existing !== null ? C.centsToInput(existing) : '', 'aria-label': 'Monthly limit in dollars' });
  const wrap = h('div', { class: 'amount-wrap' }, h('span', { class: 'cur', text: '$' }), input);
  const err = h('div', { class: 'err', role: 'alert' });
  const ml = C.monthLabel(ym);
  async function save(limit) {
    const ops = [{ store: 'budgets', put: { id: `${cat.id}|${ym}`, categoryId: cat.id, month: ym, limit, updatedAt: Date.now() } }];
    // Later months follow this change ("from this month onward"); earlier months keep their own limits.
    for (const b of S.budgets) if (b.categoryId === cat.id && b.month > ym) ops.push({ store: 'budgets', del: b.id });
    try {
      await DB.batch(ops);
      S.budgets = S.budgets.filter((b) => !(b.categoryId === cat.id && b.month >= ym));
      S.budgets.push(ops[0].put);
      sh.close(); render();
      toast(limit === null ? `Budget removed from ${ml} onward` : `Budget set from ${ml} onward`);
    } catch (e) { fail(e); }
  }
  const sh = openSheet({
    title: `${cat.name} budget`, dismissOnBackdrop: false,
    body: h('div', null,
      h('div', { class: 'field', style: 'margin-top:4px' }, h('label', { for: 'b-amt', text: 'Monthly limit' }), wrap, err),
      h('p', { class: 'hint', text: `Applies to ${ml} and later months. Earlier months keep their own limits. Spent so far in ${ml}: ${C.fmt(spent)}.` })),
    foot: [
      existing !== null ? h('button', { class: 'btn danger', onclick: async () => {
        if (await confirmDialog({ title: 'Remove budget?', message: [`${cat.name} will have no limit from ${ml} onward. Earlier months and all transactions stay as they are.`], confirmLabel: 'Remove', danger: true })) save(null);
      } }, 'Remove') : null,
      h('button', { class: 'btn primary', onclick: () => {
        const a = C.parseAmount(input.value, { allowZero: true });
        err.textContent = a.ok ? '' : a.error; wrap.classList.toggle('invalid', !a.ok);
        if (a.ok) save(a.cents);
      } }, 'Save budget')],
  });
  input.focus();
}

// ---------- Category picker (shared by forms) ----------
function categoryPicker({ kind, selected, onSelect, idPrefix }) {
  const box = h('div');
  let adding = false;
  function draw() {
    const list = activeCats(kind(), selected());
    const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Category' },
      list.map((c) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(selected() === c.id), onclick: () => { onSelect(c.id); draw(); } },
        h('span', { class: 'dot', style: `background:${c.color}` }), c.name)),
      h('button', { type: 'button', class: 'chip add', 'aria-expanded': String(adding), onclick: () => { adding = !adding; draw(); if (adding) box.querySelector('input')?.focus(); } }, adding ? 'Cancel' : '+ New category'));
    replace(box, chips, adding ? newCategoryInline() : null);
  }
  function newCategoryInline() {
    let color = PALETTE[activeCats(kind()).length % PALETTE.length];
    const name = h('input', { class: 'input', id: idPrefix + '-newcat', placeholder: 'Category name', maxlength: 32, autocomplete: 'off', 'aria-label': 'New category name' });
    const err = h('div', { class: 'err', role: 'alert' });
    const colors = colorPicker(() => color, (c) => { color = c; });
    const add = async () => {
      const n = name.value.trim();
      if (!n) { err.textContent = 'Enter a name'; name.classList.add('invalid'); return; }
      if (S.cats.some((c) => c.kind === kind() && !c.archived && c.name.toLowerCase() === n.toLowerCase())) { err.textContent = 'That category already exists'; return; }
      const cat = { id: C.uid(), kind: kind(), name: n, color, order: 100 + S.cats.length, archived: false, createdAt: Date.now() };
      try { await DB.put('categories', cat); S.cats.push(cat); adding = false; onSelect(cat.id); draw(); } catch (e) { fail(e); }
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    return h('div', { class: 'inline-box' }, name, err, h('div', { style: 'margin-top:12px' }, colors),
      h('button', { type: 'button', class: 'btn sm primary', style: 'margin-top:12px', onclick: add }, `Add ${kind() === 'income' ? 'income' : 'spending'} category`));
  }
  draw();
  return { el: box, redraw: () => { adding = false; draw(); } };
}

function colorPicker(get, set) {
  const box = h('div', { class: 'colors', role: 'group', 'aria-label': 'Color' });
  const draw = () => replace(box, PALETTE.map((c, i) => h('button', { type: 'button', class: 'color', style: `background:${c}`, 'aria-label': `Color ${i + 1}`, 'aria-pressed': String(get() === c), onclick: () => { set(c); draw(); } })));
  draw();
  return box;
}

// ---------- Transaction form ----------
function openTxForm(existing = null, preset = {}) {
  const editing = !!existing;
  const st = {
    type: existing?.type ?? preset.type ?? 'expense',
    categoryId: existing?.categoryId ?? null,
    splitOn: !!(existing?.splits && existing.splits.length > 1),
    splits: existing?.splits?.map((p) => ({ categoryId: p.categoryId, amountStr: C.centsToInput(p.amount) })) ?? [],
    catTouched: editing,
    repeat: 'none',
  };
  const linked = existing?.recurringId ? S.recs.find((r) => r.id === existing.recurringId) : null;

  const typeSeg = h('div', { class: 'seg lg', role: 'group', 'aria-label': 'Type' });
  const drawType = () => replace(typeSeg,
    h('button', { type: 'button', 'aria-pressed': String(st.type === 'expense'), onclick: () => setType('expense') }, 'Expense'),
    h('button', { type: 'button', 'aria-pressed': String(st.type === 'income'), onclick: () => setType('income') }, 'Income'));

  const amount = h('input', { id: 'tx-amt', inputmode: 'decimal', placeholder: '0.00', autocomplete: 'off', class: 'num', 'aria-label': 'Amount in dollars', value: existing ? C.centsToInput(existing.amount) : '' });
  const amountWrap = h('div', { class: 'amount-wrap' }, h('span', { class: 'cur', 'aria-hidden': 'true', text: '$' }), amount);
  const amtErr = h('div', { class: 'err', role: 'alert' });

  const names = [...new Map(S.txs.slice().sort(byDateDesc).map((t) => [t.name.toLowerCase(), t])).values()].slice(0, 60);
  const dl = h('datalist', { id: 'tx-names' }, names.map((t) => h('option', { value: t.name })));
  const name = h('input', { class: 'input', id: 'tx-name', list: 'tx-names', maxlength: 60, autocomplete: 'off', autocapitalize: 'sentences', placeholder: 'e.g. Phone bill, Paycheck', value: existing?.name ?? '' });
  const nameErr = h('div', { class: 'err', role: 'alert' });
  name.addEventListener('change', () => {
    if (st.catTouched || st.splitOn) return;
    const match = S.txs.slice().sort(byDateDesc).find((t) => t.name.toLowerCase() === name.value.trim().toLowerCase() && t.type === st.type && !t.splits);
    if (match && catById(match.categoryId) && !catById(match.categoryId).archived) { st.categoryId = match.categoryId; picker.redraw(); }
  });

  const date = h('input', { class: 'input', id: 'tx-date', type: 'date', value: existing?.date ?? preset.date ?? today() });
  const dateErr = h('div', { class: 'err', role: 'alert' });
  date.addEventListener('change', drawRepeat);

  const picker = categoryPicker({ kind: () => st.type, selected: () => st.categoryId, onSelect: (id) => { st.categoryId = id; st.catTouched = true; catErr.textContent = ''; }, idPrefix: 'tx' });
  const catErr = h('div', { class: 'err', role: 'alert' });
  const catField = h('div', { class: 'field' }, h('div', { class: 'lbl', text: 'Category' }), picker.el, catErr);

  const splitBox = h('div', { class: 'field' });
  const note = h('input', { class: 'input', id: 'tx-note', maxlength: 140, autocomplete: 'off', placeholder: 'Optional', value: existing?.note ?? '' });

  const repeatBox = h('div', { class: 'field' });

  function setType(t) {
    if (st.type === t) return;
    st.type = t;
    if (st.categoryId && catById(st.categoryId)?.kind !== t) st.categoryId = null;
    st.catTouched = false;
    if (t === 'income') st.splitOn = false;
    drawType(); picker.redraw(); drawSplit(); drawRepeat();
  }

  function drawSplit() {
    catField.hidden = st.splitOn;
    if (st.type !== 'expense') return replace(splitBox);
    if (!st.splitOn) {
      return replace(splitBox, h('button', { type: 'button', class: 'link-btn', onclick: () => {
        st.splitOn = true;
        const a = C.parseAmount(amount.value);
        st.splits = [{ categoryId: st.categoryId || '', amountStr: a.ok ? C.centsToInput(a.cents) : '' }, { categoryId: '', amountStr: '' }];
        drawSplit(); drawRepeat();
      } }, 'Split across categories'));
    }
    const cats = activeCats('expense', null).concat(st.splits.map((p) => catById(p.categoryId)).filter((c) => c && c.archived));
    const status = h('div', { class: 'split-status', 'aria-live': 'polite' });
    const updateStatus = () => {
      const total = C.parseAmount(amount.value);
      const sum = st.splits.reduce((s, p) => { const a = C.parseAmount(p.amountStr); return s + (a.ok ? a.cents : 0); }, 0);
      status.className = 'split-status';
      if (!total.ok) status.textContent = `Parts add up to ${C.fmt(sum)}. Enter the total above.`;
      else if (sum === total.cents) { status.textContent = `✓ Parts match the ${C.fmt(total.cents)} total`; status.classList.add('ok'); }
      else if (sum < total.cents) status.textContent = `${C.fmt(total.cents - sum)} left to assign of ${C.fmt(total.cents)}`;
      else { status.textContent = `Parts are ${C.fmt(sum - total.cents)} over the ${C.fmt(total.cents)} total`; status.classList.add('over'); }
    };
    amount.oninput = updateStatus;
    const rows = st.splits.map((p, i) => {
      const sel = h('select', { class: 'input', 'aria-label': `Part ${i + 1} category`, onchange: (e) => { p.categoryId = e.target.value; } },
        h('option', { value: '', text: 'Category…' }), cats.map((c) => h('option', { value: c.id, text: c.name })));
      sel.value = p.categoryId || '';
      const amt = h('input', { class: 'input num', inputmode: 'decimal', placeholder: '0.00', 'aria-label': `Part ${i + 1} amount`, value: p.amountStr, oninput: (e) => { p.amountStr = e.target.value; updateStatus(); } });
      const rm = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove part ${i + 1}`, disabled: st.splits.length <= 2 ? true : null, onclick: () => { st.splits.splice(i, 1); drawSplit(); } }, icon('close'));
      return h('div', { class: 'split-row' }, sel, amt, rm);
    });
    replace(splitBox,
      h('div', { class: 'row-between' }, h('div', { class: 'lbl', style: 'font-size:13px;color:var(--muted);font-weight:600', text: 'Split across categories' }),
        h('button', { type: 'button', class: 'link-btn', style: 'font-size:14px', onclick: () => {
          st.splitOn = false;
          const first = st.splits.find((p) => p.categoryId);
          if (first && !st.categoryId) st.categoryId = first.categoryId;
          amount.oninput = null; picker.redraw(); drawSplit(); drawRepeat();
        } }, 'Use one category')),
      h('p', { class: 'hint', style: 'margin-top:0', text: 'Counts once in your spending; each part goes to its category.' }),
      rows,
      h('button', { type: 'button', class: 'btn sm', style: 'margin-top:10px', onclick: () => { st.splits.push({ categoryId: '', amountStr: '' }); drawSplit(); } }, '+ Add part'),
      status, splitErr);
    updateStatus();
  }
  const splitErr = h('div', { class: 'err', role: 'alert' });

  function drawRepeat() {
    if (linked) {
      return replace(repeatBox, h('div', { class: 'from-note' }, `Confirmed from the “${linked.name}” schedule${existing.occurrenceDate ? ` (due ${C.shortDate(existing.occurrenceDate)})` : ''}. Editing this transaction won’t change the schedule.`,
        h('div', null, h('button', { type: 'button', class: 'link-btn', onclick: () => { sh.close(); openRecForm(linked); } }, 'Manage schedule'))));
    }
    if (existing?.recurringId) return replace(repeatBox, h('p', { class: 'hint', text: 'Confirmed from a schedule that has since been deleted.' }));
    if (st.splitOn) { st.repeat = 'none'; return replace(repeatBox, h('div', { class: 'lbl', text: 'Repeat' }), h('p', { class: 'hint', style: 'margin-top:0', text: 'Split transactions can’t repeat in this version.' })); }
    const sel = h('select', { class: 'input', id: 'tx-repeat', onchange: (e) => { st.repeat = e.target.value; drawRepeat(); } },
      [['none', 'Doesn’t repeat'], ['monthly', 'Monthly'], ['weekly', 'Weekly'], ['yearly', 'Yearly']].map(([v, l]) => h('option', { value: v, text: l })));
    sel.value = st.repeat;
    let hint = '';
    if (st.repeat !== 'none' && C.isValidYmd(date.value)) {
      const fake = { freq: st.repeat, startDate: date.value, day: C.parseYmd(date.value).d };
      const next = C.occurrenceAt(fake, 1);
      hint = `${C.describeCadence(fake)}. This one is saved now; the next (${C.shortDate(next)}) will wait in Recurring for you to confirm.`;
      if (st.repeat === 'monthly' && fake.day >= 29) hint += ' In shorter months it uses the last day.';
    }
    replace(repeatBox, h('label', { for: 'tx-repeat', text: 'Repeat' }), sel, hint ? h('p', { class: 'hint', text: hint }) : null);
  }

  drawType(); drawSplit(); drawRepeat();

  let busy = false;
  async function save() {
    if (busy) return;
    let ok = true;
    const a = C.parseAmount(amount.value);
    amtErr.textContent = a.ok ? '' : a.error; amountWrap.classList.toggle('invalid', !a.ok); ok = ok && a.ok;
    const n = name.value.trim();
    nameErr.textContent = n ? '' : 'Add a short name, like “Groceries” or “Paycheck”'; name.classList.toggle('invalid', !n); ok = ok && !!n;
    const dOk = C.isValidYmd(date.value);
    dateErr.textContent = dOk ? '' : 'Choose a date'; date.classList.toggle('invalid', !dOk); ok = ok && dOk;
    let splits = null, categoryId = st.categoryId;
    if (st.splitOn && st.type === 'expense') {
      const parsed = st.splits.map((p) => { const x = C.parseAmount(p.amountStr); return { categoryId: p.categoryId, amount: x.ok ? x.cents : NaN }; });
      const msg = a.ok ? C.validateSplits(parsed, a.cents) : 'Enter the total amount first';
      splitErr.textContent = msg || '';
      if (msg) ok = false; else { splits = parsed; categoryId = [...parsed].sort((x, y) => y.amount - x.amount)[0].categoryId; }
    } else {
      catErr.textContent = categoryId && catById(categoryId)?.kind === st.type ? '' : 'Choose a category';
      if (catErr.textContent) ok = false;
    }
    if (!ok) { sh.sheet.querySelector('.err:not(:empty)')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    busy = true;
    const now = Date.now();
    const tx = { ...(existing || {}), id: existing?.id ?? C.uid(), type: st.type, amount: a.cents, name: n, date: date.value, categoryId, splits, note: note.value.trim(), createdAt: existing?.createdAt ?? now, updatedAt: now };
    if (!existing) { tx.recurringId = null; tx.occurrenceDate = null; }
    try {
      let rec = null;
      if (st.repeat !== 'none' && !tx.recurringId) {
        rec = { id: C.uid(), type: tx.type, amount: tx.amount, name: tx.name, categoryId: tx.categoryId, note: tx.note, freq: st.repeat, startDate: tx.date, day: C.parseYmd(tx.date).d, paused: false,
          handled: { [tx.date]: { s: 'confirmed', txId: tx.id } }, createdAt: now };
        tx.recurringId = rec.id; tx.occurrenceDate = tx.date;
        await DB.saveTxWithSchedule(tx, rec);
        S.recs.push(rec);
      } else {
        await DB.put('transactions', tx);
      }
      const i = S.txs.findIndex((t) => t.id === tx.id);
      if (i >= 0) S.txs[i] = tx; else S.txs.push(tx);
      requestPersistence();
      sh.close(); render();
      toast(editing ? 'Changes saved' : rec ? `Added · repeats ${rec.freq}` : `${tx.type === 'income' ? 'Income' : 'Expense'} added`);
    } catch (e) { busy = false; fail(e); }
  }

  async function remove() {
    const copy = { ...existing };
    try {
      await DB.del('transactions', existing.id);
      S.txs = S.txs.filter((t) => t.id !== existing.id);
      sh.close(); render();
      toast(`Deleted “${copy.name}”`, { actionLabel: 'Undo', ms: 7000, onAction: async () => {
        try { await DB.put('transactions', copy); S.txs.push(copy); render(); toast('Restored'); } catch (e) { fail(e); }
      } });
    } catch (e) { fail(e); }
  }

  const body = h('form', { onsubmit: (e) => { e.preventDefault(); save(); }, novalidate: true },
    typeSeg,
    h('div', { class: 'field' }, h('label', { for: 'tx-amt', text: 'Amount' }), amountWrap, amtErr),
    h('div', { class: 'field' }, h('label', { for: 'tx-name', text: 'Name' }), name, dl, nameErr),
    catField,
    splitBox,
    h('div', { class: 'field' }, h('label', { for: 'tx-date', text: 'Date' }), date, dateErr),
    h('div', { class: 'field' }, h('label', { for: 'tx-note', text: 'Note' }), note),
    repeatBox,
    h('button', { type: 'submit', hidden: true, tabindex: -1, 'aria-hidden': 'true' }));

  const sh = openSheet({
    title: editing ? 'Edit transaction' : 'New transaction', dismissOnBackdrop: false, body,
    foot: [editing ? h('button', { class: 'btn danger', onclick: remove, 'aria-label': 'Delete transaction' }, icon('trash'), 'Delete') : null,
      h('button', { class: 'btn primary', onclick: save }, editing ? 'Save changes' : 'Save')],
  });
  if (!editing) amount.focus();
}

// ---------- Schedule form ----------
function openRecForm(existing = null) {
  const editing = !!existing;
  const t = today();
  const defaultNext = editing ? (existing.paused ? C.firstOnOrAfter(existing, t) : C.nextPending(existing)) || t : t;
  const st = { type: existing?.type ?? 'expense', categoryId: existing?.categoryId ?? null, freq: existing?.freq ?? 'monthly', paused: !!existing?.paused };

  const typeSeg = h('div', { class: 'seg lg', role: 'group', 'aria-label': 'Type' });
  const drawType = () => replace(typeSeg, ['expense', 'income'].map((v) => h('button', { type: 'button', 'aria-pressed': String(st.type === v),
    onclick: () => { if (st.type === v) return; st.type = v; if (catById(st.categoryId)?.kind !== v) st.categoryId = null; drawType(); picker.redraw(); } }, v === 'expense' ? 'Expense' : 'Income')));
  const amount = h('input', { id: 'r-amt', inputmode: 'decimal', placeholder: '0.00', class: 'num', autocomplete: 'off', 'aria-label': 'Amount in dollars', value: existing ? C.centsToInput(existing.amount) : '' });
  const amountWrap = h('div', { class: 'amount-wrap' }, h('span', { class: 'cur', 'aria-hidden': 'true', text: '$' }), amount);
  const amtErr = h('div', { class: 'err', role: 'alert' });
  const name = h('input', { class: 'input', id: 'r-name', maxlength: 60, autocomplete: 'off', placeholder: 'e.g. Phone bill', value: existing?.name ?? '' });
  const nameErr = h('div', { class: 'err', role: 'alert' });
  const picker = categoryPicker({ kind: () => st.type, selected: () => st.categoryId, onSelect: (id) => { st.categoryId = id; catErr.textContent = ''; }, idPrefix: 'r' });
  const catErr = h('div', { class: 'err', role: 'alert' });
  const freq = h('select', { class: 'input', id: 'r-freq', onchange: (e) => { st.freq = e.target.value; drawHint(); } },
    [['monthly', 'Monthly'], ['weekly', 'Weekly'], ['yearly', 'Yearly']].map(([v, l]) => h('option', { value: v, text: l })));
  freq.value = st.freq;
  const date = h('input', { class: 'input', id: 'r-date', type: 'date', value: defaultNext, onchange: () => drawHint() });
  const dateErr = h('div', { class: 'err', role: 'alert' });
  const hint = h('p', { class: 'hint' });
  const note = h('input', { class: 'input', id: 'r-note', maxlength: 140, autocomplete: 'off', placeholder: 'Optional', value: existing?.note ?? '' });
  const pause = h('input', { type: 'checkbox', id: 'r-pause', role: 'switch', checked: st.paused, onchange: (e) => { st.paused = e.target.checked; drawHint(); } });

  function previewRec() {
    const keepDay = editing && date.value === defaultNext && st.freq === existing.freq;
    return { freq: st.freq, startDate: date.value, day: keepDay ? existing.day : C.parseYmd(date.value).d };
  }
  function drawHint() {
    if (!C.isValidYmd(date.value)) { hint.textContent = ''; return; }
    const r = previewRec();
    let s = `${C.describeCadence(r)}, starting ${C.shortDate(date.value)}.`;
    if (r.freq === 'monthly' && r.day >= 29) s += ' In shorter months it uses the last day.';
    if (st.paused) s += ' Paused: nothing will come due until you resume.';
    hint.textContent = s;
  }
  drawType(); drawHint();

  let busy = false;
  async function save() {
    if (busy) return;
    const a = C.parseAmount(amount.value);
    amtErr.textContent = a.ok ? '' : a.error; amountWrap.classList.toggle('invalid', !a.ok);
    const n = name.value.trim();
    nameErr.textContent = n ? '' : 'Add a name'; name.classList.toggle('invalid', !n);
    const dOk = C.isValidYmd(date.value);
    dateErr.textContent = dOk ? '' : 'Choose a date'; date.classList.toggle('invalid', !dOk);
    catErr.textContent = st.categoryId && catById(st.categoryId)?.kind === st.type ? '' : 'Choose a category';
    if (!a.ok || !n || !dOk || catErr.textContent) return;
    busy = true;
    const r = previewRec();
    const rec = { ...(existing || { id: C.uid(), handled: {}, createdAt: Date.now() }), type: st.type, amount: a.cents, name: n, categoryId: st.categoryId, note: note.value.trim(), freq: r.freq, paused: st.paused, updatedAt: Date.now() };
    const timingChanged = !editing || date.value !== defaultNext || r.freq !== existing.freq || (existing.paused && !st.paused);
    if (timingChanged) { rec.startDate = r.startDate; rec.day = r.day; }
    try {
      await DB.put('recurring', rec);
      const i = S.recs.findIndex((x) => x.id === rec.id);
      if (i >= 0) S.recs[i] = rec; else S.recs.push(rec);
      sh.close(); render();
      toast(editing ? 'Schedule updated' : 'Schedule created');
    } catch (e) { busy = false; fail(e); }
  }

  const body = h('form', { onsubmit: (e) => { e.preventDefault(); save(); }, novalidate: true },
    typeSeg,
    h('div', { class: 'field' }, h('label', { for: 'r-amt', text: 'Usual amount' }), amountWrap, amtErr),
    h('div', { class: 'field' }, h('label', { for: 'r-name', text: 'Name' }), name, nameErr),
    h('div', { class: 'field' }, h('div', { class: 'lbl', text: 'Category' }), picker.el, catErr),
    h('div', { class: 'field' }, h('label', { for: 'r-freq', text: 'Repeats' }), freq),
    h('div', { class: 'field' }, h('label', { for: 'r-date', text: editing ? 'Next occurrence' : 'First occurrence' }), date, dateErr, hint),
    h('div', { class: 'field' }, h('label', { for: 'r-note', text: 'Note' }), note),
    editing ? h('div', { class: 'field row-between' }, h('label', { for: 'r-pause', style: 'margin:0;font-size:16px;color:var(--text);font-weight:400', text: 'Pause this schedule' }), h('span', { class: 'switch' }, pause, h('span'))) : null,
    h('p', { class: 'from-note', text: editing
      ? 'Changes apply to upcoming occurrences only. Transactions you already confirmed stay as they are.'
      : 'Nothing is added to your totals until you confirm each occurrence in Recurring.' }),
    h('button', { type: 'submit', hidden: true, tabindex: -1, 'aria-hidden': 'true' }));

  const sh = openSheet({
    title: editing ? 'Edit schedule' : 'New schedule', dismissOnBackdrop: false, body,
    foot: [editing ? h('button', { class: 'btn danger', onclick: async () => {
      if (!(await confirmDialog({ title: 'Delete schedule?', message: [`Upcoming “${existing.name}” occurrences will be removed.`, 'Transactions you already confirmed stay in your history.'], confirmLabel: 'Delete schedule', danger: true }))) return;
      try { await DB.del('recurring', existing.id); S.recs = S.recs.filter((x) => x.id !== existing.id); sh.close(); render(); toast('Schedule deleted'); } catch (e) { fail(e); }
    } }, 'Delete') : null,
    h('button', { class: 'btn primary', onclick: save }, editing ? 'Save' : 'Create schedule')],
  });
  if (!editing) amount.focus();
}

// ---------- Account & sync ----------
function syncStatusText(st) {
  switch (st.state) {
    case 'syncing': return 'Syncing…';
    case 'ok': return `Synced ${Date.now() - st.lastSync < 60 * 1000 ? 'just now' : 'at ' + new Date(st.lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    case 'offline': return 'Offline. Changes are saved on this device and will upload when you’re back online.';
    case 'error': return `Couldn’t sync: ${st.error} Tally will keep trying.`;
    default: return 'Waiting to sync…';
  }
}

/** Account card for Settings. onStatus registers a status listener the caller removes on redraw/close. */
function accountSection(redraw, onStatus) {
  const u = Cloud.user();
  if (u) {
    const line = h('p', { class: 'small muted', style: 'margin:4px 0 0', 'aria-live': 'polite' });
    const update = (st) => { if (!Cloud.user()) redraw(); else line.textContent = syncStatusText(st); };
    onStatus(update); update(Cloud.status);
    return h('div', { class: 'card prose', style: 'margin-top:0' },
      h('p', { style: 'margin:0' }, 'Signed in as ', h('strong', { text: u.email })), line,
      h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px' },
        h('button', { class: 'btn sm', onclick: () => Cloud.sync() }, 'Sync now'),
        h('button', { class: 'btn sm', onclick: openPasswordForm }, 'Change password'),
        h('button', { class: 'btn sm danger', onclick: () => signOutFlow(redraw) }, 'Sign out')));
  }
  const expired = Cloud.expiredFor();
  const email = h('input', { class: 'input', id: 'a-email', type: 'email', autocomplete: 'username', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', value: expired?.email ?? '' });
  const pw = h('input', { class: 'input', id: 'a-pw', type: 'password', autocomplete: 'current-password' });
  const err = h('div', { class: 'err', role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'btn primary block', style: 'margin-top:12px' }, 'Sign in');
  const submit = async (e) => {
    e.preventDefault();
    const em = email.value.trim();
    if (!em || !pw.value) { err.textContent = 'Enter your email and password'; return; }
    err.textContent = ''; btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const ok = await Cloud.signIn(em, pw.value, (other) => confirmDialog({
        title: 'Switch accounts?',
        message: [`This device has data from ${other}. Signing in as ${em} removes it from this device. It stays in ${other}’s account.`],
        confirmLabel: 'Switch account', danger: true }));
      if (ok) { await reloadFromDb(); toast('Signed in. Your data is backed up and syncing.'); }
      redraw();
    } catch (ex) {
      err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Sign in';
    }
  };
  return h('form', { class: 'card prose', style: 'margin-top:0', onsubmit: submit, novalidate: true },
    h('p', { style: 'margin:0', text: expired
      ? 'Your sign-in expired. Sign in again to keep syncing. Everything on this device is still here.'
      : 'Sign in to back up your data and use it on more than one device.' }),
    h('div', { class: 'field' }, h('label', { for: 'a-email', text: 'Email' }), email),
    h('div', { class: 'field' }, h('label', { for: 'a-pw', text: 'Password' }), pw, err),
    btn);
}

async function signOutFlow(redraw) {
  await Cloud.sync();
  const n = await DB.pendingCount();
  const message = n
    ? [`${n} change${n === 1 ? ' hasn’t' : 's haven’t'} uploaded yet${Cloud.status.state === 'offline' ? ' because you’re offline' : ''}. Signing out now will lose ${n === 1 ? 'it' : 'them'}.`, 'Everything else is safe in your account.']
    : ['Your data stays in your account. It will be removed from this device until you sign in again.'];
  if (!(await confirmDialog({ title: 'Sign out?', message, confirmLabel: 'Sign out', danger: true }))) return;
  try {
    await Cloud.signOut();
    await reloadFromDb();
    redraw(); toast('Signed out');
  } catch (e) { fail(e); }
}

function openPasswordForm() {
  const pw = h('input', { class: 'input', id: 'p-new', type: 'password', autocomplete: 'new-password' });
  const pw2 = h('input', { class: 'input', id: 'p-new2', type: 'password', autocomplete: 'new-password' });
  const err = h('div', { class: 'err', role: 'alert' });
  let busy = false;
  const save = async () => {
    if (busy) return;
    if (pw.value.length < 8) { err.textContent = 'Use at least 8 characters'; return; }
    if (pw.value !== pw2.value) { err.textContent = 'The passwords don’t match'; return; }
    busy = true; err.textContent = '';
    try { await Cloud.changePassword(pw.value); sh.close(); toast('Password changed'); }
    catch (e) { busy = false; err.textContent = e.message; }
  };
  const sh = openSheet({
    title: 'Change password', dismissOnBackdrop: false,
    body: h('form', { onsubmit: (e) => { e.preventDefault(); save(); }, novalidate: true },
      h('div', { class: 'field', style: 'margin-top:4px' }, h('label', { for: 'p-new', text: 'New password' }), pw),
      h('div', { class: 'field' }, h('label', { for: 'p-new2', text: 'Confirm new password' }), pw2, err),
      h('button', { type: 'submit', hidden: true, tabindex: -1, 'aria-hidden': 'true' })),
    foot: [h('button', { class: 'btn primary', onclick: save }, 'Change password')],
  });
  pw.focus();
}

// ---------- Settings & categories ----------
function openSettings() {
  const body = h('div');
  let unsub = null;
  const onStatus = (fn) => { unsub = Cloud.subscribe(fn); };
  const draw = () => {
    if (unsub) { unsub(); unsub = null; }
    const signedIn = !!Cloud.user();
    const list = (kind) => h('ul', { class: 'settings-list' }, activeCats(kind).filter((c) => !c.archived).map((c) => h('li', null,
      h('button', { onclick: () => openCategoryForm(c, draw) }, h('span', { class: 'dot', style: `background:${c.color}` }), h('span', { class: 'grow', text: c.name }), icon('right')))),
      h('li', null, h('button', { class: 'muted', onclick: () => openCategoryForm(null, draw, kind) }, h('span', { class: 'dot', style: 'background:transparent;box-shadow:inset 0 0 0 1.5px var(--faint)' }), h('span', { class: 'grow', text: `Add ${kind === 'income' ? 'income' : 'spending'} category` }))));
    const archived = S.cats.filter((c) => c.archived);
    const persistLine = h('p', { class: 'small faint', text: '' });
    if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then((p) => { persistLine.textContent = p ? 'This browser has marked Tally’s storage as persistent.' : 'This browser hasn’t marked storage as persistent (normal on iPhone).'; }).catch(() => {});
    replace(body,
      h('div', { class: 'section-label', style: 'margin-top:0', text: 'Account & sync' }), accountSection(draw, onStatus),
      h('div', { class: 'section-label', text: 'Spending categories' }), h('div', { class: 'group' }, list('expense')),
      h('div', { class: 'section-label', text: 'Income categories' }), h('div', { class: 'group' }, list('income')),
      archived.length ? [h('div', { class: 'section-label', text: 'Archived categories' }), h('div', { class: 'group' }, h('ul', { class: 'settings-list' }, archived.map((c) => h('li', null,
        h('button', { onclick: () => openCategoryForm(c, draw) }, h('span', { class: 'dot', style: `background:${c.color};opacity:.5` }), h('span', { class: 'grow', text: c.name }), h('span', { class: 'tag', text: c.kind === 'income' ? 'Income' : 'Spending' }))))))] : null,
      h('div', { class: 'section-label', text: 'Your data' }),
      h('div', { class: 'card prose', style: 'margin-top:0' }, signedIn ? [
        h('p', null, h('strong', { text: 'Saved on this device and in your account. ' }), 'Changes upload automatically when you’re online, and your other signed-in devices pick them up. Only your account can read your data.'),
        h('p', { text: 'Tally keeps working offline; anything you add uploads the next time you’re connected.' }),
      ] : [
        h('p', null, h('strong', { text: 'Stored only on this device. ' }), 'Tally keeps your transactions in this browser’s on-device storage (IndexedDB). Unless you sign in, nothing is sent to any server, and there’s never any analytics.'),
        h('p', null, h('strong', { text: 'This is not a backup. ' }), 'Your data can be lost if you clear Safari website data, remove the Home Screen app, reset or replace your phone, or if iOS clears storage. Sign in above to back it up.'),
        h('p', { text: 'On iPhone, Safari and the Home Screen app keep separate data, so use Tally from one place.' }),
        persistLine]),
      h('div', { class: 'section-label', text: 'About' }),
      h('div', { class: 'card prose', style: 'margin-top:0' }, h('p', { text: 'Tally 1.1 · Works offline after first load. All amounts in US dollars.' })),
      h('button', { class: 'btn danger block', style: 'margin-top:24px', onclick: eraseEverything }, signedIn ? 'Erase all data' : 'Erase all data on this device'));
  };
  draw();
  openSheet({ title: 'Settings', body, onClose: () => { if (unsub) unsub(); } });
}

async function eraseEverything() {
  const u = Cloud.user();
  const ok = await confirmDialog({ title: 'Erase all data?', message: [u
    ? `This permanently deletes every transaction, schedule, budget and category on this device and in your account (${u.email}), including on your other devices. It can’t be undone.`
    : 'This permanently deletes every transaction, schedule, budget and category on this device. It can’t be undone.'], confirmLabel: 'Erase everything', danger: true });
  if (!ok) return;
  try {
    await DB.eraseAll();
    S.txs = []; S.recs = []; S.budgets = []; S.cats = []; S.meta = {};
    await seedCategories();
    closeAllSheets(); go('home'); toast('All data erased');
  } catch (e) { fail(e); }
}

function usageOf(catId) {
  const txs = S.txs.filter((t) => C.allocations(t).some((a) => a.categoryId === catId) || t.categoryId === catId).length;
  const recs = S.recs.filter((r) => r.categoryId === catId).length;
  const budgets = S.budgets.filter((b) => b.categoryId === catId && b.limit !== null).length;
  return { txs, recs, budgets, any: txs + recs + budgets > 0 };
}

function openCategoryForm(cat, onDone, kind = 'expense') {
  const editing = !!cat;
  let color = cat?.color ?? PALETTE[S.cats.filter((c) => c.kind === kind).length % PALETTE.length];
  const k = cat?.kind ?? kind;
  const name = h('input', { class: 'input', id: 'c-name', maxlength: 32, autocomplete: 'off', value: cat?.name ?? '', placeholder: 'Category name' });
  const err = h('div', { class: 'err', role: 'alert' });
  const save = async () => {
    const n = name.value.trim();
    if (!n) { err.textContent = 'Enter a name'; name.classList.add('invalid'); return; }
    if (S.cats.some((c) => c.id !== cat?.id && c.kind === k && !c.archived && c.name.toLowerCase() === n.toLowerCase())) { err.textContent = 'That category already exists'; return; }
    const obj = { ...(cat || { id: C.uid(), kind: k, order: 100 + S.cats.length, archived: false, createdAt: Date.now() }), name: n, color };
    try {
      await DB.put('categories', obj);
      const i = S.cats.findIndex((c) => c.id === obj.id);
      if (i >= 0) S.cats[i] = obj; else S.cats.push(obj);
      sh.close(); onDone && onDone(); render();
    } catch (e) { fail(e); }
  };
  const foot = [h('button', { class: 'btn primary', onclick: save }, 'Save')];
  if (editing && cat.archived) foot.unshift(h('button', { class: 'btn', onclick: async () => {
    try { cat.archived = false; await DB.put('categories', cat); sh.close(); onDone && onDone(); render(); toast('Category restored'); } catch (e) { fail(e); }
  } }, 'Restore'));
  else if (editing) foot.unshift(h('button', { class: 'btn danger', onclick: () => { sh.close(); deleteCategoryFlow(cat, onDone); } }, 'Delete'));
  const sh = openSheet({
    title: editing ? 'Edit category' : `New ${k === 'income' ? 'income' : 'spending'} category`, dismissOnBackdrop: false,
    body: h('div', null,
      h('div', { class: 'field', style: 'margin-top:4px' }, h('label', { for: 'c-name', text: 'Name' }), name, err),
      h('div', { class: 'field' }, h('div', { class: 'lbl', text: 'Color' }), colorPicker(() => color, (c) => { color = c; })),
      editing ? h('p', { class: 'hint', text: 'Renaming or recoloring updates every transaction in this category, past and future.' }) : null),
    foot,
  });
  if (!editing) name.focus();
}

async function deleteCategoryFlow(cat, onDone) {
  const u = usageOf(cat.id);
  if (!u.any) {
    if (!(await confirmDialog({ title: `Delete “${cat.name}”?`, message: ['No transactions use this category.'], confirmLabel: 'Delete', danger: true }))) return;
    try {
      await DB.batch([{ store: 'categories', del: cat.id }, ...S.budgets.filter((b) => b.categoryId === cat.id).map((b) => ({ store: 'budgets', del: b.id }))]);
      S.cats = S.cats.filter((c) => c.id !== cat.id); S.budgets = S.budgets.filter((b) => b.categoryId !== cat.id);
      onDone && onDone(); render(); toast('Category deleted');
    } catch (e) { fail(e); }
    return;
  }
  const others = activeCats(cat.kind).filter((c) => c.id !== cat.id && !c.archived);
  const sel = h('select', { class: 'input', id: 'c-move' }, others.map((c) => h('option', { value: c.id, text: c.name })));
  const parts = [];
  if (u.txs) parts.push(`${u.txs} transaction${u.txs === 1 ? '' : 's'}`);
  if (u.recs) parts.push(`${u.recs} schedule${u.recs === 1 ? '' : 's'}`);
  if (u.budgets) parts.push('a budget');
  const sh = openSheet({
    title: `Delete “${cat.name}”?`, center: true,
    body: h('div', { class: 'prose' },
      h('p', { text: `This category is used by ${parts.join(', ')}. Choose what happens to them.` }),
      h('div', { class: 'section-label', style: 'margin-top:8px', text: 'Option 1 · Archive (keeps history)' }),
      h('p', { text: 'Hides it from new transactions. Past transactions keep this category and still appear in reports.' }),
      h('button', { class: 'btn block', onclick: async () => {
        try { cat.archived = true; await DB.put('categories', cat); sh.close(); onDone && onDone(); render(); toast('Category archived'); } catch (e) { fail(e); }
      } }, 'Archive category'),
      others.length ? [
        h('div', { class: 'section-label', text: 'Option 2 · Move and delete' }),
        h('p', { text: 'Moves its transactions and schedules to another category, then deletes it. Its budget is removed.' }),
        h('label', { for: 'c-move', class: 'small muted', text: 'Move to' }), sel,
        h('button', { class: 'btn danger block', style: 'margin-top:10px', onclick: async () => {
          const to = sel.value;
          try {
            await DB.reassignAndDeleteCategory(cat.id, to);
            const d = await DB.loadAll();
            S.cats = d.categories; S.txs = d.transactions; S.recs = d.recurring; S.budgets = d.budgets;
            sh.close(); onDone && onDone(); render(); toast(`Moved to ${catName(to)} and deleted`);
          } catch (e) { fail(e); }
        } }, 'Move and delete')] : null),
  });
}

init();
