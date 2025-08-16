// services/session.js
// In-memory session with TTL (default 10 minutes)
const TTL_MS = 10 * 60 * 1000;
const store = new Map(); // key: userId (number/string), value: { data, expireAt }

function setContext(userId, data, ttlMs = TTL_MS) {
    const expireAt = Date.now() + ttlMs;
    store.set(String(userId), { data, expireAt });
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
