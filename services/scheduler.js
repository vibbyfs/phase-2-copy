// services/scheduler.js
const schedule = require('node-schedule');
const { Op } = require('sequelize');             
const { User, Reminder } = require('../models');
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

async function fireReminder(reminderId) {
  try {
    const reminder = await Reminder.findByPk(reminderId);
    if (!reminder || reminder.status !== 'scheduled') return;

    const user = await User.findByPk(reminder.RecipientId || reminder.UserId);
    if (!user || !user.phone) return;

    const to = String(user.phone); // pastikan string
    const title = reminder.title || 'pengingat';
    
    // Use formattedMessage from database if available, otherwise generate with AI
    let msg = reminder.formattedMessage;
    if (!msg || msg.trim() === '') {
      // Generate message using AI if not stored
      try {
        const generatedMsg = await ai.generateReply({
          kind: 'reminder_delivery',
          username: user.username,
          title: title,
          context: 'Generate a warm, motivational reminder message in Indonesian with relevant emoticons'
        });
        msg = generatedMsg || `Halo ${user.username || 'kamu'}, ini pengingatmu untuk "${title}". Semoga harimu berjalan lancar ya ✨🙏`;
      } catch (aiError) {
        console.error('[SCHED] AI generate message error:', aiError);
        msg = `Halo ${user.username || 'kamu'}, ini pengingatmu untuk "${title}". Semoga harimu berjalan lancar ya ✨🙏`;
      }
    }

    await sendMessage(to, msg, reminder.id);

    await Reminder.update({ status: 'sent' }, { where: { id: reminder.id } });

    // Check if this is a recurring reminder
    if (reminder.isRecurring && reminder.repeatType !== 'once') {
      const nextDate = calculateNextRepeatDate(reminder);
      if (nextDate) {
        // Create next occurrence
        const nextReminder = await Reminder.create({
          title: reminder.title,
          content: reminder.content,
          dueAt: nextDate,
          UserId: reminder.UserId,
          RecipientId: reminder.RecipientId,
          repeatType: reminder.repeatType,
          repeatInterval: reminder.repeatInterval,
          repeatEndDate: reminder.repeatEndDate,
          parentReminderId: reminder.parentReminderId || reminder.id,
          isRecurring: true,
          status: 'scheduled',
          formattedMessage: reminder.formattedMessage
        });
        
        console.log('[SCHED] created next occurrence', { 
          originalId: reminder.id, 
          nextId: nextReminder.id, 
          nextDate: nextDate.toISOString() 
        });
        
        // Schedule the next occurrence
        scheduleReminder(nextReminder);
      }
    }
  } catch (err) {
    console.error('[SCHED] fire error', err);
    await Reminder.update({ status: 'failed' }, { where: { id: reminderId } }).catch(() => {});
  } finally {
    const job = jobs.get(reminderId);
    if (job) job.cancel();
    jobs.delete(reminderId);
  }
}

function calculateNextRepeatDate(reminder) {
  const currentDate = new Date(reminder.dueAt);
  const now = new Date();
  
  // Check if repeat has ended
  if (reminder.repeatEndDate && now > new Date(reminder.repeatEndDate)) {
    return null;
  }
  
  let nextDate = new Date(currentDate);
  
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
  
  // Check if next date exceeds end date
  if (reminder.repeatEndDate && nextDate > new Date(reminder.repeatEndDate)) {
    return null;
  }
  
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
        dueAt: { [Op.gte]: since }             
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
