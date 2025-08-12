'use strict';

const { hashedPassword } = require('../helpers/bcryptjs');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    /**
     * Add seed commands here.
     *
     * Example:
     * await queryInterface.bulkInsert('People', [{
     *   name: 'John Doe',
     *   isBetaMember: false
     * }], {});
    */

    const usersData = require('../data/users.json')
    const reminderssData = require('../data/reminders.json')
    const friendsData = require('../data/friends.json')

    const insertDataUsers = usersData.map((ud) => {
      const hashPassword = hashedPassword(ud.password);
      const { id, ...rest } = ud;

      return {
        ...rest,
        password: hashPassword,
        createdAt: new Date(),
        updatedAt: new Date()
      };
    });

    await queryInterface.bulkInsert('Users', insertDataUsers);


    const insertDataReminders = reminderssData.map((rd) => {
      const { id, ...rest } = rd;
      return {
        ...rest,
        createdAt: new Date(),
        updatedAt: new Date()
      };
    });

    await queryInterface.bulkInsert('Reminders', insertDataReminders);


    const insertDataFriends = friendsData.map((fd) => {
      const { id, ...rest } = fd;
      return {
        ...rest,
        createdAt: new Date(),
        updatedAt: new Date()
      };
    });

    await queryInterface.bulkInsert('Friends', insertDataFriends);


  },

  async down(queryInterface, Sequelize) {
    /**
     * Add commands to revert seed here.
     *
     * Example:
     * await queryInterface.bulkDelete('People', null, {});
     */
    await queryInterface.bulkDelete('Friends', null, {
      truncate: true,
      restartIdentity: true,
      cascade: true
    })

    await queryInterface.bulkDelete('Reminders', null, {
      truncate: true,
      restartIdentity: true,
      cascade: true
    })

    await queryInterface.bulkDelete('Users', null, {
      truncate: true,
      restartIdentity: true,
      cascade: true
    })
  }
};
