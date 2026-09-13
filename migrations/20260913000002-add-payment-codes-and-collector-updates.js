const logger = require('../src/utils/logger');
('use strict');
module.exports = {
  async up(q, S) {
    try {
      await q.sequelize.transaction(async transaction => {
        const stamp = {
          type: S.DATE,
          allowNull: false,
          defaultValue: S.literal('CURRENT_TIMESTAMP'),
        };
        await q.createTable(
          'order_payment_codes',
          {
            id: { type: S.UUID, primaryKey: true, allowNull: false },
            device_id: {
              type: S.UUID,
              allowNull: false,
              references: { model: 'aos_devices', key: 'id' },
              onDelete: 'RESTRICT',
            },
            event_id: { type: S.UUID, allowNull: false },
            order_number: { type: S.STRING(11), allowNull: false },
            order_id: {
              type: S.INTEGER,
              allowNull: true,
              references: { model: 'orders', key: 'id' },
              onDelete: 'SET NULL',
            },
            source_time: { type: S.DATE, allowNull: false },
            image_hash: { type: S.STRING(64), allowNull: false },
            payload_hash: { type: S.STRING(64), allowNull: false },
            payload: { type: S.JSONB, allowNull: false },
            created_at: stamp,
            updated_at: stamp,
          },
          { transaction }
        );
        await q.addIndex('order_payment_codes', ['device_id', 'event_id'], {
          unique: true,
          transaction,
        });
        await q.addIndex('order_payment_codes', ['order_number', 'source_time'], { transaction });
        await q.addIndex('order_payment_codes', ['order_id', 'source_time', 'image_hash'], { transaction });
        await q.createTable(
          'collector_update_jobs',
          {
            id: { type: S.UUID, primaryKey: true, allowNull: false },
            device_id: {
              type: S.UUID,
              allowNull: false,
              references: { model: 'aos_devices', key: 'id' },
              onDelete: 'RESTRICT',
            },
            release_version: { type: S.STRING(32), allowNull: false },
            status: { type: S.STRING(20), allowNull: false, defaultValue: 'queued' },
            error_code: { type: S.STRING(80), allowNull: true },
            agent_version: { type: S.STRING(32), allowNull: true },
            actor_id: {
              type: S.INTEGER,
              allowNull: false,
              references: { model: 'users', key: 'id' },
              onDelete: 'RESTRICT',
            },
            created_at: stamp,
            updated_at: stamp,
          },
          { transaction }
        );
        await q.sequelize.query(
          "CREATE UNIQUE INDEX collector_update_jobs_active_device ON collector_update_jobs(device_id) WHERE status IN ('queued','downloading','installing')",
          { transaction }
        );
        await q.sequelize.query(
          "ALTER TABLE collector_update_jobs ADD CONSTRAINT collector_update_jobs_status_check CHECK (status IN ('queued','downloading','installing','succeeded','failed','rolled_back'))",
          { transaction }
        );
      });
    } catch (error) {
      logger.debug('付款码或采集更新操作未完成', {
        errorCode: error.code || 'TEMPORARILY_UNAVAILABLE',
      });
      throw error;
    }
  },
  async down(q) {
    try {
      await q.sequelize.transaction(async transaction => {
        await q.dropTable('collector_update_jobs', { transaction });
        await q.dropTable('order_payment_codes', { transaction });
      });
    } catch (error) {
      logger.debug('付款码或采集更新操作未完成', {
        errorCode: error.code || 'TEMPORARILY_UNAVAILABLE',
      });
      throw error;
    }
  },
};
