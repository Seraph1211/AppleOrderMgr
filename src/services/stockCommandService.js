const crypto = require('crypto');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { encryptJson } = require('../utils/fieldEncryption');
const { getEffectivePermissions } = require('./permissionService');
const { uuid, digest } = require('../utils/stockRules');
const STOCK_LOCK_NAMESPACE = 641004;
const STOCK_LOCK_KEY = 1;
/** 同一模块的所有写入先取锁，旧扫码也调用。 */
async function lockStock(transaction) {
  try {
    await db.sequelize.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s';", {
      transaction,
    });
    await db.sequelize.query('SELECT pg_advisory_xact_lock(:namespace,:key)', {
      replacements: { namespace: STOCK_LOCK_NAMESPACE, key: STOCK_LOCK_KEY },
      transaction,
    });
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockCommandService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 在当前事务重读用户及权限，失效用户不得重放。 */
async function createReadContext(user, transaction) {
  try {
    const current = await db.User.findByPk(user.id, { transaction });
    if (!current || current.status !== 'active') throw new ApiError(403, 'FORBIDDEN', '账号不可用');
    const permissions = new Set(await getEffectivePermissions(current, { transaction }));
    return { user: current, permissions, transaction, authorizations: new Set() };
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockCommandService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 检查全部动作权限。 */
function requirePermissions(ctx, ...codes) {
  codes.forEach(code => ctx.authorizations?.add(code));
  if (codes.some(code => !ctx.permissions.has(code)))
    throw new ApiError(403, 'FORBIDDEN', '没有此操作权限');
}
/** 防止输入无权限敏感字段。 */
function requireField(ctx, code) {
  ctx.authorizations?.add(code);
  if (!ctx.permissions.has(code)) throw new ApiError(403, 'FIELD_FORBIDDEN', '没有此字段权限');
}
/** 敏感输入的权限在幂等重放前也重新校验。 */
function checkWriteFields(ctx, value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'cost' || key === 'officialCostAmount') requireField(ctx, 'stock.cost.edit');
    if (key === 'sourceOrderId') requireField(ctx, 'stock.source.link');
    if (key === 'collection' || key === 'collectionChange') {
      requireField(ctx, 'stock.collections.edit');
      if (child?.destination === 'company') requireField(ctx, 'stock.receipts.edit');
    }
    if (key === 'receiptChanges') requireField(ctx, 'stock.receipts.edit');
    checkWriteFields(ctx, child);
  }
}
/** 从受控模型名读取记录。 */
async function getRow(modelName, id, ctx) {
  try {
    if (modelName !== 'StockSetting') uuid(id);
    const row = await db[modelName].findByPk(id, { transaction: ctx.transaction });
    if (!row) throw ApiError.notFound();
    return row;
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockCommandService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 并发版本校验。 */
function assertVersion(row, expectedVersion) {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0)
    throw ApiError.badRequest('expectedVersion 必须为非负整数');
  if (row.version !== expectedVersion)
    throw ApiError.conflict(
      '记录已更新，请刷新',
      { currentVersion: row.version },
      'VERSION_CONFLICT'
    );
}
/** 在业务事务追加加密审计。 */
async function recordEvent(ctx, entityType, row, action, before = null) {
  try {
    await db.StockEvent.create(
      {
        entityType,
        entityId: entityType === 'StockSetting' ? '00000000-0000-0000-0000-000000000001' : row.id,
        action,
        actorUserId: ctx.user.id,
        actorName: ctx.user.nickname || ctx.user.username,
        occurredAt: new Date(),
        beforeVersion: before?.version ?? null,
        afterVersion: row.version ?? 0,
        changesCiphertext: encryptJson({
          before,
          after: row.toJSON ? row.toJSON() : row,
          reason: ctx.reason || null,
        }),
        operationId: ctx.operationId,
      },
      { transaction: ctx.transaction }
    );
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockCommandService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 修改版本与审计始终一起提交。 */
async function updateRow(ctx, row, values, action) {
  try {
    const before = row.toJSON();
    await row.update(
      { ...values, version: row.version + 1, updatedBy: ctx.user.id },
      { transaction: ctx.transaction }
    );
    await recordEvent(ctx, row.constructor.name, row, action, before);
    return row;
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockCommandService',
      code: error.code || error.name,
    });
    throw error;
  }
}
/** 统一事务、锁、当前权限、幂等及开关；work只返回受控记录引用。 */
async function runCommand(user, input, action, permissions, work, { allowDisabled = false } = {}) {
  try {
    uuid(input.requestKey, '请求键');
    const payload = { ...input };
    delete payload.requestKey;
    delete payload.previewToken;
    const requestHash = digest({ action, payload });
    return await db.sequelize.transaction(async transaction => {
      await lockStock(transaction);
      const ctx = await createReadContext(user, transaction);
      requirePermissions(ctx, ...permissions);
      checkWriteFields(ctx, input);
      const previous = await db.StockOperation.findOne({
        where: { actorKey: String(user.id), requestKey: input.requestKey },
        transaction,
      });
      if (previous) {
        if (previous.requestHash !== requestHash)
          throw ApiError.conflict('请求键已用于不同内容', undefined, 'IDEMPOTENCY_CONFLICT');
        const { _permissions: required = [], ...refs } = previous.resultRefs;
        requirePermissions(ctx, ...required);
        return { ...refs, idempotent: true };
      }
      const settings = await db.StockSetting.findByPk(1, { transaction });
      if (!allowDisabled && !settings.enabled)
        throw ApiError.conflict('库存模块尚未启用', undefined, 'STOCK_NOT_ENABLED');
      const operation = await db.StockOperation.create(
        {
          actorUserId: user.id,
          actorKey: String(user.id),
          requestKey: input.requestKey,
          action,
          requestHash,
          resultRefs: {},
        },
        { transaction }
      );
      ctx.operationId = operation.id;
      ctx.reason = input.reason;
      const result = await work(ctx);
      await operation.update(
        { resultRefs: { ...(result || {}), _permissions: [...ctx.authorizations].sort() } },
        { transaction }
      );
      return { ...result, idempotent: false };
    });
  } catch (error) {
    logger.warn('库存命令失败', { action, userId: user.id, code: error.code || error.name });
    const databaseCode = error.original?.code || error.parent?.code || error.code || '';
    const connectionMessage =
      error.original?.message || error.parent?.message || error.message || '';
    if (
      /^08[A-Z0-9]{3}$/.test(databaseCode) ||
      ['57P01', '57P02', '57P03', 'ECONNRESET', 'EPIPE'].includes(databaseCode) ||
      /^Sequelize(?:Connection|HostNotReachable)/.test(error.name) ||
      /connection (?:terminated|closed)|terminating connection|server closed the connection/i.test(
        connectionMessage
      )
    )
      throw new ApiError(503, 'STOCK_CONNECTION_LOST', '数据库连接暂时不可用，请使用原请求重试');
    if (['55P03', '57014', '40P01'].includes(databaseCode))
      throw new ApiError(503, 'STOCK_BUSY', '库存正在更新，请使用原请求重试');
    if (error.name === 'SequelizeUniqueConstraintError')
      throw ApiError.conflict('记录或序列号已存在', undefined, 'SN_EXISTS');
    if (
      (error.name === 'SequelizeDatabaseError' && /^(22|23)/.test(databaseCode)) ||
      error.name === 'SequelizeForeignKeyConstraintError'
    )
      throw ApiError.badRequest('记录引用或字段不符合约束');
    throw error;
  }
}
/** 兼容旧扫码事务的审计上下文，调用者已经加锁。 */
async function legacyContext(user, transaction, action) {
  try {
    const ctx = await createReadContext(user, transaction);
    const op = await db.StockOperation.create(
      {
        actorUserId: user.id,
        actorKey: String(user.id),
        requestKey: crypto.randomUUID(),
        action,
        requestHash: digest({ action, nonce: crypto.randomUUID() }),
        resultRefs: {},
      },
      { transaction }
    );
    return { ...ctx, operationId: op.id };
  } catch (error) {
    logger.debug('库存处理未完成', {
      module: 'stockCommandService',
      code: error.code || error.name,
    });
    throw error;
  }
}
module.exports = {
  lockStock,
  createReadContext,
  requirePermissions,
  requireField,
  getRow,
  assertVersion,
  recordEvent,
  updateRow,
  runCommand,
  legacyContext,
};
