// services/scheduler.js
const schedule = require('node-schedule');
const { Op } = require('sequelize');             // <<— Sequelize v6 operators
const { User, Reminder } = require('../models');
const { sendMessage } = require('./waOutbound');

const jobs = new Map(); // reminderId -> schedule.Job

function wibTs(date) {
  const d = new Date(date);
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(d);
}

async function fireReminder(reminderId) {
  try {
    const reminder = await Reminder.findByPk(reminderId);
    if (!reminder || reminder.status !== 'scheduled') return;

    const user = await User.findByPk(reminder.RecipientId || reminder.UserId);
    if (!user || !user.phone) return;

    const to = String(user.phone); // pastikan string
    const title = reminder.title || 'pengingat';
    const msg = `Halo ${user.username || 'kamu'}, ini pengingatmu untuk “${title}”. 😊`;

    await sendMessage(to, msg, reminder.id);

    await Reminder.update({ status: 'sent' }, { where: { id: reminder.id } });
  } catch (err) {
    console.error('[SCHED] fire error', err);
    await Reminder.update({ status: 'failed' }, { where: { id: reminderId } }).catch(() => {});
  } finally {
    const job = jobs.get(reminderId);
    if (job) job.cancel();
    jobs.delete(reminderId);
  }
}

function scheduleReminder(reminder) {
  try {
    const runAt = new Date(reminder.dueAt);
    if (Number.isNaN(runAt.getTime())) {
      console.warn('[SCHED] skip schedule, invalid date', { id: reminder.id, dueAt: reminder.dueAt });
      return;
    }

    const diff = runAt.getTime() - Date.now();

    // Kirim instan bila sangat dekat (<= 2s) atau sudah lewat tipis
    if (diff <= 2000) {
      console.log('[SCHED] fire immediate', { id: reminder.id, at: runAt.toISOString(), atWIB: wibTs(runAt) });
      setTimeout(() => fireReminder(reminder.id), Math.max(0, diff));
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
  const job = jobs.get(reminderId);
  if (job) job.cancel();
  jobs.delete(reminderId);

  await Reminder.update({ status: 'cancelled' }, { where: { id: reminderId } });
  console.log('[SCHED] cancelled', { id: reminderId });
}

async function loadAllScheduledReminders() {
  try {
    // Backfill 5 menit ke belakang untuk handle restart
    const since = new Date(Date.now() - 5 * 60 * 1000);

    const rows = await Reminder.findAll({
      where: {
        status: 'scheduled',
        dueAt: { [Op.gte]: since }             // <<— gunakan Op.gte (bukan `$gte`)
      },
      order: [['dueAt', 'ASC']]
    });

    console.log('[SCHED] loaded', rows.length, 'reminders');

    const now = Date.now();
    for (const r of rows) {
      const runAt = new Date(r.dueAt);
      if (Number.isNaN(runAt.getTime())) continue;

      if (runAt.getTime() <= now) {
        console.log('[SCHED] backfill fire', { id: r.id, at: runAt.toISOString(), atWIB: wibTs(runAt) });
        setTimeout(() => fireReminder(r.id), 100);
      } else {
        scheduleReminder(r);
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
