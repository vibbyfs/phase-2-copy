const { DateTime } = require('luxon');
const { User, Reminder, Friend } = require('../models');
const { Op } = require('sequelize');
const { scheduleReminder, cancelReminder } = require('../services/scheduler');
const { extract, generateReply, extractTitleFromText } = require('../services/ai');

const WIB_TZ = 'Asia/Jakarta';

/**
 * Helper function to send response in appropriate format
 */
async function sendResponse(res, message, isTwilioWebhook = false, userPhone = null) {
    if (isTwilioWebhook) {
        // For Twilio webhook, actively send the message via waOutbound
        if (userPhone) {
            const { sendReminder } = require('../services/waOutbound');
            try {
                await sendReminder(userPhone, message, null);
                console.log('[WA] Response sent to:', userPhone);
            } catch (error) {
                console.error('[WA] Failed to send response:', error);
            }
        }
        // Return empty TwiML response since we've already sent the message
        return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    } else {
        return res.json({
            action: 'reply',
            body: message
        });
    }
}

/**
 * Simplified WA Controller dengan Twilio Direct Integration:
 * 1. User buat reminder untuk diri sendiri (hourly/daily/weekly/monthly)
 * 2. User kirim reminder sekali ke teman dengan @username
 * 3. Stop reminder dengan natural language
 */
