'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Friend extends Model {

    static associate(models) {
      Friend.belongsTo(models.User, { as: 'requester', foreignKey: 'UserId' });
      Friend.belongsTo(models.User, { as: 'receiver', foreignKey: 'FriendId' });

    }
  }
  Friend.init({
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true
    },
    UserId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    FriendId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    status: {
      type: DataTypes.ENUM('pending', 'accepted'),
      allowNull: false,
      defaultValue: 'pending'
    }
  }, {
    sequelize,
    modelName: 'Friend',
  });
  return Friend;
};