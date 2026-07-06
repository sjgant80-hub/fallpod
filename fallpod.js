// FallPod · sovereign data pod · Solid-style path-based store · FallID-authenticated
// AI-Native Solutions · MIT · 2026
// One unified store (OPFS + IDB) that every estate tool reads from + writes to.

const POD_DB = 'fallpod-v1';
const POD_STORE = 'pod';
const POD_META = 'meta';
const OPFS_ROOT = 'fallpod';

// ─── storage backends ─────────────────────────────────────────────
const openIDB = () => new Promise((res, rej) => {
  const r = indexedDB.open(POD_DB, 1);
  r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains(POD_STORE)) db.createObjectStore(POD_STORE); if (!db.objectStoreNames.contains(POD_META)) db.createObjectStore(POD_META); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const idbReq = (db, store, mode, fn) => new Promise((res, rej) => { const t = fn(db.transaction(store, mode).objectStore(store)); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); });
const idbGet = (db, s, k) => idbReq(db, s, 'readonly', o => o.get(k));
const idbPut = (db, s, k, v) => idbReq(db, s, 'readwrite', o => o.put(v, k));
const idbDel = (db, s, k) => idbReq(db, s, 'readwrite', o => o.delete(k));
const idbKeys = (db, s) => idbReq(db, s, 'readonly', o => o.getAllKeys());

const opfsAvailable = async () => { try { return !!(navigator.storage && navigator.storage.getDirectory); } catch { return false; } };
const opfsRoot = async () => (await (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_ROOT, { create: true }));
async function opfsWalk(path, create) {
  const parts = path.replace(/^\//, '').split('/').filter(Boolean);
  if (!parts.length) throw new Error('bad path');
  let dir = await opfsRoot();
  for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i], { create });
  return { dir, name: parts.at(-1) };
}
async function opfsWrite(path, data) { const { dir, name } = await opfsWalk(path, true); const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(data); await w.close(); }
async function opfsRead(path) { try { const { dir, name } = await opfsWalk(path, false); return await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer(); } catch { return null; } }
async function opfsDelete(path) { try { const { dir, name } = await opfsWalk(path, false); await dir.removeEntry(name); return true; } catch { return false; } }

// ─── path helpers ─────────────────────────────────────────────────
function normalizePath(p) {
  if (!p || typeof p !== 'string') throw new Error('path must be string');
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function matchPattern(path, pattern) {
  // supports * (segment) and ** (any depth)
  const rx = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§§/g, '.*');
  return new RegExp('^' + rx + '$').test(path);
}

// ─── crypto helpers ───────────────────────────────────────────────
async function deriveKey(seed) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(seed), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode('fallpod-v1'), iterations: 100000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function encryptBytes(bytes, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(ct), iv.length);
  return out;
}

async function decryptBytes(bytes, key) {
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}

// ─── FallPod class ────────────────────────────────────────────────
export class FallPod {
  constructor({ ownerDid, encryptionSeed } = {}) {
    this.ownerDid = ownerDid || null;
    this.encryptionSeed = encryptionSeed || ownerDid || 'anon';
    this._db = null;
    this._key = null;
    this._subs = new Map(); // path → [fn]
    this._useOpfs = false;
    this._ready = this._init();
  }

  async _init() {
    this._db = await openIDB();
    this._useOpfs = await opfsAvailable();
    this._key = await deriveKey(this.encryptionSeed);
    // seed meta
    const created = await idbGet(this._db, POD_META, 'created');
    if (!created) {
      await idbPut(this._db, POD_META, 'created', Date.now());
      await idbPut(this._db, POD_META, 'ownerDid', this.ownerDid);
    }
  }

  async ready() { await this._ready; return this; }

