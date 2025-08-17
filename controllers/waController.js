// controllers/waController.js (CommonJS)

const { DateTime } = require('luxon');
const { User, Reminder } = require('../models');
const waOutbound = require('../services/waOutbound'); // ekspektasi: sendMessage({ to, text, reminderId? })
const { extract } = require('../services/ai');        // Chat Completions, tanpa max_tokens
const scheduler = require('../services/scheduler');   // ekspektasi: scheduleReminder(reminder), cancelReminder(id)
const { getSession, setSession, clearSession } = require('../services/session');

const WIB_TZ = 'Asia/Jakarta';

// -------------------------- Utils --------------------------

function phoneFromReq(req) {
  // Twilio webhook: From: "whatsapp:+62..."
  const raw = req.body?.From || req.body?.from || req.body?.WaId || '';
  const from = String(raw).toLowerCase().startsWith('whatsapp:')
    ? raw.replace(/^whatsapp:/i, '')
    : raw;
  return from || null;
}

function textFromReq(req) {
  return (req.body?.Body || req.body?.text || '').toString().trim();
}

function toWIB(dt) {
  if (!dt) return null;
  const d = DateTime.fromJSDate(dt, { zone: 'utc' }).setZone(WIB_TZ);
  return d;
}

function formatHumanWIB(iso) {
  if (!iso) return '';
  const now = DateTime.now().setZone(WIB_TZ);
  const t = DateTime.fromISO(iso).setZone(WIB_TZ);
  if (!t.isValid) return '';

  const diffMin = Math.round(t.diff(now, 'minutes').minutes);
  if (diffMin >= 1 && diffMin <= 59) return `${diffMin} menit lagi`;
  if (diffMin < 1 && diffMin > -1) return 'sebentar lagi';

  const isToday = t.hasSame(now, 'day');
  const isTomorrow = t.hasSame(now.plus({ days: 1 }), 'day');
  if (isToday) return `hari ini jam ${t.toFormat('HH.mm')}`;
  if (isTomorrow) return `besok jam ${t.toFormat('HH.mm')}`;

  const hari = t.toFormat('ccc'); // Sen, Sel, Rab...
  return `${hari}, ${t.toFormat('dd/LL HH.mm')}`;
}

function formatListItem(rem, idx) {
  const t = toWIB(rem.dueAt);
  const when = t ? `${t.toFormat('ccc, dd/LL HH:mm')} WIB` : '-';
  return `${idx}. ${rem.title} — ${when}`;
}

function ensureString(val, fallback = '') {
  return (val === null || val === undefined) ? fallback : String(val);
}

async function sendText(to, text, reminderId = null) {
  if (!text) return;
  try {
    await waOutbound.sendMessage({ to, text, reminderId });
  } catch (e) {
    console.error('[WAOutbound] Gagal kirim:', e?.message || e);
  }
}

// -------------------- Fallback Time Parser --------------------

function parseTimeFallback(text, base = DateTime.now().setZone(WIB_TZ)) {
  const t = (text || '').toLowerCase();

  // "X menit lagi"
  let m = t.match(/(\d+)\s*menit\s*(lagi|dari sekarang)?/i);
  if (m) return base.plus({ minutes: parseInt(m[1], 10) });

  // "X jam lagi"
  m = t.match(/(\d+)\s*jam\s*(lagi|dari sekarang)?/i);
  if (m) return base.plus({ hours: parseInt(m[1], 10) });

  // "besok" (opsional jam)
  if (/^besok\b/i.test(t) || /\bbesok\b/i.test(t)) {
    const m2 = t.match(/besok.*?(?:jam|pukul)?\s*(\d{1,2})(?:[:\.](\d{1,2}))?/i);
    let dt = base.plus({ days: 1 });
    if (m2) {
      const hh = Number(m2[1]); const mm = Number(m2[2] || 0);
      dt = dt.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
    } else {
      dt = dt.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    }
    return dt;
  }

  // “jam HH.mm” / “HH:mm” / “pukul HH.mm”
  m = t.match(/\b(?:jam|pukul)?\s*(\d{1,2})(?:[:\.](\d{1,2}))\b/);
  if (m) {
    let dt = base.set({ hour: Number(m[1]), minute: Number(m[2]), second: 0, millisecond: 0 });
    // jika sudah lewat, geser ke besok
    if (dt <= base) dt = dt.plus({ days: 1 });
    return dt;
  }

  return null;
}

