// services/session.js
// Penyimpanan sesi in-memory sederhana (TTL default 10 menit) untuk menyambungkan
// step "need_time" → "need_content" agar judul tidak hilang (mis. tidak jadi "lagi").

const TTL_MS = 10 * 60 * 1000; // 10 menit
const store = new Map(); // key: userId (string), value: { data, expireAt }

function setContext(userId, data, ttlMs = TTL_MS) {
  const key = String(userId);
  const prev = store.get(key)?.data || {};
  const merged = { ...prev, ...data };
  const expireAt = Date.now() + ttlMs;
  store.set(key, { data: merged, expireAt });
}

function getContext(userId) {
  const item = store.get(String(userId));
  if (!item) return null;
  if (Date.now() > item.expireAt) {
    store.delete(String(userId));
    return null;
  }
  return item.data;
}

function clearContext(userId) {
  store.delete(String(userId));
}

module.exports = { setContext, getContext, clearContext };
