const { Reminder, User, Friend } = require('../models');
const { scheduleReminder, cancelReminder } = require('../services/scheduler');
const { DateTime } = require('luxon');
const { Op } = require('sequelize');

/**
 * Simplified ReminderController - hanya fitur core yang diperlukan:
 * 1. Get active reminders
 * 2. Cancel reminders by keyword (untuk stop natural language)
 * 3. Cancel all recurring reminders  
 */
class ReminderController {
  
  // Get active reminders untuk user
  static async getActiveReminders(req, res, next) {
    try {
      const userId = req.user.id;

      const activeReminders = await Reminder.findAll({
        where: {
          UserId: userId,
          status: 'scheduled'
        },
        order: [['dueAt', 'ASC']]
      });

      const formattedReminders = activeReminders.map(reminder => ({
        id: reminder.id,
        title: reminder.title,
        dueAt: reminder.dueAt,
        repeat: reminder.repeat,
        recipientId: reminder.RecipientId,
        createdAt: reminder.createdAt
      }));

      res.status(200).json({
        count: activeReminders.length,
        reminders: formattedReminders
      });
    } catch (err) {
      next(err);
    }
  }

  // Cancel reminders berdasarkan keyword (untuk stop natural language)
  static async cancelRemindersByKeyword(req, res, next) {
    try {
      const userId = req.user.id;
      const { keyword } = req.body;

      if (!keyword) {
        throw { name: 'BadRequest', message: 'Keyword wajib diisi.' };
      }

      // Cari reminder berdasarkan keyword di title
      const reminders = await Reminder.findAll({
        where: {
          UserId: userId,
          status: 'scheduled',
          title: { [Op.iLike]: `%${keyword}%` }
        }
      });

      if (reminders.length === 0) {
        return res.status(200).json({ 
          message: `Tidak ada reminder aktif yang mengandung kata "${keyword}"` 
        });
      }

      // Batalkan reminder yang ditemukan
      for (const reminder of reminders) {
        reminder.status = 'cancelled';
        await reminder.save();
        cancelReminder(reminder.id);
      }

      res.status(200).json({ 
        message: `${reminders.length} reminder dengan kata "${keyword}" berhasil dibatalkan`,
        cancelledCount: reminders.length,
        cancelledReminders: reminders.map(r => ({ id: r.id, title: r.title }))
      });
    } catch (err) {
      next(err);
    }
  }

  // Cancel semua recurring reminders untuk user
  static async cancelRecurringReminders(req, res, next) {
    try {
      const userId = req.user.id;

      const activeReminders = await Reminder.findAll({
        where: { 
          UserId: userId, 
          status: 'scheduled',
          repeat: { [Op.ne]: 'none' }
        }
      });

      if (activeReminders.length === 0) {
        return res.status(200).json({ 
          message: 'Tidak ada reminder berulang yang aktif untuk dibatalkan' 
        });
      }

      // Batalkan semua recurring reminders
      for (const reminder of activeReminders) {
        reminder.status = 'cancelled';
        await reminder.save();
        cancelReminder(reminder.id);
      }

      res.status(200).json({ 
        message: `${activeReminders.length} reminder berulang berhasil dibatalkan`,
        cancelledCount: activeReminders.length
      });
    } catch (err) {
      next(err);
    }
  }

  // Cancel semua reminders (termasuk non-recurring)
  static async cancelAllReminders(req, res, next) {
    try {
      const userId = req.user.id;

      const activeReminders = await Reminder.findAll({
        where: { 
          UserId: userId, 
          status: 'scheduled'
        }
      });

      if (activeReminders.length === 0) {
        return res.status(200).json({ 
          message: 'Tidak ada reminder aktif untuk dibatalkan' 
        });
      }

      // Batalkan semua reminders
      for (const reminder of activeReminders) {
        reminder.status = 'cancelled';
        await reminder.save();
        cancelReminder(reminder.id);
      }

      res.status(200).json({ 
        message: `${activeReminders.length} reminder berhasil dibatalkan`,
        cancelledCount: activeReminders.length
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = ReminderController;