module.exports = {
    inbound: async (req, res) => {
        try {
            // Handle Twilio webhook format
            let from, text, isTwilioWebhook = false;
            
            if (req.body.From && req.body.Body) {
                // Twilio webhook format
                from = req.body.From.replace('whatsapp:', ''); // Remove whatsapp: prefix
                text = req.body.Body;
                isTwilioWebhook = true;
            } else {
                // Custom format (for testing or other sources)
                from = req.body.from;
                text = req.body.text;
            }
            
            // Validate required fields
            if (!from || !text) {
                console.log('[WA] Invalid request - missing from or text:', { from, text });
                return res.status(400).json({ error: 'Missing required fields: from and text' });
            }
            
            console.log('[WA] inbound from:', from, 'text:', text);

            // Cari user berdasarkan phone
            const user = await User.findOne({ where: { phone: from } });
            if (!user) {
                return await sendResponse(res, 'Nomormu belum terdaftar di sistem. Silakan daftar dulu ya 😊', isTwilioWebhook, from);
            }

            // Extract pesan menggunakan AI
            const ai = await extract(text);
            console.log('[WA] parsed AI:', ai);

            // Handle CANCEL intents untuk stop reminder
            if (ai.intent === 'cancel') {
                // Cancel hanya recurring reminders
                const activeReminders = await Reminder.findAll({
                    where: { 
                        UserId: user.id, 
                        status: 'scheduled',
                        repeat: { [Op.ne]: 'none' }
                    },
                    order: [['createdAt', 'DESC']]
                });

                if (activeReminders.length === 0) {
                    return await sendResponse(res, 'Tidak ada reminder berulang yang aktif untuk dibatalkan 😊', isTwilioWebhook, from);
                }

                for (const rem of activeReminders) {
                    rem.status = 'cancelled';
                    await rem.save();
                    cancelReminder(rem.id);
                }

                return await sendResponse(res, `✅ ${activeReminders.length} reminder berulang berhasil dibatalkan!`, isTwilioWebhook, from);
            }

            if (ai.intent === 'cancel_all') {
                // Cancel SEMUA reminder (termasuk non-recurring)
                const allActiveReminders = await Reminder.findAll({
                    where: { 
                        UserId: user.id, 
                        status: 'scheduled'
                    },
                    order: [['createdAt', 'DESC']]
                });

                if (allActiveReminders.length === 0) {
                    return await sendResponse(res, 'Tidak ada reminder aktif untuk dibatalkan 😊', isTwilioWebhook, from);
                }

                for (const rem of allActiveReminders) {
                    rem.status = 'cancelled';
                    await rem.save();
                    cancelReminder(rem.id);
                }

                return await sendResponse(res, `✅ Semua ${allActiveReminders.length} reminder berhasil dibatalkan!`, isTwilioWebhook, from);
            }

            if (ai.intent === 'cancel_specific' && ai.cancelKeyword) {
                // Cancel reminder berdasarkan keyword
                const specificReminders = await Reminder.findAll({
                    where: { 
                        UserId: user.id, 
                        status: 'scheduled',
                        title: { [Op.iLike]: `%${ai.cancelKeyword}%` }
                    },
                    order: [['createdAt', 'DESC']]
                });

                if (specificReminders.length === 0) {
                    return await sendResponse(res, `Tidak ada reminder aktif yang mengandung kata "${ai.cancelKeyword}" 😊`, isTwilioWebhook, from);
                }

                for (const rem of specificReminders) {
                    rem.status = 'cancelled';
                    await rem.save();
                    cancelReminder(rem.id);
                }

                const reminderTitles = specificReminders.map(r => `"${r.title}"`).join(', ');
                return await sendResponse(res, `✅ ${specificReminders.length} reminder dibatalkan: ${reminderTitles}`, isTwilioWebhook, from);
            }

            if (ai.intent === 'list') {
                // Tampilkan daftar reminder aktif
                const activeReminders = await Reminder.findAll({
                    where: { 
                        UserId: user.id, 
                        status: 'scheduled'
                    },
                    order: [['dueAt', 'ASC']],
                    limit: 10
                });

                if (activeReminders.length === 0) {
                    return await sendResponse(res, 'Tidak ada reminder aktif saat ini 😊', isTwilioWebhook, from);
                }

                let listMessage = `📋 *Daftar Reminder Aktif (${activeReminders.length}):*\n\n`;
                activeReminders.forEach((rem, index) => {
                    const dueTime = DateTime.fromJSDate(rem.dueAt).setZone(WIB_TZ).toFormat('dd/MM HH:mm');
                    const repeatText = rem.repeat !== 'none' ? ` (${rem.repeat})` : '';
                    listMessage += `${index + 1}. *${rem.title}*\n   📅 ${dueTime} WIB${repeatText}\n\n`;
                });

                listMessage += '💡 _Ketik "stop reminder [nama]" untuk membatalkan reminder tertentu_';

                return await sendResponse(res, listMessage, isTwilioWebhook, from);
            }

            // ENHANCED CREATE REMINDER with Dynamic Time Parsing
            const title = (ai.title || '').trim() || extractTitleFromText(text);
            const repeat = ai.repeat || 'none';
            const timeType = ai.timeType || 'relative';
            const repeatDetails = ai.repeatDetails || {};
            
            console.log('[WA] AI parsing result:', {
                title,
                timeType,
                dueAtWIB: ai.dueAtWIB,
                repeat,
                repeatDetails
            });

            // Enhanced time processing based on timeType
            let dueDate;
            const nowWIB = DateTime.now().setZone(WIB_TZ);

            if (ai.dueAtWIB) {
                // AI successfully parsed the time
                const parsedTime = DateTime.fromISO(ai.dueAtWIB);
                if (parsedTime.isValid) {
                    dueDate = parsedTime.toUTC().toJSDate();
                } else {
                    console.warn('[WA] Invalid AI parsed time, using fallback');
                    dueDate = nowWIB.plus({ minutes: 5 }).toUTC().toJSDate();
                }
            } else {
                // Fallback parsing
                console.log('[WA] Using fallback time parsing for:', text);
                dueDate = nowWIB.plus({ minutes: 5 }).toUTC().toJSDate();
            }

            // Additional validation for recurring reminders
            if (repeat !== 'none' && repeatDetails.timeOfDay) {
                try {
                    const [hour, minute] = repeatDetails.timeOfDay.split(':').map(Number);
                    let nextExecution = nowWIB.set({ hour, minute, second: 0, millisecond: 0 });
                    
                    // If time has passed today, schedule for tomorrow/next occurrence
                    if (nextExecution <= nowWIB) {
                        switch (repeat) {
                            case 'daily':
                                nextExecution = nextExecution.plus({ days: 1 });
                                break;
                            case 'weekly':
                                nextExecution = nextExecution.plus({ weeks: 1 });
                                break;
                            case 'monthly':
                                nextExecution = nextExecution.plus({ months: 1 });
                                break;
                            case 'hourly':
                                nextExecution = nowWIB.plus({ hours: 1 }).set({ minute: 0, second: 0, millisecond: 0 });
                                break;
                        }
                    }
                    
                    dueDate = nextExecution.toUTC().toJSDate();
                } catch (error) {
                    console.error('[WA] Error processing recurring time:', error);
                }
            }

            // Final validation
            if (isNaN(dueDate.getTime()) || DateTime.fromJSDate(dueDate) <= DateTime.utc()) {
                dueDate = nowWIB.plus({ minutes: 5 }).toUTC().toJSDate();
            }

            console.log('[WA] Final scheduling:', {
                title,
                timeType,
                dueDate: dueDate.toISOString(),
                repeat,
                repeatDetails
            });

            // Cari recipients berdasarkan @username atau default ke user sendiri
            let recipients = [user]; // Default: reminder untuk diri sendiri
            const createdReminders = [];

            if (ai.recipientUsernames && ai.recipientUsernames.length > 0) {
                // Cari teman berdasarkan username
                recipients = [];
                for (const taggedUsername of ai.recipientUsernames) {
                    const username = taggedUsername.replace('@', '');
                    
                    // Cari user berdasarkan username
                    const targetUser = await User.findOne({ where: { username } });
                    if (!targetUser) {
                        return await sendResponse(res, `User @${username} tidak ditemukan. Pastikan username benar dan user sudah terdaftar.`, isTwilioWebhook, from);
                    }

                    // Cek apakah sudah berteman
                    const friendship = await Friend.findOne({
                        where: {
                            [Op.or]: [
                                { UserId: user.id, FriendId: targetUser.id, status: 'accepted' },
                                { UserId: targetUser.id, FriendId: user.id, status: 'accepted' }
                            ]
                        }
                    });

                    if (!friendship) {
                        return await sendResponse(res, `Kamu belum berteman dengan @${username}. Kirim undangan pertemanan dulu ya 😊`, isTwilioWebhook, from);
                    }

                    recipients.push(targetUser);
                }

                // Jika ada username tagging, reminder harus 'none' (sekali saja)
                repeat = 'none';
            }

            // Buat reminder untuk setiap recipient
            for (const recipient of recipients) {
                let formattedMessage = ai.formattedMessage;
                if (!formattedMessage) {
                    const recipientName = recipient.name || recipient.username || 'Kamu';
                    const timeStr = DateTime.fromJSDate(dueDate).setZone(WIB_TZ).toFormat('HH:mm');
                    formattedMessage = `Hay ${recipientName} 👋, waktunya untuk *${title}* pada jam ${timeStr} WIB! Jangan lupa ya 😊`;
                }

                const reminder = await Reminder.create({
                    UserId: user.id,
                    RecipientId: recipient.id === user.id ? null : recipient.id,
                    title,
                    dueAt: dueDate,
                    repeat: repeat,
                    status: 'scheduled',
                    formattedMessage: formattedMessage
                });

                // Jadwalkan
                await scheduleReminder(reminder);
                createdReminders.push(reminder);
            }

            // Enhanced response message based on timeType and repeat
            const recipientNames = recipients.length > 1 
                ? recipients.map(r => r.name || r.username || 'Unknown').join(', ')
                : (recipients[0].id === user.id ? 'diri sendiri' : recipients[0].name || recipients[0].username || 'Unknown');
            
            let timeDescription = '';
            let repeatText = '';
            
            // Generate time description based on timeType
            const scheduledTime = DateTime.fromJSDate(dueDate).setZone(WIB_TZ);
            
            if (timeType === 'relative') {
                const diffMinutes = Math.round(scheduledTime.diff(nowWIB, 'minutes').minutes);
                if (diffMinutes < 60) {
                    timeDescription = `${diffMinutes} menit lagi`;
                } else if (diffMinutes < 1440) {
                    const hours = Math.round(diffMinutes / 60);
                    timeDescription = `${hours} jam lagi`;
                } else {
                    timeDescription = scheduledTime.toFormat('dd/MM/yyyy HH:mm') + ' WIB';
                }
            } else if (timeType === 'absolute') {
                const isToday = scheduledTime.hasSame(nowWIB, 'day');
                const isTomorrow = scheduledTime.hasSame(nowWIB.plus({ days: 1 }), 'day');
                
                if (isToday) {
                    timeDescription = `hari ini jam ${scheduledTime.toFormat('HH:mm')} WIB`;
                } else if (isTomorrow) {
                    timeDescription = `besok jam ${scheduledTime.toFormat('HH:mm')} WIB`;
                } else {
                    timeDescription = scheduledTime.toFormat('dd/MM/yyyy HH:mm') + ' WIB';
                }
            } else if (timeType === 'recurring') {
                timeDescription = scheduledTime.toFormat('dd/MM/yyyy HH:mm') + ' WIB (mulai)';
            }
            
            // Generate repeat description
            if (repeat !== 'none') {
                const repeatMap = {
                    'hourly': 'setiap jam',
                    'daily': 'setiap hari',
                    'weekly': 'setiap minggu', 
                    'monthly': 'setiap bulan'
                };
                repeatText = ` (${repeatMap[repeat]})`;
                
                if (repeatDetails.timeOfDay) {
                    repeatText += ` pada ${repeatDetails.timeOfDay} WIB`;
                }
                if (repeatDetails.dayOfWeek) {
                    repeatText += ` hari ${repeatDetails.dayOfWeek}`;
                }
                if (repeatDetails.dayOfMonth) {
                    repeatText += ` tanggal ${repeatDetails.dayOfMonth}`;
                }
            }
            
            const confirmMsg = await generateReply('confirm', {
                title,
                recipients: recipientNames,
                timeDescription,
                repeatText,
                timeType,
                count: createdReminders.length
            });

            // Send confirmation message back to user
            if (isTwilioWebhook) {
                // For Twilio webhook, we need to actively send the confirmation message
                const { sendReminder } = require('../services/waOutbound');
                try {
                    await sendReminder(from, confirmMsg, null);
                    console.log('[WA] Confirmation sent to:', from);
                } catch (error) {
                    console.error('[WA] Failed to send confirmation:', error);
                }
                // Return empty TwiML response since we've already sent the message
                return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
            }

            return await sendResponse(res, confirmMsg, isTwilioWebhook, from);
        } catch (err) {
            console.error('ERROR WA INBOUND', err);
            return res.status(500).json({ message: 'Internal server error' });
        }
    }
};
