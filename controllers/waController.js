// controllers/waController.js (CommonJS, conversational, with shims)

const { DateTime } = require('luxon');
const { User, Reminder } = require('../models');
const waOutbound = require('../services/waOutbound');   // ekspektasi: sendMessage(to, text, reminderId?)
const aiService = require('../services/ai');            // ekspektasi: extract(text, opts) tanpa max_tokens
const scheduler = require('../services/scheduler');     // ekspektasi: scheduleReminder(rem), cancelReminder(id)
const sessionMod = require('../services/session');      // bentuk bisa bervariasi, kita pakai shim di bawah

// -------- Session Shim (atasi "getSession is not a function") ----------
const __memSessions = new Map();
function __memGet(uid) { return __memSessions.get(uid) || {}; }
function __memSet(uid, data) { __memSessions.set(uid, { ...( __memSessions.get(uid) || {} ), ...data }); }
function __memClear(uid) { __memSessions.delete(uid); }

const getSession = (sessionMod && typeof sessionMod.getSession === 'function')
  ? sessionMod.getSession
  : (sessionMod && typeof sessionMod.get === 'function')
    ? sessionMod.get
    : __memGet;

const setSession = (sessionMod && typeof sessionMod.setSession === 'function')
  ? sessionMod.setSession
  : (sessionMod && typeof sessionMod.set === 'function')
    ? sessionMod.set
    : __memSet;

const clearSession = (sessionMod && typeof sessionMod.clearSession === 'function')
  ? sessionMod.clearSession
  : (sessionMod && typeof sessionMod.clear === 'function')
    ? sessionMod.clear
    : __memClear;

// ---------------- Constants & Utils ----------------
const WIB_TZ = 'Asia/Jakarta';

function phoneFromReq(req) {
  const raw = req.body?.From || req.body?.from || req.body?.WaId || '';
  const s = String(raw);
  if (!s) return null;
  return s.toLowerCase().startsWith('whatsapp:') ? s.replace(/^whatsapp:/i, '') : s;
}

function textFromReq(req) {
  return (req.body?.Body || req.body?.text || '').toString().trim();
}

async function sendText(to, text, reminderId = null) {
  if (!to || !text) return;
  try {
    // PENTING: waOutbound.sendMessage butuh argumen string "to", bukan object
    await waOutbound.sendMessage(to, text, reminderId || undefined);
  } catch (e) {
    console.error('[WAOutbound] Gagal kirim:', e?.message || e);
  }
}

function ensureString(v, fb = '') {
  return (v === null || v === undefined) ? fb : String(v);
}

function toWIB(dt) {
  if (!dt) return null;
  return DateTime.fromJSDate(dt, { zone: 'utc' }).setZone(WIB_TZ);
}

function formatHumanWIB(iso) {
  if (!iso) return '';
  const now = DateTime.now().setZone(WIB_TZ);
  const t = DateTime.fromISO(iso).setZone(WIB_TZ);
  if (!t.isValid) return '';
  const diffMin = Math.round(t.diff(now, 'minutes').minutes);

  if (diffMin >= 1 && diffMin <= 59) return `${diffMin} menit lagi`;
  if (diffMin < 1 && diffMin > -1) return 'sebentar lagi';

  if (t.hasSame(now, 'day')) return `hari ini jam ${t.toFormat('HH.mm')}`;
  if (t.hasSame(now.plus({ days: 1 }), 'day')) return `besok jam ${t.toFormat('HH.mm')}`;

  return `${t.toFormat('ccc')}, ${t.toFormat('dd/LL HH.mm')}`;
}

function formatListItem(rem, idx) {
  const t = toWIB(rem.dueAt);
  const when = t ? `${t.toFormat('ccc, dd/LL HH:mm')} WIB` : '-';
  return `${idx}. ${rem.title} — ${when}`;
}

