/** 仅在明确命名的独立合成库建立验收管理员，不连接真实业务库。 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const logger = require('../src/utils/logger');
/** 独立验收登录种子，凭据写入仅本机可读文件。 */
async function main() {
  if (
    !/^apple_order_mgr_stock_test_\d+$/.test(process.env.DB_NAME || '') ||
    process.env.DATABASE_URL ||
    process.env.RUN_STOCK_INTEGRATION !== 'true'
  )
    throw new Error('只允许独立库存合成测试数据库');
  const { User, sequelize } = require('../src/models');
  try {
    const username = 'stock_acceptance';
    const filename = path.join('/app/tmp/stock-dev', `${process.env.DB_NAME}-login.json`);
    let credentials;
    try {
      credentials = JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (_error) {
      credentials = { username, password: crypto.randomBytes(24).toString('base64url') };
    }
    const [user] = await User.findOrCreate({
      where: { username },
      defaults: {
        username,
        password: credentials.password,
        nickname: '合成验收管理员',
        role: 'admin',
        status: 'active',
        orderAccess: { mode: 'all', tags: [] },
      },
    });
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, JSON.stringify({ ...credentials, userId: user.id }), {
      mode: 0o600,
    });
    process.stdout.write(`合成管理员已就绪，凭据文件：${filename}\n`);
  } catch (error) {
    logger.error('合成种子失败', { code: error.name });
    throw error;
  } finally {
    await sequelize.close();
  }
}
main().catch(() => {
  process.exitCode = 1;
});
