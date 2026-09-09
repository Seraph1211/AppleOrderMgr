/* eslint-disable camelcase -- Migration使用数据库列名 */
module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        const timestamps = {
          created_at: { type: Sequelize.DATE, allowNull: false },
          updated_at: { type: Sequelize.DATE, allowNull: false },
        };
        await queryInterface.createTable(
          'identity_verification_batches',
          {
            id: { type: Sequelize.UUID, primaryKey: true },
            user_id: {
              type: Sequelize.INTEGER,
              allowNull: false,
              references: { model: 'users', key: 'id' },
              onDelete: 'RESTRICT',
            },
            source: { type: Sequelize.STRING(10), allowNull: false },
            status: { type: Sequelize.STRING(20), allowNull: false },
            idempotency_key: { type: Sequelize.UUID },
            request_hash: { type: Sequelize.STRING(64) },
            summary: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
            message: { type: Sequelize.STRING(255) },
            expires_at: { type: Sequelize.DATE },
            ...timestamps,
          },
          { transaction }
        );
        await queryInterface.addIndex(
          'identity_verification_batches',
          ['user_id', 'idempotency_key'],
          { unique: true, transaction }
        );
        await queryInterface.addIndex('identity_verification_batches', ['user_id', 'created_at'], {
          transaction,
        });
        await queryInterface.addIndex('identity_verification_batches', ['status'], { transaction });
        await queryInterface.createTable(
          'identity_verification_items',
          {
            id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
            batch_id: {
              type: Sequelize.UUID,
              allowNull: false,
              references: { model: 'identity_verification_batches', key: 'id' },
              onDelete: 'RESTRICT',
            },
            row_number: { type: Sequelize.INTEGER, allowNull: false },
            name: { type: Sequelize.TEXT, allowNull: false },
            id_card_number: { type: Sequelize.TEXT, allowNull: false },
            status: { type: Sequelize.STRING(20), allowNull: false },
            duplicate_of: { type: Sequelize.INTEGER },
            message: { type: Sequelize.STRING(255) },
            result_data: { type: Sequelize.TEXT },
            started_at: { type: Sequelize.DATE },
            finished_at: { type: Sequelize.DATE },
            ...timestamps,
          },
          { transaction }
        );
        await queryInterface.addIndex('identity_verification_items', ['batch_id', 'row_number'], {
          unique: true,
          transaction,
        });
        await queryInterface.addIndex('identity_verification_items', ['batch_id', 'status'], {
          transaction,
        });
        await queryInterface.addIndex('identity_verification_items', ['started_at'], {
          transaction,
        });
        await queryInterface.sequelize.query(
          "ALTER TABLE identity_verification_batches ADD CONSTRAINT identity_batch_status CHECK (status IN ('draft','queued','running','paused','completed','cancelled')), ADD CONSTRAINT identity_batch_source CHECK (source IN ('single','excel'))",
          { transaction }
        );
        await queryInterface.sequelize.query(
          "ALTER TABLE identity_verification_items ADD CONSTRAINT identity_item_status CHECK (status IN ('pending','processing','matched','mismatched','error','unknown','invalid','duplicate','cancelled'))",
          { transaction }
        );
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error('身份核验操作失败');
    }
  },
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.dropTable('identity_verification_items', { transaction });
        await queryInterface.dropTable('identity_verification_batches', { transaction });
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error('身份核验操作失败');
    }
  },
};
