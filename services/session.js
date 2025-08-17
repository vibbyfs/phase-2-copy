// /services/session.js  (ESM)
// Penyimpanan konteks singkat untuk percakapan (judul/waktu sementara) dengan TTL.
const STORE = new Map(); // key: userId, value: { data: object, expiresAt: number }
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 menit

function now() {
  return Date.now();
}

function isValid(entry) {
  return entry && typeof entry === 'object' && entry.expiresAt && entry.expiresAt > now();
}

/**
 * Simpan/merge context user dengan TTL (default 10 menit).
 * @param {number|string} userId
 * @param {object} patch - data yang akan di-merge
 * @param {number} ttlMs - custom TTL (opsional)
 */
export function setContext(userId, patch = {}, ttlMs = DEFAULT_TTL_MS) {
  const key = String(userId);
  const prev = STORE.get(key);
  const base = isValid(prev) ? (prev.data || {}) : {};
  const data = { ...base, ...patch };
  STORE.set(key, { data, expiresAt: now() + ttlMs });
}

/**
 * Ambil context user (hanya jika belum kedaluwarsa).
 * @param {number|string} userId
 * @returns {object|null}
 */
export function getContext(userId) {
  const key = String(userId);
  const entry = STORE.get(key);
  if (!isValid(entry)) {
    STORE.delete(key);
    return null;
  }
  return entry.data || null;
}

/**
 * Hapus context user.
 * @param {number|string} userId
 */
export function clearContext(userId) {
  const key = String(userId);
  STORE.delete(key);
}

// Pembersihan berkala (tiap 60 detik)
setInterval(() => {
  const t = now();
  for (const [key, entry] of STORE.entries()) {
    if (!entry || entry.expiresAt <= t) STORE.delete(key);
  }
}, 60 * 1000).unref?.();

export default { setContext, getContext, clearContext };
