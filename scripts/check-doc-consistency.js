#!/usr/bin/env node

/**
 * 校验 Sequelize 模型字段是否记录在权威数据库文档中。
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, '../docs/database/数据库架构.md');
const MODELS_DIR = path.join(__dirname, '../src/models');

function toSnakeCase(value) {
  return value.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

function fail(message) {
  process.stderr.write(`文档一致性检查失败：${message}\n`);
  process.exitCode = 1;
}

function main() {
  if (!fs.existsSync(SCHEMA_PATH)) {
    fail(`权威文档不存在：${SCHEMA_PATH}`);
    return;
  }
  if (!fs.existsSync(MODELS_DIR)) {
    fail(`模型目录不存在：${MODELS_DIR}`);
    return;
  }

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const modelFiles = fs
    .readdirSync(MODELS_DIR)
    .filter(file => file.endsWith('.js') && file !== 'index.js');

  for (const file of modelFiles) {
    const content = fs.readFileSync(path.join(MODELS_DIR, file), 'utf8');
    const tableName = content.match(/tableName:\s*'([^']+)'/)?.[1];
    if (!tableName) {
      fail(`${file} 缺少 tableName`);
      continue;
    }
    if (!schema.includes(`\`${tableName}\``)) {
      fail(`${file} 的表 ${tableName} 未在权威文档中记录`);
    }

    const fieldPattern = /^( {4}| {6})(\w+):\s*\{/gm;
    let match;
    while ((match = fieldPattern.exec(content)) !== null) {
      const [, indent, property] = match;
      const closing = new RegExp(`^${indent}\\},?$`, 'gm');
      closing.lastIndex = fieldPattern.lastIndex;
      const end = closing.exec(content);
      if (!end) continue;
      const block = content.slice(match.index, end.index);
      if (!/type:\s*DataTypes\./.test(block)) continue;
      const documentedName = block.match(/field:\s*'([^']+)'/)?.[1] || toSnakeCase(property);
      if (!schema.includes(`\`${documentedName}\``)) {
        fail(`${file} 字段 ${documentedName} 未在权威文档中记录`);
      }
    }
  }

  if (!process.exitCode) {
    process.stdout.write(
      `模型字段文档覆盖检查通过：${modelFiles.length} 个模型（不验证数据库实际结构）\n`
    );
  }
}

main();
