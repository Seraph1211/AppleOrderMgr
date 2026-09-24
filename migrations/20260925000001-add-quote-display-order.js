module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.addColumn(
          'quote_pricing_settings',
          'display_order',
          {
            type: Sequelize.JSONB,
            allowNull: false,
            defaultValue: [],
          },
          { transaction }
        );
        await queryInterface.sequelize.query(
          `ALTER TABLE quote_pricing_settings
             ADD CONSTRAINT quote_pricing_display_order_array
             CHECK (jsonb_typeof(display_order) = 'array');`,
          { transaction }
        );
      });
    } catch (error) {
      throw new Error('公开报价展示顺序迁移失败', { cause: error });
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.sequelize.query(
          `ALTER TABLE quote_pricing_settings
             DROP CONSTRAINT IF EXISTS quote_pricing_display_order_array;`,
          { transaction }
        );
        await queryInterface.removeColumn('quote_pricing_settings', 'display_order', {
          transaction,
        });
      });
    } catch (error) {
      throw new Error('公开报价展示顺序回滚失败', { cause: error });
    }
  },
};
