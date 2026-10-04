/** 显式清理过期且未提交的库存预览；默认仅统计，不在应用启动时执行。 */
const crypto = require('crypto');
const { Op, literal } = require('sequelize');
const ApiError = require('../src/utils/ApiError');
const { encryptJson } = require('../src/utils/fieldEncryption');
const logger = require('../src/utils/logger');
const MAX_BATCH = 500;

/** 解析维护命令，任何不明确或未知参数都拒绝。 */
function parseArgs(args) {
  const result = { apply: false, before: new Date(), batchSize: MAX_BATCH };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply') result.apply = true;
    else if (arg === '--help') result.help = true;
    else if (['--before', '--confirm-database', '--created-by'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw ApiError.badRequest(`${arg}缺少值`);
      if (arg === '--confirm-database') result.confirmDatabase = value;
      else if (arg === '--created-by') {
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
          throw ApiError.badRequest('created-by必须为正整数用户ID');
        result.createdBy = Number(value);
      } else {
        if (
          !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
          !Number.isFinite(Date.parse(value))
        )
          throw ApiError.badRequest('before必须为带时区的ISO时间');
        result.before = new Date(value);
      }
    } else throw ApiError.badRequest(`未知参数：${arg}`);
  }
  if (+result.before > Date.now()) throw ApiError.badRequest('不能清理未来才过期的预览');
  return result;
}

/** 默认预演；apply在模块事务锁内清除过期预览载荷，保留元信息与追加审计。 */
async function cleanExpiredPreviews(options = {}) {
  try {
    const db = require('../src/models');
    const before = options.before || new Date();
    if (!Number.isFinite(+new Date(before)) || +new Date(before) > Date.now())
      throw ApiError.badRequest('过期边界无效');
    const [databaseRows] = await db.sequelize.query('SELECT current_database() AS name');
    const databaseName = databaseRows[0].name;
    const isolated =
      /^apple_order_mgr_stock_test_[0-9]+$/.test(databaseName) &&
      !process.env.DATABASE_URL &&
      process.env.DB_NAME === databaseName;
    if (options.apply && !isolated && options.confirmDatabase !== databaseName)
      throw new ApiError(
        403,
        'DATABASE_CONFIRMATION_REQUIRED',
        '非库存隔离库写入需--confirm-database与实际数据库名称完全一致'
      );
    if (
      options.createdBy !== undefined &&
      (!Number.isSafeInteger(options.createdBy) || options.createdBy <= 0)
    )
      throw ApiError.badRequest('维护用户范围无效');
    const where = {
      status: 'preview',
      expiresAt: { [Op.lte]: new Date(before) },
      ...(options.createdBy !== undefined && { createdBy: options.createdBy }),
    };
    if (!options.apply)
      return {
        dryRun: true,
        eligibleCount: await db.StockImportJob.count({ where }),
        cleanedCount: 0,
        batchLimit: MAX_BATCH,
        before: new Date(before).toISOString(),
      };
    return await db.sequelize.transaction(async transaction => {
      try {
        await require('../src/services/stockCommandService').lockStock(transaction);
        const rows = await db.StockImportJob.findAll({
          where,
          attributes: ['id', 'kind', 'status', 'version'],
          limit: MAX_BATCH,
          order: [
            ['expiresAt', 'ASC'],
            ['id', 'ASC'],
          ],
          transaction,
        });
        if (!rows.length) return { dryRun: false, cleanedCount: 0, remainingCount: 0 };
        const operation = await db.StockOperation.create(
          {
            actorKey: 'maintenance:stock-import',
            actorUserId: null,
            requestKey: crypto.randomUUID(),
            action: 'import.expire',
            requestHash: crypto
              .createHash('sha256')
              .update(JSON.stringify(rows.map(row => row.id)))
              .digest('hex'),
            resultRefs: { importIds: rows.map(row => row.id) },
          },
          { transaction }
        );
        await db.StockImportJob.update(
          {
            status: 'expired',
            payloadCiphertext: {},
            version: literal('version + 1'),
            updatedBy: null,
          },
          { where: { id: { [Op.in]: rows.map(row => row.id) }, status: 'preview' }, transaction }
        );
        await db.StockEvent.bulkCreate(
          rows.map(row => ({
            entityType: 'StockImportJob',
            entityId: row.id,
            action: 'import.expire',
            actorUserId: null,
            actorName: '库存预览维护工具',
            occurredAt: new Date(),
            beforeVersion: row.version,
            afterVersion: row.version + 1,
            operationId: operation.id,
            changesCiphertext: encryptJson({
              before: { status: row.status, version: row.version },
              after: { status: 'expired', version: row.version + 1, payloadCleared: true },
            }),
          })),
          { transaction }
        );
        return {
          dryRun: false,
          cleanedCount: rows.length,
          operationId: operation.id,
          remainingCount: await db.StockImportJob.count({ where, transaction }),
        };
      } catch (error) {
        logger.warn('过期库存预览清理事务未完成', { code: error.code || error.name });
        throw error;
      }
    });
  } catch (error) {
    logger.warn('过期库存预览维护未完成', { code: error.code || error.name });
    throw error;
  }
}

async function main() {
  let db;
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(
        '用法：node scripts/cleanupStockImportPreviews.js [--before ISO时间] [--created-by 用户ID] [--apply] [--confirm-database 实际数据库名]\n默认只统计。--apply每次最多清理500个过期未提交预览；非库存隔离库还必须明确确认数据库名。已提交记录及结果引用不会清理。\n'
      );
      return;
    }
    db = require('../src/models');
    const result = await cleanExpiredPreviews(options);
    logger.info('库存过期预览维护结果', {
      dryRun: result.dryRun,
      eligibleCount: result.eligibleCount,
      cleanedCount: result.cleanedCount,
      remainingCount: result.remainingCount,
    });
  } catch (error) {
    logger.error('库存过期预览维护失败', { code: error.code || error.name });
    process.exitCode = 1;
  } finally {
    if (db) await db.sequelize.close();
  }
}

if (require.main === module) main();
module.exports = { parseArgs, cleanExpiredPreviews };
