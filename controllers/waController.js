const { User, Reminder, ReminderRecipient } = require('../models');
const { scheduleReminder, cancelReminder } = require('../services/scheduler');
const sessionStore = require('../services/session');
const { sendMessage } = require('../services/waOutbound');
const ai = require('../services/ai');
const {
  parseUsernamesFromMessage,
  validateAndGetRecipients,
  generateMultiRecipientMessage,
} = require('../helpers/multiRecipient');

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

// ---- Helpers ----
function parseISOToUTC(isoString) {
  if (!isoString) return null;
  try {
    const dt = dayjs(isoString);
    return dt.utc().toDate();
  } catch (err) {
    console.error('[parseISOToUTC] Invalid date:', isoString, err?.message || err);
    return null;
  }
}

function humanWhen(isoString) {
  if (!isoString) return null;
  try {
    const dt = dayjs(isoString).tz('Asia/Jakarta');
    const now = dayjs().tz('Asia/Jakarta');
    const diffMin = dt.diff(now, 'minute');
    if (diffMin < 1) return 'sekarang';
    if (diffMin < 60) return `${diffMin} menit lagi`;
    if (diffMin < 1440) {
      const hours = Math.floor(diffMin / 60);
      const mins = diffMin % 60;
      if (mins === 0) return `${hours} jam lagi`;
      return `${hours} jam ${mins} menit lagi`;
    }
    return dt.format('DD MMM, HH.mm');
  } catch {
    return null;
  }
}

function asStringPhone(phone) {
  if (!phone) return '';
  return String(phone);
}

async function reply(toPhone, text) {
  try {
    await sendMessage(asStringPhone(toPhone), text, null);
  } catch (e) {
    console.error('[WAOutbound] Gagal kirim:', e?.message || e);
  }
}

