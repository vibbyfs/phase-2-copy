// services/session.js (CommonJS)
'use strict';

// Penyimpanan konteks singkat untuk percakapan (judul/waktu sementara) dengan TTL.
const STORE = new Map(); // key: userId, value: { data: object, expiresAt: number }
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 menit

function now() { return Date.now(); }
function valid(entry) { return entry && entry.expiresAt && entry.expiresAt > now(); }

function setContext(userId, patch = {}, ttlMs = DEFAULT_TTL_MS) {
  const key = String(userId);
  const prev = STORE.get(key);
  const base = valid(prev) ? (prev.data || {}) : {};
  const data = { ...base, ...patch };
  STORE.set(key, { data, expiresAt: now() + ttlMs });
}

function getContext(userId) {
  const key = String(userId);
  const entry = STORE.get(key);
  if (!valid(entry)) {
    STORE.delete(key);
    return null;
  }
  return entry.data || null;
}

function clearContext(userId) {
  STORE.delete(String(userId));
}

// pembersihan berkala
setInterval(() => {
  const t = now();
  for (const [k, v] of STORE.entries()) {
    if (!valid(v)) STORE.delete(k);
  }
}, 60 * 1000).unref?.();

module.exports = { setContext, getContext, clearContext };
