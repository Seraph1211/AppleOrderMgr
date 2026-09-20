const { randomUUID } = require('crypto');

module.exports = {
  async up(qi, Sequelize) {
    try {
      await qi.sequelize.transaction(async transaction => {
        await qi.createTable(
          'wecom_notification_settings',
          {
            id: { type: Sequelize.SMALLINT, allowNull: false, primaryKey: true },
            enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            group_name: { type: Sequelize.STRING(100), allowNull: false, defaultValue: '' },
            webhook_cipher: { type: Sequelize.TEXT, allowNull: true },
            destination_id: { type: Sequelize.UUID, allowNull: false },
            enabled_at: { type: Sequelize.DATE, allowNull: true },
            version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
            next_send_at: { type: Sequelize.DATE, allowNull: true },
            paused_reason: { type: Sequelize.STRING(50), allowNull: true },
            worker_heartbeat_at: { type: Sequelize.DATE, allowNull: true },
            updated_by: { type: Sequelize.INTEGER, allowNull: true },
            created_at: { type: Sequelize.DATE, allowNull: false },
            updated_at: { type: Sequelize.DATE, allowNull: false },
          },
          { transaction }
        );
        await qi.createTable(
          'wecom_notification_deliveries',
          {
            id: { type: Sequelize.UUID, allowNull: false, primaryKey: true },
            order_id: {
              type: Sequelize.INTEGER,
              allowNull: true,
              references: { model: 'orders', key: 'id' },
              onDelete: 'SET NULL',
            },
            destination_id: { type: Sequelize.UUID, allowNull: false },
            group_name: { type: Sequelize.STRING(100), allowNull: false },
            kind: { type: Sequelize.STRING(10), allowNull: false },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'pending' },
            wait_until: { type: Sequelize.DATE, allowNull: false },
            not_before: { type: Sequelize.DATE, allowNull: false },
            attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
            lease_token: { type: Sequelize.UUID, allowNull: true },
            lease_until: { type: Sequelize.DATE, allowNull: true },
            dispatch_started_at: { type: Sequelize.DATE, allowNull: true },
            sent_at: { type: Sequelize.DATE, allowNull: true },
            error_code: { type: Sequelize.STRING(50), allowNull: true },
            request_key: { type: Sequelize.UUID, allowNull: true },
            actor_id: { type: Sequelize.INTEGER, allowNull: true },
            created_at: { type: Sequelize.DATE, allowNull: false },
            updated_at: { type: Sequelize.DATE, allowNull: false },
          },
          { transaction }
        );
        await qi.addIndex('wecom_notification_deliveries', ['order_id'], {
          unique: true,
          transaction,
        });
        await qi.addIndex('wecom_notification_deliveries', ['request_key'], {
          unique: true,
          transaction,
        });
        await qi.addIndex('wecom_notification_deliveries', ['status', 'created_at', 'id'], {
          transaction,
        });
        await qi.sequelize.query(
          `ALTER TABLE wecom_notification_settings ADD CONSTRAINT wecom_single_setting CHECK (id = 1);
          ALTER TABLE wecom_notification_deliveries ADD CONSTRAINT wecom_delivery_status CHECK (status IN ('pending','waiting','sending','accepted','failed','unknown','skipped'));
          ALTER TABLE wecom_notification_deliveries ADD CONSTRAINT wecom_delivery_kind CHECK (kind IN ('order','test'));`,
          { transaction }
        );
        await qi.bulkInsert(
          'wecom_notification_settings',
          [
            {
              id: 1,
              enabled: false,
              group_name: '',
              destination_id: randomUUID(),
              version: 1,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          { transaction }
        );
      });
    } catch (error) {
      throw new Error('企微通知迁移失败', { cause: error });
    }
  },
  async down(qi) {
    try {
      await qi.sequelize.transaction(async transaction => {
        await qi.dropTable('wecom_notification_deliveries', { transaction });
        await qi.dropTable('wecom_notification_settings', { transaction });
      });
    } catch (error) {
      throw new Error('企微通知回滚失败', { cause: error });
    }
  },
};
