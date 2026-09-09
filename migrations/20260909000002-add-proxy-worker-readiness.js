module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.addColumn(
          'order_refresh_system_states',
          'worker_proxy_ready',
          {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
          },
          { transaction }
        );
        await queryInterface.addColumn(
          'order_refresh_system_states',
          'worker_proxy_error_code',
          {
            type: Sequelize.STRING(50),
            allowNull: true,
          },
          { transaction }
        );
      });
    } catch (error) {
      throw new Error('添加代理运行状态失败', { cause: error });
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.removeColumn(
          'order_refresh_system_states',
          'worker_proxy_error_code',
          { transaction }
        );
        await queryInterface.removeColumn('order_refresh_system_states', 'worker_proxy_ready', {
          transaction,
        });
      });
    } catch (error) {
      throw new Error('回退代理运行状态失败', { cause: error });
    }
  },
};