// ---- Controller ----
async function inbound(req, res) {
  const fromPhone = (req.body?.From || '').replace('whatsapp:', '');
  const text = (req.body?.Body || '').trim();
  console.log(`[WA] inbound from: ${fromPhone} text: ${text}`);

  if (!fromPhone || !text) {
    return res.status(200).json({ ok: true });
  }

  try {
    // 1) User lookup
    const user = await User.findOne({ where: { phone: fromPhone } });
    if (!user) {
      await reply(fromPhone, 'Halo! Sepertinya kamu belum terdaftar. Yuk daftar dulu biar aku bisa bantu bikin pengingat 😊');
      return res.status(200).json({ ok: true });
    }

    const username = user.username || 'kamu';
    const ctx = sessionStore.getContext(fromPhone) || {};

    // 2) AI extraction
    let parsed = await ai.extract({
      text,
      userProfile: { username },
      sessionContext: ctx
    });
    console.log('[WA] AI parsed:', parsed);

    // 2a) Fallback parsing @username jika AI miss
    if ((!parsed.recipientUsernames || parsed.recipientUsernames.length === 0) && text.includes('@')) {
      try {
        const fallback = parseUsernamesFromMessage && parseUsernamesFromMessage(text);
        let usernames = [];
        if (Array.isArray(fallback)) usernames = fallback;
        else if (fallback && Array.isArray(fallback.usernames)) usernames = fallback.usernames;

        if (usernames.length > 0) {
          parsed.recipientUsernames = usernames;
          // Jika helper mengembalikan "cleaned" dan AI tidak punya title, gunakan cleaned
          if (!parsed.title && fallback && typeof fallback.cleaned === 'string' && fallback.cleaned.trim()) {
            parsed.title = fallback.cleaned.trim();
          }
        }
      } catch (e) {
        console.warn('[WA] Fallback mention parse warning:', e?.message || e);
      }
    }

    // 3) INTENT: create
    if (parsed.intent === 'create' && parsed.title) {
      // 3a) Validasi @recipients (opsional multi-recipient)
      let recipientUsers = [];
      if (parsed.recipientUsernames && parsed.recipientUsernames.length > 0) {
        const validation = await validateAndGetRecipients(user.id, parsed.recipientUsernames);
        const errors = [];
        if (validation.invalidUsernames.length > 0) {
          errors.push(`Username tidak ditemukan: ${validation.invalidUsernames.join(', ')}`);
        }
        if (validation.notFriends.length > 0) {
          errors.push(`Kamu belum berteman dengan: ${validation.notFriends.join(', ')}`);
        }
        if (errors.length > 0) {
          await reply(fromPhone, `❌ ${errors.join('\n')}\n\nCoba cek lagi ejaan atau pastikan sudah berteman ya 😊`);
          return res.status(200).json({ ok: true });
        }
        recipientUsers = validation.validUsers || [];
      }

      // 3b) CASE A: Repeat sederhana tanpa dueAt spesifik → set start time
      if (parsed.repeat && parsed.repeat !== 'none' && parsed.timeType !== 'relative' && !parsed.dueAtWIB) {
        let startUTC = new Date(Date.now() + 60 * 1000); // default mulai 1 menit dari sekarang
        if (parsed.repeat === 'daily' || parsed.repeat === 'weekly' || parsed.repeat === 'monthly' || parsed.repeat === 'yearly') {
          const tod = parsed.repeatDetails?.timeOfDay || '09:00';
          const [hh, mm] = tod.split(':').map(n => parseInt(n, 10) || 0);
          const nowWIB = dayjs().tz('Asia/Jakarta');
          let target = nowWIB.hour(hh).minute(mm).second(0).millisecond(0);
          // jika sudah lewat untuk hari ini → geser ke esok/hari berikutnya
          if (target.isBefore(nowWIB)) {
            if (parsed.repeat === 'daily') target = target.add(1, 'day');
            else if (parsed.repeat === 'weekly') target = target.add(1, 'week');
            else if (parsed.repeat === 'monthly') target = target.add(1, 'month');
            else if (parsed.repeat === 'yearly') target = target.add(1, 'year');
          }
          startUTC = target.utc().toDate();
          console.log('[WA] Repeat-only startUTC:', startUTC.toISOString());
        }

        // siapkan base message
        let baseMsg = await ai.generateReply({
          kind: 'reminder_delivery',
          username,
          title: parsed.title.trim(),
          context: 'Pesan pengingat hangat, natural, motivasional (Indonesia).'
        });
        if (!baseMsg) baseMsg = `Halo ${username}, waktunya ${parsed.title.trim()}! ✨`;

        // map repeat ke DB
        let dbRepeat = 'none';
        let dbRepeatType = 'once';
        if (parsed.repeat === 'minutes') { dbRepeatType = 'minutes'; }
        else if (parsed.repeat === 'hours') { dbRepeat = 'hourly'; dbRepeatType = 'hours'; }
        else if (parsed.repeat === 'daily') { dbRepeat = 'daily'; dbRepeatType = 'daily'; }
        else if (parsed.repeat === 'weekly') { dbRepeat = 'weekly'; dbRepeatType = 'weekly'; }
        else if (parsed.repeat === 'monthly') { dbRepeat = 'monthly'; dbRepeatType = 'monthly'; }
        else if (parsed.repeat === 'yearly') { dbRepeat = 'yearly'; dbRepeatType = 'yearly'; }

        const reminder = await Reminder.create({
          UserId: user.id,
          RecipientId: recipientUsers.length > 0 ? null : user.id,
          title: parsed.title.trim(),
          dueAt: startUTC,
          repeat: dbRepeat,
          repeatType: dbRepeatType,
          repeatInterval: parsed.repeatDetails?.interval || null,
          repeatEndDate: parsed.repeatDetails?.endDate ? new Date(parsed.repeatDetails.endDate) : null,
          isRecurring: parsed.repeat !== 'none',
          status: 'scheduled',
          formattedMessage: recipientUsers.length > 0
            ? generateMultiRecipientMessage(baseMsg, recipientUsers, user)
            : baseMsg
        });

        if (recipientUsers.length > 0) {
          await ReminderRecipient.bulkCreate(
            recipientUsers.map(r => ({ ReminderId: reminder.id, RecipientId: r.id, status: 'scheduled' }))
          );
        }

        await scheduleReminder(reminder);
        sessionStore.setContext(fromPhone, { lastListedIds: [] });

        const intervalText = parsed.repeatDetails?.interval
          ? `setiap ${parsed.repeatDetails.interval} ${parsed.repeat === 'minutes' ? 'menit' : 'jam'}`
          : `setiap ${parsed.repeat === 'daily' ? 'hari' :
                    parsed.repeat === 'weekly' ? 'minggu' :
                    parsed.repeat === 'monthly' ? 'bulan' : 'tahun'}`;

        const confirm =
          recipientUsers.length > 0
            ? `✅ Beres! Pengingat "${parsed.title}" ke ${recipientUsers.map(u => '@' + u.username).join(' ')} dibuat ${intervalText}.`
            : `✅ Siap, ${username}! Aku akan ingatkan "${parsed.title}" ${intervalText}.`;

        await reply(fromPhone, confirm);
        return res.status(200).json({ ok: true });
      }

      // 3c) CASE B: Reminder sekali / ada dueAt (relative/absolute)
      if (parsed.dueAtWIB) {
        const dueAtUTC = parseISOToUTC(parsed.dueAtWIB);
        if (!dueAtUTC) {
          await reply(fromPhone, 'Jamnya belum kebaca dengan jelas nih 😅 Kamu mau diingatkan jam berapa?');
          return res.status(200).json({ ok: true });
        }

        // Toleransi 30 detik untuk relative
        const toleranceMs = parsed.timeType === 'relative' ? 30000 : 0;
        const guardNow = new Date(Date.now() - toleranceMs);
        if (dayjs(dueAtUTC).isBefore(dayjs(guardNow))) {
          console.log('[WA] Reject past due:', dueAtUTC.toISOString(), 'vs', guardNow.toISOString());
          await reply(fromPhone, 'Waktunya sudah lewat nih 😅 Mau pilih waktu lain?');
          return res.status(200).json({ ok: true });
        }

        let baseMsg = await ai.generateReply({
          kind: 'reminder_delivery',
          username,
          title: parsed.title.trim(),
          context: 'Pesan pengingat hangat, natural, motivasional (Indonesia).'
        });
        if (!baseMsg) baseMsg = `Halo ${username}, waktunya ${parsed.title.trim()}! ✨`;

        // repeat mapping (default once)
        let dbRepeat = 'none';
        let dbRepeatType = 'once';
        if (parsed.repeat && parsed.repeat !== 'none') {
          if (parsed.repeat === 'minutes') { dbRepeatType = 'minutes'; }
          else if (parsed.repeat === 'hours') { dbRepeat = 'hourly'; dbRepeatType = 'hours'; }
          else if (parsed.repeat === 'daily') { dbRepeat = 'daily'; dbRepeatType = 'daily'; }
          else if (parsed.repeat === 'weekly') { dbRepeat = 'weekly'; dbRepeatType = 'weekly'; }
          else if (parsed.repeat === 'monthly') { dbRepeat = 'monthly'; dbRepeatType = 'monthly'; }
          else if (parsed.repeat === 'yearly') { dbRepeat = 'yearly'; dbRepeatType = 'yearly'; }
        }

        const reminder = await Reminder.create({
          UserId: user.id,
          RecipientId: parsed.recipientUsernames && parsed.recipientUsernames.length > 0 ? null : user.id,
          title: parsed.title.trim(),
          dueAt: dueAtUTC,
          repeat: dbRepeat,
          repeatType: dbRepeatType,
          repeatInterval: parsed.repeatDetails?.interval || null,
          repeatEndDate: parsed.repeatDetails?.endDate ? new Date(parsed.repeatDetails.endDate) : null,
          isRecurring: parsed.repeat !== 'none',
          status: 'scheduled',
          formattedMessage: (parsed.recipientUsernames && parsed.recipientUsernames.length > 0)
            ? generateMultiRecipientMessage(baseMsg, await (async () => {
                const v = await validateAndGetRecipients(user.id, parsed.recipientUsernames);
                return v.validUsers;
              })(), user)
            : baseMsg
        });

        // Buat recipients bila ada
        if (parsed.recipientUsernames && parsed.recipientUsernames.length > 0) {
          const validation = await validateAndGetRecipients(user.id, parsed.recipientUsernames);
          const list = validation.validUsers || [];
          if (list.length > 0) {
            await ReminderRecipient.bulkCreate(list.map(r => ({
              ReminderId: reminder.id, RecipientId: r.id, status: 'scheduled'
            })));
          }
        }

        await scheduleReminder(reminder);
        sessionStore.setContext(fromPhone, { lastListedIds: [] });

        const whenText = humanWhen(parsed.dueAtWIB) || 'nanti';
        const confirm =
          parsed.recipientUsernames && parsed.recipientUsernames.length > 0
            ? `✅ Siap! Pengingat "${parsed.title}" untuk ${parsed.recipientUsernames.map(u => '@' + u).join(' ')} dijadwalkan (${whenText}).`
            : `✅ Siap, ${username}! Aku akan ingatkan "${parsed.title}" ${whenText}.`;

        await reply(fromPhone, confirm);
        return res.status(200).json({ ok: true });
      }
    }

    // 4) INTENT: list
    if (parsed.intent === 'list') {
      const reminders = await Reminder.findAll({
        where: { UserId: user.id, status: 'scheduled' },
        include: [{
          model: ReminderRecipient,
          as: 'reminderRecipients',
          where: { status: 'scheduled' },
          required: false,
          include: [{ model: User, as: 'recipient', attributes: ['username'] }]
        }],
        order: [['dueAt', 'ASC']],
        limit: 10
      });

      if (reminders.length === 0) {
        await reply(fromPhone, 'Kamu belum punya pengingat aktif nih 😊 Mau bikin sekarang?');
        return res.status(200).json({ ok: true });
      }

      let listText = `📋 Pengingat aktif kamu (${reminders.length}):\n\n`;
      const listIds = [];
      reminders.forEach((r, idx) => {
        const n = idx + 1;
        listIds.push(r.id);
        const whenText = humanWhen(dayjs(r.dueAt).tz('Asia/Jakarta').format('YYYY-MM-DDTHH:mm:ss+07:00')) || 'nanti';
        const repeatText = r.isRecurring
          ? (
              r.repeatType === 'minutes' ? ` (setiap ${r.repeatInterval} menit)` :
              r.repeatType === 'hours'   ? ` (setiap ${r.repeatInterval} jam)`   :
              r.repeatType === 'daily'   ? ` (setiap hari)` :
              r.repeatType === 'weekly'  ? ` (setiap minggu)` :
              r.repeatType === 'monthly' ? ` (setiap bulan)` :
              r.repeatType === 'yearly'  ? ` (setiap tahun)` : ''
            )
          : '';
        let recipients = '';
        if (Array.isArray(r.reminderRecipients) && r.reminderRecipients.length > 0) {
          const names = r.reminderRecipients.map(rr => rr?.recipient?.username).filter(Boolean).join(', ');
          if (names) recipients = ` → ${names}`;
        }
        listText += `${n}. "${r.title}" - ${whenText}${repeatText}${recipients}\n`;
      });
      listText += `\n💡 Kirim angka (1-${reminders.length}) untuk batalkan salah satu.`;

      sessionStore.setContext(fromPhone, { ...ctx, lastListedIds: listIds });
      await reply(fromPhone, listText);
      return res.status(200).json({ ok: true });
    }

    // 5) INTENT: need_time / need_content / potential_reminder
    if (parsed.intent === 'need_time' && parsed.title) {
      sessionStore.setContext(fromPhone, { ...ctx, pendingTitle: parsed.title });
      await reply(fromPhone, parsed.reply || `Untuk "${parsed.title}", kamu mau diingatkan kapan?`);
      return res.status(200).json({ ok: true });
    }

    if (parsed.intent === 'need_content' && parsed.timeType) {
      sessionStore.setContext(fromPhone, { ...ctx, pendingTimeHint: true });
      await reply(fromPhone, parsed.reply || 'Noted jamnya! Kamu mau diingatkan tentang apa ya?');
      return res.status(200).json({ ok: true });
    }

    if (parsed.intent === 'potential_reminder') {
      if (parsed.title) {
        sessionStore.setContext(fromPhone, { ...ctx, pendingTitle: parsed.title });
      }
      await reply(fromPhone, parsed.reply || 'Mau aku bantu bikin pengingat untuk itu? 😊 Kalau iya, jam berapa?');
      return res.status(200).json({ ok: true });
    }

    // 6) INTENT: stop_number (batalkan dari list)
    if (parsed.intent === 'stop_number' && parsed.stopNumber) {
      const listed = ctx.lastListedIds || [];
      const idx = parsed.stopNumber - 1;
      if (idx < 0 || idx >= listed.length) {
        await reply(fromPhone, 'Nomornya belum cocok nih 😅 Coba kirim "list" lagi ya.');
        return res.status(200).json({ ok: true });
      }
      const remId = listed[idx];
      const rem = await Reminder.findByPk(remId, {
        include: [{
          model: ReminderRecipient,
          as: 'reminderRecipients',
          include: [{ model: User, as: 'recipient', attributes: ['username'] }]
        }]
      });
      if (!rem) {
        await reply(fromPhone, 'Reminder tidak ditemukan 😅');
        return res.status(200).json({ ok: true });
      }

      rem.status = 'cancelled';
      await rem.save();
      if (Array.isArray(rem.reminderRecipients) && rem.reminderRecipients.length > 0) {
        await ReminderRecipient.update({ status: 'cancelled' }, { where: { ReminderId: rem.id, status: 'scheduled' } });
      }
      await cancelReminder(rem.id);

      let msg = `✅ Reminder "${rem.title}" berhasil dibatalkan!`;
      if (Array.isArray(rem.reminderRecipients) && rem.reminderRecipients.length > 0) {
        const names = rem.reminderRecipients.map(rr => rr?.recipient?.username).filter(Boolean).join(', ');
        if (names) msg += ` (untuk ${names})`;
      }
      await reply(fromPhone, msg);
      sessionStore.setContext(fromPhone, { ...ctx, lastListedIds: [] });
      return res.status(200).json({ ok: true });
    }

    // 7) Unknown / small talk → conversational
    await reply(fromPhone, parsed.reply || 'Aku di sini buat bantu kamu tetap teratur. Mau bikin pengingat sekarang? 😊');
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[WA Controller] Fatal error:', err);
    await reply(fromPhone, 'Lagi ada kendala teknis kecil nih 😅 Coba ulang sebentar ya.');
    return res.status(200).json({ ok: true });
  }
}

module.exports = { inbound };
