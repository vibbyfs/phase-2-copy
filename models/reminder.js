'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Reminder extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // Reminder belongs to User (creator)
      Reminder.belongsTo(models.User, {
        foreignKey: 'UserId',
        as: 'creator'
      });
      
      // Reminder belongs to User (recipient)
      Reminder.belongsTo(models.User, {
        foreignKey: 'RecipientId',
        as: 'recipient'
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