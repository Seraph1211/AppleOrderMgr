'use strict';

/**
 * 增加官网订单创建时间，用于派生固定 30 分钟付款窗口。
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.addColumn(
        'orders',
        'official_order_created_at',
        {
          type: Sequelize.DATE,
          allowNull: true,
          comment: '官网订单创建时间（必须包含时分）',
        },
        { transaction }
      );
      await queryInterface.addIndex('orders', ['official_order_created_at'], {
        name: 'idx_orders_official_order_created_at',
        transaction,
      });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.removeIndex('orders', 'idx_orders_official_order_created_at', {
        transaction,
      });
      await queryInterface.removeColumn('orders', 'official_order_created_at', { transaction });
    });
  },
};
