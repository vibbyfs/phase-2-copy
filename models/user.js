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
      // User has many reminders as creator
      User.hasMany(models.Reminder, {
        foreignKey: 'UserId',
        as: 'reminders'
      });
      
      // User has many reminders as recipient
      User.hasMany(models.Reminder, {
        foreignKey: 'RecipientId',
        as: 'receivedReminders'
      });
      
      // User has many friends (self-referencing many-to-many)
      User.belongsToMany(models.User, {
        through: models.Friend,
        foreignKey: 'UserId',
        otherKey: 'FriendId',
        as: 'friends'
      });
      
      User.belongsToMany(models.User, {
        through: models.Friend,
        foreignKey: 'FriendId',
        otherKey: 'UserId',
        as: 'friendOf'
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
      allowNull: false,
      unique: true,
      validate: {
        notEmpty: {
          msg: 'Nomor telepon tidak boleh kosong.'
        },
        is: {
          args: /^\+\d{10,15}$/,
          msg: 'Format nomor telepon harus internasional, contoh: +6281234567890.'
        }
      }
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