  // ─── core CRUD ──────────────────────────────────────────────────
  async put(path, value, opts = {}) {
    await this._ready;
    path = normalizePath(path);
    const encrypt = opts.encrypt !== false; // default on
    const sign = !!opts.sign;
    const isBinary = value instanceof ArrayBuffer || value instanceof Uint8Array;
    const isLarge = isBinary && value.byteLength > 64 * 1024;

    let payload;
    let type;
    if (isBinary) {
      payload = value instanceof Uint8Array ? value : new Uint8Array(value);
      type = 'binary';
    } else if (typeof value === 'string') {
      payload = new TextEncoder().encode(value);
      type = 'text';
    } else {
      payload = new TextEncoder().encode(JSON.stringify(value));
      type = 'json';
    }

    let stored = payload;
    if (encrypt) stored = await encryptBytes(payload, this._key);

    const rec = {
      path,
      type,
      encrypted: encrypt,
      signed: sign,
      size: payload.byteLength,
      created: Date.now(),
      modified: Date.now(),
      backend: isLarge && this._useOpfs ? 'opfs' : 'idb'
    };

    if (sign && this.ownerDid) {
      rec.signature = await this._sign(payload);
    }

    if (rec.backend === 'opfs') {
      await opfsWrite(path, stored);
    } else {
      rec.data = stored;
    }

    const existing = await idbGet(this._db, POD_STORE, path);
    if (existing) rec.created = existing.created;
    await idbPut(this._db, POD_STORE, path, rec);
    this._emit(path, 'put', value);
    return { path, size: rec.size, backend: rec.backend };
  }

  async get(path) {
    await this._ready;
    path = normalizePath(path);
    const rec = await idbGet(this._db, POD_STORE, path);
    if (!rec || rec.tombstone) return null;

    let stored;
    if (rec.backend === 'opfs') {
      const buf = await opfsRead(path);
      if (!buf) return null;
      stored = new Uint8Array(buf);
    } else {
      stored = rec.data instanceof Uint8Array ? rec.data : new Uint8Array(rec.data);
    }

    let payload = stored;
    if (rec.encrypted) {
      try { payload = await decryptBytes(stored, this._key); }
      catch (e) { throw new Error('decrypt failed at ' + path); }
    }

    if (rec.type === 'text') return new TextDecoder().decode(payload);
    if (rec.type === 'json') return JSON.parse(new TextDecoder().decode(payload));
    return payload; // binary
  }

  async exists(path) {
    await this._ready;
    path = normalizePath(path);
    const rec = await idbGet(this._db, POD_STORE, path);
    return !!(rec && !rec.tombstone);
  }

  async delete(path) {
    await this._ready;
    path = normalizePath(path);
    const rec = await idbGet(this._db, POD_STORE, path);
    if (!rec) return false;
    if (rec.backend === 'opfs') await opfsDelete(path);
    // tombstone
    await idbPut(this._db, POD_STORE, path, { path, tombstone: true, modified: Date.now() });
    this._emit(path, 'delete', null);
    return true;
  }

  async list(prefix = '/') {
    await this._ready;
    prefix = normalizePath(prefix);
    const keys = await idbKeys(this._db, POD_STORE);
    return keys.filter(k => {
      if (prefix === '/') return true;
      return k === prefix || k.startsWith(prefix + '/');
    });
  }

  async meta(path) {
    await this._ready;
    path = normalizePath(path);
    const rec = await idbGet(this._db, POD_STORE, path);
    if (!rec) return null;
    const { data, ...m } = rec;
    return m;
  }

  // ─── grants ─────────────────────────────────────────────────────
  async grant(appId, pathPatterns) {
    await this._ready;
    if (!Array.isArray(pathPatterns)) pathPatterns = [pathPatterns];
    const g = {
      appId,
      patterns: pathPatterns,
      granted: Date.now(),
      grantedBy: this.ownerDid
    };
    await this.put('/.grants/' + appId, g, { encrypt: false });
    return g;
  }

  async revoke(appId) {
    await this._ready;
    return this.delete('/.grants/' + appId);
  }

  async grants() {
    await this._ready;
    const keys = await this.list('/.grants/');
    const out = [];
    for (const k of keys) {
      const g = await this.get(k);
      if (g) out.push(g);
    }
    return out;
  }

  async canAccess(appId, path) {
    const g = await this.get('/.grants/' + appId);
    if (!g) return false;
    return g.patterns.some(p => matchPattern(path, p));
  }