// ------------------------- Main Flow -------------------------

async function inbound(req, res) {
  try {
    const from = phoneFromReq(req);
    const text = textFromReq(req);

    if (!from) {
      res.status(200).json({ ok: true }); // noop
      return;
    }

    console.log('[WA] inbound from:', from, 'text:', text);

    // 1) Ambil user
    const user = await User.findOne({ where: { phone: from } });
    if (!user) {
      // (opsional) bisa auto-register. untuk sekarang, balas ramah.
      await sendText(from, 'Halo! Aku bisa bantu bikin pengingat biar nggak lupa. Mau bikin pengingat apa, dan kapan? 😊');
      res.status(200).json({ ok: true });
      return;
    }

    const userName = user.name || user.username || null;
    const tz = user.timezone || WIB_TZ;

    // 2) Muat sesi
    const session = getSession(user.id) || {};

    // 3) Panggil AI (biarkan AI memimpin gaya balasan)
    const ai = await extract(text, {
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

    console.log('[WA] AI parsed:', ai);

    // 4) Gabungkan dengan konteks jika perlu
    let title = ai.title || session.pendingTitle || null;
    let dueAtWIB = ai.dueAtWIB || session.pendingDueAtWIB || null;

    // Fallback parse waktu lokal jika AI belum tetapkan dueAtWIB
    if (!dueAtWIB) {
      const dt = parseTimeFallback(text, DateTime.now().setZone(WIB_TZ));
      if (dt && dt.isValid) {
        dueAtWIB = dt.toISO();
      }
    }

    // Normalisasi intent setelah penggabungan
    let intent = ai.intent || 'unknown';
    if (intent === 'need_time' && title && dueAtWIB) intent = 'create';
    if (intent === 'potential_reminder' && title && !dueAtWIB) intent = 'need_time';
    if (intent === 'need_content' && !title && dueAtWIB) intent = 'need_content';

    // 5) Simpan sesi ter-update (sementara)
    setSession(user.id, {
      lastIntent: intent,
      pendingTitle: title || null,
      pendingDueAtWIB: dueAtWIB || null,
      pendingRepeat: ai.repeat || 'none',
      pendingRepeatDetails: ai.repeatDetails || {},
      lastList: session.lastList || null, // simpan jika sudah ada
    });

    // 6) Routing intent
    // --- List semua reminder aktif
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
          `Berikut daftar reminder aktif kamu:\n` +
          lines.join('\n') +
          `\n\nKetik: stop (nomor) untuk membatalkan.`
        );
        // simpan daftar terakhir (untuk mapping stop (n))
        setSession(user.id, {
          ...getSession(user.id),
          lastList: items.map(r => ({ id: r.id, title: r.title })),
        });
      }
      return res.status(200).json({ ok: true });
    }

    // --- Filter list by keyword: --reminder <keyword>
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
          `Berikut pengingat aktif terkait "${kw}":\n` +
          lines.join('\n') +
          `\n\nKetik: stop (${1}) untuk membatalkan salah satu.`
        );
        setSession(user.id, {
          ...getSession(user.id),
          lastList: filtered.map(r => ({ id: r.id, title: r.title })),
        });
      }
      return res.status(200).json({ ok: true });
    }

    // --- stop (n)
    if (intent === 'stop_number' && ai.stopNumber) {
      const list = (getSession(user.id) || {}).lastList || [];
      const idx = ai.stopNumber - 1;
      if (idx < 0 || idx >= list.length) {
        await sendText(from, 'Nomornya kurang pas nih 😅 Coba cek lagi daftar reminder-nya ya.');
        return res.status(200).json({ ok: true });
      }

      const target = list[idx];
      const rem = await Reminder.findOne({ where: { id: target.id, UserId: user.id } });
      if (!rem || rem.status !== 'scheduled') {
        await sendText(from, 'Reminder tersebut sudah tidak aktif atau tidak ditemukan 😊');
        return res.status(200).json({ ok: true });
      }

      // batalkan
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
      // tetap pertahankan lastList biar bisa stop beberapa
      return res.status(200).json({ ok: true });
    }

    // --- Cancel all (opsional)
    if (intent === 'cancel_all') {
      const items = await Reminder.findAll({
        where: { UserId: user.id, status: 'scheduled' },
      });
      for (const r of items) {
        r.status = 'cancelled';
        await r.save().catch(() => {});
        try {
          if (typeof scheduler.cancelReminder === 'function') {
            await scheduler.cancelReminder(r.id);
          } else if (typeof scheduler.cancelJob === 'function') {
            await scheduler.cancelJob(r.id);
          }
        } catch (e) {}
      }
      await sendText(from, '✅ Semua reminder aktif sudah dibatalkan. Kalau mau bikin baru, tinggal bilang ya 😊');
      clearSession(user.id);
      return res.status(200).json({ ok: true });
    }

    // --- Need content (sudah ada waktu, belum ada judul)
    if (intent === 'need_content') {
      const reply = ai.reply || 'Noted jamnya! Kamu mau diingatkan tentang apa ya? (contoh: “minum obat”)';
      await sendText(from, reply);
      return res.status(200).json({ ok: true });
    }

    // --- Need time (sudah ada judul, belum ada waktu)
    if (intent === 'need_time') {
      const t = ensureString(title, 'itu');
      const reply = ai.reply || `Siap! Untuk “${t}”, kamu mau diingatkan kapan? (contoh: “1 jam lagi”, “besok jam 9”)`;
      await sendText(from, reply);
      return res.status(200).json({ ok: true });
    }

    // --- Create (judul & waktu lengkap)
    if (intent === 'create' && title && dueAtWIB) {
      const due = DateTime.fromISO(dueAtWIB).setZone(WIB_TZ);
      if (!due.isValid) {
        await sendText(from, 'Jamnya belum kebaca dengan jelas nih 😅 Kamu mau diingatkan jam berapa?');
        return res.status(200).json({ ok: true });
      }
      const now = DateTime.now().setZone(WIB_TZ);
      if (due <= now) {
        await sendText(from, 'Waktunya sudah lewat nih 😅 Mau pilih waktu lain?');
        return res.status(200).json({ ok: true });
      }

      // Simpan DB (dueAt harus UTC)
      const dueUTC = due.setZone('utc');
      const reminder = await Reminder.create({
        UserId: user.id,
        RecipientId: user.id, // self reminder
        title: title.trim(),
        dueAt: new Date(dueUTC.toISO()),
        repeat: ai.repeat || 'none',
        status: 'scheduled',
        formattedMessage: null
      });

      // Jadwalkan
      try {
        if (typeof scheduler.scheduleReminder === 'function') {
          await scheduler.scheduleReminder(reminder);
        } else if (typeof scheduler.createJob === 'function') {
          await scheduler.createJob({ id: reminder.id, runAt: dueUTC.toISO() });
        }
      } catch (e) {
        console.error('[SCHED] schedule error', e?.message || e);
      }

      // Kirim konfirmasi — utamakan ai.reply biar natural
      const humanWhen = formatHumanWIB(due.toISO());
      const confirm = ai.reply || `✅ Siap${userName ? `, ${userName}` : ''}! Aku ingatkan “${title}” ${humanWhen}.`;
      await sendText(from, confirm, null);

      // Bersihkan konteks setelah berhasil
      clearSession(user.id);

      return res.status(200).json({ ok: true });
    }

    // --- Potential reminder (kalimat perintah/harapan/reflektif)
    if (intent === 'potential_reminder') {
      const reply = ai.reply || 'Mau aku bantu bikin pengingat untuk itu? 😊 Kalau iya, kamu mau diingatkan jam berapa?';
      await sendText(from, reply);
      return res.status(200).json({ ok: true });
    }

    // --- Unknown → conversational friendly
    {
      const reply = ai.reply || 'Aku di sini buat bantu kamu tetap teratur. Mau bikin pengingat apa, dan kapan? 😊';
      await sendText(from, reply);
      return res.status(200).json({ ok: true });
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
