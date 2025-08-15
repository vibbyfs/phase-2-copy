const { Reminder } = require('../models');
const { cancelReminder } = require('../services/scheduler');
const { Op } = require('sequelize');

class ReminderController {

  static async getAllReminders(req, res, next) {
    try {
      const userId = req.user.id;
      const { search, filter, sort } = req.query;

      const where = { UserId: userId };

      if (search) {
        where.title = { [Op.iLike]: `%${search}%` };
      }

      if (filter) {
        where.status = filter;
      }

      const order = [
        ['createdAt', (String(sort || '').toUpperCase() === 'ASC') ? 'ASC' : 'DESC'],
      ];

      const reminders = await Reminder.findAll({ where, order });

      return res.status(200).json(reminders);
    } catch (err) {
      next(err);
    }
  }


  static async cancelReminderById(req, res, next) {
    try {
      const id = req.params.id;
      const { status } = req.body;

      const reminder = await Reminder.findByPk(id);
      if (!reminder) {
        throw { name: 'NotFound', message: 'Reminder not found' };
      }

      if (reminder.status !== 'scheduled') {
        return res.status(400).json({ message: 'Reminder is not active' });
      }

      await reminder.update({ status });
      cancelReminder(reminder.id);

      res.status(200).json({ message: 'Reminder has been cancelled' });
    } catch (err) {
      next(err);
    }
  }

  static async deleteReminderById(req, res, next) {
    try {
      const id = req.params.id;

      const reminder = await Reminder.findByPk(id);
      if (!reminder) {
        throw { name: 'NotFound', message: 'Reminder not found' };
      }

      cancelReminder(reminder.id);

      await reminder.destroy();

      res.status(200).json({ message: 'Reminder has been deleted' });
    } catch (err) {
      next(err);
    }
  }

}

module.exports = ReminderController;
