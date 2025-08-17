'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Reminders', 'repeatType', {
      type: Sequelize.ENUM('once', 'minutes', 'hours', 'daily', 'weekly', 'monthly', 'yearly'),
      allowNull: false,
      defaultValue: 'once'
    });

    await queryInterface.addColumn('Reminders', 'repeatInterval', {
      type: Sequelize.INTEGER,
      allowNull: true,
      comment: 'For minutes/hours: interval number. For weekly: day of week (0=Sunday). For monthly: day of month.'
    });

    await queryInterface.addColumn('Reminders', 'repeatEndDate', {
      type: Sequelize.DATE,
      allowNull: true,
      comment: 'Optional end date for recurring reminders'
    });

    await queryInterface.addColumn('Reminders', 'parentReminderId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'Reminders',
        key: 'id'
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
      comment: 'Reference to parent reminder for generated recurring instances'
    });

    await queryInterface.addColumn('Reminders', 'isRecurring', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'True if this is a recurring reminder template'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('Reminders', 'repeatType');
    await queryInterface.removeColumn('Reminders', 'repeatInterval');
    await queryInterface.removeColumn('Reminders', 'repeatEndDate');
    await queryInterface.removeColumn('Reminders', 'parentReminderId');
    await queryInterface.removeColumn('Reminders', 'isRecurring');
  }
};
