// controllers/waController.js (CommonJS, Twilio direct)
'use strict';

const { DateTime } = require('luxon');
const { Op } = require('sequelize');
const { User, Reminder, Friend } = require('../models'); // sesuaikan path models
const { scheduleReminder, cancelReminder } = require('../services/scheduler');
const { sendReminder } = require('../services/waOutbound');
const { setContext, getContext, clearContext } = require('../services/session');
const { extract, generateReply, extractTitleFromText } = require('../services/ai');

const WIB_TZ = 'Asia/Jakarta';

/** Helper: kirim respons via Twilio (webhook) atau JSON (untuk test) */
async function sendResponse(res, message, isTwilioWebhook = false, userPhone = null) {
  if (isTwilioWebhook) {
    if (userPhone) {
      try {
        await sendReminder(userPhone, message, null);
        console.log('[WA] Response sent to:', userPhone);
      } catch (error) {
        console.error('[WA] Failed to send response:', error);
      }
    }
    return res
      .type('text/xml')
      .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } else {
    return res.json({ action: 'reply', body: message });
  }
}

function humanTimeDescription(nowWIB, scheduledTimeWIB, timeType) {
  if (timeType === 'relative') {
    const diffMinutes = Math.max(1, Math.round(scheduledTimeWIB.diff(nowWIB, 'minutes').minutes));
    if (diffMinutes < 60) return `${diffMinutes} menit lagi`;
    if (diffMinutes < 1440) return `${Math.round(diffMinutes / 60)} jam lagi`;
    return `${scheduledTimeWIB.toFormat('dd/MM/yyyy HH:mm')} WIB`;
  }
  if (timeType === 'absolute') {
    const isToday = scheduledTimeWIB.hasSame(nowWIB, 'day');
    const isTomorrow = scheduledTimeWIB.hasSame(nowWIB.plus({ days: 1 }), 'day');
    if (isToday) return `hari ini jam ${scheduledTimeWIB.toFormat('HH:mm')} WIB`;
    if (isTomorrow) return `besok jam ${scheduledTimeWIB.toFormat('HH:mm')} WIB`;
    return `${scheduledTimeWIB.toFormat('dd/MM/yyyy HH:mm')} WIB`;
  }
  return `${scheduledTimeWIB.toFormat('dd/MM/yyyy HH:mm')} WIB (mulai)`;
}

function politeFallback(ai, rawText) {
  const title = (ai?.title || '').trim() || extractTitleFromText(rawText) || 'pengingatmu';
  const nowWIB = DateTime.now().setZone(WIB_TZ);
  const timeStr = ai?.dueAtWIB
    ? humanTimeDescription(nowWIB, DateTime.fromISO(ai.dueAtWIB, { zone: WIB_TZ }), ai.timeType)
    : null;

  switch (ai?.intent) {
    case 'need_time':
      return `Baik, aku bantu buat pengingat *${title}*. Jam berapa enaknya? 😊
Contoh: *"jam 20.00"*, *"30 menit lagi"*, atau *"besok jam 9"*.`;

    case 'need_content':
      if (timeStr) {
        return `Siap, aku catat untuk ${timeStr}. Pengingatnya mau tentang apa ya? 😊
Contoh: *"makan malam"*, *"minum obat"*, atau *"jemput anak"*.`;
      }
      return `Siap, jamnya sudah oke. Kamu mau diingatkan tentang apa ya? 😊`;

    case 'potential_reminder':
      return `Sepertinya kamu ingin bikin pengingat *${title}*. Mau kujadwalkan? Jam berapa bagusnya? 😊
Contoh: *"jam 20.00"*, *"1 jam lagi"*, *"besok jam 9"*.`;

    case 'unknown':
      return `Hai! Aku bisa bantu bikin pengingat biar nggak lupa. 😊
Cukup tulis: *"ingatkan saya <aktivitas> <waktu>"*.
Contoh: *"ingatkan saya makan malam jam 20.00"* atau *"ingatkan saya minum obat 30 menit lagi"*.`;

    default:
      if (!ai?.intent || ai.intent === 'create') {
        return `Sip! Pengingat *${title}* akan aku bantu atur. Kamu ingin diingatkan kapan ya? 😊`;
      }
      return 'Siap bantu! Kamu mau diingatkan tentang apa, dan kapan? 😊';
  }
}

