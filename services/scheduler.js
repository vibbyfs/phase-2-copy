const schedule = require('node-schedule');
const { Op } = require('sequelize');
const { User, Reminder, ReminderRecipient } = require('../models');
const { sendMessage } = require('./waOutbound');
const ai = require('./ai');

const jobs = new Map(); // reminderId -> schedule.Job

function wibTs(date) {
  const d = new Date(date);
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(d);
}

/**
 * Build final message string:
 * - Prioritaskan formattedMessage dari DB bila ada.
 * - Ganti placeholder {RECIPIENT_NAME} dan {AI_MOTIVATIONAL} bila muncul.
 * - Jika tidak ada formattedMessage, generate via AI (sekali).
 */
async function buildMessage({ baseMessage, title, username, kind = 'reminder_delivery' }) {
  const safeTitle = String(title || 'pengingat').trim();
  const name = username ? String(username).trim() : 'kamu';

  // Jika ada template dari DB
  if (baseMessage && typeof baseMessage === 'string') {
    let msg = baseMessage;

    // {RECIPIENT_NAME}
    if (msg.includes('{RECIPIENT_NAME}')) {
      msg = msg.replace(/{RECIPIENT_NAME}/g, name);
    }

    // {AI_MOTIVATIONAL}
    if (msg.includes('{AI_MOTIVATIONAL}')) {
      try {
        const motivational = await ai.generateReply({
          kind: 'motivational_reminder',
          username: name,
          title: safeTitle,
          context: `Pesan pengingat personal dan memotivasi dalam Bahasa Indonesia untuk aktivitas "${safeTitle}".`
        });
        msg = msg.replace('{AI_MOTIVATIONAL}', motivational || 'Semangat ya! ✨');
      } catch (e) {
        msg = msg.replace('{AI_MOTIVATIONAL}', 'Semangat ya! ✨');
      }
    }

    return msg.trim();
  }

  // Tanpa template → minta AI sekali
  try {
    const generated = await ai.generateReply({
      kind,
      username: name,
      title: safeTitle,
      context: `Buat pesan pengingat personal dan memotivasi (Bahasa Indonesia) yang ringkas untuk "${safeTitle}".`
    });
    return (generated && generated.trim())
      ? generated.trim()
      : `Halo ${name}, ini pengingatmu untuk "${safeTitle}". Semoga harimu lancar ya ✨🙏`;
  } catch (err) {
    return `Halo ${name}, ini pengingatmu untuk "${safeTitle}". Semoga harimu lancar ya ✨🙏`;
  }
}

