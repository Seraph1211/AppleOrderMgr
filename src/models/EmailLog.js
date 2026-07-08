const { DataTypes } = require('sequelize');

/**
 * EmailLog 模型 - 邮件处理日志
 * @module models/EmailLog
 * @description 记录邮件处理历史，用于去重和错误追踪
 */

/**
 * 定义 EmailLog 模型
 * @param {import('sequelize').Sequelize} sequelize - Sequelize实例
 * @returns {import('sequelize').Model} EmailLog模型
 */
module.exports = (sequelize) => {
  const EmailLog = sequelize.define('EmailLog', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      comment: '主键ID，自增'
    },
    emailUid: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
      field: 'email_uid',
      comment: '邮件唯一标识符（IMAP UID）',
      validate: {
        notEmpty: {
          msg: '邮件UID不能为空'
        }
      }
    },
    emailSubject: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'email_subject',
      comment: '邮件主题'
    },
    emailFrom: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: 'email_from',
      comment: '发件人（可能包含显示名称，如 "NULL预订助手" <email@domain.com>）'
    },
    emailDate: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'email_date',
      comment: '邮件发送时间'
    },
    source: {
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: 'imap',
      comment: '数据源（用于审计）：imap/manual/api',
      validate: {
        isIn: {
          args: [['imap', 'manual', 'api']],
          msg: '数据源必须是 imap、manual 或 api'
        }
      }
    },
    rawContent: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'raw_content',
      comment: '原始邮件内容（Base64编码的邮件正文，用于调试和重新解析）'
    },
    processed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: '是否已处理'
    },
    processedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'processed_at',
      comment: '处理时间'
    },
    success: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      comment: '处理是否成功'
    },
    errorMessage: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'error_message',
      comment: '错误信息'
    },
    parsedData: {
      type: DataTypes.JSONB,
      allowNull: true,
      field: 'parsed_data',
      comment: '解析后的数据（JSON格式）'
    },
    orderNumber: {
      type: DataTypes.STRING(20),
      allowNull: true,
      field: 'order_number',
      comment: '关联的订单号（冗余字段，便于查询）',
      validate: {
        is: {
          args: /^W\d{9}$/,
          msg: '订单号必须是W开头后跟9位数字'
        }
      }
    },
    retryCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: 'retry_count',
      comment: '重试次数'
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
    tableName: 'email_logs',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ['email_uid'],
        name: 'uk_email_uid'
      },
      {
        fields: ['processed'],
        name: 'idx_email_logs_processed'
      },
      {
        fields: ['success'],
        name: 'idx_email_logs_success'
      },
      {
        fields: ['source'],
        name: 'idx_email_logs_source'
      },
      {
        fields: ['order_number'],
        name: 'idx_email_logs_order_number'
      },
      {
        fields: ['email_date'],
        name: 'idx_email_logs_email_date'
      },
      {
        fields: ['processed_at'],
        name: 'idx_email_logs_processed_at'
      },
      {
        fields: ['email_from'],
        name: 'idx_email_logs_email_from'
      }
    ],
    comment: '邮件处理日志表'
  });

  /**
   * 定义模型关联关系
   * @param {Object} models - 所有模型的集合
   */
  EmailLog.associate = (_models) => {
    // EmailLog 暂无外键关联，但可以通过 order_number 关联到 Order
    // 这里不定义 belongsTo，因为是冗余字段，用于快速查询
  };

  return EmailLog;
};
