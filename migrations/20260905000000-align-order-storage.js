'use strict';

/**
 * 收口订单标签长度与付款截图 JSONB 结构。
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const [columns] = await queryInterface.sequelize.query(`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'orders'
        AND column_name = 'payment_screenshot'
    `);

    if (columns[0]?.data_type !== 'jsonb') {
      await queryInterface.sequelize.query(`
        CREATE OR REPLACE FUNCTION migration_to_jsonb_array(value TEXT)
        RETURNS JSONB AS $$
        DECLARE parsed JSONB;
        BEGIN
          IF value IS NULL OR btrim(value) = '' THEN
            RETURN '[]'::JSONB;
          END IF;
          BEGIN
            parsed := value::JSONB;
            IF jsonb_typeof(parsed) = 'array' THEN
              RETURN parsed;
            END IF;
            RETURN jsonb_build_array(parsed);
          EXCEPTION WHEN others THEN
            RETURN jsonb_build_array(value);
          END;
        END;
        $$ LANGUAGE plpgsql IMMUTABLE;
      `);
      try {
        await queryInterface.sequelize.query(`
          ALTER TABLE orders
          ALTER COLUMN payment_screenshot TYPE JSONB
          USING migration_to_jsonb_array(payment_screenshot::TEXT)
        `);
      } finally {
        await queryInterface.sequelize.query('DROP FUNCTION migration_to_jsonb_array(TEXT)');
      }
    }
    await queryInterface.changeColumn('orders', 'payment_screenshot', {
      type: Sequelize.JSONB,
      allowNull: true,
      defaultValue: [],
    });
    await queryInterface.changeColumn('orders', 'tag', {
      type: Sequelize.STRING(500),
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('orders', 'tag', {
      type: Sequelize.STRING(100),
      allowNull: true,
    });
    await queryInterface.sequelize.query(`
      ALTER TABLE orders
      ALTER COLUMN payment_screenshot DROP DEFAULT,
      ALTER COLUMN payment_screenshot TYPE TEXT
      USING payment_screenshot::TEXT
    `);
  },
};
