'use strict';

/**
 * 创建 apple_ids 表
 * @description Apple账号管理表
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('apple_ids', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID，自增'
      },
      apple_id: {
        type: Sequelize.STRING(255),
        allowNull: false,
        unique: true,
        comment: 'Apple账号邮箱（唯一）'
      },
      password: {
        type: Sequelize.STRING(255),
        allowNull: false,
        comment: 'Apple账号密码（明文存储）'
      },
      nickname: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: '账号昵称或备注名'
      },
      security_qa: {
        type: Sequelize.JSONB,
        allowNull: true,
        comment: '安全问答（JSONB格式存储）'
      },
      country: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: '账号所属国家/地区'
      },
      is_modified: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否被修改过（账号信息变更标记）'
      },
      status: {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'active',
        comment: '账号状态：active/inactive/locked'
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
      comment: 'Apple账号管理表'
    });

    // 创建索引
    await queryInterface.addIndex('apple_ids', ['apple_id'], {
      unique: true,
      name: 'uk_apple_id_email'
    });
    await queryInterface.addIndex('apple_ids', ['status'], {
      name: 'idx_apple_ids_status'
    });
    await queryInterface.addIndex('apple_ids', ['country'], {
      name: 'idx_apple_ids_country'
    });
    await queryInterface.addIndex('apple_ids', ['is_modified'], {
      name: 'idx_apple_ids_is_modified'
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('apple_ids');
  }
};
