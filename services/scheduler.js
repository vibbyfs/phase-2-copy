// services/scheduler.js (CommonJS) — setTimeout based + rehydrate on boot
'use strict';

const { DateTime } = require('luxon');
const { Reminder, User } = require('../models');
const { sendReminder } = require('./waOutbound');

const WIB_TZ = 'Asia/Jakarta';
const jobs = new Map(); // reminderId -> Timeout

function clearJob(reminderId) {
  const t = jobs.get(reminderId);
  if (t) {
    clearTimeout(t);
    jobs.delete(reminderId);
  }
}

function nextDue(dueAt, repeat) {
  const d = DateTime.fromJSDate(dueAt).setZone(WIB_TZ);
  if (repeat === 'hourly')  return d.plus({ hours: 1 }).toJSDate();
  if (repeat === 'daily')   return d.plus({ days: 1 }).toJSDate();
  if (repeat === 'weekly')  return d.plus({ weeks: 1 }).toJSDate();
  if (repeat === 'monthly') return d.plus({ months: 1 }).toJSDate();
  return null;
}

async function fireReminder(reminder) {
  try {
    console.log('[SCHED] fire job', { id: reminder.id, at: new Date().toISOString() });

    const recipient = await User.findByPk(reminder.RecipientId);
    if (recipient) {
      const phone = recipient.phone;
      const name  = recipient.name || recipient.username || 'kamu';

      const text = reminder.formattedMessage
        || `Halo ${name}, ini pengingatmu untuk '${reminder.title}'. Semoga harimu lancar ya ✨🙏`;

      await sendReminder(phone, text, reminder.id);
    } else {
      console.warn('[SCHED] recipient not found for reminder', reminder.id);
    }

    if (reminder.repeat && reminder.repeat !== 'none') {
      const next = nextDue(reminder.dueAt, reminder.repeat);
      if (next) {
        reminder.dueAt = next;
        await reminder.save();
        scheduleReminder(reminder); // reschedule
      } else {
        reminder.status = 'sent';
        await reminder.save();
        clearJob(reminder.id);
      }
    } else {
      reminder.status = 'sent';
      await reminder.save();
      clearJob(reminder.id);
    }
  } catch (err) {
    console.error('[SCHED] error firing job', reminder?.id, err);
    clearJob(reminder?.id);
  }
}

function scheduleReminder(reminder) {
  try {
    if (!reminder || !reminder.dueAt) return;
    clearJob(reminder.id);

    const now = DateTime.utc();
    const due = DateTime.fromJSDate(reminder.dueAt).toUTC();
    let delay = Math.max(0, due.diff(now, 'milliseconds').milliseconds);

    // antisipasi jika due sudah lewat sedikit: jalankan +5s
    if (delay === 0) delay = 5000;

    console.log('[SCHED] create job', { id: reminder.id, runAt: reminder.dueAt.toISOString() });
    const t = setTimeout(() => fireReminder(reminder), delay);
    jobs.set(reminder.id, t);
  } catch (err) {
    console.error('[SCHED] schedule error', err);
  }
}

/**
 * Rehydrate semua reminder 'scheduled' saat app start/restart.
 * - Jika dueAt sudah lewat: 
 *    - recurring → geser ke next occurrence sampai > now
 *    - one-shot → jadwalkan +5 detik dari sekarang
 */
async function loadAllScheduledReminders() {
  try {
    const nowUTC = DateTime.utc();
    const reminders = await Reminder.findAll({
      where: { status: 'scheduled' },
      order: [['dueAt', 'ASC']],
    });

    let scheduled = 0;

    for (const r of reminders) {
      if (!r.dueAt || isNaN(new Date(r.dueAt).getTime())) continue;

      let due = DateTime.fromJSDate(r.dueAt).toUTC();

      if (due <= nowUTC.minus({ seconds: 2 })) {
        if (r.repeat && r.repeat !== 'none') {
          let guard = 0;
          while (due <= nowUTC && guard < 100) {
            const next = nextDue(due.toJSDate(), r.repeat);
            if (!next) break;
            due = DateTime.fromJSDate(next).toUTC();
            guard++;
          }
          r.dueAt = due.toJSDate();
          await r.save();
        } else {
          r.dueAt = nowUTC.plus({ seconds: 5 }).toJSDate();
          await r.save();
        }
      }

      scheduleReminder(r);
      scheduled++;
    }

    console.log(`[SCHED] rehydrated ${scheduled} reminders`);
    return scheduled;
  } catch (err) {
    console.error('[SCHED] loadAllScheduledReminders error', err);
    return 0;
  }
}

function cancelReminder(reminderId) {
  clearJob(reminderId);
  console.log('[SCHED] cancel job', { id: reminderId });
}

module.exports = {
  scheduleReminder,
  cancelReminder,
  loadAllScheduledReminders,
};
