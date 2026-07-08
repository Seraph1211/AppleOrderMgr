const { DataTypes } = require('sequelize');

/**
 * AppleId 模型 - Apple账号管理
 * @module models/AppleId
 * @description 管理Apple账号信息，包括账号、密码、安全问答等
 */

/**
 * 定义 AppleId 模型
 * @param {import('sequelize').Sequelize} sequelize - Sequelize实例
 * @returns {import('sequelize').Model} AppleId模型
 */
module.exports = (sequelize) => {
  const AppleId = sequelize.define('AppleId', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      comment: '主键ID，自增'
    },
    appleId: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
      field: 'apple_id',
      comment: 'Apple账号邮箱（唯一）',
      validate: {
        isEmail: {
          msg: 'Apple账号必须是有效的邮箱格式'
        }
      }
    },
    password: {
      type: DataTypes.STRING(255),
      allowNull: false,
      comment: 'Apple账号密码（明文存储）'
    },
    nickname: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: '账号昵称或备注名',
      validate: {
        len: {
          args: [0, 255],
          msg: '昵称长度不能超过255个字符'
        }
      }
    },
    securityQa: {
      type: DataTypes.JSONB,
      allowNull: true,
      field: 'security_qa',
      comment: '安全问答（JSONB格式存储）'
    },
    country: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: '账号所属国家/地区',
      validate: {
        len: {
          args: [0, 50],
          msg: '国家名称长度不能超过50个字符'
        }
      }
    },
    isModified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'is_modified',
      comment: '是否被修改过（账号信息变更标记）'
    },
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'active',
      comment: '账号状态：active/inactive/locked',
      validate: {
        isIn: {
          args: [['active', 'inactive', 'locked']],
          msg: '状态必须是 active、inactive 或 locked'
        }
      }
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: 'created_at',
      comment: '记录创建时间'
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: 'updated_at',
      comment: '记录更新时间'
    }
  }, {
    tableName: 'apple_ids',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ['apple_id'],
        name: 'uk_apple_id_email'
      },
      {
        fields: ['status'],
        name: 'idx_apple_ids_status'
      },
      {
        fields: ['country'],
        name: 'idx_apple_ids_country'
      },
      {
        fields: ['is_modified'],
        name: 'idx_apple_ids_is_modified'
      }
    ],
    comment: 'Apple账号管理表'
  });

  /**
   * 定义模型关联关系
   * @param {Object} models - 所有模型的集合
   */
  AppleId.associate = (models) => {
    // 一个Apple账号可以有多个收件人
    AppleId.hasMany(models.Recipient, {
      foreignKey: 'apple_id_ref',
      as: 'recipients'
    });

    // 一个Apple账号可以有多个订单
    AppleId.hasMany(models.Order, {
      foreignKey: 'apple_id_ref',
      as: 'orders'
    });
  };

  return AppleId;
};
