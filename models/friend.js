'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Friend extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      Friend.belongsTo(models.User, { as: 'requester', foreignKey: 'UserId' });
      Friend.belongsTo(models.User, { as: 'receiver', foreignKey: 'FriendId' });

    }
  }
  Friend.init({
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