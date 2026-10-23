// IndexedDB storage. Everything stays on this device; nothing is sent anywhere.
const DB_NAME = 'tally';
const DB_VERSION = 1;
export const STORES = ['categories', 'transactions', 'recurring', 'budgets', 'meta'];

let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('categories')) db.createObjectStore('categories', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('transactions')) {
        const s = db.createObjectStore('transactions', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('recurring')) db.createObjectStore('recurring', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('budgets')) db.createObjectStore('budgets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Storage is busy. Close other Tally tabs and try again.'));
  });
  return dbp;
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** Run fn(stores) in one atomic transaction; resolves after commit. */
async function run(names, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    const stores = Object.fromEntries(names.map((n) => [n, tx.objectStore(n)]));
    let result;
    Promise.resolve()
      .then(() => fn(stores, tx))
      .then((r) => { result = r; })
      .catch((e) => { try { tx.abort(); } catch {} reject(e); });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Aborted'));
  });
}

export async function loadAll() {
  const out = {};
  await run(STORES, 'readonly', async (s) => {
    for (const n of STORES) out[n] = await reqP(s[n].getAll());
  });
  return out;
}

export const put = (store, obj) => run([store], 'readwrite', (s) => reqP(s[store].put(obj)));
export const putMany = (store, list) => run([store], 'readwrite', async (s) => { for (const o of list) await reqP(s[store].put(o)); });
export const del = (store, id) => run([store], 'readwrite', (s) => reqP(s[store].delete(id)));

/** Save a transaction and its new recurring schedule together. */
export const saveTxWithSchedule = (tx, rec) =>
  run(['transactions', 'recurring'], 'readwrite', async (s) => {
    await reqP(s.transactions.put(tx));
    await reqP(s.recurring.put(rec));
  });

export class AlreadyHandled extends Error {}

/**
 * Confirm one recurring occurrence atomically. If it was already confirmed or
 * skipped (e.g. double tap, second tab), nothing is written.
 */
export const confirmOccurrence = (recId, occDate, tx) =>
  run(['transactions', 'recurring'], 'readwrite', async (s) => {
    const rec = await reqP(s.recurring.get(recId));
    if (!rec) throw new Error('This schedule no longer exists');
    rec.handled = rec.handled || {};
    if (rec.handled[occDate]) throw new AlreadyHandled('Already handled');
    rec.handled[occDate] = { s: 'confirmed', txId: tx.id };
    await reqP(s.transactions.put(tx));
    await reqP(s.recurring.put(rec));
    return rec;
  });

export const setOccurrenceState = (recId, occDate, state) =>
  run(['recurring'], 'readwrite', async (s) => {
    const rec = await reqP(s.recurring.get(recId));
    if (!rec) throw new Error('This schedule no longer exists');
    rec.handled = rec.handled || {};
    if (state === null) delete rec.handled[occDate];
    else {
      if (rec.handled[occDate]) throw new AlreadyHandled('Already handled');
      rec.handled[occDate] = state;
    }
    await reqP(s.recurring.put(rec));
    return rec;
  });

/** Move everything from one category to another, then delete it. */
export const reassignAndDeleteCategory = (fromId, toId) =>
  run(['transactions', 'recurring', 'budgets', 'categories'], 'readwrite', async (s) => {
    const txs = await reqP(s.transactions.getAll());
    for (const t of txs) {
      let changed = false;
      if (t.categoryId === fromId) { t.categoryId = toId; changed = true; }
      if (Array.isArray(t.splits) && t.splits.some((p) => p.categoryId === fromId)) {
        // Merge into the target category if it is already one of the parts.
        const merged = new Map();
        for (const p of t.splits) {
          const c = p.categoryId === fromId ? toId : p.categoryId;
          merged.set(c, (merged.get(c) || 0) + p.amount);
        }
        t.splits = [...merged].map(([categoryId, amount]) => ({ categoryId, amount }));
        if (t.splits.length < 2) { t.categoryId = t.splits[0].categoryId; t.splits = null; }
        changed = true;
      }
      if (changed) { t.updatedAt = Date.now(); await reqP(s.transactions.put(t)); }
    }
    for (const r of await reqP(s.recurring.getAll())) {
      if (r.categoryId === fromId) { r.categoryId = toId; await reqP(s.recurring.put(r)); }
    }
    for (const b of await reqP(s.budgets.getAll())) {
      if (b.categoryId === fromId) await reqP(s.budgets.delete(b.id));
    }
    await reqP(s.categories.delete(fromId));
  });

/** Apply several puts/deletes atomically: [{store, put}|{store, del}] */
export const batch = (ops) => {
  const names = [...new Set(ops.map((o) => o.store))];
  return run(names, 'readwrite', async (s) => {
    for (const o of ops) {
      if (o.put) await reqP(s[o.store].put(o.put));
      else await reqP(s[o.store].delete(o.del));
    }
  });
};

export const eraseAll = () =>
  run(STORES, 'readwrite', async (s) => { for (const n of STORES) await reqP(s[n].clear()); });
