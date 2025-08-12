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

            // CREATE REMINDER
            let title = (ai.title || '').trim() || extractTitleFromText(text);
            let dueAtUTC = ai.dueAtWIB;
            let repeat = ai.repeat || 'none';

            const t = (text || '').toLowerCase();
            const nowWIB = DateTime.now().setZone(WIB_TZ);

            // Heuristik fallback waktu jika AI tidak mendeteksi
            if (!dueAtUTC) {
                const m = t.match(/(\d+)\s*menit/i);
                const h = t.match(/(\d+)\s*jam/i);
                const besok = /\bbesok\b/i.test(t);

                if (m) dueAtUTC = nowWIB.plus({ minutes: Number(m[1]) }).toUTC().toISO();
                else if (h) dueAtUTC = nowWIB.plus({ hours: Number(h[1]) }).toUTC().toISO();
                else if (besok) {
                    dueAtUTC = nowWIB
                        .plus({ days: 1 })
                        .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
                        .toUTC()
                        .toISO();
                }
            }

            // Fallback: +5 menit
            if (!dueAtUTC) {
                dueAtUTC = nowWIB.plus({ minutes: 5 }).toUTC().toISO();
            }

            // Pastikan dueDate valid & future
            let dueDate = DateTime.fromISO(dueAtUTC).toJSDate();
            if (isNaN(dueDate.getTime()) || DateTime.fromJSDate(dueDate) <= DateTime.utc()) {
                dueDate = nowWIB.plus({ minutes: 5 }).toUTC().toJSDate();
            }

            console.log('[WA] final title:', title, 'dueDateJS:', dueDate.toISOString(), 'repeat:', repeat);

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

            // Buat response konfirmasi yang ramah menggunakan AI
            const recipientNames = recipients.length > 1 
                ? recipients.map(r => r.name || r.username || 'Unknown').join(', ')
                : (recipients[0].id === user.id ? 'diri sendiri' : recipients[0].name || recipients[0].username || 'Unknown');
            
            let repeatText = '';
            if (repeat !== 'none') {
                if (repeat === 'hourly') {
                    repeatText = ' (setiap jam)';
                } else if (repeat === 'daily') {
                    repeatText = ' (setiap hari)';
                } else if (repeat === 'weekly') {
                    repeatText = ' (setiap minggu)';
                } else if (repeat === 'monthly') {
                    repeatText = ' (setiap bulan)';
                }
            }
            
            const confirmMsg = await generateReply('confirm', {
                title,
                recipients: recipientNames,
                dueTime: DateTime.fromJSDate(dueDate).setZone(WIB_TZ).toFormat('dd/MM/yyyy HH:mm') + ' WIB',
                repeat: repeatText,
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
