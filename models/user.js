'use strict';
const {
  Model
} = require('sequelize');
const { hashedPassword } = require('../helpers/bcryptjs');
module.exports = (sequelize, DataTypes) => {
  class User extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      User.hasMany(models.Reminder, {
        foreignKey: 'UserId',
        as: 'createdReminders'
      });

      User.hasMany(models.Reminder, {
        foreignKey: 'RecipientId',
        as: 'receivedReminders'
      });

      User.hasMany(models.ReminderRecipient, {
        foreignKey: 'RecipientId',
        as: 'reminderRecipients'
      });

      User.belongsToMany(models.Reminder, {
        through: models.ReminderRecipient,
        foreignKey: 'RecipientId',
        otherKey: 'ReminderId',
        as: 'reminders'
      });

      User.hasMany(models.Friend, {
        foreignKey: 'UserId',
        as: 'sentFriendRequests'
      });

      User.hasMany(models.Friend, {
        foreignKey: 'FriendId',
        as: 'receivedFriendRequests'
      });
    }
  }
  User.init({
    username: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notEmpty: {
          msg: 'Username tidak boleh kosong.'
        },
        len: {
          args: [3, 50],
          msg: 'Username harus antara 3 sampai 50 karakter.'
        }
      }
    },
    phone: {
      type: DataTypes.STRING,
      defaultValue: "-"
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: {
        msg: 'Email is already exists'
      },
      validate: {
        notEmpty: {
          msg: 'Email tidak boleh kosong.'
        },
        isEmail: {
          msg: 'Format email tidak valid.'
        }
      }
    },
    password: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notEmpty: {
          msg: 'Password tidak boleh kosong.'
        },
        len: {
          args: [8, 100],
          msg: 'Password minimal 8 karakter.'
        }
      }
    },
    timezone: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'Asia/Jakarta',
      validate: {
        notEmpty: {
          msg: 'Timezone tidak boleh kosong.'
        }
      }
    }
  }, {
    sequelize,
    modelName: 'User',
  });
  User.beforeCreate((user) => {
    user.password = hashedPassword(user.password)
  })
  return User;
};