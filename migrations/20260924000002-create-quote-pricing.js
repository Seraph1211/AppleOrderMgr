module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.createTable(
          'quote_pricing_settings',
          {
            id: { type: Sequelize.SMALLINT, allowNull: false, primaryKey: true },
            public_enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            updated_by: {
              type: Sequelize.INTEGER,
              allowNull: true,
              references: { model: 'users', key: 'id' },
              onDelete: 'SET NULL',
            },
            created_at: { type: Sequelize.DATE, allowNull: false },
            updated_at: { type: Sequelize.DATE, allowNull: false },
          },
          { transaction }
        );
        await queryInterface.createTable(
          'quote_price_adjustments',
          {
            product_key: { type: Sequelize.STRING(191), allowNull: false, primaryKey: true },
            product_model: { type: Sequelize.STRING(32), allowNull: false },
            storage_gb: { type: Sequelize.INTEGER, allowNull: false },
            color: { type: Sequelize.STRING(32), allowNull: false },
            percentage: {
              type: Sequelize.DECIMAL(8, 4),
              allowNull: false,
              defaultValue: 0,
            },
            fixed_amount: {
              type: Sequelize.DECIMAL(12, 2),
              allowNull: false,
              defaultValue: 0,
            },
            updated_by: {
              type: Sequelize.INTEGER,
              allowNull: true,
              references: { model: 'users', key: 'id' },
              onDelete: 'SET NULL',
            },
            created_at: { type: Sequelize.DATE, allowNull: false },
            updated_at: { type: Sequelize.DATE, allowNull: false },
          },
          { transaction }
        );
        await queryInterface.createTable(
          'quote_pricing_versions',
          {
            id: { type: Sequelize.UUID, allowNull: false, primaryKey: true },
            revision: { type: Sequelize.INTEGER, allowNull: false, unique: true },
            action: { type: Sequelize.STRING(30), allowNull: false },
            snapshot: { type: Sequelize.JSONB, allowNull: false },
            summary: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
            actor_user_id: {
              type: Sequelize.INTEGER,
              allowNull: true,
              references: { model: 'users', key: 'id' },
              onDelete: 'SET NULL',
            },
            actor_name: { type: Sequelize.STRING(100), allowNull: false },
            created_at: { type: Sequelize.DATE, allowNull: false },
          },
          { transaction }
        );
        await queryInterface.addIndex('quote_pricing_versions', ['created_at'], { transaction });
        await queryInterface.sequelize.query(
          `ALTER TABLE quote_pricing_settings
             ADD CONSTRAINT quote_pricing_single_setting CHECK (id = 1),
             ADD CONSTRAINT quote_pricing_version_nonnegative CHECK (version >= 0);
           ALTER TABLE quote_price_adjustments
             ADD CONSTRAINT quote_adjustment_storage_positive CHECK (storage_gb > 0),
             ADD CONSTRAINT quote_adjustment_percentage_range CHECK (percentage >= -100 AND percentage <= 1000),
             ADD CONSTRAINT quote_adjustment_fixed_range CHECK (fixed_amount >= -100000 AND fixed_amount <= 100000);
           ALTER TABLE quote_pricing_versions
             ADD CONSTRAINT quote_pricing_revision_positive CHECK (revision > 0),
             ADD CONSTRAINT quote_pricing_action_valid CHECK (action IN ('bulk_adjust','reset','restore'));`,
          { transaction }
        );
        const now = new Date();
        await queryInterface.bulkInsert(
          'quote_pricing_settings',
          [{ id: 1, public_enabled: false, version: 0, created_at: now, updated_at: now }],
          { transaction }
        );
      });
    } catch (error) {
      throw new Error('公开报价调价迁移失败', { cause: error });
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.dropTable('quote_pricing_versions', { transaction });
        await queryInterface.dropTable('quote_price_adjustments', { transaction });
        await queryInterface.dropTable('quote_pricing_settings', { transaction });
      });
    } catch (error) {
      throw new Error('公开报价调价回滚失败', { cause: error });
    }
  },
};
