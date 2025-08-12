'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('Reminders', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      UserId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      RecipientId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      title: {
        type: Sequelize.STRING,
        allowNull: false
      },
      dueAt: {
        type: Sequelize.DATE,
        allowNull: false
      },
      repeat: {
        type: Sequelize.ENUM('none', 'hourly', 'daily', 'weekly', 'monthly'),
        allowNull: false,
        defaultValue: 'none'
      },
      status: {
        type: Sequelize.ENUM('scheduled', 'sent', 'cancelled'),
        allowNull: false,
        defaultValue: 'scheduled'
      },
      formattedMessage: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('Reminders');
  }
};
