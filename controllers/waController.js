// controllers/waController.js — tanpa prefix "✅", hard guard sapaan
'use strict';

const { DateTime } = require('luxon');
const { Op } = require('sequelize');
const { User, Reminder, Friend } = require('../models');
const { scheduleReminder, cancelReminder } = require('../services/scheduler');
const { sendReminder } = require('../services/waOutbound');
const { setContext, getContext, clearContext } = require('../services/session');
const { extract, generateReply, extractTitleFromText } = require('../services/ai');

const WIB_TZ = 'Asia/Jakarta';

function normalize(s){return (s||'').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();}
const GREET_WORDS = ['halo','hai','hey','hi','hello','hola','pagi','siang','sore','malam','oi','yo','hay'];
function isGreeting(t){const w=normalize(t).split(' '); if(w.length>3)return false; const s=w.reduce((a,b)=>a+(GREET_WORDS.includes(b)?1:0),0); return s>=Math.max(1,Math.ceil(w.length/2));}

async function sendResponse(res, message, isTwilioWebhook = false, userPhone = null) {
  if (isTwilioWebhook) {
    if (userPhone) {
      try { await sendReminder(userPhone, message, null); }
      catch (e) { console.error('[WA] Failed to send response:', e); }
    }
    return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
  return res.json({ action: 'reply', body: message });
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
  switch (ai?.intent) {
    case 'need_time':
      return `Baik, aku bantu buat pengingat *${title}*. Jam berapa enaknya? 😊
Contoh: "jam 20.00", "30 menit lagi", atau "besok jam 9".`;
    case 'need_content':
      return `Noted jamnya! Kamu mau diingatkan tentang apa ya? 😊`;
    case 'potential_reminder':
      return `Sepertinya kamu ingin bikin pengingat *${title}*. Mau kujadwalkan? Jam berapa bagusnya? 😊`;
    case 'unknown':
    default:
      return `Hai! Aku bisa bantu bikin pengingat biar nggak lupa 😊
Tulis: "ingatkan saya <aktivitas> <waktu>". Contoh: "ingatkan saya makan malam jam 20.00".`;
  }
}

module.exports = {
  inbound: async (req, res) => {
    const nowWIB = DateTime.now().setZone(WIB_TZ);
    try {
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
        return res.status(400).json({ error: 'Missing required fields: from and text' });
      }

      // Hard guard: sapaan → jangan buat reminder
      if (isGreeting(text)) {
        const msg = 'Hai! Semoga harimu menyenangkan 😊 Aku bisa bantu bikin pengingat biar nggak lupa. Mau buat pengingat untuk sesuatu?';
        return await sendResponse(res, msg, isTwilioWebhook, from);
      }

      // User lookup
      const user = await User.findOne({ where: { phone: from } });
      if (!user) {
        return await sendResponse(res, 'Nomormu belum terdaftar di sistem. Silakan daftar dulu ya 😊', isTwilioWebhook, from);
      }

      // Extract AI
      let ai = await extract(text);
      if (!ai || typeof ai !== 'object') {
        ai = { intent: 'unknown', title: 'Reminder' };
      }
      console.log('[WA] parsed AI:', ai);

      // LIST
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

      // CANCEL recurring
      if (ai.intent === 'cancel') {
        const activeRecur = await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled', repeat: { [Op.ne]: 'none' } },
        });
        if (!activeRecur.length) {
          return await sendResponse(res, 'Tidak ada reminder berulang yang aktif 😊', isTwilioWebhook, from);
        }
        for (const r of activeRecur) { r.status='cancelled'; await r.save(); cancelReminder(r.id); }
        return await sendResponse(res, `✅ ${activeRecur.length} reminder berulang berhasil dibatalkan!`, isTwilioWebhook, from);
      }

      // CANCEL all
      if (ai.intent === 'cancel_all') {
        const allActive = await Reminder.findAll({ where: { UserId: user.id, status: 'scheduled' } });
        if (!allActive.length) {
          return await sendResponse(res, 'Tidak ada reminder aktif untuk dibatalkan 😊', isTwilioWebhook, from);
        }
        for (const r of allActive) { r.status='cancelled'; await r.save(); cancelReminder(r.id); }
        return await sendResponse(res, `✅ Semua ${allActive.length} reminder berhasil dibatalkan!`, isTwilioWebhook, from);
      }

      // --reminder <keyword>
      if (ai.intent === 'cancel_keyword' && ai.cancelKeyword) {
        const matches = await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled', title: { [Op.iLike]: `%${ai.cancelKeyword}%` } },
          order: [['dueAt', 'ASC']],
        });
        if (!matches.length) {
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
        if (!Number.isFinite(idx) || idx < 1) {
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
        target.status = 'cancelled'; await target.save(); cancelReminder(target.id);
        return await sendResponse(res, `✅ Reminder nomor ${idx} (*${target.title}*) sudah dibatalkan.`, isTwilioWebhook, from);
      }

      // CREATE flow
      if (ai.intent === 'need_time') {
        const title = ai.title || extractTitleFromText(text) || 'Reminder';
        // Simpan judul agar "1 menit lagi" nempel ke sini (bukan "lagi")
        setContext(user.id, { pendingTitle: title });
        return await sendResponse(res, politeFallback({ intent:'need_time', title }, text), isTwilioWebhook, from);
      }

      if (ai.intent === 'need_content') {
        if (ai.dueAtWIB) setContext(user.id, { pendingDueAtWIB: ai.dueAtWIB, pendingTimeType: ai.timeType || 'absolute' });
        return await sendResponse(res, politeFallback({ intent:'need_content' }, text), isTwilioWebhook, from);
      }

      if (ai.intent === 'potential_reminder' || ai.intent === 'unknown') {
        const msg = ai.conversationalResponse || politeFallback(ai, text);
        return await sendResponse(res, msg, isTwilioWebhook, from);
      }

      if (ai.intent === 'create') {
        // ambil dari context bila ada yang belum lengkap
        const ctx = getContext(user.id) || {};
        let title = (ai.title || ctx.pendingTitle || extractTitleFromText(text) || 'Reminder').trim();

        // hindari sapaan jadi judul
        if (GREET_WORDS.includes(normalize(title))) {
          title = 'Reminder';
        }

        const dueIso = ai.dueAtWIB || ctx.pendingDueAtWIB || null;
        const timeType = ai.timeType || ctx.pendingTimeType || 'absolute';

        if (!dueIso) {
          setContext(user.id, { pendingTitle: title });
          return await sendResponse(res, politeFallback({ intent:'need_time', title }, text), isTwilioWebhook, from);
        }

        const scheduledWIB = DateTime.fromISO(dueIso, { zone: WIB_TZ });
        if (!scheduledWIB.isValid) {
          return await sendResponse(res, 'Jamnya belum kebaca dengan jelas nih 😅 Kamu mau diingatkan jam berapa?', isTwilioWebhook, from);
        }
        if (scheduledWIB <= nowWIB) {
          return await sendResponse(res, 'Waktunya sudah lewat nih 😅 Mau pilih waktu lain?', isTwilioWebhook, from);
        }

        // recipient: default diri sendiri
        let recipientId = user.id;
        if (Array.isArray(ai.recipientUsernames) && ai.recipientUsernames.length > 0) {
          const username = ai.recipientUsernames[0].replace(/^@/, '');
          const friend = await Friend.findOne({
            where: { [Op.or]: [
              { UserId: user.id, username },
              { FriendId: user.id, username }
            ]}
          });
          if (friend && friend.idRecipient) recipientId = friend.idRecipient;
        }

        const reminder = await Reminder.create({
          UserId: user.id,
          RecipientId: recipientId,
          title,
          dueAt: scheduledWIB.toUTC().toJSDate(),
          repeat: ai.repeat || 'none',
          status: 'scheduled',
          formattedMessage: null,
        });

        scheduleReminder(reminder);

        const whenText = humanTimeDescription(nowWIB, scheduledWIB, timeType);
        const confirm = await generateReply('confirm', {
          title,
          userName: user.name || user.username || 'kamu',
          whenText,
        });

        clearContext(user.id);
        // Tanpa prefix "✅" supaya tidak dobel
        return await sendResponse(res, confirm, isTwilioWebhook, from);
      }

      // fallback
      return await sendResponse(res, politeFallback(ai, text), isTwilioWebhook, from);
    } catch (err) {
      console.error('[WA Controller] Fatal error:', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  },
};
