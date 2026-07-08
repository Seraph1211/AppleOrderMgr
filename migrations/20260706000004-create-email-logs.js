'use strict';

/**
 * 创建 email_logs 表
 * @description 邮件处理日志表
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('email_logs', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID，自增'
      },
      email_uid: {
        type: Sequelize.STRING(100),
        allowNull: false,
        unique: true,
        comment: '邮件唯一标识符（IMAP UID）'
      },
      email_subject: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: '邮件主题'
      },
      email_from: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: '发件人邮箱'
      },
      email_date: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: '邮件发送时间'
      },
      source: {
        type: Sequelize.STRING(50),
        allowNull: false,
        defaultValue: 'imap',
        comment: '数据源（用于审计）：imap/manual/api'
      },
      raw_content: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: '原始邮件内容（Base64编码的邮件正文，用于调试和重新解析）'
      },
      processed: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否已处理'
      },
      processed_at: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: '处理时间'
      },
      success: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        comment: '处理是否成功'
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: '错误信息'
      },
      parsed_data: {
        type: Sequelize.JSONB,
        allowNull: true,
        comment: '解析后的数据（JSON格式）'
      },
      order_number: {
        type: Sequelize.STRING(20),
        allowNull: true,
        comment: '关联的订单号（冗余字段，便于查询）'
      },
      retry_count: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '重试次数'
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        comment: '记录创建时间'
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        comment: '记录更新时间'
      }
    }, {
      comment: '邮件处理日志表'
    });

    // 创建索引
    await queryInterface.addIndex('email_logs', ['email_uid'], {
      unique: true,
      name: 'uk_email_uid'
    });
    await queryInterface.addIndex('email_logs', ['processed'], {
      name: 'idx_email_logs_processed'
    });
    await queryInterface.addIndex('email_logs', ['success'], {
      name: 'idx_email_logs_success'
    });
    await queryInterface.addIndex('email_logs', ['source'], {
      name: 'idx_email_logs_source'
    });
    await queryInterface.addIndex('email_logs', ['order_number'], {
      name: 'idx_email_logs_order_number'
    });
    await queryInterface.addIndex('email_logs', ['email_date'], {
      name: 'idx_email_logs_email_date'
    });
    await queryInterface.addIndex('email_logs', ['processed_at'], {
      name: 'idx_email_logs_processed_at'
    });
    await queryInterface.addIndex('email_logs', ['email_from'], {
      name: 'idx_email_logs_email_from'
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('email_logs');
  }
};