async function fireReminder(reminderId) {
  try {
    const reminder = await Reminder.findByPk(reminderId, {
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['id', 'username', 'phone']
        },
        {
          model: ReminderRecipient,
          as: 'reminderRecipients',
          where: { status: 'scheduled' },
          required: false,
          include: [
            {
              model: User,
              as: 'recipient',
              attributes: ['id', 'username', 'phone']
            }
          ]
        }
      ]
    });

    if (!reminder || reminder.status !== 'scheduled') return;

    const title = reminder.title || 'pengingat';
    let sentCount = 0;

    // MULTI-RECIPIENT
    if (Array.isArray(reminder.reminderRecipients) && reminder.reminderRecipients.length > 0) {
      for (const rr of reminder.reminderRecipients) {
        try {
          const recipient = rr.recipient;
          const to = recipient?.phone ? String(recipient.phone) : null;
          if (!to) continue;

          const msg = await buildMessage({
            baseMessage: reminder.formattedMessage,
            title,
            username: recipient.username,
            kind: 'motivational_reminder'
          });

          await sendMessage(to, String(msg || '').trim(), reminder.id);

          await ReminderRecipient.update(
            { status: 'sent', sentAt: new Date() },
            { where: { ReminderId: reminder.id, RecipientId: rr.RecipientId } }
          );

          sentCount += 1;
        } catch (sendErr) {
          // Tandai recipient ini gagal, jangan hentikan loop
          await ReminderRecipient.update(
            { status: 'cancelled' },
            { where: { ReminderId: reminder.id, RecipientId: rr.RecipientId } }
          ).catch(() => {});
          console.error('[SCHED] Failed to send to a recipient:', sendErr?.message || sendErr);
        }
      }
    } else {
      // SINGLE-RECIPIENT (legacy)
      // Gunakan RecipientId bila ada; kalau tidak, jatuhkan ke pembuat (user)
      const singleUserId = reminder.RecipientId || reminder.UserId;
      let user = null;
      if (reminder.RecipientId && reminder.user && reminder.user.id === reminder.RecipientId) {
        // Jarang terjadi; jaga-jaga bila association diset aneh
        user = reminder.user;
      } else if (!reminder.RecipientId && reminder.user) {
        user = reminder.user;
      } else {
        user = await User.findByPk(singleUserId, { attributes: ['id', 'username', 'phone'] });
      }

      const to = user?.phone ? String(user.phone) : null;
      if (to) {
        const msg = await buildMessage({
          baseMessage: reminder.formattedMessage,
          title,
          username: user.username,
          kind: 'reminder_delivery'
        });

        await sendMessage(to, String(msg || '').trim(), reminder.id);
        sentCount = 1;
      }
    }

    // Update status utama
    await Reminder.update({ status: 'sent' }, { where: { id: reminder.id } });

    // Jika recurring → buat occurrence berikutnya
    if (reminder.isRecurring && reminder.repeatType !== 'once') {
      const nextDate = calculateNextRepeatDate(reminder);
      if (nextDate) {
        const nextReminder = await Reminder.create({
          title: reminder.title,
          content: reminder.content,
          dueAt: nextDate,
          UserId: reminder.UserId,
          RecipientId: reminder.RecipientId, // legacy
          repeat: reminder.repeat,
          repeatType: reminder.repeatType,
          repeatInterval: reminder.repeatInterval,
          repeatEndDate: reminder.repeatEndDate,
          parentReminderId: reminder.parentReminderId || reminder.id,
          isRecurring: true,
          status: 'scheduled',
          formattedMessage: reminder.formattedMessage
        });

        if (Array.isArray(reminder.reminderRecipients) && reminder.reminderRecipients.length > 0) {
          const nextRR = reminder.reminderRecipients.map(r => ({
            ReminderId: nextReminder.id,
            RecipientId: r.RecipientId,
            status: 'scheduled'
          }));
          if (nextRR.length) {
            await ReminderRecipient.bulkCreate(nextRR);
          }
        }

        scheduleReminder(nextReminder);
        console.log('[SCHED] next occurrence', {
          originalId: reminder.id,
          nextId: nextReminder.id,
          nextDate: nextDate.toISOString()
        });
      }
    }

    console.log(`[SCHED] Fired reminder ${reminderId} to ${sentCount} recipient(s)`);
  } catch (err) {
    console.error('[SCHED] fire error', err);
    try { await Reminder.update({ status: 'failed' }, { where: { id: reminderId } }); } catch (_) {}
  } finally {
    const job = jobs.get(reminderId);
    if (job) job.cancel();
    jobs.delete(reminderId);
  }
}

/**
 * Perhitungan sederhana next occurrence berdasarkan dueAt:
 * minutes/hours/daily/weekly/monthly/yearly
 * (AI/Controller sudah memastikan dueAt awal sesuai pola user)
 */
