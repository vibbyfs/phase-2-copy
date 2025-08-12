const schedule = require('node-schedule');
const { Reminder, User } = require('../models');
const { sendReminder } = require('./waOutbound');

const jobs = {};

async function scheduleReminder(reminder) {
  try {
    if (!reminder || reminder.status !== 'scheduled') return;
    const runAt = new Date(reminder.dueAt);
    if (!(runAt instanceof Date) || isNaN(runAt.getTime()) || runAt <= new Date()) {
      console.log('[SCHED] skip (invalid/past)', { id: reminder.id, dueAt: reminder.dueAt });
      return;
    }

    // Batalkan job lama bila ada
    cancelReminder(reminder.id);

    console.log('[SCHED] create job', { id: reminder.id, runAt: runAt.toISOString() });
    const job = schedule.scheduleJob(reminder.id.toString(), runAt, async () => {
      try {
        console.log('[SCHED] fire job', { id: reminder.id, at: new Date().toISOString() });
        const owner = await User.findByPk(reminder.UserId);
        const recipient = reminder.RecipientId ? await User.findByPk(reminder.RecipientId) : owner;
        const to = recipient.phone;

        // Gunakan formattedMessage jika ada, jika tidak gunakan format default
        const message = reminder.formattedMessage || `⏰ Pengingat: ${reminder.title}`;
        await sendReminder(to, message, reminder.id);

        // Handle repeat patterns - disederhanakan hanya hourly, daily, weekly, monthly
        if (reminder.repeat === 'hourly') {
          reminder.dueAt = new Date(reminder.dueAt.getTime() + 60 * 60 * 1000); // +1 hour
          reminder.status = 'scheduled';
          await reminder.save();
          await scheduleReminder(reminder);
        } else if (reminder.repeat === 'daily') {
          reminder.dueAt = new Date(reminder.dueAt.getTime() + 24 * 60 * 60 * 1000); // +1 day
          reminder.status = 'scheduled';
          await reminder.save();
          await scheduleReminder(reminder);
        } else if (reminder.repeat === 'weekly') {
          reminder.dueAt = new Date(reminder.dueAt.getTime() + 7 * 24 * 60 * 60 * 1000); // +7 days
          reminder.status = 'scheduled';
          await reminder.save();
          await scheduleReminder(reminder);
        } else if (reminder.repeat === 'monthly') {
          // Tambah 1 bulan dengan mempertahankan tanggal yang sama
          const currentDate = new Date(reminder.dueAt);
          const nextMonth = new Date(currentDate);
          nextMonth.setMonth(currentDate.getMonth() + 1);
          
          // Jika tanggal tidak valid (misal 31 Jan -> 28/29 Feb), gunakan hari terakhir bulan
          if (nextMonth.getDate() !== currentDate.getDate()) {
            nextMonth.setDate(0); // Set ke hari terakhir bulan sebelumnya
          }
          
          reminder.dueAt = nextMonth;
          reminder.status = 'scheduled';
          await reminder.save();
          await scheduleReminder(reminder);
        } else {
          // Reminder sekali (none) - mark as sent
          reminder.status = 'sent';
          await reminder.save();
        }
      } catch (e) {
        console.error('[SCHED] error executing job', reminder.id, e);
      }
    });

    jobs[reminder.id] = job;
  } catch (e) {
    console.error('[SCHED] scheduleReminder error', e);
  }
}

function cancelReminder(reminderId) {
  const job = jobs[reminderId];
  if (job) {
    job.cancel();
    console.log('[SCHED] cancel job', reminderId);
    delete jobs[reminderId];
  }
}

async function loadAllScheduledReminders() {
  try {
    const reminders = await Reminder.findAll({ where: { status: 'scheduled' } });
    console.log('[SCHED] load scheduled count:', reminders.length);
    for (const r of reminders) await scheduleReminder(r);
  } catch (e) {
    console.error('[SCHED] loadAllScheduledReminders error', e);
  }
}

module.exports = { scheduleReminder, cancelReminder, loadAllScheduledReminders };
