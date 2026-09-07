/**
 * 为订单刷新单例状态增加运行时代理 Provider 切换字段。
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.addColumn(
        'order_refresh_system_states',
        'requested_proxy_provider',
        { type: Sequelize.STRING(30), allowNull: true },
        { transaction }
      );
      await queryInterface.addColumn(
        'order_refresh_system_states',
        'active_proxy_provider',
        { type: Sequelize.STRING(30), allowNull: true },
        { transaction }
      );
      await queryInterface.addColumn(
        'order_refresh_system_states',
        'proxy_switch_status',
        { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'idle' },
        { transaction }
      );
      await queryInterface.addColumn(
        'order_refresh_system_states',
        'proxy_switch_error_code',
        { type: Sequelize.STRING(50), allowNull: true },
        { transaction }
      );
      await queryInterface.addColumn(
        'order_refresh_system_states',
        'proxy_switch_error_message',
        { type: Sequelize.TEXT, allowNull: true },
        { transaction }
      );
      await queryInterface.addColumn(
        'order_refresh_system_states',
        'proxy_switch_requested_at',
        { type: Sequelize.DATE, allowNull: true },
        { transaction }
      );
      await queryInterface.addColumn(
        'order_refresh_system_states',
        'proxy_switched_at',
        { type: Sequelize.DATE, allowNull: true },
        { transaction }
      );

      await queryInterface.addConstraint('order_refresh_system_states', {
        fields: ['requested_proxy_provider'],
        type: 'check',
        name: 'chk_order_refresh_requested_proxy_provider',
        where: { requested_proxy_provider: ['kdl_tunnel', 'kdl_private'] },
        transaction,
      });
      await queryInterface.addConstraint('order_refresh_system_states', {
        fields: ['active_proxy_provider'],
        type: 'check',
        name: 'chk_order_refresh_active_proxy_provider',
        where: { active_proxy_provider: ['kdl_tunnel', 'kdl_private'] },
        transaction,
      });
      await queryInterface.addConstraint('order_refresh_system_states', {
        fields: ['proxy_switch_status'],
        type: 'check',
        name: 'chk_order_refresh_proxy_switch_status',
        where: {
          proxy_switch_status: ['idle', 'pending', 'switching', 'succeeded', 'failed'],
        },
        transaction,
      });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.removeConstraint(
        'order_refresh_system_states',
        'chk_order_refresh_proxy_switch_status',
        { transaction }
      );
      await queryInterface.removeConstraint(
        'order_refresh_system_states',
        'chk_order_refresh_active_proxy_provider',
        { transaction }
      );
      await queryInterface.removeConstraint(
        'order_refresh_system_states',
        'chk_order_refresh_requested_proxy_provider',
        { transaction }
      );

      for (const column of [
        'proxy_switched_at',
        'proxy_switch_requested_at',
        'proxy_switch_error_message',
        'proxy_switch_error_code',
        'proxy_switch_status',
        'active_proxy_provider',
        'requested_proxy_provider',
      ]) {
        await queryInterface.removeColumn('order_refresh_system_states', column, { transaction });
      }
    });
  },
};
