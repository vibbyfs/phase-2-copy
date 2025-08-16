// controllers/waController.js
const { DateTime } = require('luxon');
const { User, Reminder, Friend } = require('../models');
const { Op } = require('sequelize');
const { scheduleReminder, cancelReminder } = require('../services/scheduler');
const { extract, generateReply, extractTitleFromText } = require('../services/ai');

const WIB_TZ = 'Asia/Jakarta';

/**
 * Helper function to send response in appropriate format
 */
async function sendResponse(res, message, isTwilioWebhook = false, userPhone = null) {
  if (isTwilioWebhook) {
    // For Twilio webhook, actively send the message via waOutbound
    if (userPhone) {
      const { sendReminder } = require('../services/waOutbound');
      try {
        await sendReminder(userPhone, message, null);
        console.log('[WA] Response sent to:', userPhone);
      } catch (error) {
        console.error('[WA] Failed to send response:', error);
      }
    }
    // Return empty TwiML response since we've already sent the message
    return res
      .type('text/xml')
      .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } else {
    return res.json({
      action: 'reply',
      body: message
    });
  }
}

/**
 * Conversational fallback yang lebih manusiawi & mengarahkan
 */
function humanizeTimeWIB(iso) {
  if (!iso) return null;
  const dt = DateTime.fromISO(iso, { zone: WIB_TZ });
  if (!dt.isValid) return null;
  const now = DateTime.now().setZone(WIB_TZ);
  const isToday = dt.hasSame(now, 'day');
  const isTomorrow = dt.hasSame(now.plus({ days: 1 }), 'day');
  if (isToday) return `hari ini jam ${dt.toFormat('HH:mm')} WIB`;
  if (isTomorrow) return `besok jam ${dt.toFormat('HH:mm')} WIB`;
  return dt.toFormat('dd/MM/yyyy HH:mm') + ' WIB';
}

function politeFallback(ai, rawText) {
  const title = (ai?.title || '').trim() || extractTitleFromText(rawText) || 'pengingatmu';
  const timeStr = humanizeTimeWIB(ai?.dueAtWIB);

  // Balasan yang jelas, hangat, dan mengarahkan user ke langkah berikutnya
  switch (ai?.intent) {
    case 'need_time':
      return `Baik, aku bantu buat pengingat *${title}*. Jam berapa enaknya? 😊\n` +
             `Contoh: *"jam 20.00"*, *"30 menit lagi"*, atau *"besok jam 9"*.`;

    case 'need_content':
      if (timeStr) {
        return `Siap, aku catat untuk ${timeStr}. Pengingatnya mau tentang apa ya? 😊\n` +
               `Contoh: *"makan malam"*, *"minum obat"*, atau *"jemput anak"*.`;
      }
      return `Siap, jamnya sudah oke. Kamu mau diingatkan tentang apa ya? 😊`;

    case 'potential_reminder':
      // Jika AI mendeteksi sinyal tapi belum yakin, arahkan dengan jelas
      return `Sepertinya kamu ingin bikin pengingat *${title}*. Mau kujadwalkan? Jam berapa bagusnya? 😊\n` +
             `Contoh: *"jam 20.00"*, *"1 jam lagi"*, *"besok jam 9"*.`;

    case 'unknown':
      return `Hai! Aku bisa bantu bikin pengingat biar nggak lupa. 😊\n` +
             `Cukup tulis: *"ingatkan saya <aktivitas> <waktu>"*.\n` +
             `Contoh: *"ingatkan saya makan malam jam 20.00"* atau *"ingatkan saya minum obat 30 menit lagi"*.`;

    default:
      // create/cancel/list dll tanpa conversationalResponse dari AI
      if (!ai?.intent || ai.intent === 'create') {
        // Jarang terjadi di fallback, aman-kan:
        return `Sip! Pengingat *${title}* akan aku bantu atur. Kamu ingin diingatkan kapan ya? 😊`;
      }
      return 'Siap bantu! Kamu mau diingatkan tentang apa, dan kapan? 😊';
  }
}

/**
 * Simplified WA Controller dengan Twilio Direct Integration:
 * 1. User buat reminder untuk diri sendiri (hourly/daily/weekly/monthly)
 * 2. User kirim reminder sekali ke teman dengan @username
 * 3. Stop reminder dengan natural language
 */
