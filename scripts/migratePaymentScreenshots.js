/**
 * 数据库迁移脚本：将 payment_screenshot 改为 JSONB 类型，支持多张图片
 *
 * 迁移步骤：
 * 1. 添加新字段 payment_screenshots (JSONB)
 * 2. 将旧字段 payment_screenshot 的数据迁移到新字段（转为数组）
 * 3. 删除旧字段 payment_screenshot
 * 4. 重命名新字段为 payment_screenshot
 */

require('dotenv').config();
const { sequelize } = require('../src/models');

async function migrate() {
  console.log('开始迁移 payment_screenshot 字段...');

  try {
    // 步骤1：添加新的 JSONB 字段
    console.log('1. 添加新字段 payment_screenshots (JSONB)...');
    await sequelize.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS payment_screenshots JSONB DEFAULT '[]'::jsonb;
    `);
    console.log('✅ 新字段添加成功');

    // 步骤2：数据迁移 - 将旧字段数据转换为 JSON 数组
    console.log('2. 迁移旧数据到新字段...');
    await sequelize.query(`
      UPDATE orders
      SET payment_screenshots =
        CASE
          WHEN payment_screenshot IS NOT NULL
               AND payment_screenshot != ''
               AND payment_screenshot != '-'
          THEN jsonb_build_array(payment_screenshot)
          ELSE '[]'::jsonb
        END
      WHERE payment_screenshots = '[]'::jsonb;
    `);
    console.log('✅ 数据迁移成功');

    // 步骤3：删除旧字段
    console.log('3. 删除旧字段 payment_screenshot...');
    await sequelize.query(`
      ALTER TABLE orders
      DROP COLUMN IF EXISTS payment_screenshot;
    `);
    console.log('✅ 旧字段删除成功');

    // 步骤4：重命名新字段
    console.log('4. 重命名 payment_screenshots -> payment_screenshot...');
    await sequelize.query(`
      ALTER TABLE orders
      RENAME COLUMN payment_screenshots TO payment_screenshot;
    `);
    console.log('✅ 字段重命名成功');

    console.log('\n🎉 迁移完成！payment_screenshot 现在是 JSONB 类型，支持存储多张图片数组。');

    // 验证迁移结果
    console.log('\n验证迁移结果...');
    const [results] = await sequelize.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'orders' AND column_name = 'payment_screenshot';
    `);
    console.log('payment_screenshot 字段信息:', results);

    process.exit(0);
  } catch (error) {
    console.error('❌ 迁移失败:', error.message);
    console.error('详细错误:', error);
    process.exit(1);
  }
}

// 执行迁移
migrate();
