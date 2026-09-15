const logger = require('../src/utils/logger');

module.exports = {
  /** 创建服务器监控邮件通知设置、投递与事件表。 */
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.createTable(
          'monitor_notification_settings',
          {
            id: { type: Sequelize.SMALLINT, allowNull: false, primaryKey: true },
            enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            recipients: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
            send_recovery: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
            version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
            updated_by: {
              type: Sequelize.INTEGER,
              allowNull: true,
              references: { model: 'users', key: 'id' },
              onDelete: 'SET NULL',
            },
            created_at: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
            updated_at: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
          },
          { transaction }
        );
        await queryInterface.createTable(
          'monitor_notification_deliveries',
          {
            id: { type: Sequelize.UUID, allowNull: false, primaryKey: true },
            device_id: {
              type: Sequelize.UUID,
              allowNull: true,
              references: { model: 'aos_devices', key: 'id' },
              onDelete: 'SET NULL',
            },
            category: { type: Sequelize.STRING(20), allowNull: false },
            severity: { type: Sequelize.STRING(20), allowNull: false },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'pending' },
            not_before: { type: Sequelize.DATE, allowNull: false },
            recipient_snapshot: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
            attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            last_error: { type: Sequelize.STRING(500), allowNull: true },
            sent_at: { type: Sequelize.DATE, allowNull: true },
            created_at: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
            updated_at: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
          },
          { transaction }
        );
        await queryInterface.createTable(
          'monitor_notification_events',
          {
            id: { type: Sequelize.UUID, allowNull: false, primaryKey: true },
            delivery_id: {
              type: Sequelize.UUID,
              allowNull: false,
              references: { model: 'monitor_notification_deliveries', key: 'id' },
              onDelete: 'CASCADE',
            },
            source_key: { type: Sequelize.STRING(255), allowNull: false, unique: true },
            payload: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
            created_at: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
            updated_at: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
          },
          { transaction }
        );
        await queryInterface.addIndex('monitor_notification_deliveries', ['status', 'not_before'], {
          name: 'monitor_notification_delivery_due',
          transaction,
        });
        await queryInterface.addIndex(
          'monitor_notification_deliveries',
          ['device_id', 'created_at'],
          {
            name: 'monitor_notification_delivery_device',
            transaction,
          }
        );
        await queryInterface.addIndex('monitor_notification_events', ['delivery_id'], {
          name: 'monitor_notification_event_delivery',
          transaction,
        });
        await queryInterface.sequelize.query(
          `ALTER TABLE monitor_notification_settings
             ADD CONSTRAINT monitor_notification_settings_singleton CHECK (id = 1),
             ADD CONSTRAINT monitor_notification_settings_version CHECK (version >= 1),
             ADD CONSTRAINT monitor_notification_settings_recipients CHECK (jsonb_typeof(recipients) = 'array');
           ALTER TABLE monitor_notification_deliveries
             ADD CONSTRAINT monitor_notification_delivery_category CHECK (category IN ('alert','recovery','reminder','test')),
             ADD CONSTRAINT monitor_notification_delivery_severity CHECK (severity IN ('info','warning','critical')),
             ADD CONSTRAINT monitor_notification_delivery_status CHECK (status IN ('pending','sending','sent','skipped','failed')),
             ADD CONSTRAINT monitor_notification_delivery_attempts CHECK (attempts >= 0),
             ADD CONSTRAINT monitor_notification_delivery_recipients CHECK (jsonb_typeof(recipient_snapshot) = 'array');`,
          { transaction }
        );
        await queryInterface.bulkInsert(
          'monitor_notification_settings',
          [
            {
              id: 1,
              enabled: false,
              recipients: JSON.stringify([]),
              send_recovery: true,
              version: 1,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          { transaction }
        );
      });
    } catch (error) {
      logger.error('服务器监控邮件通知迁移失败', { errorCode: error.code || error.name });
      throw error;
    }
  },

  /** 删除服务器监控邮件通知设置、投递与事件表。 */
  async down(queryInterface) {
    try {
      await queryInterface.sequelize.transaction(async transaction => {
        await queryInterface.dropTable('monitor_notification_events', { transaction });
        await queryInterface.dropTable('monitor_notification_deliveries', { transaction });
        await queryInterface.dropTable('monitor_notification_settings', { transaction });
      });
    } catch (error) {
      logger.error('服务器监控邮件通知回滚失败', { errorCode: error.code || error.name });
      throw error;
    }
  },
};
