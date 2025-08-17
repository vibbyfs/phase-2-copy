'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Reminder extends Model {

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