// controllers/waController.js
const { DateTime } = require('luxon');
const { User, Reminder, Friend } = require('../models');
const { Op } = require('sequelize');
const { scheduleReminder, cancelReminder } = require('../services/scheduler');
const { extract, generateReply, extractTitleFromText } = require('../services/ai');

const WIB_TZ = 'Asia/Jakarta';

/**
 * Helper: kirim respons sesuai mode (webhook Twilio / JSON)
 */
async function sendResponse(res, message, isTwilioWebhook = false, userPhone = null) {
  if (isTwilioWebhook) {
    if (userPhone) {
      const { sendReminder } = require('../services/waOutbound');
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
  }
  return res.json({ action: 'reply', body: message });
}

/**
 * Human-friendly helpers
 */
function humanizeTimeWIB(iso) {
  if (!iso) return null;
  const dt = DateTime.fromISO(iso, { zone: WIB_TZ });
  if (!dt.isValid) return null;
  const now = DateTime.now().setZone(WIB_TZ);
  if (dt.hasSame(now, 'day')) return `hari ini jam ${dt.toFormat('HH:mm')} WIB`;
  if (dt.hasSame(now.plus({ days: 1 }), 'day')) return `besok jam ${dt.toFormat('HH:mm')} WIB`;
  return dt.toFormat('dd/MM/yyyy HH:mm') + ' WIB';
}

function politeFallback(ai, rawText) {
  const title = (ai?.title || '').trim() || extractTitleFromText(rawText) || 'pengingatmu';
  const timeStr = humanizeTimeWIB(ai?.dueAtWIB);

  switch (ai?.intent) {
    case 'need_time':
      return `Baik, aku bantu buat pengingat *${title}*. Jam berapa enaknya? 😊\nContoh: *"jam 20.00"*, *"30 menit lagi"*, atau *"besok jam 9"*.`;
    case 'need_content':
      if (timeStr) {
        return `Siap, aku catat untuk ${timeStr}. Pengingatnya mau tentang apa ya? 😊\nContoh: *"makan malam"*, *"minum obat"*, atau *"jemput anak"*.`;
      }
      return `Siap, jamnya sudah oke. Kamu mau diingatkan tentang apa ya? 😊`;
    case 'potential_reminder':
      return `Sepertinya kamu ingin bikin pengingat *${title}*. Mau kujadwalkan? Jam berapa bagusnya? 😊\nContoh: *"jam 20.00"*, *"1 jam lagi"*, *"besok jam 9"*.`;
    case 'unknown':
      return `Aku bisa bantu bikin pengingat biar nggak lupa. 😊\nTulis: *"ingatkan saya <aktivitas> <waktu>"*.\nContoh: *"ingatkan saya makan malam jam 20.00"* atau *"ingatkan saya minum obat 30 menit lagi"*.`;
    default:
      if (!ai?.intent || ai.intent === 'create') {
        return `Sip! Pengingat *${title}* akan aku bantu atur. Kamu ingin diingatkan kapan ya? 😊`;
      }
      return 'Siap bantu! Kamu mau diingatkan tentang apa, dan kapan? 😊';
  }
}

/** Utamakan conversationalResponse untuk intent tertentu; unknown pakai fallback instruktif */
function chooseReply(ai, rawText) {
  const pf = politeFallback(ai, rawText);
  if (ai?.intent === 'need_time' || ai?.intent === 'need_content' || ai?.intent === 'potential_reminder') {
    return ai?.conversationalResponse || pf;
  }
  return pf;
}

/**
 * WA Controller
 */
module.exports = {
  inbound: async (req, res) => {
    try {
      // --- Parse input (Twilio atau custom) ---
      let from, text, isTwilioWebhook = false;
      if (req.body.From && req.body.Body) {
        from = req.body.From.replace('whatsapp:', '');
        text = req.body.Body;
        isTwilioWebhook = true;
      } else {
        from = req.body.from;
        text = req.body.text;
      }

      if (!from || !text) {
        console.log('[WA] Invalid request - missing from or text:', { from, text });
        return res.status(400).json({ error: 'Missing required fields: from and text' });
      }

      console.log('[WA] inbound from:', from, 'text:', text);

      // --- Auth user by phone ---
      const user = await User.findOne({ where: { phone: from } });
      if (!user) {
        return await sendResponse(
          res,
          'Nomormu belum terdaftar di sistem. Silakan daftar dulu ya 😊',
          isTwilioWebhook,
          from
        );
      }

      // --- AI extract ---
      const ai = await extract(text);
      console.log('[WA] parsed AI:', ai);

      // ===================== CANCEL & LIST FLOWS =====================
      if (ai.intent === 'cancel') {
        const activeReminders = await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled', repeat: { [Op.ne]: 'none' } },
          order: [['createdAt', 'DESC']]
        });

        if (activeReminders.length === 0) {
          return await sendResponse(res, 'Tidak ada reminder berulang yang aktif untuk dibatalkan 😊', isTwilioWebhook, from);
        }

        for (const rem of activeReminders) {
          rem.status = 'cancelled';
          await rem.save();
          cancelReminder(rem.id);
        }

        return await sendResponse(res, `✅ ${activeReminders.length} reminder berulang berhasil dibatalkan!`, isTwilioWebhook, from);
      }

      if (ai.intent === 'cancel_all') {
        const allActiveReminders = await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled' },
          order: [['createdAt', 'DESC']]
        });

        if (allActiveReminders.length === 0) {
          return await sendResponse(res, 'Tidak ada reminder aktif untuk dibatalkan 😊', isTwilioWebhook, from);
        }

        for (const rem of allActiveReminders) {
          rem.status = 'cancelled';
          await rem.save();
          cancelReminder(rem.id);
        }

        return await sendResponse(res, `✅ Semua ${allActiveReminders.length} reminder berhasil dibatalkan!`, isTwilioWebhook, from);
      }

      if (ai.intent === 'cancel_keyword' && ai.cancelKeyword) {
        const matches = await Reminder.findAll({
          where: {
            UserId: user.id,
            status: 'scheduled',
            title: { [Op.iLike]: `%${ai.cancelKeyword}%` }
          },
          order: [['dueAt', 'ASC']]
        });

        if (matches.length === 0) {
          return await sendResponse(
            res,
            `Tidak ada reminder aktif yang mengandung kata "${ai.cancelKeyword}" 😊`,
            isTwilioWebhook,
            from
          );
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

      if (ai.intent === 'stop_number' && ai.stopNumber) {
        const idx = parseInt(ai.stopNumber, 10);
        if (Number.isNaN(idx) || idx < 1) {
          return await sendResponse(res, 'Nomornya kurang pas nih 😅 Coba cek lagi daftar reminder-nya ya.', isTwilioWebhook, from);
        }

        const active = await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled' },
          order: [['dueAt', 'ASC']]
        });

        if (idx > active.length) {
          return await sendResponse(res, 'Nomor tersebut tidak ada di daftar saat ini 😅', isTwilioWebhook, from);
        }

        const target = active[idx - 1];
        target.status = 'cancelled';
        await target.save();
        cancelReminder(target.id);

        return await sendResponse(res, `✅ Reminder nomor ${idx} (${target.title}) sudah dibatalkan.`, isTwilioWebhook, from);
      }

      if (ai.intent === 'list') {
        const activeReminders = await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled' },
          order: [['dueAt', 'ASC']],
          limit: 10
        });

        if (activeReminders.length === 0) {
          return await sendResponse(res, 'Tidak ada reminder aktif saat ini 😊', isTwilioWebhook, from);
        }

        let listMessage = `📋 *Daftar Reminder Aktif (${activeReminders.length}):*\n\n`;
        activeReminders.forEach((rem, index) => {
          const dueTime = DateTime.fromJSDate(rem.dueAt).setZone(WIB_TZ).toFormat('dd/MM HH:mm');
          const repeatText = rem.repeat !== 'none' ? ` (${rem.repeat})` : '';
          listMessage += `${index + 1}. *${rem.title}*\n   📅 ${dueTime} WIB${repeatText}\n\n`;
        });
        listMessage += '💡 _Ketik "--reminder <keyword>" untuk filter, atau "stop (n)" untuk membatalkan salah satu_';

        return await sendResponse(res, listMessage, isTwilioWebhook, from);
      }

      // ===================== NGOBROL DULU (bukan create) =====================
      if (['potential_reminder', 'need_time', 'need_content', 'unknown'].includes(ai.intent)) {
        const reply = chooseReply(ai, text);
        return await sendResponse(res, reply, isTwilioWebhook, from);
      }

      // ===================== GUARD: WAJIB create + ada dueAtWIB =====================
      if (ai.intent !== 'create' || !ai.dueAtWIB) {
        const reply = chooseReply(ai, text);
        return await sendResponse(res, reply, isTwilioWebhook, from);
      }

      // ===================== CREATE REMINDER =====================
      const title = (ai.title || '').trim() || extractTitleFromText(text);
      let repeat = ai.repeat || 'none';
      const timeType = ai.timeType || 'relative';
      const repeatDetails = ai.repeatDetails || {};

      console.log('[WA] AI parsing result:', { title, timeType, dueAtWIB: ai.dueAtWIB, repeat, repeatDetails });

      const nowWIB = DateTime.now().setZone(WIB_TZ);
      const parsedTime = DateTime.fromISO(ai.dueAtWIB);
      if (!parsedTime.isValid) {
        const reply = 'Jamnya belum kebaca dengan jelas nih 😅 Kamu mau diingatkan jam berapa?';
        return await sendResponse(res, reply, isTwilioWebhook, from);
      }

      let dueDate = parsedTime.toUTC().toJSDate();

      // Recurring dengan timeOfDay → hitung next occurrence
      if (repeat !== 'none' && repeatDetails.timeOfDay) {
        try {
          const [hour, minute] = repeatDetails.timeOfDay.split(':').map(Number);
          let nextExecution = nowWIB.set({ hour, minute, second: 0, millisecond: 0 });
          if (nextExecution <= nowWIB) {
            switch (repeat) {
              case 'daily': nextExecution = nextExecution.plus({ days: 1 }); break;
              case 'weekly': nextExecution = nextExecution.plus({ weeks: 1 }); break;
              case 'monthly': nextExecution = nextExecution.plus({ months: 1 }); break;
              case 'hourly':
                nextExecution = nowWIB.plus({ hours: 1 }).set({ minute: 0, second: 0, millisecond: 0 });
                break;
            }
          }
          dueDate = nextExecution.toUTC().toJSDate();
        } catch (err) {
          console.error('[WA] Error processing recurring time:', err);
        }
      }

      // Validasi final
      if (isNaN(dueDate.getTime())) {
        return await sendResponse(res, 'Format waktunya kurang pas nih 😅 Coba kirim ulang jamnya ya.', isTwilioWebhook, from);
      }
      if (DateTime.fromJSDate(dueDate) <= DateTime.utc()) {
        return await sendResponse(res, 'Waktunya sudah lewat nih 😅 Mau pilih waktu lain?', isTwilioWebhook, from);
      }

      console.log('[WA] Final scheduling:', { title, timeType, dueDate: dueDate.toISOString(), repeat, repeatDetails });

      // --- Recipient: default diri sendiri, atau @username ---
      let recipients = [user];
      const createdReminders = [];

      if (ai.recipientUsernames && ai.recipientUsernames.length > 0) {
        recipients = [];
        for (const tagged of ai.recipientUsernames) {
          const username = tagged.replace('@', '');
          const targetUser = await User.findOne({ where: { username } });
          if (!targetUser) {
            return await sendResponse(res, `User @${username} tidak ditemukan. Pastikan username benar dan user sudah terdaftar.`, isTwilioWebhook, from);
          }

          const friendship = await Friend.findOne({
            where: {
              [Op.or]: [
                { UserId: user.id, FriendId: targetUser.id, status: 'accepted' },
                { UserId: targetUser.id, FriendId: user.id, status: 'accepted' }
              ]
            }
          });
          if (!friendship) {
            return await sendResponse(res, `Kamu belum berteman dengan @${username}. Kirim undangan pertemanan dulu ya 😊`, isTwilioWebhook, from);
          }

          recipients.push(targetUser);
        }
        // Kirim ke teman = sekali saja
        repeat = 'none';
      }

      // --- Create & schedule each reminder ---
      for (const recipient of recipients) {
        const isForFriend = recipient.id !== user.id;
        let formattedMessage;

        if (isForFriend) {
          const context = {
            title,
            userName: recipient.name || recipient.username || 'kamu',
            timeOfDay: DateTime.fromJSDate(dueDate).setZone(WIB_TZ).toFormat('HH:mm'),
            senderName: user.name || user.username || 'Teman',
            isForFriend: true
          };
          formattedMessage = await generateReply('reminder', context);
        } else {
          formattedMessage = ai.formattedMessage;
          if (!formattedMessage) {
            const context = {
              title,
              userName: recipient.name || recipient.username || 'kamu',
              timeOfDay: DateTime.fromJSDate(dueDate).setZone(WIB_TZ).toFormat('HH:mm'),
              isForFriend: false
            };
            formattedMessage = await generateReply('reminder', context);
          }
        }

        const reminder = await Reminder.create({
          UserId: user.id,
          RecipientId: recipient.id,
          title,
          dueAt: dueDate,
          repeat,
          status: 'scheduled',
          formattedMessage
        });

        await scheduleReminder(reminder);
        createdReminders.push(reminder);
      }

      // --- Konfirmasi ke user ---
      const recipientNames =
        recipients.length > 1
          ? recipients.map(r => r.name || r.username || 'Unknown').join(', ')
          : recipients[0].id === user.id
          ? 'diri sendiri'
          : recipients[0].name || recipients[0].username || 'Unknown';

      const now = DateTime.now().setZone(WIB_TZ);
      const scheduledTime = DateTime.fromJSDate(dueDate).setZone(WIB_TZ);

      let timeDescription = '';
      if (timeType === 'relative') {
        const diffMinutes = Math.round(scheduledTime.diff(now, 'minutes').minutes);
        if (diffMinutes < 60) timeDescription = `${diffMinutes} menit lagi`;
        else if (diffMinutes < 1440) timeDescription = `${Math.round(diffMinutes / 60)} jam lagi`;
        else timeDescription = scheduledTime.toFormat('dd/MM/yyyy HH:mm') + ' WIB';
      } else if (timeType === 'absolute') {
        const isToday = scheduledTime.hasSame(now, 'day');
        const isTomorrow = scheduledTime.hasSame(now.plus({ days: 1 }), 'day');
        if (isToday) timeDescription = `hari ini jam ${scheduledTime.toFormat('HH:mm')} WIB`;
        else if (isTomorrow) timeDescription = `besok jam ${scheduledTime.toFormat('HH:mm')} WIB`;
        else timeDescription = scheduledTime.toFormat('dd/MM/yyyy HH:mm') + ' WIB';
      } else if (timeType === 'recurring') {
        timeDescription = scheduledTime.toFormat('dd/MM/yyyy HH:mm') + ' WIB (mulai)';
      }

      let repeatText = '';
      if (repeat !== 'none') {
        const repeatMap = { hourly: 'setiap jam', daily: 'setiap hari', weekly: 'setiap minggu', monthly: 'setiap bulan' };
        repeatText = ` (${repeatMap[repeat]})`;
        if (repeatDetails.timeOfDay) repeatText += ` pada ${repeatDetails.timeOfDay} WIB`;
        if (repeatDetails.dayOfWeek) repeatText += ` hari ${repeatDetails.dayOfWeek}`;
        if (repeatDetails.dayOfMonth) repeatText += ` tanggal ${repeatDetails.dayOfMonth}`;
      }

      const confirmMsg = await generateReply('confirm', {
        title,
        recipients: recipientNames,
        userName: user.name || user.username || null,
        timeDescription,
        repeatText,
        timeType,
        relativeTime: timeType === 'relative' ? timeDescription : null,
        dueTime: timeType !== 'relative' ? timeDescription : null,
        count: createdReminders.length
      });

      if (isTwilioWebhook) {
        const { sendReminder } = require('../services/waOutbound');
        try {
          await sendReminder(from, confirmMsg, null);
          console.log('[WA] Confirmation sent to:', from);
        } catch (error) {
          console.error('[WA] Failed to send confirmation:', error);
        }
        return res
          .type('text/xml')
          .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      }

      return await sendResponse(res, confirmMsg, isTwilioWebhook, from);
    } catch (err) {
      console.error('ERROR WA INBOUND', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }
};
