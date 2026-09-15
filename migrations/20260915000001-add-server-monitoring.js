const logger = require('../src/utils/logger');
module.exports = {
  /** 创建监控表。 */
  async up(q, S) {
    try {
      await q.sequelize.transaction(async transaction => {
        try {
          await q.createTable(
            'monitor_rules',
            {
              id: { type: S.UUID, allowNull: false, primaryKey: true },
              version: { type: S.INTEGER, allowNull: false, defaultValue: 1 },
              config: { type: S.JSONB, allowNull: false, defaultValue: {} },
              created_at: {
                type: S.DATE,
                allowNull: false,
                defaultValue: S.literal('CURRENT_TIMESTAMP'),
              },
              updated_at: {
                type: S.DATE,
                allowNull: false,
                defaultValue: S.literal('CURRENT_TIMESTAMP'),
              },
            },
            { transaction }
          );
          await q.createTable(
            'monitor_instances',
            {
              id: { type: S.UUID, allowNull: false, primaryKey: true },
              device_id: {
                type: S.UUID,
                allowNull: false,
                references: { model: 'aos_devices', key: 'id' },
                onDelete: 'RESTRICT',
              },
              local_id: { type: S.UUID, allowNull: false },
              label: { type: S.STRING(100), allowNull: false },
              active: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
              observed_at: { type: S.DATE, allowNull: true },
              snapshot: { type: S.JSONB, allowNull: false, defaultValue: {} },
              handling: { type: S.JSONB, allowNull: false, defaultValue: {} },
              version: { type: S.INTEGER, allowNull: false, defaultValue: 1 },
              created_at: {
                type: S.DATE,
                allowNull: false,
                defaultValue: S.literal('CURRENT_TIMESTAMP'),
              },
              updated_at: {
                type: S.DATE,
                allowNull: false,
                defaultValue: S.literal('CURRENT_TIMESTAMP'),
              },
            },
            { transaction }
          );
          await q.createTable(
            'monitor_traffic',
            {
              id: { type: S.UUID, allowNull: false, primaryKey: true },
              device_id: {
                type: S.UUID,
                allowNull: false,
                references: { model: 'aos_devices', key: 'id' },
                onDelete: 'RESTRICT',
              },
              started_at: { type: S.DATE, allowNull: false },
              ended_at: { type: S.DATE, allowNull: false },
              received_bytes: { type: S.BIGINT, allowNull: false, defaultValue: 0 },
              sent_bytes: { type: S.BIGINT, allowNull: false, defaultValue: 0 },
              collector_received_bytes: { type: S.BIGINT, allowNull: false, defaultValue: 0 },
              collector_sent_bytes: { type: S.BIGINT, allowNull: false, defaultValue: 0 },
              quality: { type: S.STRING(20), allowNull: false },
              payload_hash: { type: S.STRING(64), allowNull: false },
              created_at: {
                type: S.DATE,
                allowNull: false,
                defaultValue: S.literal('CURRENT_TIMESTAMP'),
              },
              updated_at: {
                type: S.DATE,
                allowNull: false,
                defaultValue: S.literal('CURRENT_TIMESTAMP'),
              },
            },
            { transaction }
          );
          await q.createTable(
            'monitor_alerts',
            {
              id: { type: S.UUID, allowNull: false, primaryKey: true },
              instance_id: {
                type: S.UUID,
                allowNull: false,
                references: { model: 'monitor_instances', key: 'id' },
                onDelete: 'RESTRICT',
              },
              rule_id: {
                type: S.UUID,
                allowNull: false,
                references: { model: 'monitor_rules', key: 'id' },
                onDelete: 'RESTRICT',
              },
              rule_version: { type: S.INTEGER, allowNull: false },
              rule_name: { type: S.STRING(100), allowNull: false },
              severity: { type: S.STRING(20), allowNull: false },
              status: { type: S.STRING(20), allowNull: false },
              hit_count: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
              quiet_checks: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
              first_seen_at: { type: S.DATE, allowNull: false },
              last_seen_at: { type: S.DATE, allowNull: false },
              recovered_at: { type: S.DATE, allowNull: true },
              samples: { type: S.JSONB, allowNull: false, defaultValue: [] },
              created_at: {
                type: S.DATE,
                allowNull: false,
                defaultValue: S.literal('CURRENT_TIMESTAMP'),
              },
              updated_at: {
                type: S.DATE,
                allowNull: false,
                defaultValue: S.literal('CURRENT_TIMESTAMP'),
              },
            },
            { transaction }
          );
          await q.createTable(
            'monitor_actions',
            {
              id: { type: S.UUID, allowNull: false, primaryKey: true },
              instance_id: {
                type: S.UUID,
                allowNull: true,
                references: { model: 'monitor_instances', key: 'id' },
                onDelete: 'RESTRICT',
              },
              actor_id: {
                type: S.INTEGER,
                allowNull: false,
                references: { model: 'users', key: 'id' },
                onDelete: 'RESTRICT',
              },
              action: { type: S.STRING(30), allowNull: false },
              note: { type: S.STRING(500), allowNull: false, defaultValue: '' },
              details: { type: S.JSONB, allowNull: false, defaultValue: {} },
              created_at: {
                type: S.DATE,
                allowNull: false,
                defaultValue: S.literal('CURRENT_TIMESTAMP'),
              },
              updated_at: {
                type: S.DATE,
                allowNull: false,
                defaultValue: S.literal('CURRENT_TIMESTAMP'),
              },
            },
            { transaction }
          );
          await q.addIndex('monitor_instances', ['device_id', 'local_id'], {
            unique: true,
            transaction,
          });
          await q.addIndex('monitor_traffic', ['device_id', 'ended_at'], { transaction });
          await q.addIndex('monitor_traffic', ['ended_at'], { transaction });
          await q.addIndex('monitor_alerts', ['instance_id', 'rule_id'], {
            unique: true,
            where: { status: 'active' },
            name: 'monitor_alert_active_unique',
            transaction,
          });
          await q.addIndex('monitor_alerts', ['instance_id', 'last_seen_at'], { transaction });
          await q.addIndex('monitor_actions', ['instance_id', 'created_at'], { transaction });
          await q.sequelize.query(
            'ALTER TABLE monitor_traffic ADD CONSTRAINT monitor_traffic_range CHECK (ended_at > started_at AND received_bytes >= 0 AND sent_bytes >= 0 AND collector_received_bytes >= 0 AND collector_sent_bytes >= 0)',
            { transaction }
          );
        } catch (error) {
          logger.debug('监控操作未完成', { errorCode: error.code || error.name });
          throw error;
        }
      });
    } catch (error) {
      logger.error('创建监控表失败', { errorCode: error.name });
      throw error;
    }
  },
  /** 回滚监控表结构，仅用于受控迁移。 */
  async down(q) {
    try {
      await q.sequelize.transaction(async transaction => {
        try {
          for (const table of [
            'monitor_actions',
            'monitor_alerts',
            'monitor_traffic',
            'monitor_instances',
            'monitor_rules',
          ])
            await q.dropTable(table, { transaction });
        } catch (error) {
          logger.debug('监控操作未完成', { errorCode: error.code || error.name });
          throw error;
        }
      });
    } catch (error) {
      logger.error('回滚监控表失败', { errorCode: error.name });
      throw error;
    }
  },
};
