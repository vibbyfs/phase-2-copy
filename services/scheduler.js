// services/scheduler.js
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

    // Check if this is a multi-recipient reminder
    if (reminder.reminderRecipients && reminder.reminderRecipients.length > 0) {
      // Multi-recipient reminder
      for (const reminderRecipient of reminder.reminderRecipients) {
        try {
          const recipient = reminderRecipient.recipient;
          if (!recipient || !recipient.phone) continue;

          const to = String(recipient.phone);
          
          // Personalize message for each recipient
          let msg = reminder.formattedMessage;
          if (msg && msg.includes('{RECIPIENT_NAME}')) {
            // Replace recipient name placeholder
            msg = msg.replace('{RECIPIENT_NAME}', recipient.username);
            
            // Generate AI motivational message based on context
            if (msg.includes('{AI_MOTIVATIONAL}')) {
              try {
                // Extract clean reminder title (remove "ingetin" prefix if present)
                let cleanTitle = title.replace(/^(ingetin\s+)/i, '').trim();
                
                const motivationalMsg = await ai.generateReply({
                  kind: 'motivational_reminder',
                  username: recipient.username,
                  title: cleanTitle,
                  context: `Generate complete reminder message in Indonesian for "${cleanTitle}" to ${recipient.username}. Include greeting, activity, and motivation with relevant emoticons.`
                });
                
                const finalMotivational = motivationalMsg || `Halo ${recipient.username}, ini pengingat untuk "${cleanTitle}". Semoga harimu berjalan lancar! ✨`;
                msg = msg.replace('{AI_MOTIVATIONAL}', finalMotivational);
              } catch (aiError) {
                console.error('[SCHED] AI motivational error:', aiError);
                msg = msg.replace('{AI_MOTIVATIONAL}', 'semoga ini jadi dorongan kecil yang memotivasi kamu! ✨');
              }
            }
          } else {
            // Fallback message with AI motivational
            try {
              // Extract clean reminder title
              let cleanTitle = title.replace(/^(ingetin\s+)/i, '').trim();
              
              const motivationalMsg = await ai.generateReply({
                kind: 'motivational_reminder',
                username: recipient.username,
                title: cleanTitle,
                context: `Generate complete reminder message in Indonesian for "${cleanTitle}" to ${recipient.username}. Include greeting, activity, and motivation with relevant emoticons.`
              });
              
              const finalMotivational = motivationalMsg || `Halo ${recipient.username}, ini pengingat untuk "${cleanTitle}". Semoga harimu berjalan lancar! ✨`;
              msg = `Halo ${recipient.username}, ini pengingatmu untuk "${title}". ${finalMotivational}`;
            } catch (aiError) {
              console.error('[SCHED] AI fallback error:', aiError);
              msg = `Halo ${recipient.username}, ini pengingatmu untuk "${title}". Semoga harimu berjalan lancar ya ✨🙏`;
            }
          }

          await sendMessage(to, msg, reminder.id);
          
          // Update specific ReminderRecipient status using composite key
          await ReminderRecipient.update(
            { status: 'sent', sentAt: new Date() },
            { 
              where: { 
                ReminderId: reminder.id,
                RecipientId: reminderRecipient.RecipientId 
              } 
            }
          );
          
          sentCount++;
          console.log(`[SCHED] Sent multi-recipient reminder to ${recipient.username}: ${title}`);
        } catch (sendError) {
          console.error(`[SCHED] Failed to send to recipient ${reminderRecipient.RecipientId}:`, sendError);
          
          // Mark this specific recipient as failed but don't stop the whole process
          await ReminderRecipient.update(
            { status: 'cancelled' },
            { 
              where: { 
                ReminderId: reminder.id,
                RecipientId: reminderRecipient.RecipientId 
              } 
            }
          );
        }
      }
    } else {
      // Single recipient reminder (legacy mode)
      const user = await User.findByPk(reminder.RecipientId || reminder.UserId);
      if (!user || !user.phone) return;

      const to = String(user.phone);
      
      // Use formattedMessage from database if available, otherwise generate with AI
      let msg = reminder.formattedMessage;
      if (!msg || msg.trim() === '') {
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
      sentCount = 1;
    }

    // Update main reminder status
    await Reminder.update({ status: 'sent' }, { where: { id: reminder.id } });

    console.log(`[SCHED] Successfully fired reminder ${reminderId} to ${sentCount} recipient(s)`);

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
          RecipientId: reminder.RecipientId, // Keep for legacy compatibility
          repeat: reminder.repeat,
          repeatType: reminder.repeatType,
          repeatInterval: reminder.repeatInterval,
          repeatEndDate: reminder.repeatEndDate,
          parentReminderId: reminder.parentReminderId || reminder.id,
          isRecurring: true,
          status: 'scheduled',
          formattedMessage: reminder.formattedMessage
        });

        // Copy ReminderRecipients for next occurrence if multi-recipient
        if (reminder.reminderRecipients && reminder.reminderRecipients.length > 0) {
          const nextRecipientData = reminder.reminderRecipients.map(rr => ({
            ReminderId: nextReminder.id,
            RecipientId: rr.RecipientId,
            status: 'scheduled'
          }));
          
          await ReminderRecipient.bulkCreate(nextRecipientData);
          console.log(`[SCHED] Created ${nextRecipientData.length} recipients for next occurrence`);
        }
        
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
    
    console.log(`[SCHED] Schedule check - reminderId: ${reminder.id}, runAt: ${runAt.toISOString()}, now: ${new Date().toISOString()}, diff: ${diff}ms`);

    // Only fire immediately if genuinely overdue by a small margin (max 30 seconds)
    if (diff <= 0 && diff >= -30000) {
      console.log('[SCHED] fire immediate (slightly overdue)', { id: reminder.id, at: runAt.toISOString(), atWIB: wibTs(runAt) });
      setTimeout(() => fireReminder(reminder.id), 100);
      return;
    }
    
    // Don't schedule anything that's way overdue
    if (diff < -30000) {
      console.log('[SCHED] skip overdue reminder', { id: reminder.id, at: runAt.toISOString(), overdue: Math.abs(diff) });
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

      const diff = runAt.getTime() - now;
      
      // Only backfill if slightly overdue (max 5 minutes)
      if (diff <= 0 && diff >= -5 * 60 * 1000) {
        console.log('[SCHED] backfill fire', { id: r.id, at: runAt.toISOString(), atWIB: wibTs(runAt), overdue: Math.abs(diff) });
        setTimeout(() => fireReminder(r.id), 100);
      } else if (diff > 0) {
        scheduleReminder(r);
      } else {
        console.log('[SCHED] skip old reminder', { id: r.id, at: runAt.toISOString(), overdue: Math.abs(diff) });
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
