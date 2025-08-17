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

/** Jadwalkan reminder (single atau recurring) */
function scheduleReminder(reminder) {
  try {
    clearJob(reminder.id);
    const now = DateTime.utc();
    const due = DateTime.fromJSDate(reminder.dueAt).toUTC();
    let delay = Math.max(0, due.diff(now, 'milliseconds').milliseconds);

    console.log('[SCHED] create job', { id: reminder.id, runAt: reminder.dueAt.toISOString() });

    const t = setTimeout(async () => {
      try {
        console.log('[SCHED] fire job', { id: reminder.id, at: new Date().toISOString() });

        // Ambil penerima
        const recipient = await User.findByPk(reminder.RecipientId);
        if (!recipient) {
          console.warn('[SCHED] recipient not found for reminder', reminder.id);
        } else {
          const phone = recipient.phone;
          await sendReminder(phone, reminder.formattedMessage || `Halo ${recipient.name || 'kamu'}, ini pengingatmu untuk '${reminder.title}'.`, reminder.id);
        }

        // Update status / reschedule jika recurring
        if (reminder.repeat && reminder.repeat !== 'none') {
          const next = nextDue(reminder.dueAt, reminder.repeat);
          if (next) {
            reminder.dueAt = next;
            await reminder.save();
            scheduleReminder(reminder); // recursive re-schedule
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
        console.error('[SCHED] error firing job', reminder.id, err);
        clearJob(reminder.id);
      }
    }, delay);

    jobs.set(reminder.id, t);
  } catch (err) {
    console.error('[SCHED] schedule error', err);
  }
}

/** Batalkan reminder terjadwal */
function cancelReminder(reminderId) {
  clearJob(reminderId);
  console.log('[SCHED] cancel job', { id: reminderId });
}

module.exports = { scheduleReminder, cancelReminder };
