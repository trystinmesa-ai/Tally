// IndexedDB storage. This device's copy is always the one the app reads and writes.
// Every change is also noted in the 'outbox' (same transaction), which cloud.js
// uploads when you're signed in. Signed out, nothing leaves the device.
const DB_NAME = 'tally';
const DB_VERSION = 2;
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
      // One entry per changed record ("store|id"), removed once uploaded.
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'k' });
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

const listeners = new Set();
/** Called after any local change commits (not for changes pulled from the cloud). */
export const onChange = (fn) => listeners.add(fn);

let seqN = 0;
const nextSeq = () => Date.now() * 1000 + (seqN++ % 1000);

/** A store whose put/delete also record the change in the outbox. */
function tracked(tx, name) {
  const s = tx.objectStore(name);
  const out = tx.objectStore('outbox');
  const mark = (id) => out.put({ k: `${name}|${id}`, store: name, id, seq: nextSeq() });
  return {
    get: (k) => s.get(k),
    getAll: () => s.getAll(),
    getAllKeys: () => s.getAllKeys(),
    put(obj) { mark(obj[s.keyPath]); return s.put(obj); },
    delete(id) { mark(id); return s.delete(id); },
  };
}

/**
 * Run fn(stores) in one atomic transaction; resolves after commit.
 * Read-write runs record their changes in the outbox unless track is false.
 */
async function run(names, mode, fn, { track = true } = {}) {
  const db = await open();
  const tracking = track && mode === 'readwrite';
  return new Promise((resolve, reject) => {
    const tx = db.transaction(tracking ? [...names, 'outbox'] : names, mode);
    const stores = Object.fromEntries(names.map((n) => [n, tracking ? tracked(tx, n) : tx.objectStore(n)]));
    let result;
    Promise.resolve()
      .then(() => fn(stores, tx))
      .then((r) => { result = r; })
      .catch((e) => { try { tx.abort(); } catch {} reject(e); });
    tx.oncomplete = () => {
      resolve(result);
      if (tracking) for (const l of listeners) l();
    };
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

/** Delete every record. When signed in, the deletes sync to the account too. */
export const eraseAll = () =>
  run(STORES, 'readwrite', async (s) => {
    for (const n of STORES) for (const k of await reqP(s[n].getAllKeys())) await reqP(s[n].delete(k));
  });

// ---------- Sync support (used by cloud.js) ----------

/** Stable JSON (sorted keys): the database stores objects with its own key order. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export const pendingCount = () => run(['outbox'], 'readonly', (s) => reqP(s.outbox.count()));

/** Outbox entries with each record's current value (null when it was deleted). */
export const readPending = () =>
  run([...STORES, 'outbox'], 'readonly', async (s) => {
    const list = await reqP(s.outbox.getAll());
    for (const e of list) e.data = (await reqP(s[e.store].get(e.id))) ?? null;
    return list;
  });

/** Drop uploaded entries, unless the record changed again while uploading. */
export const markPushed = (entries) =>
  run(['outbox'], 'readwrite', async (s) => {
    for (const e of entries) {
      const cur = await reqP(s.outbox.get(e.k));
      if (cur && cur.seq === e.seq) await reqP(s.outbox.delete(e.k));
    }
  }, { track: false });

/** Queue every local record for upload (first sign-in on a device). */
export const enqueueAll = () =>
  run([...STORES, 'outbox'], 'readwrite', async (s) => {
    for (const n of STORES) {
      for (const id of await reqP(s[n].getAllKeys())) await reqP(s.outbox.put({ k: `${n}|${id}`, store: n, id, seq: nextSeq() }));
    }
  }, { track: false });

/**
 * Apply records pulled from the cloud. A record with a local change that hasn't
 * uploaded yet is skipped (the local change wins and uploads next).
 * Resolves to the number of records that actually changed.
 */
export const applyRemote = (rows) =>
  run([...STORES, 'outbox'], 'readwrite', async (s) => {
    let changed = 0;
    for (const r of rows) {
      if (!STORES.includes(r.store)) continue;
      if (await reqP(s.outbox.get(`${r.store}|${r.id}`))) continue;
      const cur = await reqP(s[r.store].get(r.id));
      if (r.deleted) {
        if (cur !== undefined) { await reqP(s[r.store].delete(r.id)); changed++; }
      } else if (cur === undefined || stable(cur) !== stable(r.data)) {
        await reqP(s[r.store].put(r.data)); changed++;
      }
    }
    return changed;
  }, { track: false });

/** Replace everything on this device with the account's records. */
export const replaceLocal = (rows) =>
  run([...STORES, 'outbox'], 'readwrite', async (s) => {
    for (const n of [...STORES, 'outbox']) await reqP(s[n].clear());
    for (const r of rows) if (STORES.includes(r.store) && !r.deleted) await reqP(s[r.store].put(r.data));
  }, { track: false });

/** Remove all data from this device without touching the account (sign-out). */
export const wipeLocal = () =>
  run([...STORES, 'outbox'], 'readwrite', async (s) => {
    for (const n of [...STORES, 'outbox']) await reqP(s[n].clear());
  }, { track: false });
