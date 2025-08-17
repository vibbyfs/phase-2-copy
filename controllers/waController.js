// controllers/waController.js
// CommonJS, full conversational flow, Twilio direct via waOutbound.sendMessage

const { DateTime } = require('luxon');
const { Op } = require('sequelize');
const { User, Reminder } = require('../models');
const { scheduleReminder, cancelReminder, loadAllScheduledReminders } = require('../services/scheduler');
const { extract } = require('../services/ai');
const { sendMessage } = require('../services/waOutbound'); // pastikan fungsi ini ada
const session = require('../services/session'); // pastikan ada penyimpanan sederhana (in-memory) { get, set, clear }

const WIB_TZ = 'Asia/Jakarta';

// Helper: format natural time description
function describeTime(dueDateWIB, nowWIB) {
  const diffMin = Math.round(dueDateWIB.diff(nowWIB, 'minutes').minutes);
  if (diffMin < 0) return 'waktu sudah lewat';
  if (diffMin < 60) return `${diffMin} menit lagi`;
  if (diffMin < 24 * 60) {
    const h = Math.round(diffMin / 60);
    return `${h} jam lagi`;
  }
  const isToday = dueDateWIB.hasSame(nowWIB, 'day');
  const isTomorrow = dueDateWIB.hasSame(nowWIB.plus({ days: 1 }), 'day');
  if (isToday) return `hari ini jam ${dueDateWIB.toFormat('HH.mm')} WIB`;
  if (isTomorrow) return `besok jam ${dueDateWIB.toFormat('HH.mm')} WIB`;
  return dueDateWIB.toFormat('ccc, dd/LL HH.mm') + ' WIB';
}

// Helper: kirim reply (Twilio webhook or JSON)
async function replyOut(res, to, text, isTwilio) {
  if (isTwilio) {
    try {
      await sendMessage(to, text, null);
    } catch (e) {
      console.error('[WAOutbound] gagal kirim balasan:', e);
    }
    // Twilio butuh response kosong
    return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } else {
    return res.json({ action: 'reply', body: text });
  }
}