module.exports = {
  inbound: async (req, res) => {
    const nowWIB = DateTime.now().setZone(WIB_TZ);

    try {
      // Twilio webhook vs custom payload
      let from, text, isTwilioWebhook = false;
      if (req.body && req.body.From && req.body.Body) {
        from = String(req.body.From).replace(/^whatsapp:/, '');
        text = String(req.body.Body || '').trim();
        isTwilioWebhook = true;
      } else {
        from = String(req.body?.from || '').trim();
        text = String(req.body?.text || '').trim();
      }

      if (!from || !text) {
        console.log('[WA] Invalid request - missing from or text:', { from, text });
        return res.status(400).json({ error: 'Missing required fields: from and text' });
      }

      console.log('[WA] inbound from:', from, 'text:', text);

      // Cari user
      const user = await User.findOne({ where: { phone: from } });
      if (!user) {
        return await sendResponse(
          res,
          'Nomormu belum terdaftar di sistem. Silakan daftar dulu ya 😊',
          isTwilioWebhook,
          from
        );
      }

      // ====== AI EXTRACT ======
      let ai = await extract(text);
      if (!ai || typeof ai !== 'object') {
        ai = {
          intent: 'unknown',
          title: extractTitleFromText(text) || 'Reminder',
          recipientUsernames: [],
          timeType: 'relative',
          dueAtWIB: null,
          repeat: 'none',
          repeatDetails: {},
          cancelKeyword: null,
          stopNumber: null,
          conversationalResponse:
            "Aku bisa bantu bikin pengingat. Tulis: 'ingatkan saya <aktivitas> <waktu>'. Contoh: 'ingatkan saya makan malam jam 20.00' 😊",
        };
      }
      console.log('[WA] parsed AI:', ai);

      // ====== CANCEL / LIST ======
      // list semua aktif (opsional: jika intent === 'list')
      if (ai.intent === 'list') {
        const active = await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled' },
          order: [['dueAt', 'ASC']],
          limit: 10,
        });

        if (active.length === 0) {
          return await sendResponse(res, 'Belum ada reminder aktif 😊', isTwilioWebhook, from);
        }

        let msg = 'Berikut pengingat aktif kamu:\n\n';
        active.forEach((rem, i) => {
          const due = DateTime.fromJSDate(rem.dueAt).setZone(WIB_TZ).toFormat('ccc, dd/LL HH:mm');
          const rpt = rem.repeat !== 'none' ? ` (${rem.repeat})` : '';
          msg += `${i + 1}. *${rem.title}*${rpt}\n   📅 ${due} WIB\n\n`;
        });
        msg += 'Tip: ketik `--reminder <keyword>` untuk filter, atau `stop (nomor)` untuk batalkan salah satu.';
        return await sendResponse(res, msg, isTwilioWebhook, from);
      }

      // cancel semua recurring
      if (ai.intent === 'cancel') {
        const activeRecur = await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled', repeat: { [Op.ne]: 'none' } },
        });
        if (activeRecur.length === 0) {
          return await sendResponse(res, 'Tidak ada reminder berulang yang aktif 😊', isTwilioWebhook, from);
        }
        for (const r of activeRecur) {
          r.status = 'cancelled';
          await r.save();
          cancelReminder(r.id);
        }
        return await sendResponse(res, `✅ ${activeRecur.length} reminder berulang berhasil dibatalkan!`, isTwilioWebhook, from);
      }

      // cancel semua aktif (termasuk one-shot)
      if (ai.intent === 'cancel_all') {
        const allActive = await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled' },
        });
        if (allActive.length === 0) {
          return await sendResponse(res, 'Tidak ada reminder aktif untuk dibatalkan 😊', isTwilioWebhook, from);
        }
        for (const r of allActive) {
          r.status = 'cancelled';
          await r.save();
          cancelReminder(r.id);
        }
        return await sendResponse(res, `✅ Semua ${allActive.length} reminder berhasil dibatalkan!`, isTwilioWebhook, from);
      }

      // cancel berdasarkan keyword - --reminder <keyword>
      if (ai.intent === 'cancel_keyword' && ai.cancelKeyword) {
        const matches = await Reminder.findAll({
          where: {
            UserId: user.id,
            status: 'scheduled',
            title: { [Op.iLike]: `%${ai.cancelKeyword}%` },
          },
          order: [['dueAt', 'ASC']],
        });

        if (matches.length === 0) {
          return await sendResponse(res, `Tidak ada reminder aktif yang mengandung kata "${ai.cancelKeyword}" 😊`, isTwilioWebhook, from);
        }

        let msg = `Berikut pengingat aktif terkait "${ai.cancelKeyword}":\n\n`;
        matches.forEach((rem, i) => {
          const due = DateTime.fromJSDate(rem.dueAt).setZone(WIB_TZ).toFormat('ccc, dd/LL HH:mm');
          const rpt = rem.repeat !== 'none' ? ` (${rem.repeat})` : '';
          msg += `${i + 1}. *${rem.title}*${rpt}\n   📅 ${due} WIB\n\n`;
        });
        msg += 'Ketik: `stop (nomor)` untuk membatalkan salah satu, contoh: `stop (1)`';
        return await sendResponse(res, msg, isTwilioWebhook, from);
      }

      // stop (n)
      if (ai.intent === 'stop_number' && ai.stopNumber) {
        const idx = parseInt(ai.stopNumber, 10);
        if (Number.isNaN(idx) || idx < 1) {
          return await sendResponse(res, 'Nomornya kurang pas nih 😅 Coba cek lagi daftar reminder-nya ya.', isTwilioWebhook, from);
        }

        const active = await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled' },
          order: [['dueAt', 'ASC']],
        });

        if (idx > active.length) {
          return await sendResponse(res, 'Nomor tersebut tidak ada di daftar saat ini 😅', isTwilioWebhook, from);
        }

        const target = active[idx - 1];
        target.status = 'cancelled';
        await target.save();
        cancelReminder(target.id);

        return await sendResponse(
          res,
          `✅ Reminder nomor ${idx} (*${target.title}*) sudah dibatalkan.`,
          isTwilioWebhook,
          from
        );
      }

      // ====== CREATE / NEED_* ======
      if (ai.intent === 'need_time') {
        // simpan judul sementara agar "1 menit lagi" mengikat ke sini, bukan "lagi"
        setContext(user.id, { pendingTitle: ai.title || extractTitleFromText(text) || 'Reminder' });
        return await sendResponse(res, politeFallback(ai, text), isTwilioWebhook, from);
      }

      if (ai.intent === 'need_content') {
        // simpan waktu sementara
        if (ai.dueAtWIB) setContext(user.id, { pendingDueAtWIB: ai.dueAtWIB, pendingTimeType: ai.timeType || 'absolute' });
        return await sendResponse(res, politeFallback(ai, text), isTwilioWebhook, from);
      }

      if (ai.intent === 'potential_reminder' || ai.intent === 'unknown') {
        return await sendResponse(
          res,
          ai.conversationalResponse || politeFallback(ai, text),
          isTwilioWebhook,
          from
        );
      }

      // intent === 'create' → jadwalkan
      if (ai.intent === 'create') {
        // perbaiki bila AI tidak mengisi title/time tapi ada di context
        const ctx = getContext(user.id) || {};
        const title = (ai.title || ctx.pendingTitle || extractTitleFromText(text) || 'Reminder').trim();
        const dueIso = ai.dueAtWIB || ctx.pendingDueAtWIB || null;
        const timeType = ai.timeType || ctx.pendingTimeType || 'absolute';

        if (!dueIso) {
          // belum ada waktu → minta jamnya
          setContext(user.id, { pendingTitle: title });
          return await sendResponse(res, politeFallback({ intent: 'need_time', title }, text), isTwilioWebhook, from);
        }

        const scheduledWIB = DateTime.fromISO(dueIso, { zone: WIB_TZ });
        if (!scheduledWIB.isValid) {
          return await sendResponse(res, 'Jamnya belum kebaca dengan jelas nih 😅 Kamu mau diingatkan jam berapa?', isTwilioWebhook, from);
        }

        const now = DateTime.now().setZone(WIB_TZ);
        if (scheduledWIB <= now) {
          return await sendResponse(res, 'Waktunya sudah lewat nih 😅 Mau pilih waktu lain?', isTwilioWebhook, from);
        }

        // tentukan penerima: diri sendiri (default) atau teman via @username
        let recipientId = user.id;
        if (Array.isArray(ai.recipientUsernames) && ai.recipientUsernames.length > 0) {
          const raw = ai.recipientUsernames[0].replace(/^@/, '');
          const friend = await Friend.findOne({ where: { UserId: user.id, username: raw } });
          if (friend) recipientId = friend.idRecipient; // asumsi kolom mapping
        }

        // buat Reminder
        const r = await Reminder.create({
          UserId: user.id,
          RecipientId: recipientId,
          title,
          dueAt: scheduledWIB.toUTC().toJSDate(),
          repeat: ai.repeat || 'none',
          status: 'scheduled',
          formattedMessage: null, // biar scheduler bikin pesan hangat
        });

        // jadwalkan
        scheduleReminder(r);

        // konfirmasi ke user
        const whenText = humanTimeDescription(now, scheduledWIB, timeType);
        const confirm = await generateReply('confirm', {
          title,
          userName: user.name || user.username || 'kamu',
          whenText,
        });

        clearContext(user.id);
        return await sendResponse(res, `✅ ${confirm}`, isTwilioWebhook, from);
      }

      // fallback umum
      return await sendResponse(
        res,
        ai.conversationalResponse || politeFallback(ai, text),
        isTwilioWebhook,
        from
      );
    } catch (err) {
      console.error('[WA Controller] Fatal error:', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  },
};
