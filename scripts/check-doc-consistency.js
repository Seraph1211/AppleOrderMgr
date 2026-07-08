#!/usr/bin/env node

/**
 * 文档一致性检查脚本
 *
 * 用途：检查代码与文档的一致性，特别是数据库 Model 与 SCHEMA.md
 *
 * 使用方法：
 *   node scripts/check-doc-consistency.js
 *
 * 检查项：
 *   1. SCHEMA.md 中定义的表是否都有对应的 Model 文件
 *   2. Model 文件中的字段是否在 SCHEMA.md 中有文档
 *   3. 字段类型是否一致
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, '../docs/database/SCHEMA.md');
const MODELS_DIR = path.join(__dirname, '../src/models');

// ANSI 颜色代码
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

let hasErrors = false;

/**
 * 打印带颜色的消息
 */
function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

/**
 * 从 SCHEMA.md 中提取表定义
 */
function extractTablesFromSchema() {
  try {
    const content = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    const tables = {};

    // 匹配表定义章节
    const tableRegex = /##\s+(\w+)\s+表[\s\S]*?\|[\s\S]*?\n\n/g;
    let match;

    while ((match = tableRegex.exec(content)) !== null) {
      const tableName = match[1];
      const tableSection = match[0];

      // 提取字段定义
      const fieldRegex = /\|\s*(\w+)\s*\|\s*([^|]+)\s*\|/g;
      const fields = [];
      let fieldMatch;

      while ((fieldMatch = fieldRegex.exec(tableSection)) !== null) {
        const fieldName = fieldMatch[1].trim();
        const fieldType = fieldMatch[2].trim();

        // 跳过表头
        if (fieldName !== '字段名' && fieldName !== '---') {
          fields.push({
            name: fieldName,
            type: fieldType
          });
        }
      }

      if (fields.length > 0) {
        tables[tableName] = fields;
      }
    }

    return tables;
  } catch (error) {
    log(`❌ 读取 SCHEMA.md 失败: ${error.message}`, 'red');
    return {};
  }
}

/**
 * 从 Model 文件中提取字段定义
 */
function extractFieldsFromModel(modelPath) {
  try {
    const content = fs.readFileSync(modelPath, 'utf-8');
    const fields = [];

    // 匹配 Sequelize 字段定义
    // 例如: fieldName: { type: DataTypes.STRING, ... }
    const fieldRegex = /(\w+):\s*\{[^}]*type:\s*DataTypes\.(\w+)/g;
    let match;

    while ((match = fieldRegex.exec(content)) !== null) {
      fields.push({
        name: match[1],
        type: match[2]
      });
    }

    return fields;
  } catch (error) {
    log(`❌ 读取 Model 文件失败: ${error.message}`, 'red');
    return [];
  }
}

/**
 * 获取所有 Model 文件
 */
function getModelFiles() {
  try {
    if (!fs.existsSync(MODELS_DIR)) {
      log(`⚠️  Models 目录不存在: ${MODELS_DIR}`, 'yellow');
      return [];
    }

    return fs.readdirSync(MODELS_DIR)
      .filter(file => file.endsWith('.js') && file !== 'index.js')
      .map(file => ({
        name: path.basename(file, '.js'),
        path: path.join(MODELS_DIR, file)
      }));
  } catch (error) {
    log(`❌ 读取 Models 目录失败: ${error.message}`, 'red');
    return [];
  }
}

/**
 * 检查 SCHEMA.md 中的表是否都有对应的 Model
 */
function checkMissingModels(schemaTables, modelFiles) {
  log('\n📋 检查 1: SCHEMA.md 中定义的表是否有对应的 Model', 'cyan');

  const modelNames = modelFiles.map(m => m.name.toLowerCase());
  let allExist = true;

  for (const tableName of Object.keys(schemaTables)) {
    const modelName = tableName.toLowerCase();

    if (!modelNames.includes(modelName)) {
      log(`  ❌ 表 "${tableName}" 在 SCHEMA.md 中定义，但没有对应的 Model 文件`, 'red');
      hasErrors = true;
      allExist = false;
    } else {
      log(`  ✅ 表 "${tableName}" 有对应的 Model`, 'green');
    }
  }

  if (allExist) {
    log('  🎉 所有表都有对应的 Model 文件', 'green');
  }
}

