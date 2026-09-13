/** 为入库首次刷新增加独立标记，兼容历史首次排队任务。 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.removeConstraint(
        'order_refresh_jobs',
        'chk_order_refresh_jobs_trigger',
        { transaction }
      );
      await queryInterface.addConstraint('order_refresh_jobs', {
        fields: ['trigger'],
        type: 'check',
        name: 'chk_order_refresh_jobs_trigger',
        where: { trigger: ['initial', 'auto', 'page_open', 'manual_single', 'manual_all'] },
        transaction,
      });
      await queryInterface.sequelize.query(
        `
        UPDATE order_refresh_jobs j SET trigger = 'initial'
        FROM orders o
        WHERE j.order_id = o.id AND j.trigger = 'auto' AND j.status = 'pending'
          AND o.last_crawled_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM order_refresh_jobs older
            WHERE older.order_id = j.order_id AND older.id < j.id)
      `,
        { transaction }
      );
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query(
        "UPDATE order_refresh_jobs SET trigger = 'auto' WHERE trigger = 'initial'",
        { transaction }
      );
      await queryInterface.removeConstraint(
        'order_refresh_jobs',
        'chk_order_refresh_jobs_trigger',
        { transaction }
      );
      await queryInterface.addConstraint('order_refresh_jobs', {
        fields: ['trigger'],
        type: 'check',
        name: 'chk_order_refresh_jobs_trigger',
        where: { trigger: ['auto', 'page_open', 'manual_single', 'manual_all'] },
        transaction,
      });
    });
  },
};
