// services/session.js (CommonJS)
// In-memory lightweight session per phone

const store = new Map();

function get(phone) {
  if (!store.has(phone)) {
    store.set(phone, {
      userName: null,
      pendingTitle: null,
      pendingDueAtWIB: null,
      lastListCache: [], // for stop (n)
      lastKeyword: null,
    });
  }
  return store.get(phone);
}

function set(phone, patch = {}) {
  const s = get(phone);
  Object.assign(s, patch);
  return s;
}

function clearPending(phone) {
  const s = get(phone);
  s.pendingTitle = null;
  s.pendingDueAtWIB = null;
}

function setListCache(phone, list, keyword = null) {
  const s = get(phone);
  s.lastListCache = Array.isArray(list) ? list : [];
  s.lastKeyword = keyword;
}

module.exports = {
  get,
  set,
  clearPending,
  setListCache,
};
