// controllers/waController.js (ESM)
// Kompatibel dengan campuran ESM/CJS services via dynamic import fallback.
// Jika nanti semua services sudah ESM murni, hapus bagian "interopImport" & ganti ke import biasa.

import { DateTime } from 'luxon';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Models Sequelize biasanya CJS; gunakan require agar aman di ESM.
const { User, Reminder, Friend } = require('../models');
// Sequelize operators (kebanyakan project masih CJS)
const { Op } = require('sequelize');

// ---------- Interop helpers: aman untuk import ESM / CJS ----------
async function interopImport(path, cjsFallback = null) {
  try {
    // Coba import sebagai ESM
    const mod = await import(path);
    return mod?.default ? { ...mod.default, ...mod } : mod;
  } catch (e) {
    if (cjsFallback) return cjsFallback();
    throw e;
  }
}

// ai.js biasanya CJS pada proyek lama; gunakan interop agar fleksibel.
const ai = await interopImport('../services/ai.js', () => require('../services/ai.js'));
const { extract, generateReply, extractTitleFromText, generateReminderList } = ai;

// session.js kamu (di repo ini) CommonJS; interop otomatis.
const session = await interopImport('../services/session.js', () => require('../services/session.js'));
const { setContext, getContext, clearContext } = session;

// scheduler: beberapa repo CJS, beberapa ESM. Interop bikin aman di dua-duanya.
const scheduler = await interopImport('../services/scheduler.js', () => require('../services/scheduler'));
const { scheduleReminder, cancelReminder } = scheduler;

// Wa outbound Twilio (CJS di proyek kamu). Interop otomatis.
const waOut = await interopImport('../services/waOutbound.js', () => require('../services/waOutbound.js'));
const { sendReminder } = waOut;

const WIB_TZ = 'Asia/Jakarta';

