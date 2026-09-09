const { DataTypes } = require('sequelize');

/**
 * 定义追加式账号操作日志，身份快照不随用户删除而丢失。
 * @param {Object} sequelize - 数据库连接
 * @returns {Object} 操作日志模型
 */
module.exports = sequelize =>
  sequelize.define(
    'OperationLog',
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      actorUserId: { type: DataTypes.INTEGER, field: 'actor_user_id' },
      username: { type: DataTypes.STRING(50) },
      nickname: { type: DataTypes.STRING(50) },
      action: { type: DataTypes.STRING(100), allowNull: false },
      target: { type: DataTypes.STRING(500), allowNull: false },
      method: { type: DataTypes.STRING(10), allowNull: false },
      ip: { type: DataTypes.STRING(64) },
      statusCode: { type: DataTypes.INTEGER, allowNull: false, field: 'status_code' },
      result: { type: DataTypes.STRING(20), allowNull: false },
      requestId: { type: DataTypes.UUID, allowNull: false, field: 'request_id' },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
    },
    {
      tableName: 'operation_logs',
      timestamps: true,
      updatedAt: false,
      underscored: true,
      indexes: [
        { fields: ['created_at'] },
        { fields: ['actor_user_id', 'created_at'] },
        { fields: ['action', 'created_at'] },
      ],
    }
  );
