// controllers/waController.js (CommonJS)
// Twilio webhook + conversational AI flow (natural replies + deterministic actions)

const { DateTime } = require('luxon');
const { Op } = require('sequelize');
const { User, Reminder } = require('../models');

const { extract, generateReply, WIB_TZ } = require('../services/ai');
const { scheduleReminder, cancelReminder } = require('../services/scheduler');
const session = require('../services/session');
const { sendMessage } = require('../services/waOutbound');

async function sendResponseTwilio(res, text) {
  // Kita aktif kirim via Twilio API (sendMessage) lalu balas TwiML kosong
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

function humanTimeDescription(dueDateWIB, nowWIB) {
  const diffMin = Math.round(dueDateWIB.diff(nowWIB, 'minutes').minutes);
  if (diffMin < 60 && diffMin >= 0) return `${diffMin} menit lagi`;
  if (diffMin < 24 * 60 && diffMin >= 0) {
    const hours = Math.round(diffMin / 60);
    return `${hours} jam lagi`;
  }
  if (dueDateWIB.hasSame(nowWIB, 'day')) {
    return `hari ini jam ${dueDateWIB.toFormat('HH:mm')} WIB`;
  }
  if (dueDateWIB.hasSame(nowWIB.plus({ days: 1 }), 'day')) {
    return `besok jam ${dueDateWIB.toFormat('HH:mm')} WIB`;
  }
  return dueDateWIB.toFormat('dd/LL/yyyy HH:mm') + ' WIB';
}

async function handleList(user, phone, keyword = null) {
  const where = {
    UserId: user.id,
    status: 'scheduled',
  };
  if (keyword) where.title = { [Op.iLike]: `%${keyword}%` };

  const items = await Reminder.findAll({
    where,
    order: [['dueAt', 'ASC']],
    limit: 10,
  });

  session.setListCache(phone, items, keyword || null);

  if (!items.length) {
    const msg = keyword
      ? `Tidak ada pengingat aktif yang mengandung "${keyword}" ya.`
      : 'Tidak ada pengingat aktif saat ini.';
    await sendMessage(phone, msg, null);
    return;
  }

  let text = keyword
    ? `Berikut pengingat aktif terkait "${keyword}":\n`
    : `📋 Daftar pengingat aktif (${items.length}):\n`;

  items.forEach((r, i) => {
    const w = DateTime.fromJSDate(r.dueAt).setZone(WIB_TZ);
    const rep = r.repeat !== 'none' ? ` (${r.repeat})` : '';
    text += `${i + 1}. ${r.title} – ${w.toFormat('ccc, dd/LL HH:mm')} WIB${rep}\n`;
  });
  text += `\nKetik: stop (1) untuk membatalkan salah satunya.`;

  await sendMessage(phone, text, null);
}

async function cancelByNumber(user, phone, numStr) {
  const s = session.get(phone);
  let list = s.lastListCache;

  if (!list || !list.length) {
    // fallback ke semua active
    list = await Reminder.findAll({
      where: { UserId: user.id, status: 'scheduled' },
      order: [['dueAt', 'ASC']],
      limit: 10,
    });
    session.setListCache(phone, list, null);
  }

  const idx = parseInt(numStr, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= list.length) {
    await sendMessage(phone, 'Nomornya kurang pas nih 😅 Coba cek lagi daftar reminder-nya ya.', null);
    return;
  }

  const target = list[idx];
  target.status = 'cancelled';
  await target.save();
  cancelReminder(target.id);

  const text = `✅ Reminder nomor ${idx + 1} (${target.title}) sudah dibatalkan.`;
  await sendMessage(phone, text, null);
}

module.exports = {
  inbound: async (req, res) => {
    try {
      // Twilio webhook
      const isTwilio = !!(req.body && req.body.From && req.body.Body);
      const from = isTwilio ? req.body.From.replace('whatsapp:', '') : (req.body.from || '').replace('whatsapp:', '');
      const text = isTwilio ? req.body.Body : req.body.text;

      if (!from || !text) {
        console.log('[WA] Invalid request', { from, text });
        return res.status(400).json({ error: 'Missing fields' });
      }

      console.log('[WA] inbound from:', from, 'text:', text);

      // Find user
      const user = await User.findOne({ where: { phone: from } });
      if (!user) {
        await sendMessage(from, 'Nomormu belum terdaftar. Daftar dulu ya 😊', null);
        return sendResponseTwilio(res, '');
      }

      // Init session state
      const s = session.get(from);
      if (!s.userName) session.set(from, { userName: user.name || user.username || null });

      // --- Extract via AI ---
      const ai = await extract(text, s);
      const reply = ai.reply || null;
      const action = ai.action || { type: 'none' };

      // Always send the conversational reply first (natural, non-template)
      if (reply) {
        await sendMessage(from, reply, null);
      }

      // Handle actions deterministically
      const nowWIB = DateTime.now().setZone(WIB_TZ);

      switch (action.type) {
        case 'cancel_all': {
          const all = await Reminder.findAll({ where: { UserId: user.id, status: 'scheduled' } });
          for (const r of all) {
            r.status = 'cancelled';
            await r.save();
            cancelReminder(r.id);
          }
          await sendMessage(from, `✅ Semua ${all.length} pengingat aktif dibatalkan.`, null);
          break;
        }

        case 'cancel': {
          // Only recurring
          const list = await Reminder.findAll({
            where: { UserId: user.id, status: 'scheduled', repeat: { [Op.ne]: 'none' } },
          });
          if (!list.length) {
            await sendMessage(from, 'Tidak ada pengingat berulang yang aktif.', null);
            break;
          }
          for (const r of list) {
            r.status = 'cancelled';
            await r.save();
            cancelReminder(r.id);
          }
          await sendMessage(from, `✅ ${list.length} pengingat berulang dibatalkan.`, null);
          break;
        }

        case 'cancel_keyword': {
          const keyword = (action.cancelKeyword || '').trim();
          await handleList(user, from, keyword);
          break;
        }

        case 'stop_number': {
          await cancelByNumber(user, from, action.stopNumber);
          break;
        }

        case 'list': {
          await handleList(user, from, null);
          break;
        }

        case 'need_time': {
          // store pending title
          const title = (action.title || '').trim();
          if (title) session.set(from, { pendingTitle: title });
          // The reply already asked the time.
          break;
        }

        case 'need_content': {
          // store pending dueAt
          const dueAtWIB = action.dueAtWIB ? DateTime.fromISO(action.dueAtWIB) : null;
          if (dueAtWIB && dueAtWIB.isValid) {
            session.set(from, { pendingDueAtWIB: dueAtWIB.toISO() });
          }
          // The reply already asked the content.
          break;
        }

        case 'potential_reminder': {
          // store possible title
          const title = (action.title || '').trim();
          if (title) session.set(from, { pendingTitle: title });
          break;
        }

        case 'create': {
          // Determine title
          let title = (action.title || '').trim();
          if (!title && s.pendingTitle) title = s.pendingTitle;

          // Determine dueAt
          let dueAtWIB = action.dueAtWIB ? DateTime.fromISO(action.dueAtWIB) : null;
          if ((!dueAtWIB || !dueAtWIB.isValid) && s.pendingDueAtWIB) {
            const tmp = DateTime.fromISO(s.pendingDueAtWIB);
            if (tmp.isValid) dueAtWIB = tmp;
          }

          // As a fallback, if still no dueAt -> ask again (safety)
          if (!dueAtWIB || !dueAtWIB.isValid) {
            const ask = await generateReply('ask_time', { title: title || 'pengingat' });
            await sendMessage(from, ask, null);
            session.set(from, { pendingTitle: title || null });
            break;
          }

          // If dueAt has passed, ask reschedule
          const dueWIB = dueAtWIB.setZone(WIB_TZ);
          if (dueWIB <= nowWIB) {
            const ask = await generateReply('time_passed', { title: title || 'pengingat' });
            await sendMessage(from, ask, null);
            // keep pending
            session.set(from, { pendingTitle: title || null, pendingDueAtWIB: null });
            break;
          }

          // Repeat handling
          const repeat = action.repeat || 'none';
          const repeatDetails = action.repeatDetails || {};

          // Create reminder
          const reminder = await Reminder.create({
            UserId: user.id,
            RecipientId: user.id,
            title: title || 'Pengingat',
            dueAt: dueWIB.toUTC().toJSDate(),
            repeat,
            status: 'scheduled',
            formattedMessage: null, // generated at send-time by AI
          });

          // Schedule
          scheduleReminder(reminder);

          // Confirm to user (one-liner AI)
          const timeText = humanTimeDescription(dueWIB, nowWIB);
          const confirm = await generateReply('confirm', {
            userName: user.name || user.username || 'kamu',
            title: title || 'Pengingat',
            timeText,
            repeat,
          });
          await sendMessage(from, confirm, null);

          // clear pending
          session.clearPending(from);
          break;
        }

        case 'none':
        default:
          // nothing more to do
          break;
      }

      return sendResponseTwilio(res, '');
    } catch (err) {
      console.error('[WA Controller] Fatal error:', err);
      if (req && req.body && req.body.From && req.body.Body) {
        try {
          await sendMessage(req.body.From.replace('whatsapp:', ''), 'Maaf, bisa dijelaskan lagi ya? 🙂', null);
        } catch (_) {}
        return sendResponseTwilio(res, '');
      }
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
};
