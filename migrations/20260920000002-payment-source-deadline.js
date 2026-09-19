/** 扩展付款截止来源；旧缓存按读取时来源时间派生，不迁移任务归属。 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.removeConstraint('payment_tasks', 'chk_payment_tasks_deadline_source', {
        transaction,
      });
      await queryInterface.addConstraint('payment_tasks', {
        fields: ['deadline_source'],
        type: 'check',
        name: 'chk_payment_tasks_deadline_source',
        where: { deadline_source: ['official', 'manual_verified', 'source_order'] },
        transaction,
      });
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query(
        "UPDATE payment_tasks SET deadline_at = NULL, deadline_source = NULL, version = version + 1 WHERE deadline_source = 'source_order'",
        { transaction }
      );
      await queryInterface.removeConstraint('payment_tasks', 'chk_payment_tasks_deadline_source', {
        transaction,
      });
      await queryInterface.addConstraint('payment_tasks', {
        fields: ['deadline_source'],
        type: 'check',
        name: 'chk_payment_tasks_deadline_source',
        where: { deadline_source: ['official', 'manual_verified'] },
        transaction,
      });
    });
  },
};