function calculateNextRepeatDate(reminder) {
  const currentDate = new Date(reminder.dueAt);
  const now = new Date();

  if (reminder.repeatEndDate && now > new Date(reminder.repeatEndDate)) return null;

  const nextDate = new Date(currentDate);

  switch (reminder.repeatType) {
    case 'minutes':
      nextDate.setMinutes(nextDate.getMinutes() + (reminder.repeatInterval || 30));
      break;
    case 'hours':
      nextDate.setHours(nextDate.getHours() + (reminder.repeatInterval || 1));
      break;
    case 'daily':
      nextDate.setDate(nextDate.getDate() + 1);
      break;
    case 'weekly':
      nextDate.setDate(nextDate.getDate() + 7);
      break;
    case 'monthly':
      nextDate.setMonth(nextDate.getMonth() + 1);
      break;
    case 'yearly':
      nextDate.setFullYear(nextDate.getFullYear() + 1);
      break;
    default:
      return null;
  }

  if (reminder.repeatEndDate && nextDate > new Date(reminder.repeatEndDate)) return null;

  return nextDate;
}

function scheduleReminder(reminder) {
  try {
    const runAt = new Date(reminder.dueAt);
    if (Number.isNaN(runAt.getTime())) {
      console.warn('[SCHED] skip schedule, invalid date', { id: reminder.id, dueAt: reminder.dueAt });
      return;
    }

    const diff = runAt.getTime() - Date.now();
    console.log('[SCHED] schedule check', {
      id: reminder.id,
      runAt: runAt.toISOString(),
      now: new Date().toISOString(),
      diff
    });

    // Sedikit lewat ≤ 30 detik → langsung tembak
    if (diff <= 0 && diff >= -30000) {
      console.log('[SCHED] fire immediate (slightly overdue)', { id: reminder.id, at: runAt.toISOString(), atWIB: wibTs(runAt) });
      setTimeout(() => fireReminder(reminder.id), 100);
      return;
    }

    // Terlalu lewat → tidak dijadwalkan
    if (diff < -30000) {
      console.log('[SCHED] skip overdue', { id: reminder.id, at: runAt.toISOString(), overdueMs: Math.abs(diff) });
      return;
    }

    const job = schedule.scheduleJob(runAt, () => {
      console.log('[SCHED] fire job', { id: reminder.id, at: runAt.toISOString(), atWIB: wibTs(runAt) });
      fireReminder(reminder.id);
    });

    jobs.set(reminder.id, job);
    console.log('[SCHED] create job', { id: reminder.id, runAt: runAt.toISOString(), runAtWIB: wibTs(runAt) });
  } catch (err) {
    console.error('[SCHED] schedule error', err);
  }
}

async function cancelReminder(reminderId) {
  try {
    const job = jobs.get(reminderId);
    if (job) job.cancel();
    jobs.delete(reminderId);
    await Reminder.update({ status: 'cancelled' }, { where: { id: reminderId } });
    console.log('[SCHED] cancelled', { id: reminderId });
  } catch (err) {
    console.error('[SCHED] cancel error', err);
  }
}

async function loadAllScheduledReminders() {
  try {
    const since = new Date(Date.now() - 5 * 60 * 1000); // backfill 5 menit

    const rows = await Reminder.findAll({
      where: {
        status: 'scheduled',
        dueAt: { [Op.gte]: since }
      },
      order: [['dueAt', 'ASC']]
    });

    console.log('[SCHED] loaded', rows.length, 'reminders');

    const now = Date.now();
    for (const r of rows) {
      const runAt = new Date(r.dueAt);
      if (Number.isNaN(runAt.getTime())) continue;

      const diff = runAt.getTime() - now;

      if (diff <= 0 && diff >= -5 * 60 * 1000) {
        console.log('[SCHED] backfill fire', { id: r.id, at: runAt.toISOString(), atWIB: wibTs(runAt), overdueMs: Math.abs(diff) });
        setTimeout(() => fireReminder(r.id), 100);
      } else if (diff > 0) {
        scheduleReminder(r);
      } else {
        console.log('[SCHED] skip old reminder', { id: r.id, at: runAt.toISOString(), overdueMs: Math.abs(diff) });
      }
    }

    console.log('[SCHED] loaded at startup');
  } catch (err) {
    console.error('Scheduler init error', err);
  }
}

module.exports = {
  scheduleReminder,
  cancelReminder,
  loadAllScheduledReminders
};
