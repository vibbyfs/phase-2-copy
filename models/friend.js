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
      // Friend belongs to User (user who initiated the friendship)
      Friend.belongsTo(models.User, {
        foreignKey: 'UserId',
        as: 'user'
      });
      
      // Friend belongs to User (friend)
      Friend.belongsTo(models.User, {
        foreignKey: 'FriendId',
        as: 'friend'
      });
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