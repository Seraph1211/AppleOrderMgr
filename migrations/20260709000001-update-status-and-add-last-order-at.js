'use strict';

/**
 * 迁移文件：更新状态枚举值并添加 last_order_at 字段
 *
 * 变更内容：
 * 1. 统一 apple_ids 和 recipients 表的状态值为：未使用、使用中、已下架、异常
 * 2. 为两个表添加 last_order_at 字段（最后下单时间）
 * 3. 为 last_order_at 字段创建索引
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // 1. 为 apple_ids 表添加 last_order_at 字段
      await queryInterface.addColumn('apple_ids', 'last_order_at', {
        type: Sequelize.DATE,
        allowNull: true,
        comment: '最后下单时间'
      }, { transaction });

      // 2. 为 recipients 表添加 last_order_at 字段
      await queryInterface.addColumn('recipients', 'last_order_at', {
        type: Sequelize.DATE,
        allowNull: true,
        comment: '最后下单时间'
      }, { transaction });

      // 3. 更新 apple_ids 表的状态值（从旧值映射到新值）
      await queryInterface.sequelize.query(`
        UPDATE apple_ids
        SET status = CASE
          WHEN status = 'active' THEN '使用中'
          WHEN status = 'inactive' THEN '已下架'
          ELSE '未使用'
        END
      `, { transaction });

      // 4. 更新 recipients 表的状态值（从旧值映射到新值）
      await queryInterface.sequelize.query(`
        UPDATE recipients
        SET status = CASE
          WHEN status = 'active' THEN '使用中'
          WHEN status = 'inactive' THEN '已下架'
          WHEN status = 'disabled' THEN '已下架'
          ELSE '未使用'
        END
      `, { transaction });

      // 5. 创建索引
      await queryInterface.addIndex('apple_ids', ['last_order_at'], {
        name: 'idx_apple_ids_last_order_at',
        transaction
      });

      await queryInterface.addIndex('recipients', ['last_order_at'], {
        name: 'idx_recipients_last_order_at',
        transaction
      });

      await transaction.commit();
      console.log('✅ 成功添加 last_order_at 字段并更新状态枚举值');
    } catch (error) {
      await transaction.rollback();
      console.error('❌ 迁移失败:', error);
      throw error;
    }
  },

  down: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // 1. 删除索引
      await queryInterface.removeIndex('apple_ids', 'idx_apple_ids_last_order_at', { transaction });
      await queryInterface.removeIndex('recipients', 'idx_recipients_last_order_at', { transaction });

      // 2. 恢复状态值（新值映射回旧值）
      await queryInterface.sequelize.query(`
        UPDATE apple_ids
        SET status = CASE
          WHEN status = '使用中' THEN 'active'
          WHEN status = '已下架' THEN 'inactive'
          WHEN status = '异常' THEN 'inactive'
          ELSE 'active'
        END
      `, { transaction });

      await queryInterface.sequelize.query(`
        UPDATE recipients
        SET status = CASE
          WHEN status = '使用中' THEN 'active'
          WHEN status = '已下架' THEN 'inactive'
          WHEN status = '异常' THEN 'inactive'
          ELSE 'active'
        END
      `, { transaction });

      // 3. 删除字段
      await queryInterface.removeColumn('apple_ids', 'last_order_at', { transaction });
      await queryInterface.removeColumn('recipients', 'last_order_at', { transaction });

      await transaction.commit();
      console.log('✅ 成功回滚迁移');
    } catch (error) {
      await transaction.rollback();
      console.error('❌ 回滚失败:', error);
      throw error;
    }
  }
};
