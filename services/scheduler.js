// /services/scheduler.js  (CommonJS)
'use strict';

const { DateTime } = require('luxon');
const { Reminder, User } = require('../models');
const { sendReminder } = require('./waOutbound');

const WIB_TZ = 'Asia/Jakarta';
const jobs = new Map(); // reminderId -> timeout

function clearJob(reminderId) {
  const t = jobs.get(reminderId);
  if (t) {
    clearTimeout(t);
    jobs.delete(reminderId);
  }
}

/** Hitung due berikutnya untuk recurring */
function nextDue(dueAt, repeat) {
  const d = DateTime.fromJSDate(dueAt).setZone(WIB_TZ);
  if (repeat === 'hourly') return d.plus({ hours: 1 }).toJSDate();
  if (repeat === 'daily') return d.plus({ days: 1 }).toJSDate();
  if (repeat === 'weekly') return d.plus({ weeks: 1 }).toJSDate();
  if (repeat === 'monthly') return d.plus({ months: 1 }).toJSDate();
  return null;
}

/** Kirim reminder saat waktunya */
async function fireReminder(reminder) {
  try {
    console.log('[SCHED] fire job', { id: reminder.id, at: new Date().toISOString() });

    const recipient = await User.findByPk(reminder.RecipientId);
    if (!recipient) {
      console.warn('[SCHED] recipient not found for reminder', reminder.id);
    } else {
      const phone = recipient.phone;
      await sendReminder(
        phone,
        reminder.formattedMessage || `Halo ${recipient.name || 'kamu'}, ini pengingatmu untuk '${reminder.title}'.`,
        reminder.id
      );
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

/** Jadwalkan reminder (single atau recurring) */
function scheduleReminder(reminder) {
  try {
    clearJob(reminder.id);
    const now = DateTime.utc();
    const due = DateTime.fromJSDate(reminder.dueAt).toUTC();
    const delay = Math.max(0, due.diff(now, 'milliseconds').milliseconds);

    console.log('[SCHED] create job', { id: reminder.id, runAt: reminder.dueAt.toISOString() });

    const t = setTimeout(() => fireReminder(reminder), delay);
    jobs.set(reminder.id, t);
  } catch (err) {
    console.error('[SCHED] schedule error', err);
  }
}

/**
 * Rehydrate semua reminder 'scheduled' dari DB saat aplikasi start/restart.
 * - Jika dueAt sudah lewat:
 *    - recurring: geser ke next occurrence hingga > now
 *    - one-shot: jadwalkan +5 detik dari sekarang agar tidak hilang
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

      // Jika due sudah lewat, tangani sesuai repeat
      if (due <= nowUTC.minus({ seconds: 2 })) {
        if (r.repeat && r.repeat !== 'none') {
          // Geser maju sampai di masa depan
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
          // One-shot: jadwalkan +5 detik dari sekarang
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

/** Batalkan reminder terjadwal */
function cancelReminder(reminderId) {
  clearJob(reminderId);
  console.log('[SCHED] cancel job', { id: reminderId });
}

module.exports = {
  scheduleReminder,
  cancelReminder,
  loadAllScheduledReminders, // <-- penting untuk app.js
};