// ---------------- Fallback Time Parser ----------------
function parseTimeFallback(text, base = DateTime.now().setZone(WIB_TZ)) {
  const s = (text || '').toLowerCase();

  // X menit lagi
  let m = s.match(/(\d+)\s*menit\s*(lagi|dari sekarang)?/i);
  if (m) return base.plus({ minutes: parseInt(m[1], 10) });

  // X jam lagi
  m = s.match(/(\d+)\s*jam\s*(lagi|dari sekarang)?/i);
  if (m) return base.plus({ hours: parseInt(m[1], 10) });

  // besok [jam HH[.mm]]
  if (/\bbesok\b/i.test(s)) {
    const m2 = s.match(/besok.*?(?:jam|pukul)?\s*(\d{1,2})(?:[:\.](\d{1,2}))?/i);
    let dt = base.plus({ days: 1 });
    if (m2) {
      const hh = Number(m2[1]); const mm = Number(m2[2] || 0);
      dt = dt.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
    } else {
      dt = dt.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    }
    return dt;
  }

  // jam HH.mm / HH:mm / pukul HH.mm
  m = s.match(/\b(?:jam|pukul)?\s*(\d{1,2})(?:[:\.](\d{1,2}))\b/);
  if (m) {
    let dt = base.set({ hour: Number(m[1]), minute: Number(m[2]), second: 0, millisecond: 0 });
    if (dt <= base) dt = dt.plus({ days: 1 });
    return dt;
  }

  return null;
}

