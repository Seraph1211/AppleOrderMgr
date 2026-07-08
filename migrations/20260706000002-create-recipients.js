'use strict';

/**
 * 创建 recipients 表
 * @description 收件人管理表
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('recipients', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID，自增'
      },
      // 基础信息
      last_name: {
        type: Sequelize.STRING(50),
        allowNull: false,
        comment: '姓'
      },
      first_name: {
        type: Sequelize.STRING(50),
        allowNull: false,
        comment: '名'
      },
      // 身份信息
      id_card_number: {
        type: Sequelize.STRING(18),
        allowNull: false,
        unique: true,
        comment: '完整身份证号（明文存储）'
      },
      id_card_last4: {
        type: Sequelize.STRING(4),
        allowNull: true,
        comment: '身份证后四位（冗余，快速匹配）'
      },
      phone: {
        type: Sequelize.STRING(20),
        allowNull: true,
        comment: '手机号'
      },
      email: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: '下单邮箱'
      },
      // 地址信息
      province: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: '省'
      },
      city: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: '市'
      },
      district: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: '区'
      },
      street_address: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: '街道地址'
      },
      // 关联Apple账号
      apple_id: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: '绑定的Apple账号邮箱'
      },
      password: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: '绑定的Apple账号密码'
      },
      apple_id_ref: {
        type: Sequelize.INTEGER,
        allowNull: true,
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
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: '标签（地区或批次）'
      },
      status: {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'active',
        comment: '使用状态：active/inactive'
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: '备注'
      },
      // 时间戳
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
      comment: '收件人管理表'
    });

    // 创建索引
    await queryInterface.addIndex('recipients', ['last_name', 'first_name'], {
      name: 'idx_recipients_last_name_first_name'
    });
    await queryInterface.addIndex('recipients', ['id_card_number'], {
      unique: true,
      name: 'idx_recipients_id_card_number'
    });
    await queryInterface.addIndex('recipients', ['tag'], {
      name: 'idx_recipients_tag'
    });
    await queryInterface.addIndex('recipients', ['status'], {
      name: 'idx_recipients_status'
    });
    await queryInterface.addIndex('recipients', ['province', 'city'], {
      name: 'idx_recipients_province_city'
    });
    await queryInterface.addIndex('recipients', ['apple_id'], {
      name: 'idx_recipients_apple_id'
    });
    await queryInterface.addIndex('recipients', ['apple_id_ref'], {
      name: 'idx_recipients_apple_id_ref'
    });

    // 创建触发器函数：自动提取身份证后四位
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION auto_extract_id_card_last4()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.id_card_number IS NOT NULL THEN
          NEW.id_card_last4 = RIGHT(NEW.id_card_number, 4);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER trigger_recipients_id_card_last4
      BEFORE INSERT OR UPDATE ON recipients
      FOR EACH ROW
      EXECUTE FUNCTION auto_extract_id_card_last4();
    `);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS trigger_recipients_id_card_last4 ON recipients;');
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS auto_extract_id_card_last4();');
    await queryInterface.dropTable('recipients');
  }
};
