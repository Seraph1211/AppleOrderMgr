'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.addColumn(
        'aos_devices',
        'credential_ciphertext',
        { type: Sequelize.TEXT, allowNull: true },
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.removeColumn('aos_devices', 'credential_ciphertext', { transaction });
    });
  },
};
