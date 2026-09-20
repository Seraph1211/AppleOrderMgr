const { DataTypes } = require('sequelize');

/** 定义订单邮件独立同步状态。 */
module.exports = sequelize =>
  sequelize.define(
    'OrderMailState',
    {
      mailboxIdentityHash: {
        type: DataTypes.STRING(64),
        primaryKey: true,
        allowNull: false,
        field: 'mailbox_identity_hash',
      },
      isConnected: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'is_connected',
      },
      lastScanStartedAt: { type: DataTypes.DATE, field: 'last_scan_started_at' },
      lastScanSucceededAt: { type: DataTypes.DATE, field: 'last_scan_succeeded_at' },
      lastScanErrorCode: { type: DataTypes.STRING(50), field: 'last_scan_error_code' },
      lastScanDurationMs: { type: DataTypes.INTEGER, field: 'last_scan_duration_ms' },
      receivedCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'received_count',
      },
      ignoredCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'ignored_count',
      },
    },
    { tableName: 'order_mail_states', underscored: true, timestamps: true }
  );
