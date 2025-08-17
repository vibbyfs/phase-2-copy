// controllers/waController.js - CommonJS, Twilio outbound, conversational flow
const { User, Reminder } = require('../models');
const { scheduleReminder, cancelReminder } = require('../services/scheduler');
const sessionStore = require('../services/session');
const { sendMessage } = require('../services/waOutbound');
const ai = require('../services/ai');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

// Helper Functions
function parseISOToUTC(isoString) {
  if (!isoString) return null;
  try {
    const dt = dayjs.tz(isoString, 'Asia/Jakarta');
    return dt.utc().toDate();
  } catch (err) {
    console.error('[parseISOToUTC] Invalid date:', isoString, err.message);
    return null;
  }
}

function humanWhen(isoString) {
  if (!isoString) return null;
  try {
    const dt = dayjs.tz(isoString, 'Asia/Jakarta');
    const now = dayjs.tz('Asia/Jakarta');
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
      
      // Handle repeat reminders (prioritize repeat over specific time)
      if (parsed.repeat && parsed.repeat !== 'none') {
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
          
          // Set time for today or next occurrence
          const [hours, minutes] = (parsed.repeatDetails.timeOfDay || '09:00').split(':');
          startTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
          
          // If time has passed today, schedule for next occurrence
          if (startTime <= new Date()) {
            switch (parsed.repeat) {
              case 'daily':
                startTime.setDate(startTime.getDate() + 1);
                break;
              case 'weekly':
                startTime.setDate(startTime.getDate() + 7);
                break;
              case 'monthly':
                startTime.setMonth(startTime.getMonth() + 1);
                break;
            }
          }
        }
        
        const dueAtUTC = startTime;
        
        // Generate formatted message for reminder using AI
        const formattedMessage = await ai.generateReply({
          kind: 'reminder_delivery',
          username,
          title: parsed.title.trim(),
          context: 'Generate a warm, motivational reminder message in Indonesian with relevant emoticons based on the activity.'
        });

        const finalFormattedMessage = formattedMessage || 
          `Halo ${username}, waktunya ${parsed.title.trim()}! 😊`;

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

        const reminder = await Reminder.create({
          UserId: user.id,
          RecipientId: user.id,
          title: parsed.title.trim(),
          dueAt: dueAtUTC,
          repeat: dbRepeat,
          repeatType: dbRepeatType,
          repeatInterval: parsed.repeatDetails?.interval || null,
          repeatEndDate: parsed.repeatDetails?.endDate ? new Date(parsed.repeatDetails.endDate) : null,
          isRecurring: parsed.repeat !== 'none',
          status: 'scheduled',
          formattedMessage: finalFormattedMessage
        });
        
        await scheduleReminder(reminder);
        sessionStore.setContext(fromPhone, { lastListedIds: [] });

        const intervalText = parsed.repeatDetails?.interval 
          ? `setiap ${parsed.repeatDetails.interval} ${parsed.repeat === 'minutes' ? 'menit' : 'jam'}`
          : `setiap ${parsed.repeat === 'daily' ? 'hari' : parsed.repeat === 'weekly' ? 'minggu' : 'bulan'}`;
          
        await replyToUser(`✅ Siap! Aku akan mengingatkan kamu "${parsed.title}" ${intervalText}. 😊`);
        return res.status(200).json({ ok: true });
      }
      
      // Handle regular reminders with specific time
      if (parsed.dueAtWIB) {
        const dueAtUTC = parseISOToUTC(parsed.dueAtWIB);
        if (!dueAtUTC) {
          await replyToUser('Jamnya belum kebaca dengan jelas nih 😅 Kamu mau diingatkan jam berapa?');
          return res.status(200).json({ ok: true });
        }
        // prevent past
        if (dayjs(dueAtUTC).isBefore(dayjs())) {
          await replyToUser('Waktunya sudah lewat nih 😅 Mau pilih waktu lain?');
          return res.status(200).json({ ok: true });
        }

        // Generate formatted message for reminder using AI
        const formattedMessage = await ai.generateReply({
          kind: 'reminder_delivery',
          username,
          title: parsed.title.trim(),
          context: 'Generate a warm, motivational reminder message in Indonesian with relevant emoticons based on the activity.'
        });

        const finalFormattedMessage = formattedMessage || 
          `Halo ${username}, waktunya ${parsed.title.trim()}! 😊`;

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
          RecipientId: user.id,
          title: parsed.title.trim(),
          dueAt: dueAtUTC,
          repeat: dbRepeat,
          repeatType: dbRepeatType,
          repeatInterval: parsed.repeatDetails?.interval || null,
          repeatEndDate: parsed.repeatDetails?.endDate ? new Date(parsed.repeatDetails.endDate) : null,
          isRecurring: parsed.repeat !== 'none',
          status: 'scheduled',
          formattedMessage: finalFormattedMessage
        });
        await scheduleReminder(reminder);
        // persist minimal context (clear pending since created)
        sessionStore.setContext(fromPhone, { lastListedIds: [] });

        const whenText = humanWhen(parsed.dueAtWIB) || 'nanti';
        // Ask AI for a one-line confirm
        const confirm = await ai.generateReply({
          kind: 'confirm_create',
          username,
          title: parsed.title,
          whenText
        });
        await replyToUser(confirm || `✅ Siap, ${username}! Aku akan ingatkan kamu untuk "${parsed.title}" ${whenText}.`);
        return res.status(200).json({ ok: true });
      }
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