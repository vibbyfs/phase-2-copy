// services/scheduler.js (CommonJS)
// Simple in-memory scheduler + DB reload on boot

const { DateTime } = require('luxon');
const { Reminder, User } = require('../models');
const { sendMessage } = require('./waOutbound');
const { WIB_TZ, generateReply } = require('./ai');

const timers = new Map();

async function fireReminder(reminderId) {
  try {
    const reminder = await Reminder.findByPk(reminderId);
    if (!reminder) return;

    // Fetch recipient for phone/username
    const recipient = await User.findByPk(reminder.RecipientId || reminder.UserId);
    if (!recipient || !recipient.phone) return;

    const name = recipient.name || recipient.username || 'kamu';
    const title = reminder.title || 'pengingat';

    // Compose single-line message by AI
    const text = await generateReply('reminder_send', { userName: name, title });

    await sendMessage(recipient.phone, text, reminder.id);

    // Update status for one-off reminders
    if (reminder.repeat === 'none') {
      reminder.status = 'sent';
      await reminder.save();
      timers.delete(reminderId);
    } else {
      // For recurring, compute next run
      const next = computeNextRun(reminder);
      if (!next) {
        reminder.status = 'cancelled';
        await reminder.save();
        timers.delete(reminderId);
        return;
      }
      reminder.dueAt = next.toUTC().toJSDate();
      await reminder.save();
      scheduleReminder(reminder); // reschedule
    }
  } catch (e) {
    console.error('[SCHED] fire error:', e);
  }
}

function computeNextRun(reminder) {
  const now = DateTime.now().setZone(WIB_TZ);
  let next = DateTime.fromJSDate(reminder.dueAt).setZone(WIB_TZ);

  switch (reminder.repeat) {
    case 'hourly':
      next = next.plus({ hours: 1 });
      break;
    case 'daily':
      next = next.plus({ days: 1 });
      break;
    case 'weekly':
      next = next.plus({ weeks: 1 });
      break;
    case 'monthly':
      next = next.plus({ months: 1 });
      break;
    default:
      return null;
  }
  if (next <= now) next = now.plus({ minutes: 1 });
  return next;
}

function scheduleReminder(remOrPlain) {
  const reminder = remOrPlain.dataValues ? remOrPlain : remOrPlain; // Sequelize or plain
  const id = reminder.id;
  const due = DateTime.fromJSDate(reminder.dueAt).toUTC();
  const now = DateTime.utc();

  const delay = Math.max(0, due.toMillis() - now.toMillis());

  if (timers.has(id)) clearTimeout(timers.get(id));

  // setTimeout limit ~24.8 days — OK for most reminders; recurring will reschedule anyway.
  const t = setTimeout(() => fireReminder(id), delay);
  timers.set(id, t);

  console.log('[SCHED] create job', { id, runAt: due.toISO() });
}

function cancelReminder(reminderId) {
  if (timers.has(reminderId)) {
    clearTimeout(timers.get(reminderId));
    timers.delete(reminderId);
  }
}

async function loadAllScheduledReminders() {
  const list = await Reminder.findAll({
    where: { status: 'scheduled' },
    order: [['dueAt', 'ASC']],
  });
  for (const r of list) scheduleReminder(r);
  console.log('[SCHED] loaded', list.length, 'reminders');
}

module.exports = {
  scheduleReminder,
  cancelReminder,
  loadAllScheduledReminders,
};