// ---------- Util kirim response ----------
async function sendResponse(res, message, isTwilioWebhook = false, userPhone = null) {
  if (isTwilioWebhook) {
    try {
      if (userPhone) await sendReminder(userPhone, message, null);
      // Twilio webhook harus balas TwiML "kosong"
      return res
        .type('text/xml')
        .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    } catch (err) {
      console.error('[WA] Failed to send response via Twilio:', err);
      // tetap balas TwiML kosong agar webhook tidak retry berulang
      return res
        .type('text/xml')
        .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
  }
  // Fallback untuk testing non-Twilio
  return res.json({ action: 'reply', body: message });
}

// ---------- Controller ----------
export default {
  inbound: async (req, res) => {
    try {
      // Deteksi payload Twilio
      let from, text, isTwilioWebhook = false;
      if (req.body?.From && req.body?.Body) {
        from = String(req.body.From).replace('whatsapp:', '');
        text = req.body.Body;
        isTwilioWebhook = true;
      } else {
        from = req.body?.from;
        text = req.body?.text;
      }

      if (!from || !text) {
        console.log('[WA] Invalid request - missing from or text:', { from, text });
        return res.status(400).json({ error: 'Missing required fields: from and text' });
      }

      console.log('[WA] inbound from:', from, 'text:', text);

      // Cari user by phone
      const user = await User.findOne({ where: { phone: from } });
      if (!user) {
        return await sendResponse(
          res,
          'Nomormu belum terdaftar di sistem. Silakan daftar dulu ya 😊',
          isTwilioWebhook,
          from
        );
      }

      // --- Panggil AI extractor (natural & kontekstual) ---
      let aiParsed;
      try {
        aiParsed = await extract(text);
      } catch (err) {
        console.error('[AI] Extract error:', err);
        // fallback minimal
        aiParsed = {
          intent: 'unknown',
          title: extractTitleFromText ? extractTitleFromText(text) : 'Reminder',
          recipientUsernames: [],
          timeType: 'relative',
          dueAtWIB: null,
          repeat: 'none',
          repeatDetails: {},
          cancelKeyword: null,
          stopNumber: null,
          conversationalResponse:
            "Aku bisa bantu bikin pengingat. Tulis: 'ingatkan saya <aktivitas> <waktu>'. Contoh: 'ingatkan saya makan malam jam 20.00' 😊"
        };
      }

      console.log('[WA] parsed AI:', aiParsed);

      // ---------- Fast-path untuk conversational AI-only ----------
      if (aiParsed.conversationalResponse && aiParsed.intent === 'unknown') {
        return await sendResponse(res, aiParsed.conversationalResponse, isTwilioWebhook, from);
      }

      // ---------- Flow Cancel/List ----------
      const nowWIB = DateTime.now().setZone(WIB_TZ);

      // -- Pattern: --reminder <keyword> (list dengan nomor)
      if (aiParsed.intent === 'cancel_keyword' && aiParsed.cancelKeyword) {
        const keyword = aiParsed.cancelKeyword;
        const reminders = await Reminder.findAll({
          where: {
            UserId: user.id,
            status: 'scheduled',
            title: { [Op.iLike]: `%${keyword}%` }
          },
          order: [['dueAt', 'ASC']],
          limit: 20
        });

        if (!reminders.length) {
          const msg = `Tidak ada pengingat aktif terkait '${keyword}' nih. Mau cek semua reminder kamu? Ketik 'list reminder' ya 😊`;
          return await sendResponse(res, msg, isTwilioWebhook, from);
        }

        let listMsg = `Berikut pengingat aktif terkait '${keyword}':\n`;
        reminders.forEach((r, i) => {
          const dueStr = DateTime.fromJSDate(r.dueAt).setZone(WIB_TZ).toFormat('dd/MM HH:mm');
          listMsg += `${i + 1}. ${r.title} - ${dueStr} WIB\n`;
        });
        listMsg += `\nKirim pesan: \`stop (${1})\` untuk membatalkan pengingat nomor 1, dan seterusnya.`;
        return await sendResponse(res, listMsg, isTwilioWebhook, from);
      }

      // -- Pattern: stop (No)
      const stopNoMatch = String(text).toLowerCase().match(/stop\s*\((\d+)\)/i);
      if (stopNoMatch) {
        const no = Number(stopNoMatch[1]);
        // Ambil list aktif (paling baru)
        const active = await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled' },
          order: [['dueAt', 'ASC']],
          limit: 50
        });
        if (!active.length || no < 1 || no > active.length) {
          return await sendResponse(
            res,
            'Nomor yang kamu kirim belum cocok nih 😅 Coba cek lagi daftar reminder-nya ya.',
            isTwilioWebhook,
            from
          );
        }
        const target = active[no - 1];
        // update DB + batalkan scheduler
        target.status = 'cancelled';
        await target.save();
        try { await cancelReminder?.(target.id); } catch (e) {} // best-effort

        return await sendResponse(
          res,
          `✅ Reminder nomor ${no} ("${target.title}") sudah dibatalkan. Kalau kamu butuh pengingat baru, tinggal bilang aja ya 😊`,
          isTwilioWebhook,
          from
        );
      }

      // -- list
      if (aiParsed.intent === 'list') {
        const list = await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled' },
          order: [['dueAt', 'ASC']],
          limit: 10
        });

        if (!list.length) {
          return await sendResponse(
            res,
            'Tidak ada reminder aktif saat ini 😊',
            isTwilioWebhook,
            from
          );
        }

        let listMessage = `📋 *Daftar Reminder Aktif (${list.length}):*\n\n`;
        list.forEach((rem, index) => {
          const dueTime = DateTime.fromJSDate(rem.dueAt).setZone(WIB_TZ).toFormat('dd/MM HH:mm');
          const repeatText = rem.repeat !== 'none' ? ` (${rem.repeat})` : '';
          listMessage += `${index + 1}. *${rem.title}*\n   📅 ${dueTime} WIB${repeatText}\n\n`;
        });
        listMessage += '💡 _Ketik "--reminder <kata>" untuk filter & batalkan cepat_';

        return await sendResponse(res, listMessage, isTwilioWebhook, from);
      }

      // ---------- Flow pembuatan reminder ----------
      // Ambil/isi konteks session biar judul tidak jadi "lagi"
      const ctx = getContext(user.id) || {};
      let title = (aiParsed.title || '').trim();
      let dueAtWIB = aiParsed.dueAtWIB;
      let timeType = aiParsed.timeType || 'relative';
      let repeat = aiParsed.repeat || 'none';
      const repeatDetails = aiParsed.repeatDetails || {};

      // Jika AI mendeteksi potensi reminder
      if (aiParsed.intent === 'potential_reminder') {
        setContext(user.id, { pendingTitle: title || extractTitleFromText(text) });
        const msg = 'Mau aku bantu bikin pengingat untuk itu? 😊 Kalau iya, kamu mau diingatkan jam berapa?';
        return await sendResponse(res, msg, isTwilioWebhook, from);
      }

      // User sebut isi saja → minta jam
      if (aiParsed.intent === 'need_time') {
        title = title || extractTitleFromText(text) || ctx.pendingTitle || 'Reminder';
        setContext(user.id, { pendingTitle: title });
        const msg = `Siap! Untuk '${title}', kamu mau diingatkan kapan?`;
        return await sendResponse(res, msg, isTwilioWebhook, from);
      }

      // User sebut jam saja → minta isi
      if (aiParsed.intent === 'need_content') {
        // simpan waktu sementara
        setContext(user.id, { pendingDueAtWIB: dueAtWIB, pendingTimeType: timeType });
        const msg = 'Noted jamnya! Kamu mau diingatkan tentang apa ya?';
        return await sendResponse(res, msg, isTwilioWebhook, from);
      }

      // Jika user hanya kirim "1 menit lagi" dsb setelah sebelumnya sebut judul
      if (!title && ctx.pendingTitle) {
        title = ctx.pendingTitle;
      }

      // Kalau dueAt kosong tapi intent create, pakai waktu pending kalau ada
      if (!dueAtWIB && ctx.pendingDueAtWIB) {
        dueAtWIB = ctx.pendingDueAtWIB;
        timeType = ctx.pendingTimeType || timeType;
      }

      // Safety net: kalau tetap belum jelas
      if (!title) title = extractTitleFromText ? extractTitleFromText(text) : 'Reminder';

      // Jika AI belum bisa create, arahkan lagi dengan cara hangat
      if (aiParsed.intent !== 'create' && !dueAtWIB) {
        setContext(user.id, { pendingTitle: title });
        const msg = `Oke! Untuk '${title}', kamu mau diingatkan jam berapa? Contoh: "jam 20.00", "15 menit lagi" 😊`;
        return await sendResponse(res, msg, isTwilioWebhook, from);
      }

      // --- Hitung dueDate final (ISO WIB -> UTC Date)
      let dueDate;
      if (dueAtWIB) {
        const parsed = DateTime.fromISO(dueAtWIB);
        dueDate = parsed.isValid ? parsed.toUTC().toJSDate() : null;
      }
      if (!dueDate) {
        // fallback 5 menit
        dueDate = nowWIB.plus({ minutes: 5 }).toUTC().toJSDate();
      }
      // Validasi waktu di masa depan
      if (DateTime.fromJSDate(dueDate) <= DateTime.utc()) {
        dueDate = nowWIB.plus({ minutes: 5 }).toUTC().toJSDate();
      }

      // -- Username tagging (reminder untuk teman)
      let recipients = [user];
      if (Array.isArray(aiParsed.recipientUsernames) && aiParsed.recipientUsernames.length) {
        recipients = [];
        for (const tag of aiParsed.recipientUsernames) {
          const uname = tag.replace('@', '');
          const target = await User.findOne({ where: { username: uname } });
          if (!target) {
            return await sendResponse(
              res,
              `User @${uname} tidak ditemukan. Pastikan username benar dan user sudah terdaftar.`,
              isTwilioWebhook,
              from
            );
          }
          // Cek pertemanan
          const rel = await Friend.findOne({
            where: {
              [Op.or]: [
                { UserId: user.id, FriendId: target.id, status: 'accepted' },
                { UserId: target.id, FriendId: user.id, status: 'accepted' }
              ]
            }
          });
          if (!rel) {
            return await sendResponse(
              res,
              `Kamu belum berteman dengan @${uname}. Kirim undangan pertemanan dulu ya 😊`,
              isTwilioWebhook,
              from
            );
          }
          recipients.push(target);
        }
        // tag teman → selalu sekali (none)
        repeat = 'none';
      }

      // -- Simpan & jadwalkan untuk tiap penerima
      const created = [];
      for (const recipient of recipients) {
        // Format pesan reminder (AI bebas 1 baris motivasi, pendek)
        const ctxReply = {
          title,
          userName: recipient.name || recipient.username || 'kamu',
          timeOfDay: DateTime.fromJSDate(dueDate).setZone(WIB_TZ).toFormat('HH:mm'),
          isForFriend: recipient.id !== user.id,
          senderName: user.name || user.username || 'Teman'
        };
        const formattedMessage = await generateReply('reminder', ctxReply);

        const rec = await Reminder.create({
          UserId: user.id,
          RecipientId: recipient.id,
          title,
          dueAt: dueDate,
          repeat: repeat,
          status: 'scheduled',
          formattedMessage
        });

        // Jadwalkan melalui service scheduler project (bukan node-schedule lokal di controller)
        try {
          await scheduleReminder(rec);
        } catch (e) {
          console.error('[SCHED] scheduleReminder error:', e);
        }

        created.push(rec);
      }

      // Clear context setelah berhasil create
      clearContext(user.id);

      // --- Konfirmasi yang natural & singkat
      const scheduledTime = DateTime.fromJSDate(dueDate).setZone(WIB_TZ);
      let timePhrase;
      const diffMin = Math.round(scheduledTime.diff(nowWIB, 'minutes').minutes);
      if (diffMin < 60) timePhrase = `${diffMin} menit lagi`;
      else if (scheduledTime.hasSame(nowWIB, 'day')) timePhrase = `hari ini jam ${scheduledTime.toFormat('HH:mm')} WIB`;
      else if (scheduledTime.hasSame(nowWIB.plus({ days: 1 }), 'day')) timePhrase = `besok jam ${scheduledTime.toFormat('HH:mm')} WIB`;
      else timePhrase = scheduledTime.toFormat('dd/MM/yyyy HH:mm') + ' WIB';

      const recipientsText =
        recipients.length > 1
          ? recipients.map(r => r.name || r.username || 'Unknown').join(', ')
          : (recipients[0].id === user.id ? 'kamu' : (recipients[0].name || recipients[0].username || 'teman'));

      const confirm = await generateReply('confirm', {
        title,
        recipients: recipientsText,
        userName: user.name || user.username || null,
        timeType,
        relativeTime: timeType === 'relative' ? timePhrase : null,
        dueTime: timeType !== 'relative' ? timePhrase : null,
        count: created.length
      });

      return await sendResponse(res, confirm, isTwilioWebhook, from);
    } catch (err) {
      console.error('[WA Controller] Fatal error:', err);
      // Jangan diam; selalu balas sesuatu ke user agar UX tidak terasa "hang"
      try {
        return await sendResponse(
          res,
          'Maaf, lagi ada kendala teknis. Coba ulangi sebentar lagi ya 🙏',
          Boolean(req.body?.From && req.body?.Body),
          (req.body?.From || '').replace('whatsapp:', '')
        );
      } catch {
        return res.status(500).json({ message: 'Internal server error' });
      }
    }
  }
};
