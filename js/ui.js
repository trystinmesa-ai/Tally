// Tiny DOM helpers, icons, bottom sheets, confirm dialogs and toasts.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  setProps(el, props);
  append(el, kids);
  return el;
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function sv(tag, props, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v);
  }
  append(el, kids);
  return el;
}

function setProps(el, props) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function replace(el, ...kids) { clear(el); append(el, kids); return el; }

// Static, trusted icon markup (24×24, stroke-based).
const ICONS = {
  home: '<path d="M3.5 10.5 12 4l8.5 6.5V19a1 1 0 0 1-1 1H15v-5.5H9V20H4.5a1 1 0 0 1-1-1z"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.75" cy="6.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.75" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.75" cy="17.5" r="1.1" fill="currentColor" stroke="none"/>',
  repeat: '<path d="M17 3.5 20.5 7 17 10.5"/><path d="M3.5 12V10a3 3 0 0 1 3-3h14"/><path d="M7 20.5 3.5 17 7 13.5"/><path d="M20.5 12v2a3 3 0 0 1-3 3h-14"/>',
  budget: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5V12l6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  left: '<path d="M14.5 18 8.5 12l6-6"/>',
  right: '<path d="M9.5 18l6-6-6-6"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
};
export function icon(name, label) {
  const el = document.createElementNS(SVGNS, 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', '24');
  el.setAttribute('height', '24');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.8');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  if (label) { el.setAttribute('role', 'img'); el.setAttribute('aria-label', label); }
  else el.setAttribute('aria-hidden', 'true');
  el.innerHTML = ICONS[name] || '';
  return el;
}

// ---------- Sheets ----------
const stack = [];
export function openSheet({ title, body, foot, center = false, dismissOnBackdrop = true, onClose, label }) {
  const root = document.getElementById('sheets');
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close() }, icon('close'));
  const sheet = h('div', { class: 'sheet' + (center ? ' center' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': label || title },
    h('div', { class: 'sheet-head' }, h('h2', { text: title }), closeBtn),
    h('div', { class: 'sheet-body' }, body),
    foot ? h('div', { class: 'sheet-foot' }, foot) : null);
  const overlay = h('div', { class: 'overlay' }, sheet);
  overlay.addEventListener('click', (e) => { if (e.target === overlay && dismissOnBackdrop) close(); });
  root.append(overlay);
  document.body.style.overflow = 'hidden';
  let closed = false;
  const entry = { close, overlay };
  stack.push(entry);
  function close(result) {
    if (closed) return;
    closed = true;
    overlay.remove();
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    if (!stack.length) document.body.style.overflow = '';
    onClose && onClose(result);
  }
  return { close, sheet, overlay };
}
export function closeAllSheets() { while (stack.length) stack[stack.length - 1].close(); }
export const sheetOpen = () => stack.length > 0;

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) stack[stack.length - 1].close();
});

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    let answer = false;
    const s = openSheet({
      title, center: true,
      body: h('div', { class: 'prose' }, [].concat(message).map((m) => h('p', { text: m }))),
      foot: [
        h('button', { class: 'btn', onclick: () => s.close() }, cancelLabel),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { answer = true; s.close(); } }, confirmLabel),
      ],
      onClose: () => resolve(answer),
    });
  });
}

// ---------- Toast ----------
let toastTimer = null;
export function toast(message, { actionLabel, onAction, ms = 5000 } = {}) {
  const root = document.getElementById('toast-root');
  clear(root);
  clearTimeout(toastTimer);
  const el = h('div', { class: 'toast' + (actionLabel ? '' : ' noaction'), role: 'status' }, h('span', { text: message }),
    actionLabel ? h('button', { onclick: () => { clear(root); clearTimeout(toastTimer); onAction(); } }, actionLabel) : null);
  root.append(el);
  toastTimer = setTimeout(() => clear(root), ms);
}
