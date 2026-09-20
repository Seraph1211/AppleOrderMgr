const { buildProductFilterItems } = require('../src/utils/productFilter');

module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.addColumn(
          'orders',
          'product_filter_items',
          {
            type: Sequelize.JSONB,
            allowNull: false,
            defaultValue: [],
          },
          { transaction }
        );
        let lastId = 0;
        for (;;) {
          const [rows] = await queryInterface.sequelize.query(
            'SELECT id, products, source_snapshot FROM orders WHERE id > :lastId ORDER BY id LIMIT 500',
            { replacements: { lastId }, transaction }
          );
          if (!rows.length) break;
          const replacements = {};
          const values = rows.map((row, index) => {
            replacements[`id${index}`] = row.id;
            replacements[`items${index}`] = JSON.stringify(
              buildProductFilterItems(row.products, [], row.source_snapshot?.products)
            );
            return `(CAST(:id${index} AS integer), CAST(:items${index} AS jsonb))`;
          });
          await queryInterface.sequelize.query(
            `UPDATE orders AS o SET product_filter_items = v.items FROM (VALUES ${values.join(',')}) AS v(id, items) WHERE o.id = v.id`,
            { replacements, transaction }
          );
          lastId = rows[rows.length - 1].id;
        }
      });
    } catch (error) {
      throw new Error('商品筛选处理失败', { cause: error });
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.removeColumn('orders', 'product_filter_items');
    } catch (error) {
      throw new Error('商品筛选处理失败', { cause: error });
    }
  },
};
