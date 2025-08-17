'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('ReminderRecipients', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      ReminderId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Reminders', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      RecipientId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      status: {
        type: Sequelize.ENUM('scheduled', 'sent', 'cancelled'),
        allowNull: false,
        defaultValue: 'scheduled'
      },
      sentAt: {
        type: Sequelize.DATE,
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

    // Add indexes for better performance
    await queryInterface.addIndex('ReminderRecipients', ['ReminderId', 'RecipientId'], {
      unique: true,
      name: 'unique_reminder_recipient'
    });
    await queryInterface.addIndex('ReminderRecipients', ['RecipientId']);
    await queryInterface.addIndex('ReminderRecipients', ['status']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('ReminderRecipients');
  }
};
