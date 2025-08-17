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

function toWIBISOString(date) {
  return dayjs(date).tz('Asia/Jakarta').format('YYYY-MM-DDTHH:mm:ssZ');
}
function parseISOToUTC(dueAtWIB) {
  // Store UTC in DB
  const m = dayjs(dueAtWIB).tz('Asia/Jakarta');
  return m.isValid() ? m.utc().toDate() : null;
}
function humanWhen(dueAtWIB) {
  if (!dueAtWIB) return null;
  const m = dayjs(dueAtWIB).tz('Asia/Jakarta');
  const now = dayjs().tz('Asia/Jakarta');
  if (!m.isValid()) return null;
  if (m.isBefore(now)) return m.format('DD/MM/YYYY HH.mm') + ' WIB';
  const diffMin = m.diff(now, 'minute');
  if (diffMin < 60 && diffMin >= 0) return `${diffMin} menit lagi`;
  if (m.isSame(now, 'day')) return `hari ini jam ${m.format('HH.mm')}`;
  if (m.isSame(now.add(1,'day'), 'day')) return `besok jam ${m.format('HH.mm')}`;
  return m.format('ddd, DD/MM HH.mm') + ' WIB';
}

async function inbound(req, res, next) {
  const fromRaw = req.body?.From || req.body?.from || '';
  const text = (req.body?.Body || req.body?.text || '').trim();
  const fromPhone = String(fromRaw).replace('whatsapp:', '').trim();

  try {
    console.log('[WA] inbound from:', fromPhone, 'text:', text);
    const user = await User.findOne({ where: { phone: fromPhone } });
    const username = user?.username || fromPhone;

    // load session context
    const ctx = sessionStore.getContext(fromPhone) || {};

    // Fallback pattern matching for stop commands (before AI)
    let fallbackParsed = null;
    const stopPatterns = [
      { pattern: /stop\s*\(\s*(\d+)\s*\)/i, intent: 'stop_number' },
      { pattern: /batal\s*\(\s*(\d+)\s*\)/i, intent: 'stop_number' },
      { pattern: /^\s*(\d+)\s*$/, intent: 'stop_number' } // just number after list
    ];
    
    for (const { pattern, intent } of stopPatterns) {
      const match = text.match(pattern);
      if (match && intent === 'stop_number') {
        const number = parseInt(match[1]);
        if (number >= 1 && number <= 10) { // reasonable range
          fallbackParsed = {
            intent: 'stop_number',
            stopNumber: number,
            conversationalResponse: `Membatalkan reminder nomor ${number}...`
          };
          console.log('[WA] Fallback detected stop pattern:', text, '→', fallbackParsed);
          break;
        }
      }
    }

    // run AI extraction (unless fallback already handled it)
    const parsed = fallbackParsed || await ai.extract({
      text,
      userProfile: { username },
      sessionContext: ctx
    });
    console.log('[WA] AI parsed:', parsed);

    // Helper: quick send
    const replyToUser = async (msg) => {
      if (!msg) return;
      await sendMessage(fromPhone, msg, null);
    };

    // Special commands via AI intents
    if (parsed.intent === 'cancel_keyword' && parsed.cancelKeyword) {
      // list reminders that match keyword
      const list = await Reminder.findAll({
        where: { UserId: user.id, status: 'scheduled' },
        order: [['dueAt', 'ASC']]
      });
      const filtered = list.filter(r => (r.title || '').toLowerCase().includes(parsed.cancelKeyword.toLowerCase()));
      if (!filtered.length) {
        await replyToUser(`Tidak ada reminder aktif yang mengandung "${parsed.cancelKeyword}" 😊`);
        return res.status(200).json({ ok: true });
      }
      // keep ids in session for stop(n)
      const ids = filtered.map(r => r.id);
      sessionStore.setContext(fromPhone, { ...ctx, lastListedIds: ids });

      const lines = filtered.slice(0, 10).map((r, i) => {
        const wib = toWIBISOString(r.dueAt);
        const hm = dayjs(wib).format('ddd, DD/MM HH.mm');
        return `${i+1}. ${r.title} — ${hm} WIB`;
      });
      lines.push('Ketik: Nomor Reminder Aktif untuk membatalkan salah satunya.');
      await replyToUser(`Berikut pengingat aktif terkait "${parsed.cancelKeyword}":\n` + lines.join('\n'));
      return res.status(200).json({ ok: true });
    }

    if (parsed.intent === 'stop_number' && Number.isInteger(parsed.stopNumber)) {
      const listIds = Array.isArray(ctx.lastListedIds) ? ctx.lastListedIds : [];
      const idx = parsed.stopNumber - 1;
      if (!(idx >= 0 && idx < listIds.length)) {
        await replyToUser('Nomornya kurang pas nih 😅 Coba cek lagi daftar reminder-nya ya.');
        return res.status(200).json({ ok: true });
      }
      const reminder = await Reminder.findOne({ where: { id: listIds[idx], UserId: user.id } });
      if (!reminder) {
        await replyToUser('Data pengingatnya sudah tidak ada. Coba daftar ulang ya 😊');
        return res.status(200).json({ ok: true });
      }
      
      // Cancel reminder (this will update status to 'cancelled' in database)
      await cancelReminder(reminder.id);
      
      sessionStore.setContext(fromPhone, { ...ctx, lastListedIds: [] });
      await replyToUser(`✅ Reminder nomor ${parsed.stopNumber} (${reminder.title}) sudah dibatalkan.`);
      return res.status(200).json({ ok: true });
    }

    if (parsed.intent === 'list') {
      const list = await Reminder.findAll({
        where: { UserId: user.id, status: 'scheduled' },
        order: [['dueAt', 'ASC']]
      });
      if (!list.length) {
        await replyToUser('Belum ada reminder aktif 😊');
        return res.status(200).json({ ok: true });
      }
      const ids = list.slice(0, 10).map(r => r.id);
      sessionStore.setContext(fromPhone, { ...ctx, lastListedIds: ids });
      const lines = list.slice(0, 10).map((r, i) => {
        const wib = toWIBISOString(r.dueAt);
        const hm = dayjs(wib).format('ddd, DD/MM HH.mm');
        return `${i+1}. ${r.title} — ${hm} WIB`;
      });
      lines.push('Ketik: Nomor Reminder Aktif untuk membatalkan salah satu. Atau filter: `--reminder <kata>`');
      await replyToUser('Daftar reminder aktif:\n' + lines.join('\n'));
      return res.status(200).json({ ok: true });
    }

    // Reminder creation flows
    if (parsed.intent === 'create' && parsed.title) {
      
      // Handle repeat reminders without specific start time
      if (parsed.repeat !== 'none' && !parsed.dueAtWIB) {
        // For repeat reminders, start immediately or use default timing
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

        const reminder = await Reminder.create({
          UserId: user.id,
          RecipientId: user.id,
          title: parsed.title.trim(),
          dueAt: dueAtUTC,
          repeat: parsed.repeat || 'none',
          repeatType: parsed.repeat || 'once',
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
        `Halo ${username}, waktunya ${parsed.title.trim()}! �`;

      const reminder = await Reminder.create({
        UserId: user.id,
        RecipientId: user.id,
        title: parsed.title.trim(),
        dueAt: dueAtUTC,
        repeat: parsed.repeat || 'none',
        repeatType: parsed.repeat || 'once',
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
