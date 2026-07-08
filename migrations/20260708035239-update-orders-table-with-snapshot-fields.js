'use strict';

/**
 * 更新 orders 表为快照模式
 * @description
 * 1. 删除 _raw 后缀字段
 * 2. 添加完整的快照字段（收件人完整信息）
 * 3. 重命名字段以符合快照语义
 * @date 2026-07-08
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. 重命名 apple_id_raw 为 apple_id
    await queryInterface.renameColumn('orders', 'apple_id_raw', 'apple_id');

    // 2. 添加 apple_password 字段
    await queryInterface.addColumn('orders', 'apple_password', {
      type: Sequelize.STRING(255),
      allowNull: true,
      comment: 'Apple ID 密码（从 apple_ids 表匹配填充）'
    });

    // 3. 重命名 recipient_name_raw 为 recipient_name
    await queryInterface.renameColumn('orders', 'recipient_name_raw', 'recipient_name');

    // 4. 删除 recipient_id_last4_raw（不再需要，直接存完整身份证号）
    await queryInterface.removeColumn('orders', 'recipient_id_last4_raw');

    // 5. 添加 recipient_id_card（完整18位身份证号）
    await queryInterface.addColumn('orders', 'recipient_id_card', {
      type: Sequelize.STRING(18),
      allowNull: true,
      comment: '取货人完整身份证号（从 recipients 表匹配填充）'
    });

    // 6. 添加 recipient_email
    await queryInterface.addColumn('orders', 'recipient_email', {
      type: Sequelize.STRING(255),
      allowNull: true,
      comment: '收件人邮箱（从 recipients 表匹配填充）'
    });

    // 7. 重命名 recipient_phone_raw 为 recipient_phone
    await queryInterface.renameColumn('orders', 'recipient_phone_raw', 'recipient_phone');

    // 8. 重命名 recipient_address_raw 为 recipient_address
    await queryInterface.renameColumn('orders', 'recipient_address_raw', 'recipient_address');

    // 9. 添加取货信息字段
    await queryInterface.addColumn('orders', 'pickup_store_code', {
      type: Sequelize.STRING(50),
      allowNull: true,
      comment: '取货门店代码（如 R638）'
    });

    await queryInterface.addColumn('orders', 'pickup_time_slot', {
      type: Sequelize.STRING(50),
      allowNull: true,
      comment: '取货时间段（如 25-18:30-18:45）'
    });

    // 10. 添加付款信息字段
    await queryInterface.addColumn('orders', 'payer_name', {
      type: Sequelize.STRING(100),
      allowNull: true,
      comment: '付款人姓名'
    });

    await queryInterface.addColumn('orders', 'payment_screenshot', {
      type: Sequelize.TEXT,
      allowNull: true,
      comment: '付款截图URL或路径'
    });

    // 11. 删除不需要的字段
    await queryInterface.removeColumn('orders', 'order_placed_date');

    // 12. 添加索引
    await queryInterface.addIndex('orders', ['apple_id'], {
      name: 'idx_orders_apple_id'
    });

    await queryInterface.addIndex('orders', ['recipient_name'], {
      name: 'idx_orders_recipient_name'
    });

    await queryInterface.addIndex('orders', ['recipient_id_card'], {
      name: 'idx_orders_recipient_id_card'
    });

    await queryInterface.addIndex('orders', ['pickup_store_code'], {
      name: 'idx_orders_pickup_store_code'
    });
  },

  async down(queryInterface, Sequelize) {
    // 删除索引
    await queryInterface.removeIndex('orders', 'idx_orders_pickup_store_code');
    await queryInterface.removeIndex('orders', 'idx_orders_recipient_id_card');
    await queryInterface.removeIndex('orders', 'idx_orders_recipient_name');
    await queryInterface.removeIndex('orders', 'idx_orders_apple_id');

    // 恢复字段
    await queryInterface.addColumn('orders', 'order_placed_date', {
      type: Sequelize.DATEONLY,
      allowNull: true
    });

    await queryInterface.removeColumn('orders', 'payment_screenshot');
    await queryInterface.removeColumn('orders', 'payer_name');
    await queryInterface.removeColumn('orders', 'pickup_time_slot');
    await queryInterface.removeColumn('orders', 'pickup_store_code');

    await queryInterface.renameColumn('orders', 'recipient_address', 'recipient_address_raw');
    await queryInterface.renameColumn('orders', 'recipient_phone', 'recipient_phone_raw');
    await queryInterface.removeColumn('orders', 'recipient_email');
    await queryInterface.removeColumn('orders', 'recipient_id_card');

    await queryInterface.addColumn('orders', 'recipient_id_last4_raw', {
      type: Sequelize.STRING(4),
      allowNull: true
    });

    await queryInterface.renameColumn('orders', 'recipient_name', 'recipient_name_raw');
    await queryInterface.removeColumn('orders', 'apple_password');
    await queryInterface.renameColumn('orders', 'apple_id', 'apple_id_raw');
  }
};
