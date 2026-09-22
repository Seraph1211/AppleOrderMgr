/** 全局邮件通讯录；删除联系人不影响已有转发快照。 */
module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.createTable('mail_contacts', {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        name: { type: Sequelize.STRING(100), allowNull: false },
        email: { type: Sequelize.STRING(254), allowNull: false, unique: true },
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      });
    } catch (error) {
      error.migration = 'mail_contacts';
      throw error;
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.dropTable('mail_contacts');
    } catch (error) {
      error.migration = 'mail_contacts';
      throw error;
    }
  },
};
