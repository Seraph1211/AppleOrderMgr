const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_SHA256 = '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8';

/**
 * 在安装前校验固定的公开第三方制品，失败时拒绝继续构建。
 * @param {string} filePath - 待验证的本地制品路径
 * @returns {void}
 */
function verifyVendor(filePath = path.join(__dirname, '../vendor/xlsx-0.20.3.tgz')) {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  if (digest !== EXPECTED_SHA256) {
    throw new Error('SheetJS 制品 SHA-256 不匹配，停止安装');
  }
}

if (require.main === module) {
  try {
    verifyVendor();
    process.stdout.write('SheetJS 制品校验通过\n');
  } catch (_error) {
    // 安装前尚无 Winston 依赖，不打印文件内容或异常原文。
    process.stderr.write('SheetJS 制品缺失或校验失败，停止安装\n');
    process.exitCode = 1;
  }
}

module.exports = { verifyVendor };
