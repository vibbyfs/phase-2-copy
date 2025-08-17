// controllers/waController.js - CommonJS, Twilio outbound, conversational flow
const { User, Reminder, ReminderRecipient } = require('../models');
const { scheduleReminder, cancelReminder } = require('../services/scheduler');
const sessionStore = require('../services/session');
const { sendMessage } = require('../services/waOutbound');
const ai = require('../services/ai');
const { 
  parseUsernamesFromMessage, 
  validateAndGetRecipients, 
  generateMultiRecipientMessage,
  checkRecipientPermissions 
} = require('../helpers/multiRecipient');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

// Helper Functions
function parseISOToUTC(isoString) {
  if (!isoString) return null;
  try {
    // Parse ISO string directly (already has timezone info)
    const dt = dayjs(isoString);
    console.log(`[parseISOToUTC] Input: ${isoString}, Parsed: ${dt.toISOString()}, UTC: ${dt.utc().toISOString()}`);
    return dt.utc().toDate();
  } catch (err) {
    console.error('[parseISOToUTC] Invalid date:', isoString, err.message);
    return null;
  }
}

function humanWhen(isoString) {
  if (!isoString) return null;
  try {
    // Parse ISO string and convert to Jakarta timezone for display
    const dt = dayjs(isoString).tz('Asia/Jakarta');
    const now = dayjs().tz('Asia/Jakarta');
    const diffInMinutes = dt.diff(now, 'minute');
    
    if (diffInMinutes < 1) return 'sekarang';
    if (diffInMinutes < 60) return `${diffInMinutes} menit lagi`;
    if (diffInMinutes < 1440) {
      const hours = Math.floor(diffInMinutes / 60);
      return `${hours} jam lagi`;
    }
    return dt.format('DD MMM, HH:mm');
  } catch (err) {
    return null;
  }
}

async function replyToUser(message) {
  await sendMessage(fromPhone, message, null);
}

let fromPhone; // Global variable to store current phone