module.exports = {
  inbound: async (req, res) => {
    // Bungkus semua dengan try-catch dan pastikan braces seimbang
    try {
      // 1) Ambil payload (Twilio / custom)
      let from, text, isTwilio = false;
      if (req.body && req.body.From && req.body.Body) {
        from = String(req.body.From).replace('whatsapp:', '');
        text = req.body.Body || '';
        isTwilio = true;
      } else {
        from = req.body?.from;
        text = req.body?.text || '';
      }

      if (!from || !text) {
        return res.status(400).json({ error: 'Missing from or text' });
      }
      console.log('[WA] inbound from:', from, 'text:', text);

      // 2) Cari user
      const user = await User.findOne({ where: { phone: from } });
      if (!user) {
        const msg = 'Nomormu belum terdaftar. Yuk daftar dulu biar aku bisa bantu bikin pengingat 😊';
        return await replyOut(res, from, msg, isTwilio);
      }

      const nowWIB = DateTime.now().setZone(WIB_TZ);

      // 3) Ambil context sementara di session (judul/tanggal dari step sebelumnya)
      const sess = session.get(from) || {};
      const pendingTitle = sess.pendingTitle || null;
      const pendingDueAtWIB = sess.pendingDueAtWIB || null;
      const lastList = Array.isArray(sess.lastList) ? sess.lastList : [];

      // 4) AI extract (natural + JSON)
      const ai = await extract(text, {
        userName: user.name || user.username || null,
        timezone: WIB_TZ
      });
      console.log('[AI] parsed:', ai);

      // 5) Intent cepat: stop (No)
      if (ai.intent === 'stop_number' && ai.stopNumber != null) {
        const idx = ai.stopNumber - 1;
        const list = lastList.length ? lastList : await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled' },
          order: [['dueAt', 'ASC']],
          limit: 10
        });

        if (!list.length || idx < 0 || idx >= list.length) {
          const msg = 'Nomornya kurang pas nih 😅 Coba cek lagi daftar reminder-nya ya.';
          return await replyOut(res, from, msg, isTwilio);
        }

        const target = list[idx];
        target.status = 'cancelled';
        await target.save();
        cancelReminder(target.id);

        // bersihkan list setelah cancel
        session.set(from, { ...sess, lastList: [] });

        const tWIB = DateTime.fromJSDate(target.dueAt).setZone(WIB_TZ).toFormat('ccc, dd/LL HH.mm');
        const msg = `✅ Reminder nomor ${ai.stopNumber} (${target.title} – ${tWIB} WIB) sudah dibatalkan. Kalau butuh pengingat baru, tinggal bilang ya 😊`;
        return await replyOut(res, from, msg, isTwilio);
      }

      // 6) Intent cepat: --reminder keyword
      if (ai.intent === 'cancel_keyword' && ai.cancelKeyword) {
        const list = await Reminder.findAll({
          where: {
            UserId: user.id,
            status: 'scheduled',
            title: { [Op.iLike]: `%${ai.cancelKeyword}%` }
          },
          order: [['dueAt', 'ASC']],
          limit: 10
        });

        if (!list.length) {
          const msg = `Tidak ada reminder aktif yang mengandung kata "${ai.cancelKeyword}" 😊`;
          return await replyOut(res, from, msg, isTwilio);
        }

        // simpan list bernomor di session
        session.set(from, { ...sess, lastList: list });

        let lines = `Berikut pengingat aktif terkait "${ai.cancelKeyword}":\n`;
        list.forEach((r, i) => {
          const tWIB = DateTime.fromJSDate(r.dueAt).setZone(WIB_TZ).toFormat('ccc, dd/LL HH.mm');
          lines += `${i + 1}. ${r.title} – ${tWIB} WIB\n`;
        });
        lines += `\nKetik: \`stop (${list.length >= 1 ? 1 : 'No'})\` untuk membatalkan salah satu.`;
        return await replyOut(res, from, lines, isTwilio);
      }

      // 7) Intent: list
      if (ai.intent === 'list') {
        const actives = await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled' },
          order: [['dueAt', 'ASC']],
          limit: 10
        });

        if (!actives.length) {
          return await replyOut(res, from, 'Tidak ada reminder aktif saat ini 😊', isTwilio);
        }

        session.set(from, { ...sess, lastList: actives });
        let msg = `📋 Daftar reminder aktif (${actives.length}):\n`;
        actives.forEach((r, i) => {
          const tWIB = DateTime.fromJSDate(r.dueAt).setZone(WIB_TZ).toFormat('ccc, dd/LL HH.mm');
          msg += `${i + 1}. ${r.title} – ${tWIB} WIB\n`;
        });
        msg += `\nTip: ketik \`--reminder <keyword>\` untuk filter atau \`stop (No)\` untuk batal salah satu.`;
        return await replyOut(res, from, msg, isTwilio);
      }

      // 8) Intent: cancel all
      if (ai.intent === 'cancel_all') {
        const list = await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled' },
          order: [['createdAt', 'DESC']]
        });
        if (!list.length) {
          return await replyOut(res, from, 'Tidak ada reminder aktif untuk dibatalkan 😊', isTwilio);
        }
        for (const r of list) {
          r.status = 'cancelled';
          await r.save();
          cancelReminder(r.id);
        }
        session.set(from, { ...sess, lastList: [] });
        return await replyOut(res, from, `✅ Semua ${list.length} reminder berhasil dibatalkan.`, isTwilio);
      }

      // 9) Intent: cancel (hanya recurring)
      if (ai.intent === 'cancel') {
        const list = await Reminder.findAll({
          where: {
            UserId: user.id,
            status: 'scheduled',
            repeat: { [Op.ne]: 'none' }
          }
        });
        if (!list.length) {
          return await replyOut(res, from, 'Tidak ada reminder berulang yang aktif 😊', isTwilio);
        }
        for (const r of list) {
          r.status = 'cancelled';
          await r.save();
          cancelReminder(r.id);
        }
        session.set(from, { ...sess, lastList: [] });
        return await replyOut(res, from, `✅ ${list.length} reminder berulang berhasil dibatalkan.`, isTwilio);
      }

      // 10) Need time (punya isi, belum waktu)
      if (ai.intent === 'need_time' || (!ai.dueAtWIB && (ai.title || pendingTitle))) {
        const title = ai.title || pendingTitle || (text || '').trim();
        // simpan pending title
        session.set(from, { ...sess, pendingTitle: title, pendingDueAtWIB: null });
        const name = user.name || user.username || '';
        const msg = ai.reply || `Siap ${name ? name + ',' : ''} untuk “${title}”. Kamu mau diingatkan kapan? Misal: "jam 20.00", "30 menit lagi", "besok 09.00" 😊`;
        return await replyOut(res, from, msg, isTwilio);
      }

      // 11) Need content (punya waktu, belum isi) – contoh user balas “1 menit lagi”
      if (ai.intent === 'need_content' || (!ai.title && (ai.dueAtWIB || pendingDueAtWIB))) {
        // simpan pending dueAt
        const dueAtWIB = ai.dueAtWIB || pendingDueAtWIB || null;
        session.set(from, { ...sess, pendingTitle: pendingTitle || null, pendingDueAtWIB: dueAtWIB });

        const msg = ai.reply || `Oke, jamnya sudah dapat. Kamu mau diingatkan tentang apa ya? Contoh: "minum obat", "beli kopi nescafe" 😊`;
        return await replyOut(res, from, msg, isTwilio);
      }

      // 12) Create – lengkap
      if (ai.intent === 'create' || (ai.dueAtWIB && (ai.title || pendingTitle))) {
        const title = (ai.title || pendingTitle || '').trim();
        if (!title) {
          // tidak boleh kosong
          session.set(from, { ...sess, pendingTitle: null, pendingDueAtWIB: null });
          return await replyOut(res, from, 'Judul pengingatnya belum kebaca. Tulis pengingatnya ya (mis. "minum obat").', isTwilio);
        }

        // waktu
        let dueWIB = null;
        if (ai.dueAtWIB) {
          dueWIB = DateTime.fromISO(ai.dueAtWIB).setZone(WIB_TZ);
        } else if (pendingDueAtWIB) {
          dueWIB = DateTime.fromISO(pendingDueAtWIB).setZone(WIB_TZ);
        }

        if (!dueWIB || !dueWIB.isValid) {
          // minta jam lagi
          session.set(from, { ...sess, pendingTitle: title, pendingDueAtWIB: null });
          return await replyOut(res, from, `Aku belum nangkep jamnya. Untuk “${title}”, kamu mau diingatkan kapan? 😊`, isTwilio);
        }

        // kalau waktu sudah lewat, minta reschedule
        if (dueWIB <= nowWIB) {
          session.set(from, { ...sess, pendingTitle: title, pendingDueAtWIB: null });
          return await replyOut(res, from, 'Waktunya sudah lewat nih 😅 Mau pilih waktu lain?', isTwilio);
        }

        // Simpan ke UTC
        const dueUTC = dueWIB.toUTC().toJSDate();

        const reminder = await Reminder.create({
          UserId: user.id,
          RecipientId: user.id,
          title,
          dueAt: dueUTC,
          repeat: 'none',
          status: 'scheduled',
          formattedMessage: null
        });

        await scheduleReminder(reminder);

        // bersihkan session pending
        session.set(from, { ...sess, pendingTitle: null, pendingDueAtWIB: null });

        const whenText = describeTime(dueWIB, nowWIB);
        const name = user.name || user.username || 'kamu';
        const confirm = ai.reply ||
          `✅ Siap, ${name}! Aku akan ingatkan kamu untuk “${title}” ${whenText}.`;
        return await replyOut(res, from, confirm, isTwilio);
      }

      // 13) potential_reminder / unknown – tanggapan hangat yang selalu membuka pintu reminder
      {
        const msg =
          ai.reply ||
          'Semangat ya! Kalau kamu butuh pengingat biar nggak lupa hal penting, bilang aja—aku siap bantu 😊';
        // simpan tidak mengganggu context
        return await replyOut(res, from, msg, isTwilio);
      }
    } catch (err) {
      console.error('[WA Controller] Fatal error:', err);
      try {
        // fallback balasan agar user tetap dapat respons
        return await replyOut(res, (req.body?.From || '').replace('whatsapp:', ''), 'Maaf, bisa dijelaskan lagi ya? 🙂', !!(req.body && req.body.From && req.body.Body));
      } catch (_) {
        return res.status(500).json({ message: 'Internal server error' });
      }
    }
  }
};
