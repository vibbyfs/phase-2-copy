const { Reminder } = require('../models');
const { cancelReminder } = require('../services/scheduler');
const { Op } = require('sequelize');

class ReminderController {

  static async getAllReminders(req, res, next) {
    try {
      const userId = req.user.id;
      const { search, filter, sort } = req.query

      let queryOption = {
        where: {}
      }

      if (search) {
        queryOption.where = {
          title: { [Op.iLike]: `%${search}%` }
        }
      }

      if (filter) {
        queryOption.status = filter
      }

      if (sort) {
        queryOption.order = [
          ['createdAt', sort]
        ]
      }

      const reminders = await Reminder.findAll(queryOption, {
        where: { UserId: userId }
      })

      res.status(200).json(reminders)
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