  async requestAccess(pathPatterns, purpose, appId) {
    await this._ready;
    // Emits a permission event owner UI can hook into
    const req = { appId, patterns: pathPatterns, purpose, at: Date.now() };
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('fallpod:access-request', { detail: req }));
    }
    return new Promise((res) => {
      const handler = (e) => {
        if (e.detail.appId === appId) {
          window.removeEventListener('fallpod:access-response', handler);
          res(e.detail.granted);
        }
      };
      if (typeof window !== 'undefined') {
        window.addEventListener('fallpod:access-response', handler);
      } else res(false);
    });
  }

  // ─── subscriptions ──────────────────────────────────────────────
  subscribe(path, fn) {
    path = normalizePath(path);
    if (!this._subs.has(path)) this._subs.set(path, []);
    this._subs.get(path).push(fn);
    return () => {
      const arr = this._subs.get(path) || [];
      this._subs.set(path, arr.filter(f => f !== fn));
    };
  }

  _emit(path, op, value) {
    for (const [prefix, fns] of this._subs) {
      if (prefix === '/' || path === prefix || path.startsWith(prefix + '/')) {
        for (const fn of fns) { try { fn({ path, op, value }); } catch {} }
      }
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('fallpod:change', { detail: { path, op } }));
    }
  }

  // ─── signing ────────────────────────────────────────────────────
  async _sign(bytes) {
    // Uses FallID if attached via window.FallID; else HMAC-fallback
    if (typeof window !== 'undefined' && window.FallID?.sign) {
      try { return await window.FallID.sign(bytes); } catch {}
    }
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(this.encryptionSeed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, bytes);
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
  }

  // ─── export / import ────────────────────────────────────────────
  async export() {
    await this._ready;
    const keys = await idbKeys(this._db, POD_STORE);
    const entries = [];
    for (const k of keys) {
      const rec = await idbGet(this._db, POD_STORE, k);
      if (!rec || rec.tombstone) continue;
      let dataB64 = null;
      if (rec.backend === 'opfs') {
        const buf = await opfsRead(k);
        if (buf) dataB64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      } else if (rec.data) {
        dataB64 = btoa(String.fromCharCode(...(rec.data instanceof Uint8Array ? rec.data : new Uint8Array(rec.data))));
      }
      entries.push({ ...rec, data: dataB64 });
    }
    return {
      _fallpod: 'v1',
      ownerDid: this.ownerDid,
      exported: Date.now(),
      count: entries.length,
      entries
    };
  }

  async import(blob, opts = {}) {
    await this._ready;
    if (typeof blob === 'string') blob = JSON.parse(blob);
    if (blob._fallpod !== 'v1') throw new Error('bad pod blob');
    const mode = opts.mode || 'merge';
    if (mode === 'replace') {
      const keys = await idbKeys(this._db, POD_STORE);
      for (const k of keys) await idbDel(this._db, POD_STORE, k);
    }
    let count = 0;
    for (const e of blob.entries) {
      const bytes = e.data ? Uint8Array.from(atob(e.data), c => c.charCodeAt(0)) : null;
      const rec = { ...e };
      delete rec.data;
      if (rec.backend === 'opfs' && bytes) await opfsWrite(rec.path, bytes);
      else if (bytes) rec.data = bytes;
      await idbPut(this._db, POD_STORE, rec.path, rec);
      count++;
    }
    this._emit('/', 'import', { count });
    return { imported: count };
  }

  // ─── stats ──────────────────────────────────────────────────────
  async stats() {
    await this._ready;
    const keys = await idbKeys(this._db, POD_STORE);
    let total = 0, live = 0, tombstones = 0;
    const byTop = {};
    for (const k of keys) {
      const rec = await idbGet(this._db, POD_STORE, k);
      if (!rec) continue;
      if (rec.tombstone) { tombstones++; continue; }
      live++;
      total += rec.size || 0;
      const top = '/' + (k.split('/')[1] || '');
      byTop[top] = (byTop[top] || 0) + (rec.size || 0);
    }
    return { total, live, tombstones, byTop };
  }

  async gc() {
    await this._ready;
    const keys = await idbKeys(this._db, POD_STORE);
    let n = 0;
    for (const k of keys) {
      const rec = await idbGet(this._db, POD_STORE, k);
      if (rec?.tombstone) { await idbDel(this._db, POD_STORE, k); n++; }
    }
    return { collected: n };
  }
}

// Convenience factory
export async function openPod(opts) {
  const p = new FallPod(opts);
  await p.ready();
  return p;
}

export default FallPod;