// ---------------- Controller ----------------
async function inbound(req, res) {
  try {
    const from = phoneFromReq(req);
    const text = textFromReq(req);

    if (!from) {
      res.status(200).json({ ok: true });
      return;
    }

    console.log('[WA] inbound from:', from, 'text:', text);

    // user
    const user = await User.findOne({ where: { phone: from } });
    if (!user) {
      await sendText(from, 'Halo! Aku bisa bantu bikin pengingat biar nggak lupa. Mau bikin pengingat apa, dan kapan? 😊');
      res.status(200).json({ ok: true });
      return;
    }

    const userName = user.name || user.username || null;
    const tz = user.timezone || WIB_TZ;

    // session
    const session = getSession(user.id) || {};

    // AI extract (pakai try-catch agar tidak memutus flow)
    let ai;
    try {
      if (typeof aiService.extract !== 'function') {
        throw new Error('AI extract() not available');
      }
      ai = await aiService.extract(text, {
        userName,
        timezone: tz,
        context: {
          lastIntent: session.lastIntent || null,
          pendingTitle: session.pendingTitle || null,
          pendingDueAtWIB: session.pendingDueAtWIB || null,
          pendingRepeat: session.pendingRepeat || 'none',
          pendingRepeatDetails: session.pendingRepeatDetails || {},
        },
      });
    } catch (e) {
      console.error('[AI] Extract error:', e?.message || e);
      ai = {
        intent: 'unknown',
        title: null,
        recipientUsernames: [],
        timeType: 'absolute',
        dueAtWIB: null,
        repeat: 'none',
        repeatDetails: {},
        cancelKeyword: null,
        stopNumber: null,
        reply: userName
          ? `Halo ${userName}! Aku bisa bantu bikin pengingat biar nggak lupa. Mau diingatkan tentang apa, dan kapan? 😊`
          : 'Halo! Aku bisa bantu bikin pengingat biar nggak lupa. Mau diingatkan tentang apa, dan kapan? 😊',
      };
    }

    console.log('[WA] AI parsed:', ai);

    // Gabungkan konteks
    let title = ai.title || session.pendingTitle || null;
    let dueAtWIB = ai.dueAtWIB || session.pendingDueAtWIB || null;

    if (!dueAtWIB) {
      const dt = parseTimeFallback(text, DateTime.now().setZone(WIB_TZ));
      if (dt && dt.isValid) dueAtWIB = dt.toISO();
    }

    // Normalisasi intent
    let intent = ai.intent || 'unknown';
    if (intent === 'need_time' && title && dueAtWIB) intent = 'create';
    if (intent === 'potential_reminder' && title && !dueAtWIB) intent = 'need_time';
    if (intent === 'need_content' && !title && dueAtWIB) intent = 'need_content';

    // simpan sesi sementara
    setSession(user.id, {
      lastIntent: intent,
      pendingTitle: title || null,
      pendingDueAtWIB: dueAtWIB || null,
      pendingRepeat: ai.repeat || 'none',
      pendingRepeatDetails: ai.repeatDetails || {},
      lastList: session.lastList || null,
    });

    // ---------- Intent Routing ----------

    // 1) List semua reminder aktif
    if (intent === 'list') {
      const items = await Reminder.findAll({
        where: { UserId: user.id, status: 'scheduled' },
        order: [['dueAt', 'ASC']],
        limit: 10,
      });
      if (!items?.length) {
        await sendText(from, 'Belum ada reminder aktif. Mau bikin satu sekarang? 😊');
      } else {
        const lines = items.map((r, i) => formatListItem(r, i + 1));
        await sendText(from,
          `Berikut daftar reminder aktif kamu:\n${lines.join('\n')}\n\nKetik: stop (nomor) untuk membatalkan.`
        );
        setSession(user.id, {
          ...getSession(user.id),
          lastList: items.map(r => ({ id: r.id, title: r.title })),
        });
      }
      res.status(200).json({ ok: true }); return;
    }

    // 2) Filter list by keyword: --reminder <keyword>
    if (intent === 'cancel_keyword' && ai.cancelKeyword) {
      const kw = ai.cancelKeyword.toLowerCase();
      const items = await Reminder.findAll({
        where: { UserId: user.id, status: 'scheduled' },
        order: [['dueAt', 'ASC']],
      });
      const filtered = items.filter(r => (r.title || '').toLowerCase().includes(kw)).slice(0, 10);

      if (!filtered.length) {
        await sendText(from, `Nggak ada reminder aktif yang mengandung "${kw}" 😊`);
      } else {
        const lines = filtered.map((r, i) => formatListItem(r, i + 1));
        await sendText(from,
          `Berikut pengingat aktif terkait "${kw}":\n${lines.join('\n')}\n\nKetik: stop (1) untuk membatalkan salah satu.`
        );
        setSession(user.id, {
          ...getSession(user.id),
          lastList: filtered.map(r => ({ id: r.id, title: r.title })),
        });
      }
      res.status(200).json({ ok: true }); return;
    }

    // 3) stop (n)
    if (intent === 'stop_number' && ai.stopNumber) {
      const list = (getSession(user.id) || {}).lastList || [];
      const idx = Number(ai.stopNumber) - 1;
      if (!(idx >= 0 && idx < list.length)) {
        await sendText(from, 'Nomornya kurang pas nih 😅 Coba cek lagi daftar reminder-nya ya.');
        res.status(200).json({ ok: true }); return;
      }
      const target = list[idx];
      const rem = await Reminder.findOne({ where: { id: target.id, UserId: user.id } });
      if (!rem || rem.status !== 'scheduled') {
        await sendText(from, 'Reminder itu sudah tidak aktif atau tidak ditemukan 😊');
        res.status(200).json({ ok: true }); return;
      }

      rem.status = 'cancelled';
      await rem.save().catch(() => {});
      try {
        if (typeof scheduler.cancelReminder === 'function') {
          await scheduler.cancelReminder(rem.id);
        } else if (typeof scheduler.cancelJob === 'function') {
          await scheduler.cancelJob(rem.id);
        }
      } catch (e) {
        console.error('[SCHED] cancel error', e?.message || e);
      }

      await sendText(from, `✅ Reminder "${ensureString(rem.title)}" sudah dibatalkan.`);
      res.status(200).json({ ok: true }); return;
    }

    // 4) Cancel all (opsional)
    if (intent === 'cancel_all') {
      const items = await Reminder.findAll({ where: { UserId: user.id, status: 'scheduled' } });
      for (const r of items) {
        r.status = 'cancelled';
        await r.save().catch(() => {});
        try {
          if (typeof scheduler.cancelReminder === 'function') await scheduler.cancelReminder(r.id);
          else if (typeof scheduler.cancelJob === 'function') await scheduler.cancelJob(r.id);
        } catch (_) {}
      }
      await sendText(from, '✅ Semua reminder aktif sudah dibatalkan. Kalau mau bikin baru, tinggal bilang ya 😊');
      clearSession(user.id);
      res.status(200).json({ ok: true }); return;
    }

    // 5) Need content (punya waktu, belum punya judul)
    if (intent === 'need_content') {
      const reply = ai.reply || 'Noted jamnya! Kamu mau diingatkan tentang apa ya? (contoh: “minum obat”)';
      await sendText(from, reply);
      res.status(200).json({ ok: true }); return;
    }

    // 6) Need time (punya judul, belum punya waktu)
    if (intent === 'need_time') {
      const t = ensureString(title, 'itu');
      const reply = ai.reply || `Siap! Untuk “${t}”, kamu mau diingatkan kapan? (contoh: “1 jam lagi”, “besok jam 9”)`;
      await sendText(from, reply);
      res.status(200).json({ ok: true }); return;
    }

    // 7) Create (judul & waktu lengkap)
    if (intent === 'create' && title && dueAtWIB) {
      const due = DateTime.fromISO(dueAtWIB).setZone(WIB_TZ);
      if (!due.isValid) {
        await sendText(from, 'Jamnya belum kebaca dengan jelas nih 😅 Kamu mau diingatkan jam berapa?');
        res.status(200).json({ ok: true }); return;
      }
      const now = DateTime.now().setZone(WIB_TZ);
      if (due <= now) {
        await sendText(from, 'Waktunya sudah lewat nih 😅 Mau pilih waktu lain?');
        res.status(200).json({ ok: true }); return;
      }

      const dueUTC = due.setZone('utc');
      const reminder = await Reminder.create({
        UserId: user.id,
        RecipientId: user.id,
        title: title.trim(),
        dueAt: new Date(dueUTC.toISO()),
        repeat: ai.repeat || 'none',
        status: 'scheduled',
        formattedMessage: null,
      });

      try {
        if (typeof scheduler.scheduleReminder === 'function') {
          await scheduler.scheduleReminder(reminder);
        } else if (typeof scheduler.createJob === 'function') {
          await scheduler.createJob({ id: reminder.id, runAt: dueUTC.toISO() });
        }
      } catch (e) {
        console.error('[SCHED] schedule error', e?.message || e);
      }

      const humanWhen = formatHumanWIB(due.toISO());
      const confirm = ai.reply || `✅ Siap${userName ? `, ${userName}` : ''}! Aku ingatkan “${title}” ${humanWhen}.`;
      await sendText(from, confirm);

      clearSession(user.id);
      res.status(200).json({ ok: true }); return;
    }

    // 8) Potential reminder → ajak buat reminder
    if (intent === 'potential_reminder') {
      const reply = ai.reply || 'Mau aku bantu bikin pengingat untuk itu? 😊 Kalau iya, kamu mau diingatkan jam berapa?';
      await sendText(from, reply);
      res.status(200).json({ ok: true }); return;
    }

    // 9) Unknown → conversational friendly
    {
      const reply = ai.reply || (userName
        ? `Halo ${userName}! Aku di sini buat bantu kamu tetap teratur. Mau bikin pengingat apa, dan kapan? 😊`
        : 'Aku di sini buat bantu kamu tetap teratur. Mau bikin pengingat apa, dan kapan? 😊');
      await sendText(from, reply);
      res.status(200).json({ ok: true }); return;
    }

  } catch (err) {
    console.error('[WA Controller] Fatal error:', err);
    try {
      const to = phoneFromReq(req);
      if (to) await sendText(to, 'Maaf, lagi ada kendala sebentar. Coba ulangi pesannya ya 🙂');
    } catch (_) {}
    res.status(200).json({ ok: true });
  }
}

module.exports = { inbound };