module.exports = {
  inbound: async (req, res) => {
    try {
      // Handle Twilio webhook format
      let from, text, isTwilioWebhook = false;

      if (req.body.From && req.body.Body) {
        // Twilio webhook format
        from = req.body.From.replace('whatsapp:', ''); // Remove whatsapp: prefix
        text = req.body.Body;
        isTwilioWebhook = true;
      } else {
        // Custom format (for testing or other sources)
        from = req.body.from;
        text = req.body.text;
      }

      // Validate required fields
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

      // Extract pesan menggunakan AI
      const ai = await extract(text);
      console.log('[WA] parsed AI:', ai);

      // ===================== CANCEL & LIST FLOWS =====================

      // Cancel semua recurring
      if (ai.intent === 'cancel') {
        const activeReminders = await Reminder.findAll({
          where: {
            UserId: user.id,
            status: 'scheduled',
            repeat: { [Op.ne]: 'none' }
          },
          order: [['createdAt', 'DESC']]
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

      // Cancel semua (termasuk one-time)
      if (ai.intent === 'cancel_all') {
        const allActiveReminders = await Reminder.findAll({
          where: {
            UserId: user.id,
            status: 'scheduled'
          },
          order: [['createdAt', 'DESC']]
        });

        if (allActiveReminders.length === 0) {
          return await sendResponse(
            res,
            'Tidak ada reminder aktif untuk dibatalkan 😊',
            isTwilioWebhook,
            from
          );
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

      // Cancel berdasarkan keyword (intent dari ai.js: cancel_keyword)
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
          const due = DateTime.fromJSDate(rem.dueAt)
            .setZone(WIB_TZ)
            .toFormat('ccc, dd/LL HH:mm');
          const rpt = rem.repeat !== 'none' ? ` (${rem.repeat})` : '';
          msg += `${i + 1}. *${rem.title}*${rpt}\n   📅 ${due} WIB\n\n`;
        });
        msg += 'Ketik: `stop (nomor)` untuk membatalkan salah satu, contoh: `stop (1)`';

        return await sendResponse(res, msg, isTwilioWebhook, from);
      }

      // Stop berdasarkan urutan dalam daftar aktif (global, urut dueAt ASC)
      if (ai.intent === 'stop_number' && ai.stopNumber) {
        const idx = parseInt(ai.stopNumber, 10);
        if (Number.isNaN(idx) || idx < 1) {
          return await sendResponse(
            res,
            'Nomornya kurang pas nih 😅 Coba cek lagi daftar reminder-nya ya.',
            isTwilioWebhook,
            from
          );
        }

        const active = await Reminder.findAll({
          where: { UserId: user.id, status: 'scheduled' },
          order: [['dueAt', 'ASC']]
        });

        if (idx > active.length) {
          return await sendResponse(
            res,
            'Nomor tersebut tidak ada di daftar saat ini 😅',
            isTwilioWebhook,
            from
          );
        }

        const target = active[idx - 1];
        target.status = 'cancelled';
        await target.save();
        cancelReminder(target.id);

        return await sendResponse(
          res,
          `✅ Reminder nomor ${idx} (${target.title}) sudah dibatalkan.`,
          isTwilioWebhook,
          from
        );
      }

      // List reminder aktif
      if (ai.intent === 'list') {
        const activeReminders = await Reminder.findAll({
          where: {
            UserId: user.id,
            status: 'scheduled'
          },
          order: [['dueAt', 'ASC']],
          limit: 10
        });

        if (activeReminders.length === 0) {
          return await sendResponse(
            res,
            'Tidak ada reminder aktif saat ini 😊',
            isTwilioWebhook,
            from
          );
        }

        let listMessage = `📋 *Daftar Reminder Aktif (${activeReminders.length}):*\n\n`;
        activeReminders.forEach((rem, index) => {
          const dueTime = DateTime.fromJSDate(rem.dueAt)
            .setZone(WIB_TZ)
            .toFormat('dd/MM HH:mm');
          const repeatText = rem.repeat !== 'none' ? ` (${rem.repeat})` : '';
          listMessage += `${index + 1}. *${rem.title}*\n   📅 ${dueTime} WIB${repeatText}\n\n`;
        });

        listMessage += '💡 _Ketik "--reminder <keyword>" untuk filter, atau "stop (n)" untuk membatalkan salah satu_';

        return await sendResponse(res, listMessage, isTwilioWebhook, from);
      }

      // ===================== NON-CREATE INTENTS (NGOBROL DULU) =====================
      if (['potential_reminder', 'need_time', 'need_content', 'unknown'].includes(ai.intent)) {
        const reply = politeFallback(ai, text);
        return await sendResponse(res, reply, isTwilioWebhook, from);
      }

      // ===================== GUARD: WAJIB CREATE + DUE AT TERSEDIA =====================
      if (ai.intent !== 'create' || !ai.dueAtWIB) {
        const reply = politeFallback(ai, text);
        return await sendResponse(res, reply, isTwilioWebhook, from);
      }

      // ===================== CREATE REMINDER FLOW =====================
      const title = (ai.title || '').trim() || extractTitleFromText(text);
      let repeat = ai.repeat || 'none';
      const timeType = ai.timeType || 'relative';
      const repeatDetails = ai.repeatDetails || {};

      console.log('[WA] AI parsing result:', {
        title,
        timeType,
        dueAtWIB: ai.dueAtWIB,
        repeat,
        repeatDetails
      });

      const nowWIB = DateTime.now().setZone(WIB_TZ);
      // AI must supply dueAtWIB (guarded). Validasi format:
      const parsedTime = DateTime.fromISO(ai.dueAtWIB);
      if (!parsedTime.isValid) {
        const reply = 'Jamnya belum kebaca dengan jelas nih 😅 Kamu mau diingatkan jam berapa?';
        return await sendResponse(res, reply, isTwilioWebhook, from);
      }

      let dueDate = parsedTime.toUTC().toJSDate();

      // Penyesuaian untuk recurring jika ada timeOfDay
      if (repeat !== 'none' && repeatDetails.timeOfDay) {
        try {
          const [hour, minute] = repeatDetails.timeOfDay.split(':').map(Number);
          let nextExecution = nowWIB.set({ hour, minute, second: 0, millisecond: 0 });

          if (nextExecution <= nowWIB) {
            switch (repeat) {
              case 'daily':
                nextExecution = nextExecution.plus({ days: 1 });
                break;
              case 'weekly':
                nextExecution = nextExecution.plus({ weeks: 1 });
                break;
              case 'monthly':
                nextExecution = nextExecution.plus({ months: 1 });
                break;
              case 'hourly':
                nextExecution = nowWIB
                  .plus({ hours: 1 })
                  .set({ minute: 0, second: 0, millisecond: 0 });
                break;
            }
          }

          dueDate = nextExecution.toUTC().toJSDate();
        } catch (error) {
          console.error('[WA] Error processing recurring time:', error);
        }
      }

      // Final validation: waktu harus valid & ke depan
      if (isNaN(dueDate.getTime())) {
        return await sendResponse(
          res,
          'Format waktunya kurang pas nih 😅 Coba kirim ulang jamnya ya.',
          isTwilioWebhook,
          from
        );
      }
      if (DateTime.fromJSDate(dueDate) <= DateTime.utc()) {
        return await sendResponse(
          res,
          'Waktunya sudah lewat nih 😅 Mau pilih waktu lain?',
          isTwilioWebhook,
          from
        );
      }

      console.log('[WA] Final scheduling:', {
        title,
        timeType,
        dueDate: dueDate.toISOString(),
        repeat,
        repeatDetails
      });

      // Cari recipients berdasarkan @username atau default ke user sendiri
      let recipients = [user]; // Default: reminder untuk diri sendiri
      const createdReminders = [];

      if (ai.recipientUsernames && ai.recipientUsernames.length > 0) {
        // Cari teman berdasarkan username
        recipients = [];
        for (const taggedUsername of ai.recipientUsernames) {
          const username = taggedUsername.replace('@', '');

          // Cari user berdasarkan username
          const targetUser = await User.findOne({ where: { username } });
          if (!targetUser) {
            return await sendResponse(
              res,
              `User @${username} tidak ditemukan. Pastikan username benar dan user sudah terdaftar.`,
              isTwilioWebhook,
              from
            );
          }

          // Cek apakah sudah berteman
          const friendship = await Friend.findOne({
            where: {
              [Op.or]: [
                { UserId: user.id, FriendId: targetUser.id, status: 'accepted' },
                { UserId: targetUser.id, FriendId: user.id, status: 'accepted' }
              ]
            }
          });

          if (!friendship) {
            return await sendResponse(
              res,
              `Kamu belum berteman dengan @${username}. Kirim undangan pertemanan dulu ya 😊`,
              isTwilioWebhook,
              from
            );
          }

          recipients.push(targetUser);
        }

        // Jika ada username tagging, reminder harus 'none' (sekali saja)
        repeat = 'none';
      }

      // Buat reminder untuk setiap recipient
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
          UserId: user.id, // Creator of the reminder
          RecipientId: recipient.id, // Self or friend
          title,
          dueAt: dueDate,
          repeat,
          status: 'scheduled',
          formattedMessage
        });

        await scheduleReminder(reminder);
        createdReminders.push(reminder);
      }

      // Enhanced response message based on timeType and repeat
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
        if (diffMinutes < 60) {
          timeDescription = `${diffMinutes} menit lagi`;
        } else if (diffMinutes < 1440) {
          const hours = Math.round(diffMinutes / 60);
          timeDescription = `${hours} jam lagi`;
        } else {
          timeDescription = scheduledTime.toFormat('dd/MM/yyyy HH:mm') + ' WIB';
        }
      } else if (timeType === 'absolute') {
        const isToday = scheduledTime.hasSame(now, 'day');
        const isTomorrow = scheduledTime.hasSame(now.plus({ days: 1 }), 'day');
        if (isToday) {
          timeDescription = `hari ini jam ${scheduledTime.toFormat('HH:mm')} WIB`;
        } else if (isTomorrow) {
          timeDescription = `besok jam ${scheduledTime.toFormat('HH:mm')} WIB`;
        } else {
          timeDescription = scheduledTime.toFormat('dd/MM/yyyy HH:mm') + ' WIB';
        }
      } else if (timeType === 'recurring') {
        timeDescription = scheduledTime.toFormat('dd/MM/yyyy HH:mm') + ' WIB (mulai)';
      }

      let repeatText = '';
      if (repeat !== 'none') {
        const repeatMap = {
          hourly: 'setiap jam',
          daily: 'setiap hari',
          weekly: 'setiap minggu',
          monthly: 'setiap bulan'
        };
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

      // Send confirmation message back to user
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
