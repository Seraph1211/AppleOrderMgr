const { DataTypes } = require('sequelize');

/**
 * Recipient 模型 - 收件人管理
 * @module models/Recipient
 * @description 管理取机人完整信息，包括姓名、身份证、地址、关联Apple账号等
 */

/**
 * 定义 Recipient 模型
 * @param {import('sequelize').Sequelize} sequelize - Sequelize实例
 * @returns {import('sequelize').Model} Recipient模型
 */
module.exports = (sequelize) => {
  const Recipient = sequelize.define('Recipient', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      comment: '主键ID，自增'
    },
    // 基础信息
    lastName: {
      type: DataTypes.STRING(50),
      allowNull: false,
      field: 'last_name',
      comment: '姓',
      validate: {
        notEmpty: {
          msg: '姓不能为空'
        },
        len: {
          args: [1, 50],
          msg: '姓的长度必须在1-50个字符之间'
        }
      }
    },
    firstName: {
      type: DataTypes.STRING(50),
      allowNull: false,
      field: 'first_name',
      comment: '名',
      validate: {
        notEmpty: {
          msg: '名不能为空'
        },
        len: {
          args: [1, 50],
          msg: '名的长度必须在1-50个字符之间'
        }
      }
    },
    // 身份信息
    idCardNumber: {
      type: DataTypes.STRING(18),
      allowNull: false,
      unique: true,
      field: 'id_card_number',
      comment: '完整身份证号（明文存储）',
      validate: {
        is: {
          args: /^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/,
          msg: '身份证号格式无效'
        }
      }
    },
    idCardLast4: {
      type: DataTypes.STRING(4),
      allowNull: true,
      field: 'id_card_last4',
      comment: '身份证后四位（冗余，快速匹配）'
    },
    phone: {
      type: DataTypes.STRING(20),
      allowNull: true,
      comment: '手机号',
      validate: {
        is: {
          args: /^1[3-9]\d{9}$/,
          msg: '手机号格式无效'
        }
      }
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: '下单邮箱',
      validate: {
        isEmail: {
          msg: '邮箱格式无效'
        }
      }
    },
    // 地址信息
    province: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: '省'
    },
    city: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: '市'
    },
    district: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: '区'
    },
    streetAddress: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: 'street_address',
      comment: '街道地址'
    },
    // 关联Apple账号
    appleId: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'apple_id',
      comment: '绑定的Apple账号邮箱',
      validate: {
        isEmail: {
          msg: 'Apple账号必须是有效的邮箱格式'
        }
      }
    },
    password: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: '绑定的Apple账号密码'
    },
    appleIdRef: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'apple_id_ref',
      comment: '关联到apple_ids表的外键',
      references: {
        model: 'apple_ids',
        key: 'id'
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    },
    // 业务字段
    tag: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: '标签（地区或批次）',
      validate: {
        len: {
          args: [0, 100],
          msg: '标签长度不能超过100个字符'
        }
      }
    },
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: '未使用',
      comment: '使用状态：未使用/使用中/已下架/异常',
      validate: {
        isIn: {
          args: [['未使用', '使用中', '已下架', '异常']],
          msg: '状态必须是：未使用、使用中、已下架或异常'
        }
      }
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: '备注'
    },
    // 时间戳
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
    },
    lastOrderAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'last_order_at',
      comment: '最后下单时间'
    }
  }, {
    tableName: 'recipients',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        fields: ['last_name', 'first_name'],
        name: 'idx_recipients_last_name_first_name'
      },
      {
        unique: true,
        fields: ['id_card_number'],
        name: 'idx_recipients_id_card_number'
      },
      {
        fields: ['tag'],
        name: 'idx_recipients_tag'
      },
      {
        fields: ['status'],
        name: 'idx_recipients_status'
      },
      {
        fields: ['province', 'city'],
        name: 'idx_recipients_province_city'
      },
      {
        fields: ['apple_id'],
        name: 'idx_recipients_apple_id'
      },
      {
        fields: ['apple_id_ref'],
        name: 'idx_recipients_apple_id_ref'
      },
      {
        fields: ['last_order_at'],
        name: 'idx_recipients_last_order_at'
      }
    ],
    hooks: {
      beforeValidate: (recipient) => {
        // 自动提取身份证后四位
        if (recipient.idCardNumber) {
          recipient.idCardLast4 = recipient.idCardNumber.slice(-4);
        }
      }
    },
    comment: '收件人管理表'
  });

  /**
   * 定义模型关联关系
   * @param {Object} models - 所有模型的集合
   */
  Recipient.associate = (models) => {
    // 收件人关联到Apple账号
    Recipient.belongsTo(models.AppleId, {
      foreignKey: 'apple_id_ref',
      as: 'appleAccount'
    });

    // 一个收件人可以有多个订单
    Recipient.hasMany(models.Order, {
      foreignKey: 'recipient_ref',
      as: 'orders'
    });
  };

  return Recipient;
};
