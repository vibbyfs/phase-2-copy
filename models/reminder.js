'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Reminder extends Model {
    static associate(models) {
      // Define associations here
      Reminder.belongsTo(models.User, {
        foreignKey: 'UserId',
        as: 'user'
      });
      
      Reminder.belongsTo(models.User, {
        foreignKey: 'RecipientId',
        as: 'recipient'
      });

      // Many-to-Many relationship with Users through ReminderRecipients
      Reminder.hasMany(models.ReminderRecipient, {
        foreignKey: 'ReminderId',
        as: 'reminderRecipients'
      });

      // Convenient method to get all recipients
      Reminder.belongsToMany(models.User, {
        through: models.ReminderRecipient,
        foreignKey: 'ReminderId',
        otherKey: 'RecipientId',
        as: 'recipients'
      });

      // Parent-child relationship for recurring reminders
      Reminder.belongsTo(models.Reminder, {
        foreignKey: 'parentReminderId',
        as: 'parentReminder'
      });

      Reminder.hasMany(models.Reminder, {
        foreignKey: 'parentReminderId',
        as: 'childReminders'
      });
    }
  }
  Reminder.init({
    UserId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    RecipientId: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false
    },
    dueAt: {
      type: DataTypes.DATE,
      allowNull: false
    },
    repeat: {
      type: DataTypes.ENUM('none', 'hourly', 'daily', 'weekly', 'monthly'),
      allowNull: false,
      defaultValue: 'none'
    },
    repeatType: {
      type: DataTypes.ENUM('once', 'minutes', 'hours', 'daily', 'weekly', 'monthly', 'yearly'),
      allowNull: false,
      defaultValue: 'once'
    },
    repeatInterval: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    repeatEndDate: {
      type: DataTypes.DATE,
      allowNull: true
    },
    parentReminderId: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    isRecurring: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    status: {
      type: DataTypes.ENUM('scheduled', 'sent', 'cancelled'),
      allowNull: false,
      defaultValue: 'scheduled'
    },
    formattedMessage: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'Reminder',
  });
  return Reminder;
};