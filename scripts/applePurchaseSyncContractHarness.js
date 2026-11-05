#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Sequelize } = require('sequelize');
const migration = require('../migrations/20261106000001-create-apple-purchase-sync');
const { createRouter } = require('../src/routes/applePurchaseSyncMachine');
const terminalService = require('../src/services/applePurchaseSyncTerminalService');
const databaseService = require('../src/services/applePurchaseSyncDatabase');

const OUTPUT_DIR = path.join(__dirname, '../.tmp/apple-purchase-sync-contract');
const CREDENTIAL_PATH = path.join(OUTPUT_DIR, 'terminal.json');
const PORT = Number(process.env.APPLE_PURCHASE_SYNC_HARNESS_PORT || 3301);

function assertIsolation() {
  if (process.env.NODE_ENV !== 'test') throw new Error('契约联调入口只允许 NODE_ENV=test');
  if (!/^apple_purchase_sync_test_/.test(process.env.DB_NAME || '')) {
    throw new Error('契约联调入口只允许 apple_purchase_sync_test_ 前缀数据库');
  }
  if (process.env.DATABASE_URL) throw new Error('契约联调入口禁止 DATABASE_URL');
  if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('联调端口无效');
}

async function ensureSchema(database) {
  const [rows] = await database.query(
    "SELECT 1 FROM information_schema.schemata WHERE schema_name='apple_purchase_sync'"
  );
  if (rows.length) return;
  await database.query(
    'CREATE TABLE IF NOT EXISTS public.users (id INTEGER PRIMARY KEY, username VARCHAR(50))'
  );
  await migration.up(database.getQueryInterface(), Sequelize);
}

function writeCredential(data) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    CREDENTIAL_PATH,
    `${JSON.stringify(
      {
        baseUrl: `http://127.0.0.1:${PORT}`,
        terminalId: data.terminalId,
        token: data.token,
        createdAt: data.tokenCreatedAt,
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  fs.chmodSync(CREDENTIAL_PATH, 0o600);
}

async function main() {
  assertIsolation();
  const database = databaseService.getAdminDatabase();
  await ensureSchema(database);
  const terminal = await terminalService.createTerminal(
    { name: `本地契约联调 ${new Date().toISOString()}` },
    null,
    crypto.randomUUID()
  );
  writeCredential(terminal);
  const app = express();
  app.use('/api/apple-purchase-sync/v1', createRouter());
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(PORT, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  process.stdout.write(`本地冻结 v1 联调入口：http://127.0.0.1:${PORT}\n`);
  process.stdout.write(`一次性终端凭据已写入仅本机 0600 文件：${CREDENTIAL_PATH}\n`);
  process.stdout.write('停止服务请按 Ctrl-C；测试库历史不会在停止时删除。\n');
  const shutdown = async () => {
    await new Promise(resolve => server.close(resolve));
    await databaseService.closeApplePurchaseSyncDatabases();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(error => {
  process.stderr.write(`本地契约联调入口启动失败：${error.message}\n`);
  process.exit(1);
});
