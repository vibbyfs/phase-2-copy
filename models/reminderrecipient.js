'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ReminderRecipient extends Model {
    static associate(models) {
      // Define associations here
      ReminderRecipient.belongsTo(models.Reminder, {
        foreignKey: 'ReminderId',
        as: 'reminder'
      });
      ReminderRecipient.belongsTo(models.User, {
        foreignKey: 'RecipientId',
        as: 'recipient'
      });
    }
  }

  ReminderRecipient.init({
    ReminderId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    RecipientId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    status: {
      type: DataTypes.ENUM('scheduled', 'sent', 'cancelled'),
      allowNull: false,
      defaultValue: 'scheduled'
    },
    sentAt: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'ReminderRecipient',
    indexes: [
      {
        unique: true,
        fields: ['ReminderId', 'RecipientId']
      },
      {
        fields: ['RecipientId']
      },
      {
        fields: ['status']
      }
    ]
  });

  return ReminderRecipient;
};
