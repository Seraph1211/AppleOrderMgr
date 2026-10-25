require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const models = require('../src/models');
const repair = require('../src/services/aosAccountIndexRepair');
const logger = require('../src/utils/logger');

async function persist(file, value) {
  let handle;
  try {
    handle = await fs.open(file, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    const directory = await fs.open(path.dirname(file), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    throw new Error('REPAIR_AUDIT_PERSIST_FAILED', { cause: error });
  } finally {
    await handle?.close();
  }
}
function safeErrorCode(error) {
  let code = 'REPAIR_FAILED';
  for (let depth = 0; error && depth < 8; depth++, error = error.cause) {
    if (typeof error.message === 'string' && /^REPAIR_[A-Z_]+$/.test(error.message))
      code = error.message;
    const sqlState = error.original?.code || error.parent?.code || error.code;
    if (typeof sqlState === 'string' && /^[0-9A-Z]{5}$/.test(sqlState)) code = sqlState;
  }
  return code;
}
/** 默认只读预览；apply需审核manifest摘要并先落盘旧事实备份审计。 @returns {Promise<void>} 完成 */
async function main() {
  try {
    const args = process.argv.slice(2);
    const read = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const scope = { deviceId: read('--device'), localId: read('--instance') };
    if (!args.includes('--apply')) {
      const out = read('--out');
      if (!out) throw new Error('REPAIR_OUTPUT_REQUIRED');
      const manifest = await repair.preview(models, scope, {
        afterId: read('--after'),
        limit: read('--limit') ? Number(read('--limit')) : undefined,
      });
      await persist(out, manifest);
      logger.info('AOS数值状态索引修复预览', {
        digest: manifest.digest,
        scanned: manifest.scanned,
        eligible: manifest.entries.length,
        retained: manifest.retained,
        nextCursor: manifest.nextCursor,
        complete: manifest.complete,
      });
    } else {
      const plan = read('--plan');
      const expectedDigest = read('--expected-digest');
      if (!plan || !/^[0-9a-f]{64}$/.test(expectedDigest || ''))
        throw new Error('REPAIR_REVIEW_REQUIRED');
      const file = await fs.open(plan, 'r');
      let manifest;
      try {
        const data = Buffer.alloc(2 * 1024 * 1024 + 1);
        const { bytesRead } = await file.read(data, 0, data.length, 0);
        if (bytesRead > 2 * 1024 * 1024) throw new Error('REPAIR_MANIFEST_BYTE_BUDGET');
        manifest = JSON.parse(data.subarray(0, bytesRead).toString('utf8'));
      } finally {
        await file.close();
      }
      const audit = path.join(path.dirname(plan), `repair-${randomUUID()}`);
      const result = await repair.apply(models, manifest, expectedDigest, {
        scope,
        beforeDelete: before => persist(`${audit}.before.json`, before),
      });
      await persist(`${audit}.result.json`, result);
      logger.info('AOS数值状态派生索引修复完成', { ...result, audit });
    }
  } catch (error) {
    logger.error('AOS数值状态索引修复未完成', {
      errorCode: safeErrorCode(error),
    });
    process.exitCode = 1;
  } finally {
    await models.sequelize.close();
  }
}
main();
