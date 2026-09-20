const { calculateCatalogAmount } = require('../src/utils/orderCatalogPricingV1');

module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.addColumn(
          'orders',
          'order_amount',
          {
            type: Sequelize.DECIMAL(12, 2),
            allowNull: true,
          },
          { transaction }
        );
        await queryInterface.addColumn(
          'orders',
          'order_amount_price_version',
          {
            type: Sequelize.STRING(40),
            allowNull: true,
          },
          { transaction }
        );
        let lastId = 0;
        for (;;) {
          const [rows] = await queryInterface.sequelize.query(
            'SELECT id, products FROM orders WHERE id > :lastId ORDER BY id LIMIT 500',
            { replacements: { lastId }, transaction }
          );
          if (!rows.length) break;
          const replacements = {};
          const values = rows.map((row, index) => {
            const pricing = calculateCatalogAmount(row.products);
            replacements[`id${index}`] = row.id;
            replacements[`amount${index}`] = pricing.orderAmount;
            replacements[`version${index}`] = pricing.orderAmountPriceVersion;
            return `(CAST(:id${index} AS integer), CAST(:amount${index} AS numeric), CAST(:version${index} AS text))`;
          });
          await queryInterface.sequelize.query(
            `UPDATE orders AS o SET order_amount = v.amount, order_amount_price_version = v.version FROM (VALUES ${values.join(',')}) AS v(id, amount, version) WHERE o.id = v.id`,
            { replacements, transaction }
          );
          lastId = rows[rows.length - 1].id;
        }
      });
    } catch (error) {
      throw new Error('订单价格映射迁移失败', { cause: error });
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.removeColumn('orders', 'order_amount_price_version', { transaction });
        await queryInterface.removeColumn('orders', 'order_amount', { transaction });
      });
    } catch (error) {
      throw new Error('订单价格映射回退失败', { cause: error });
    }
  },
};
