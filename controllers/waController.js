// /controllers/waController.js  (CommonJS)
'use strict';

const { DateTime } = require('luxon');
const { Op } = require('sequelize');

// Models
const { User, Reminder, Friend } = require('../models');

// Services
const { scheduleReminder, cancelReminder } = require('../services/scheduler');
const { sendReminder } = require('../services/waOutbound');
const { setContext, getContext, clearContext } = require('../services/session');

// AI helpers (pastikan ai.js CommonJS & ekspor fungsi-fungsi di bawah)
const {
  extract,
  generateReply,
  extractTitleFromText,
  generateConversationalResponse,
  generateReminderList,
} = require('../services/ai');

const WIB_TZ = 'Asia/Jakarta';

/** Helper: kirim respons via Twilio (untuk webhook) atau JSON (untuk test) */
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
    // Kembalikan TwiML kosong karena pesan sudah dikirim aktif
    return res
      .type('text/xml')
      .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } else {
    return res.json({ action: 'reply', body: message });
  }
}

/** Format konfirmasi manusiawi */
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

/** Controller utama */
module.exports = {
  inbound: async (req, res) => {
    const nowWIB = DateTime.now().setZone(WIB_TZ);

    try {
      // Deteksi Twilio webhook vs custom
      let from, text, isTwilioWebhook = false;
      if (req.body && req.body.From && req.body.Body) {
        from = req.body.From.replace('whatsapp:', '');
        text = (req.body.Body || '').trim();
        isTwilioWebhook = true;
      } else {
        from = req.body?.from;
        text = (req.body?.text || '').trim();
      }

      if (!from || !text) {
        console.log('[WA] Invalid request - missing from or text:', { from, text });
        return res.status(400).json({ error: 'Missing required fields: from and text' });
      }

      console.log('[WA] inbound from:', from, 'text:', text);

      // Cari user berdasarkan phone
      const user = await User.findOne({ where: { phone: from } });
      if (!user) {
        return await sendResponse(
          res,
          'Nomormu belum terdaftar di sistem. Silakan daftar dulu ya 😊',
          isTwilioWebhook,
          from
        );
      }

      // Jalankan AI extract (pastikan ai.js sudah ganti max_tokens -> max_completion_tokens
      // dan hilangkan temperature non-default agar cocok dgn gpt-5-mini).
      let ai = await extract(text);
      // Antisipasi AI kosong -> fallback extremely safe
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

      // ===== Flow CANCEL via kata umum =====
      if (ai.intent === 'cancel') {
        const activeReminders = await Reminder.findAll({
          where: {
            UserId: user.id,
            status: 'scheduled',
            repeat: { [Op.ne]: 'none' },
          },
          order: [['createdAt', 'DESC']],
        });

        if (activeReminders.length === 0) {
          return await sendResponse(
            res,
            'Tidak ada reminder berulang yang aktif untuk dibatalkan 😊',
            isTwilioWebhook,
            from
          );
        }

        for (const rem of activeReminders) {
          rem.status = 'cancelled';
          await rem.save();
          cancelReminder(rem.id);
        }

        return await sendResponse(
          res,
          `✅ ${activeReminders.length} reminder berulang berhasil dibatalkan!`,
          isTwilioWebhook,
          from
        );
      }

      // ===== Flow CANCEL ALL =====
      if (ai.intent === 'cancel_all') {
        const allActiveReminders = await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled' },
          order: [['createdAt', 'DESC']],
        });

        if (allActiveReminders.length === 0) {
          return await sendResponse(res, 'Tidak ada reminder aktif untuk dibatalkan 😊', isTwilioWebhook, from);
        }

        for (const rem of allActiveReminders) {
          rem.status = 'cancelled';
          await rem.save();
          cancelReminder(rem.id);
        }

        return await sendResponse(
          res,
          `✅ Semua ${allActiveReminders.length} reminder berhasil dibatalkan!`,
          isTwilioWebhook,
          from
        );
      }

      // ===== Flow CANCEL specific via keyword (--reminder makan) =====
      if (ai.intent === 'cancel_keyword' && ai.cancelKeyword) {
        const specificReminders = await Reminder.findAll({
          where: {
            UserId: user.id,
            status: 'scheduled',
            title: { [Op.iLike]: `%${ai.cancelKeyword}%` },
          },
          order: [['createdAt', 'DESC']],
        });

        if (specificReminders.length === 0) {
          return await sendResponse(
            res,
            `Tidak ada reminder aktif yang mengandung kata "${ai.cancelKeyword}" 😊`,
            isTwilioWebhook,
            from
          );
        }

        // Kirim daftar bernomor
        const msg = generateReminderList(specificReminders, ai.cancelKeyword);
        return await sendResponse(res, msg, isTwilioWebhook, from);
      }

      // ===== Flow STOP (No) =====
      if (ai.intent === 'stop_number' && ai.stopNumber) {
        const index = parseInt(ai.stopNumber, 10) - 1;
        if (Number.isNaN(index) || index < 0) {
          return await sendResponse(res, 'Nomor tidak valid 😅 Coba cek lagi daftarnya ya.', isTwilioWebhook, from);
        }
        // Cari 10 reminder aktif utk user (urut ASC)
        const activeReminders = await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled' },
          order: [['dueAt', 'ASC']],
          limit: 10,
        });
        if (!activeReminders[index]) {
          return await sendResponse(res, 'Nomor yang kamu kirim belum cocok nih 😅 Coba cek lagi daftar reminder-nya ya.', isTwilioWebhook, from);
        }
        const rem = activeReminders[index];
        rem.status = 'cancelled';
        await rem.save();
        cancelReminder(rem.id);
        return await sendResponse(res, `✅ Reminder nomor ${ai.stopNumber} sudah dibatalkan. Kalau kamu butuh pengingat baru, tinggal bilang aja ya 😊`, isTwilioWebhook, from);
      }

      // ===== Flow LIST =====
      if (ai.intent === 'list') {
        const activeReminders = await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled' },
          order: [['dueAt', 'ASC']],
          limit: 10,
        });

        if (activeReminders.length === 0) {
          return await sendResponse(res, 'Tidak ada reminder aktif saat ini 😊', isTwilioWebhook, from);
        }

        let listMessage = `📋 *Daftar Reminder Aktif (${activeReminders.length}):*\n\n`;
        for (let i = 0; i < activeReminders.length; i++) {
          const rem = activeReminders[i];
          const dueTime = DateTime.fromJSDate(rem.dueAt).setZone(WIB_TZ).toFormat('dd/MM HH:mm');
          const repeatText = rem.repeat !== 'none' ? ` (${rem.repeat})` : '';
          listMessage += `${i + 1}. *${rem.title}*\n   📅 ${dueTime} WIB${repeatText}\n\n`;
        }
        listMessage += '💡 _Ketik "--reminder <keyword>" untuk cari & batalkan berdasarkan nama_\n   _Ketik "stop (No)" untuk batalkan berdasarkan nomor_';

        return await sendResponse(res, listMessage, isTwilioWebhook, from);
      }

      // ===== Potential reminder / Need content or time =====
      // Jika AI sudah kasih conversationalResponse → kirimkan
      if (ai.intent !== 'create' && ai.conversationalResponse) {
        return await sendResponse(res, ai.conversationalResponse, isTwilioWebhook, from);
      }

      // ===== CREATE REMINDER =====
      const titleRaw = (ai.title || '').trim() || extractTitleFromText(text) || 'Reminder';
      const title = titleRaw.replace(/\s+/g, ' ').trim();

      let repeat = ai.repeat || 'none';
      const timeType = ai.timeType || 'relative';
      const repeatDetails = ai.repeatDetails || {};

      // Hitung dueDate
      let dueDate;
      if (ai.dueAtWIB) {
        const parsed = DateTime.fromISO(ai.dueAtWIB).setZone(WIB_TZ);
        dueDate = parsed.isValid ? parsed.toUTC().toJSDate() : nowWIB.plus({ minutes: 5 }).toUTC().toJSDate();
      } else {
        dueDate = nowWIB.plus({ minutes: 5 }).toUTC().toJSDate();
      }

      // Jika recurring & ada timeOfDay → set eksekusi berikutnya
      if (repeat !== 'none' && repeatDetails.timeOfDay) {
        try {
          const [h, m] = repeatDetails.timeOfDay.split(':').map(Number);
          let nextExec = nowWIB.set({ hour: h, minute: m, second: 0, millisecond: 0 });
          if (nextExec <= nowWIB) {
            switch (repeat) {
              case 'daily':   nextExec = nextExec.plus({ days: 1 }); break;
              case 'weekly':  nextExec = nextExec.plus({ weeks: 1 }); break;
              case 'monthly': nextExec = nextExec.plus({ months: 1 }); break;
              case 'hourly':  nextExec = nowWIB.plus({ hours: 1 }).set({ minute: 0, second: 0, millisecond: 0 }); break;
            }
          }
          dueDate = nextExec.toUTC().toJSDate();
        } catch (e) {
          console.error('[WA] Error processing recurring time:', e);
        }
      }

      // Validasi akhir
      if (Number.isNaN(dueDate.getTime()) || DateTime.fromJSDate(dueDate) <= DateTime.utc()) {
        dueDate = nowWIB.plus({ minutes: 5 }).toUTC().toJSDate();
      }

      // Recipient(s)
      let recipients = [user];
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
                { UserId: targetUser.id, FriendId: user.id, status: 'accepted' },
              ],
            },
          });
          if (!friendship) {
            return await sendResponse(res, `Kamu belum berteman dengan @${username}. Kirim undangan pertemanan dulu ya 😊`, isTwilioWebhook, from);
          }
          recipients.push(targetUser);
        }
        repeat = 'none'; // mention teman → sekali saja
      }

      // Simpan reminders
      const createdReminders = [];
      for (const recipient of recipients) {
        const isForFriend = recipient.id !== user.id;

        let formattedMessage;
        if (isForFriend) {
          const ctx = {
            title,
            userName: recipient.name || recipient.username || 'kamu',
            timeOfDay: DateTime.fromJSDate(dueDate).setZone(WIB_TZ).toFormat('HH:mm'),
            senderName: user.name || user.username || 'Teman',
            isForFriend: true,
          };
          formattedMessage = await generateReply('reminder', ctx);
        } else {
          const ctx = {
            title,
            userName: recipient.name || recipient.username || 'kamu',
            timeOfDay: DateTime.fromJSDate(dueDate).setZone(WIB_TZ).toFormat('HH:mm'),
            isForFriend: false,
          };
          formattedMessage = await generateReply('reminder', ctx);
        }

        const reminder = await Reminder.create({
          UserId: user.id,
          RecipientId: recipient.id,
          title,
          dueAt: dueDate,
          repeat,
          status: 'scheduled',
          formattedMessage,
        });

        await scheduleReminder(reminder);
        createdReminders.push(reminder);
      }

      // Konfirmasi ke user
      const scheduledTimeWIB = DateTime.fromJSDate(dueDate).setZone(WIB_TZ);
      const timeDesc = humanTimeDescription(nowWIB, scheduledTimeWIB, timeType);

      const recipientNames =
        recipients.length > 1
          ? recipients.map(r => r.name || r.username || 'Unknown').join(', ')
          : (recipients[0].id === user.id ? 'diri sendiri' : recipients[0].name || recipients[0].username || 'Unknown');

      const confirmMsg = await generateReply('confirm', {
        title,
        recipients: recipientNames,
        userName: user.name || user.username || null,
        timeDescription: timeDesc,
        repeatText: repeat !== 'none' ? ` (${repeat})` : '',
        timeType,
        relativeTime: timeType === 'relative' ? timeDesc : null,
        dueTime: timeType !== 'relative' ? timeDesc : null,
        count: createdReminders.length,
      });

      return await sendResponse(res, confirmMsg, isTwilioWebhook, from);
    } catch (err) {
      console.error('[WA Controller] Fatal error:', err);
      // fallback kirim pesan ramah agar user tidak bengong
      try {
        const from = (req.body?.From || '').replace('whatsapp:', '') || req.body?.from;
        if (from) {
          await sendReminder(from, 'Maaf, ada kendala teknis. Coba ketik lagi ya, misalnya: "ingatkan saya minum air 10 menit lagi" 🙂', null);
        }
      } catch (_) {}
      return res.status(500).json({ message: 'Internal server error' });
    }
  },
};