async function inbound(req, res) {
  try {
    const { From, Body, MessageSid } = req.body;
    fromPhone = From?.replace('whatsapp:', ''); // Set global variable
    const text = Body?.trim();
    
    console.log(`[WA] inbound from: ${fromPhone} text: ${text}`);
    
    if (!fromPhone || !text) {
      return res.status(200).json({ ok: true });
    }

    // Find user
    const user = await User.findOne({ where: { phone: fromPhone } });
    if (!user) {
      await replyToUser('Halo! Sepertinya kamu belum terdaftar. Silakan daftar terlebih dahulu ya! 😊');
      return res.status(200).json({ ok: true });
    }

    const username = user.username;
    const ctx = sessionStore.getContext(fromPhone) || {};

    // Get AI response
    const parsed = await ai.extract({
      text,
      userProfile: { username },
      sessionContext: ctx
    });

    console.log('[WA] AI parsed:', parsed);

    // Handle different intents
    if (parsed.intent === 'create' && parsed.title) {
      
      // Process @username mentions if any
      let recipientUsers = [];
      let validationErrors = [];
      
      if (parsed.recipientUsernames && parsed.recipientUsernames.length > 0) {
        console.log('[WA] Processing recipients:', parsed.recipientUsernames);
        
        const validation = await validateAndGetRecipients(user.id, parsed.recipientUsernames);
        recipientUsers = validation.validUsers;
        
        if (validation.invalidUsernames.length > 0) {
          validationErrors.push(`Username tidak ditemukan: ${validation.invalidUsernames.join(', ')}`);
        }
        
        if (validation.notFriends.length > 0) {
          validationErrors.push(`Kamu belum berteman dengan: ${validation.notFriends.join(', ')}`);
        }
        
        if (validationErrors.length > 0) {
          await replyToUser(`❌ ${validationErrors.join('\n')}\n\nPastikan username benar dan kalian sudah berteman ya! 😊`);
          return res.status(200).json({ ok: true });
        }
      }
      
      // Handle repeat reminders (only if explicit repeat pattern detected AND no specific dueAt time)
      if (parsed.repeat && parsed.repeat !== 'none' && parsed.timeType !== 'relative') {
        let startTime = new Date();
        
        if (parsed.repeat === 'minutes' || parsed.repeat === 'hours') {
          // Start immediately for frequent repeats
          startTime = new Date(Date.now() + 60000); // Start in 1 minute
        } else {
          // For daily/weekly/monthly, need time of day
          if (!parsed.repeatDetails?.timeOfDay) {
            await replyToUser('Untuk reminder harian/mingguan/bulanan, kamu mau diingatkan jam berapa? 😊');
            return res.status(200).json({ ok: true });
          }
          
          // Parse time in WIB timezone properly
          const [hours, minutes] = (parsed.repeatDetails.timeOfDay || '09:00').split(':');
          const now = new Date();
          
          // Create target time in WIB today
          const targetTimeWIB = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Jakarta"}));
          targetTimeWIB.setHours(parseInt(hours), parseInt(minutes), 0, 0);
          
          // Convert to UTC for storage
          const targetTimeUTC = new Date(targetTimeWIB.getTime() - (7 * 60 * 60 * 1000)); // WIB to UTC
          
          console.log(`[WA Controller] Daily reminder - timeOfDay: ${parsed.repeatDetails.timeOfDay}, targetWIB: ${targetTimeWIB.toISOString()}, targetUTC: ${targetTimeUTC.toISOString()}, now: ${now.toISOString()}`);
          
          // If time has passed today, schedule for tomorrow
          if (targetTimeUTC <= now) {
            switch (parsed.repeat) {
              case 'daily':
                targetTimeUTC.setDate(targetTimeUTC.getDate() + 1);
                break;
              case 'weekly':
                targetTimeUTC.setDate(targetTimeUTC.getDate() + 7);
                break;
              case 'monthly':
                targetTimeUTC.setMonth(targetTimeUTC.getMonth() + 1);
                break;
            }
            console.log(`[WA Controller] Time passed, moved to next occurrence: ${targetTimeUTC.toISOString()}`);
          }
          
          startTime = targetTimeUTC;
        }
        
        const dueAtUTC = startTime;
        
        // Generate formatted message for reminder using AI
        let baseFormattedMessage = await ai.generateReply({
          kind: 'reminder_delivery',
          username,
          title: parsed.title.trim(),
          context: 'Generate a warm, motivational reminder message in Indonesian with relevant emoticons based on the activity.'
        });

        baseFormattedMessage = baseFormattedMessage || 
          `Halo, waktunya ${parsed.title.trim()}! 😊`;

        // Map AI's repeat values to database enum values
        let dbRepeat = 'none';
        let dbRepeatType = 'once';
        
        if (parsed.repeat === 'minutes') {
          dbRepeat = 'none'; // Frequent repeats use none for legacy repeat field
          dbRepeatType = 'minutes';
        } else if (parsed.repeat === 'hours') {
          dbRepeat = 'hourly';
          dbRepeatType = 'hours';
        } else if (parsed.repeat === 'daily') {
          dbRepeat = 'daily';
          dbRepeatType = 'daily';
        } else if (parsed.repeat === 'weekly') {
          dbRepeat = 'weekly';
          dbRepeatType = 'weekly';
        } else if (parsed.repeat === 'monthly') {
          dbRepeat = 'monthly';
          dbRepeatType = 'monthly';
        }

        // Create main reminder
        const reminder = await Reminder.create({
          UserId: user.id,
          RecipientId: recipientUsers.length > 0 ? null : user.id, // null if multi-recipient
          title: parsed.title.trim(),
          dueAt: dueAtUTC,
          repeat: dbRepeat,
          repeatType: dbRepeatType,
          repeatInterval: parsed.repeatDetails?.interval || null,
          repeatEndDate: parsed.repeatDetails?.endDate ? new Date(parsed.repeatDetails.endDate) : null,
          isRecurring: parsed.repeat !== 'none',
          status: 'scheduled',
          formattedMessage: recipientUsers.length > 0 
            ? generateMultiRecipientMessage(baseFormattedMessage, recipientUsers, user)
            : baseFormattedMessage
        });

        // Create ReminderRecipients if there are multiple recipients
        if (recipientUsers.length > 0) {
          const recipientData = recipientUsers.map(recipient => ({
            ReminderId: reminder.id,
            RecipientId: recipient.id,
            status: 'scheduled'
          }));
          
          await ReminderRecipient.bulkCreate(recipientData);
          console.log(`[WA] Created reminder for ${recipientUsers.length} recipients`);
        }
        
        await scheduleReminder(reminder);
        sessionStore.setContext(fromPhone, { lastListedIds: [] });

        const intervalText = parsed.repeatDetails?.interval 
          ? `setiap ${parsed.repeatDetails.interval} ${parsed.repeat === 'minutes' ? 'menit' : 'jam'}`
          : `setiap ${parsed.repeat === 'daily' ? 'hari' : parsed.repeat === 'weekly' ? 'minggu' : 'bulan'}`;
        
        let confirmMessage;
        if (recipientUsers.length > 0) {
          const recipientNames = recipientUsers.map(u => u.username).join(', ');
          confirmMessage = `✅ Siap! Aku akan mengingatkan ${recipientNames} "${parsed.title}" ${intervalText}. 😊`;
        } else {
          confirmMessage = `✅ Siap! Aku akan mengingatkan kamu "${parsed.title}" ${intervalText}. 😊`;
        }
        
        await replyToUser(confirmMessage);
        return res.status(200).json({ ok: true });
      }
      
      // Handle regular reminders with specific time
      if (parsed.dueAtWIB) {
        const dueAtUTC = parseISOToUTC(parsed.dueAtWIB);
        if (!dueAtUTC) {
          await replyToUser('Jamnya belum kebaca dengan jelas nih 😅 Kamu mau diingatkan jam berapa?');
          return res.status(200).json({ ok: true });
        }
        
        // Debug logging for time checking
        console.log(`[WA Controller] Time check - dueAtWIB: ${parsed.dueAtWIB}, dueAtUTC: ${dueAtUTC.toISOString()}, now: ${new Date().toISOString()}, timeType: ${parsed.timeType}`);
        
        // prevent past (with 30 second tolerance for relative times)
        const tolerance = parsed.timeType === 'relative' ? 30000 : 0; // 30 seconds tolerance for relative times
        const now = new Date(Date.now() - tolerance);
        
        if (dayjs(dueAtUTC).isBefore(dayjs(now))) {
          console.log(`[WA Controller] Time rejected - dueAt: ${dueAtUTC.toISOString()}, checkAgainst: ${now.toISOString()}`);
          await replyToUser('Waktunya sudah lewat nih 😅 Mau pilih waktu lain?');
          return res.status(200).json({ ok: true });
        }

        // Generate formatted message for reminder using AI
        let baseFormattedMessage = await ai.generateReply({
          kind: 'reminder_delivery',
          username,
          title: parsed.title.trim(),
          context: 'Generate a warm, motivational reminder message in Indonesian with relevant emoticons based on the activity.'
        });

        baseFormattedMessage = baseFormattedMessage || 
          `Halo, waktunya ${parsed.title.trim()}! 😊`;

        // Map AI's repeat values to database enum values for regular reminders
        let dbRepeat = 'none';
        let dbRepeatType = 'once';
        
        if (parsed.repeat && parsed.repeat !== 'none') {
          if (parsed.repeat === 'minutes') {
            dbRepeat = 'none'; // Frequent repeats use none for legacy repeat field
            dbRepeatType = 'minutes';
          } else if (parsed.repeat === 'hours') {
            dbRepeat = 'hourly';
            dbRepeatType = 'hours';
          } else if (parsed.repeat === 'daily') {
            dbRepeat = 'daily';
            dbRepeatType = 'daily';
          } else if (parsed.repeat === 'weekly') {
            dbRepeat = 'weekly';
            dbRepeatType = 'weekly';
          } else if (parsed.repeat === 'monthly') {
            dbRepeat = 'monthly';
            dbRepeatType = 'monthly';
          }
        }

        const reminder = await Reminder.create({
          UserId: user.id,
          RecipientId: recipientUsers.length > 0 ? null : user.id, // null if multi-recipient
          title: parsed.title.trim(),
          dueAt: dueAtUTC,
          repeat: dbRepeat,
          repeatType: dbRepeatType,
          repeatInterval: parsed.repeatDetails?.interval || null,
          repeatEndDate: parsed.repeatDetails?.endDate ? new Date(parsed.repeatDetails.endDate) : null,
          isRecurring: parsed.repeat !== 'none',
          status: 'scheduled',
          formattedMessage: recipientUsers.length > 0 
            ? generateMultiRecipientMessage(baseFormattedMessage, recipientUsers, user)
            : baseFormattedMessage
        });

        // Create ReminderRecipients if there are multiple recipients
        if (recipientUsers.length > 0) {
          const recipientData = recipientUsers.map(recipient => ({
            ReminderId: reminder.id,
            RecipientId: recipient.id,
            status: 'scheduled'
          }));
          
          await ReminderRecipient.bulkCreate(recipientData);
          console.log(`[WA] Created regular reminder for ${recipientUsers.length} recipients`);
        }

        await scheduleReminder(reminder);
        // persist minimal context (clear pending since created)
        sessionStore.setContext(fromPhone, { lastListedIds: [] });

        const whenText = humanWhen(parsed.dueAtWIB) || 'nanti';
        
        let confirmMessage;
        if (recipientUsers.length > 0) {
          const recipientNames = recipientUsers.map(u => u.username).join(', ');
          // Ask AI for a one-line confirm
          const confirm = await ai.generateReply({
            kind: 'confirm_create',
            username,
            title: parsed.title,
            whenText,
            context: `Multi-recipient reminder for: ${recipientNames}`
          });
          confirmMessage = confirm || `✅ Siap! Aku akan ingatkan ${recipientNames} untuk "${parsed.title}" ${whenText}.`;
        } else {
          // Ask AI for a one-line confirm
          const confirm = await ai.generateReply({
            kind: 'confirm_create',
            username,
            title: parsed.title,
            whenText
          });
          confirmMessage = confirm || `✅ Siap, ${username}! Aku akan ingatkan kamu untuk "${parsed.title}" ${whenText}.`;
        }
        
        await replyToUser(confirmMessage);
        return res.status(200).json({ ok: true });
      }
    }

    // Handle list reminders
    if (parsed.intent === 'list') {
      const reminders = await Reminder.findAll({
        where: { 
          UserId: user.id, 
          status: 'scheduled' 
        },
        include: [
          {
            model: ReminderRecipient,
            as: 'reminderRecipients',
            where: { status: 'scheduled' },
            required: false,
            include: [
              {
                model: User,
                as: 'recipient',
                attributes: ['username']
              }
            ]
          }
        ],
        order: [['dueAt', 'ASC']],
        limit: 10
      });

      if (reminders.length === 0) {
        await replyToUser('Kamu belum punya pengingat aktif nih 😊 Mau bikin sekarang?');
        return res.status(200).json({ ok: true });
      }

      let listText = `📋 Pengingat aktif kamu (${reminders.length}):\n\n`;
      const listIds = [];
      
      reminders.forEach((reminder, idx) => {
        const num = idx + 1;
        listIds.push(reminder.id);
        
        const whenText = humanWhen(reminder.dueAt.toISOString().replace('Z', '+07:00'));
        const repeatText = reminder.isRecurring 
          ? ` (${reminder.repeatType === 'minutes' ? `setiap ${reminder.repeatInterval} menit` : 
               reminder.repeatType === 'hours' ? `setiap ${reminder.repeatInterval} jam` :
               `setiap ${reminder.repeatType === 'daily' ? 'hari' : reminder.repeatType === 'weekly' ? 'minggu' : 'bulan'}`})`
          : '';
        
        // Show recipients if multi-recipient
        let recipientText = '';
        if (reminder.reminderRecipients && reminder.reminderRecipients.length > 0) {
          const recipientNames = reminder.reminderRecipients
            .map(rr => rr.recipient.username)
            .join(', ');
          recipientText = ` → ${recipientNames}`;
        }
        
        listText += `${num}. "${reminder.title}" - ${whenText}${repeatText}${recipientText}\n`;
      });
      
      listText += `\n💡 Kirim angka (1-${reminders.length}) untuk batalkan reminder tertentu.`;
      
      // Store listed IDs for stop_number intent
      sessionStore.setContext(fromPhone, { ...ctx, lastListedIds: listIds });
      
      await replyToUser(listText);
      return res.status(200).json({ ok: true });
    }

    if (parsed.intent === 'need_time' && parsed.title) {
      // keep pending title in context
      sessionStore.setContext(fromPhone, { ...ctx, pendingTitle: parsed.title });
      await replyToUser(parsed.reply || `Untuk "${parsed.title}", kamu mau diingatkan kapan?`);
      return res.status(200).json({ ok: true });
    }

    if (parsed.intent === 'need_content' && parsed.timeType) {
      // keep hint about time in context (optional)
      sessionStore.setContext(fromPhone, { ...ctx, pendingTimeHint: true });
      await replyToUser(parsed.reply || 'Noted jamnya! Kamu mau diingatkan tentang apa ya?');
      return res.status(200).json({ ok: true });
    }

    if (parsed.intent === 'potential_reminder') {
      // Keep content so user can reply with time
      if (parsed.title) {
        sessionStore.setContext(fromPhone, { ...ctx, pendingTitle: parsed.title });
      }
      await replyToUser(parsed.reply || 'Mau aku bantu bikin pengingat untuk itu? 😊 Kalau iya, kamu mau diingatkan jam berapa?');
      return res.status(200).json({ ok: true });
    }

    // Handle stop by number (after list)
    if (parsed.intent === 'stop_number' && parsed.stopNumber) {
      const listIds = ctx.lastListedIds || [];
      const targetIndex = parsed.stopNumber - 1;
      
      if (targetIndex < 0 || targetIndex >= listIds.length) {
        await replyToUser('Nomor reminder tidak valid nih 😅 Coba kirim "list" lagi ya.');
        return res.status(200).json({ ok: true });
      }
      
      const reminderId = listIds[targetIndex];
      const reminder = await Reminder.findByPk(reminderId, {
        include: [
          {
            model: ReminderRecipient,
            as: 'reminderRecipients',
            include: [
              {
                model: User,
                as: 'recipient',
                attributes: ['username']
              }
            ]
          }
        ]
      });
      
      if (!reminder) {
        await replyToUser('Reminder tidak ditemukan 😅');
        return res.status(200).json({ ok: true });
      }
      
      // Cancel the reminder and all its recipients
      reminder.status = 'cancelled';
      await reminder.save();
      
      // Cancel all ReminderRecipients
      if (reminder.reminderRecipients && reminder.reminderRecipients.length > 0) {
        await ReminderRecipient.update(
          { status: 'cancelled' },
          { where: { ReminderId: reminderId, status: 'scheduled' } }
        );
      }
      
      await cancelReminder(reminderId);
      
      let cancelMessage = `✅ Reminder "${reminder.title}" berhasil dibatalkan!`;
      if (reminder.reminderRecipients && reminder.reminderRecipients.length > 0) {
        const recipientNames = reminder.reminderRecipients
          .map(rr => rr.recipient.username)
          .join(', ');
        cancelMessage += ` (untuk ${recipientNames})`;
      }
      
      await replyToUser(cancelMessage);
      
      // Clear listed IDs
      sessionStore.setContext(fromPhone, { ...ctx, lastListedIds: [] });
      return res.status(200).json({ ok: true });
    }

    // Unknown / small talk -> warm reply that opens door to reminders
    await replyToUser(parsed.reply || 'Aku di sini buat bantu kamu tetap teratur. Mau bikin pengingat sekarang? 😊');
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[WA Controller] Fatal error:', err);
    try {
      await sendMessage(fromPhone, 'Lagi ada kendala teknis kecil nih 😅 Coba ulang sebentar ya.', null);
    } catch (e) {
      console.error('[WAOutbound] Gagal kirim:', e?.message || e);
    }
    return res.status(200).json({ ok: true });
  }
}

module.exports = { inbound };