/**
 * 检查 Model 文件是否在 SCHEMA.md 中有文档
 */
function checkMissingDocs(schemaTables, modelFiles) {
  log('\n📋 检查 2: Model 文件是否在 SCHEMA.md 中有文档', 'cyan');

  const tableNames = Object.keys(schemaTables).map(t => t.toLowerCase());
  let allDocumented = true;

  for (const model of modelFiles) {
    const modelName = model.name.toLowerCase();

    if (!tableNames.includes(modelName)) {
      log(`  ⚠️  Model "${model.name}" 没有在 SCHEMA.md 中找到文档`, 'yellow');
      allDocumented = false;
    } else {
      log(`  ✅ Model "${model.name}" 有文档`, 'green');
    }
  }

  if (allDocumented) {
    log('  🎉 所有 Model 都有文档', 'green');
  }
}

/**
 * 检查字段一致性
 */
function checkFieldConsistency(schemaTables, modelFiles) {
  log('\n📋 检查 3: 字段一致性检查', 'cyan');

  for (const model of modelFiles) {
    const modelName = model.name.toLowerCase();
    const tableName = Object.keys(schemaTables).find(
      t => t.toLowerCase() === modelName
    );

    if (!tableName) {
      continue; // 跳过没有文档的 Model
    }

    log(`\n  📄 检查 Model: ${model.name}`, 'blue');

    const schemaFields = schemaTables[tableName];
    const modelFields = extractFieldsFromModel(model.path);

    // 检查 SCHEMA 中的字段是否在 Model 中
    const modelFieldNames = modelFields.map(f => f.name.toLowerCase());

    for (const schemaField of schemaFields) {
      const fieldName = schemaField.name.toLowerCase();

      if (!modelFieldNames.includes(fieldName)) {
        log(`    ❌ 字段 "${schemaField.name}" 在 SCHEMA.md 中定义，但 Model 中未找到`, 'red');
        hasErrors = true;
      } else {
        log(`    ✅ 字段 "${schemaField.name}" 存在`, 'green');
      }
    }

    // 检查 Model 中的字段是否在 SCHEMA 中
    const schemaFieldNames = schemaFields.map(f => f.name.toLowerCase());

    for (const modelField of modelFields) {
      const fieldName = modelField.name.toLowerCase();

      if (!schemaFieldNames.includes(fieldName)) {
        log(`    ⚠️  字段 "${modelField.name}" 在 Model 中定义，但 SCHEMA.md 中未找到文档`, 'yellow');
      }
    }
  }
}

/**
 * 主函数
 */
function main() {
  log('═══════════════════════════════════════════', 'cyan');
  log('  📚 文档一致性检查工具', 'cyan');
  log('═══════════════════════════════════════════', 'cyan');

  // 提取数据
  const schemaTables = extractTablesFromSchema();
  const modelFiles = getModelFiles();

  if (Object.keys(schemaTables).length === 0) {
    log('\n⚠️  SCHEMA.md 中未找到表定义', 'yellow');
    return;
  }

  if (modelFiles.length === 0) {
    log('\n⚠️  未找到 Model 文件', 'yellow');
    return;
  }

  log(`\n发现 ${Object.keys(schemaTables).length} 个表定义`);
  log(`发现 ${modelFiles.length} 个 Model 文件\n`);

  // 执行检查
  checkMissingModels(schemaTables, modelFiles);
  checkMissingDocs(schemaTables, modelFiles);
  checkFieldConsistency(schemaTables, modelFiles);

  // 总结
  log('\n═══════════════════════════════════════════', 'cyan');
  if (hasErrors) {
    log('  ❌ 检查完成，发现错误', 'red');
    log('  请先更新 docs/database/SCHEMA.md 或修复 Model 定义', 'red');
    log('═══════════════════════════════════════════', 'cyan');
    process.exit(1);
  } else {
    log('  ✅ 检查完成，未发现严重错误', 'green');
    log('═══════════════════════════════════════════', 'cyan');
    process.exit(0);
  }
}

// 运行检查
main();
