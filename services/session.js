// In-memory lightweight session per phone (WhatsApp number)

const store = new Map();

// Normalisasi key agar konsisten
function keyOf(phone) {
  return String(phone || '').trim();
}

// Bentuk session standar (kompatibel dgn ai.extract & waController)
function defaultSession() {
  return {
    userName: null,

    // pembuatan reminder bertahap
    pendingTitle: null,
    pendingDueAtWIB: null,
    pendingTimeHint: false,

    // daftar untuk fitur stop (N)
    lastListedIds: [],
    lastListCache: [],
    lastKeyword: null
  };
}

// Ambil atau buat session
function get(phone) {
  const k = keyOf(phone);
  if (!store.has(k)) store.set(k, defaultSession());
  return store.get(k);
}

// Patch/merge session
function set(phone, patch = {}) {
  const s = get(phone);
  Object.assign(s, patch);
  return s;
}

// Hapus konteks pending (dipanggil setelah reminder berhasil dibuat/batal)
function clearPending(phone) {
  const s = get(phone);
  s.pendingTitle = null;
  s.pendingDueAtWIB = null;
  s.pendingTimeHint = false;
  return s;
}

// Simpan cache list bernomor (untuk stop (N))
// - list boleh array id (number/string) atau array objek { id }
function setListCache(phone, list, keyword = null) {
  const s = get(phone);

  const ids = Array.isArray(list)
    ? list.map(item => {
        if (item == null) return null;
        if (typeof item === 'object' && 'id' in item) return item.id;
        return item;
      })
      .filter(v => v !== null && v !== undefined)
    : [];

  // dedupe dan batasi agar ringan
  const cleanIds = Array.from(new Set(ids)).slice(0, 50);

  s.lastListedIds = cleanIds;
  s.lastListCache = list;       // simpan mentah utk kompatibilitas lama
  s.lastKeyword = keyword || null;

  return s;
}

// Alias agar kompatibel dengan pemanggilan di file lain
module.exports = {
  get,
  set,
  clearPending,
  setListCache,
  getContext: get,
  setContext: set,
};
