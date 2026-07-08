'use strict';

/**
 * 添加原始数据字段到 orders 表
 * @description 添加 _raw 后缀的字段，用于存储邮件/爬虫中的原始数据
 * @date 2026-07-08
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('orders', 'apple_id_raw', {
      type: Sequelize.STRING(255),
      allowNull: true,
      comment: '邮件/爬虫中的原始Apple ID字符串'
    });

    await queryInterface.addColumn('orders', 'recipient_name_raw', {
      type: Sequelize.STRING(100),
      allowNull: true,
      comment: '邮件/爬虫中的原始收件人姓名'
    });

    await queryInterface.addColumn('orders', 'recipient_id_last4_raw', {
      type: Sequelize.STRING(4),
      allowNull: true,
      comment: '邮件/爬虫中的原始身份证后4位'
    });

    await queryInterface.addColumn('orders', 'recipient_phone_raw', {
      type: Sequelize.STRING(20),
      allowNull: true,
      comment: '邮件/爬虫中的原始手机号'
    });

    await queryInterface.addColumn('orders', 'recipient_address_raw', {
      type: Sequelize.TEXT,
      allowNull: true,
      comment: '邮件/爬虫中的原始地址'
    });

    // 添加索引以提高查询性能
    await queryInterface.addIndex('orders', ['apple_id_raw'], {
      name: 'idx_orders_apple_id_raw'
    });

    await queryInterface.addIndex('orders', ['recipient_name_raw'], {
      name: 'idx_orders_recipient_name_raw'
    });

    await queryInterface.addIndex('orders', ['recipient_id_last4_raw'], {
      name: 'idx_orders_recipient_id_last4_raw'
    });
  },

  async down(queryInterface, _Sequelize) {
    // 删除索引
    await queryInterface.removeIndex('orders', 'idx_orders_recipient_id_last4_raw');
    await queryInterface.removeIndex('orders', 'idx_orders_recipient_name_raw');
    await queryInterface.removeIndex('orders', 'idx_orders_apple_id_raw');

    // 删除字段
    await queryInterface.removeColumn('orders', 'recipient_address_raw');
    await queryInterface.removeColumn('orders', 'recipient_phone_raw');
    await queryInterface.removeColumn('orders', 'recipient_id_last4_raw');
    await queryInterface.removeColumn('orders', 'recipient_name_raw');
    await queryInterface.removeColumn('orders', 'apple_id_raw');
  }
};
