module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        const actorReference = {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'users', key: 'id' },
          onDelete: 'SET NULL',
        };
        await queryInterface.createTable(
          'duo_quote_pricing_settings',
          {
            id: { type: Sequelize.SMALLINT, allowNull: false, primaryKey: true },
            version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            pricing_updated_at: { type: Sequelize.DATE, allowNull: true },
            updated_by: { ...actorReference },
            created_at: { type: Sequelize.DATE, allowNull: false },
            updated_at: { type: Sequelize.DATE, allowNull: false },
          },
          { transaction }
        );
        await queryInterface.createTable(
          'duo_quote_price_adjustments',
          {
            product_key: { type: Sequelize.STRING(40), allowNull: false, primaryKey: true },
            product_model: { type: Sequelize.STRING(32), allowNull: false },
            storage_gb: { type: Sequelize.INTEGER, allowNull: false },
            color: { type: Sequelize.STRING(32), allowNull: false },
            markup: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 50 },
            updated_by: { ...actorReference },
            created_at: { type: Sequelize.DATE, allowNull: false },
            updated_at: { type: Sequelize.DATE, allowNull: false },
          },
          { transaction }
        );
        await queryInterface.createTable(
          'duo_quote_pricing_versions',
          {
            id: { type: Sequelize.UUID, allowNull: false, primaryKey: true },
            revision: { type: Sequelize.INTEGER, allowNull: false, unique: true },
            action: { type: Sequelize.STRING(30), allowNull: false },
            snapshot: { type: Sequelize.JSONB, allowNull: false },
            summary: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
            actor_user_id: { ...actorReference },
            actor_name: { type: Sequelize.STRING(100), allowNull: false },
            created_at: { type: Sequelize.DATE, allowNull: false },
          },
          { transaction }
        );
        await queryInterface.sequelize.query(
          `
          ALTER TABLE duo_quote_pricing_settings
            ADD CONSTRAINT duo_quote_single_setting CHECK (id = 1),
            ADD CONSTRAINT duo_quote_version_nonnegative CHECK (version >= 0);
          ALTER TABLE duo_quote_price_adjustments
            ADD CONSTRAINT duo_quote_product_key_valid CHECK (product_key ~ '^[a-f0-9]{40}$'),
            ADD CONSTRAINT duo_quote_model_valid CHECK (product_model = 'Duo'),
            ADD CONSTRAINT duo_quote_storage_valid CHECK (storage_gb IN (256,512,1024,2048)),
            ADD CONSTRAINT duo_quote_color_valid CHECK (color IN ('星光白色','夜空色')),
            ADD CONSTRAINT duo_quote_markup_range CHECK (markup >= -100000 AND markup <= 100000);
          ALTER TABLE duo_quote_pricing_versions
            ADD CONSTRAINT duo_quote_revision_positive CHECK (revision > 0),
            ADD CONSTRAINT duo_quote_action_valid CHECK (action IN ('adjust','reset','restore')),
            ADD CONSTRAINT duo_quote_snapshot_array CHECK (jsonb_typeof(snapshot) = 'array' AND jsonb_array_length(snapshot) = 8);
        `,
          { transaction }
        );
        await queryInterface.addIndex(
          'duo_quote_price_adjustments',
          ['product_model', 'storage_gb', 'color'],
          {
            name: 'duo_quote_product_identity_unique',
            unique: true,
            transaction,
          }
        );
        const now = new Date();
        await queryInterface.bulkInsert(
          'duo_quote_pricing_settings',
          [
            {
              id: 1,
              version: 0,
              pricing_updated_at: null,
              created_at: now,
              updated_at: now,
            },
          ],
          { transaction }
        );
      });
    } catch (error) {
      throw new Error('Duo报价管理迁移失败', { cause: error });
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.dropTable('duo_quote_pricing_versions', { transaction });
        await queryInterface.dropTable('duo_quote_price_adjustments', { transaction });
        await queryInterface.dropTable('duo_quote_pricing_settings', { transaction });
      });
    } catch (error) {
      throw new Error('Duo报价管理回滚失败', { cause: error });
    }
  },
};
