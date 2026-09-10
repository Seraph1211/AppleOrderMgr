/** 来源设置、事务边界及管理操作持久化。 */
const crypto = require('crypto');
const { Op } = require('sequelize');
const {
  sequelize,
  IngestionSetting,
  IngestionOperation,
  AosDevice,
  OperationLog,
} = require('../models');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { blindIndex } = require('../utils/fieldEncryption');

const INGESTION_LOCK_ID = 921100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 返回北京时间业务日。 @param {Date|string} value 时间 @returns {string} 日期 */
function businessDate(value = new Date()) {
  return new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);
}

/** 获取日界。 @param {string} day 北京日期 @returns {Object} 左闭右开时间 */
function dayBounds(day = businessDate()) {
  const from = new Date(`${day}T00:00:00+08:00`);
  return {
    from: from.toISOString(),
    toExclusive: new Date(from.getTime() + 86400000).toISOString(),
  };
}

/** UUID 校验。 @param {string} value 输入 @returns {string} ID */
function requireUuid(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value))
    throw ApiError.badRequest('标识符必须是 UUID');
  return value;
}

/** 未知字段拒绝。 @param {Object} value 输入 @param {string[]} fields 允许字段 @returns {void} */
function assertFields(value, fields) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(k => !fields.includes(k))
  ) {
    throw ApiError.badRequest('请求包含未知字段或结构无效');
  }
}

/** 乐观锁检查。 @param {Object} row 模型 @param {number} expectedVersion 期望 @returns {void} */
function assertVersion(row, expectedVersion) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    throw ApiError.badRequest('expectedVersion 必须为正整数');
  if (row.version !== expectedVersion)
    throw ApiError.conflict('数据已变化，请刷新后重试', undefined, 'VERSION_CONFLICT');
}

/** 规范化内容用于摘要，与 JSON 对象属性顺序无关。 @param {*} value JSON @returns {string} 规范序列 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** 带服务端密钥的载荷摘要。 @param {*} value JSON @returns {string} 摘要 */
function payloadHash(value) {
  // blindIndex 会规范化文本，先 SHA-256 保留载荷大小写及空格差异。
  return blindIndex(crypto.createHash('sha256').update(canonical(value)).digest('hex'));
}

/** 与来源切换和设备禁用使用同一个事务锁，始终首先调用。 @param {Object} transaction 事务 @returns {Promise<Object>} 设置 */
async function lockSettings(transaction) {
  try {
    await sequelize.query('SELECT pg_advisory_xact_lock(:id)', {
      replacements: { id: INGESTION_LOCK_ID },
      transaction,
    });
    const settings = await IngestionSetting.findByPk(1, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!settings) throw new ApiError(503, 'TEMPORARILY_UNAVAILABLE', '来源设置尚未初始化');
    return settings;
  } catch (error) {
    logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
    throw error;
  }
}

/** 统一来源事务执行器。 @param {Function} work 事务内工作 @returns {Promise<*>} 结果 */
async function ingestionTransaction(work) {
  try {
    return await sequelize.transaction(async transaction => {
      try {
        return await work(transaction, await lockSettings(transaction));
      } catch (error) {
        logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
        throw error;
      }
    });
  } catch (error) {
    if (!error.statusCode) logger.warn('来源事务失败', { errorCode: 'DATABASE_TEMPORARY' });
    throw error;
  }
}

/** 来源资格最终检查；跨天只恢复已经持久化取得范围资格的记录。 @param {Object} settings 设置 @param {string} source 来源 @param {Object} record 记录 @param {Object} device 设备 @returns {string} 原因 */
function eligibility(settings, source, record, device = null) {
  if (device && !device.enabled) return 'device_disabled';
  if (settings.activeSource !== source) return 'source_disabled';
  if (
    !record.eligibleAt &&
    !record.ingestionEligibleAt &&
    (!record.orderDate || businessDate(record.orderDate) !== businessDate())
  )
    return 'out_of_range';
  return 'allowed';
}

/** 将暂停原因转换为稳定 API 错误。 @param {string} reason 暂停原因 @returns {void} */
function requireAllowed(reason) {
  const codes = new Map([
    ['source_disabled', 'SOURCE_DISABLED'],
    ['device_disabled', 'DEVICE_DISABLED'],
    ['out_of_range', 'RECORD_OUT_OF_RANGE'],
  ]);
  if (reason !== 'allowed')
    throw new ApiError(409, codes.get(reason) || 'RECORD_STATE_INVALID', '当前记录暂停处理', {
      eligibility: reason,
    });
}

/** 同事务追加无敏感值的操作审计。 @param {Object} actor 操作者 @param {string} action 动作 @param {string} target 目标 @param {Object} transaction 事务 @returns {Promise<Object>} 日志 */
function audit(actor, action, target, transaction) {
  return OperationLog.create(
    {
      actorUserId: actor?.id || null,
      username: actor?.username || null,
      action: `订单数据源：${action}`,
      target,
      method: 'POST',
      statusCode: 200,
      result: 'success',
      requestId: crypto.randomUUID(),
    },
    { transaction }
  );
}

/** 管理幂等操作，凭证明文只存在当次内存响应。 @param {Object} req HTTP 请求 @param {Function} work 工作 @returns {Promise<Object>} 结果 */
async function manageOperation(req, work) {
  const key = requireUuid(req.get('Idempotency-Key'));
  const scope = `idempotency:${req.user.id}:${req.method}:${req.baseUrl}${req.path}:${key}`;
  const hash = payloadHash(req.body);
  try {
    return await ingestionTransaction(async (transaction, settings) => {
      try {
        const previous = await IngestionOperation.findOne({ where: { scope }, transaction });
        if (previous && previous.expiresAt > new Date()) {
          if (previous.requestHash !== hash)
            throw ApiError.conflict('幂等键已用于不同请求', undefined, 'IDEMPOTENCY_CONFLICT');
          return previous.data;
        }
        if (previous) await previous.destroy({ transaction });
        const response = await work(transaction, settings);
        const stored = structuredClone(response);
        if (Object.hasOwn(stored, 'credential')) {
          stored.credential = null;
          stored.credentialDisplayed = true;
        }
        await IngestionOperation.create(
          {
            id: crypto.randomUUID(),
            kind: 'idempotency',
            scope,
            requestHash: hash,
            actorId: req.user.id,
            status: 'completed',
            data: stored,
            expiresAt: new Date(Date.now() + 86400000),
          },
          { transaction }
        );
        return response;
      } catch (error) {
        logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
        throw error;
      }
    });
  } catch (error) {
    logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
    throw error;
  }
}

/** 验证专用设备 Bearer 凭证，拒绝普通用户 JWT。 @param {string} header 认证头 @param {Object} transaction 可选事务 @returns {Promise<Object>} 设备 */
async function authenticateDevice(header, transaction) {
  try {
    const match = /^Bearer (aos_[A-Za-z0-9_-]{43})$/.exec(header || '');
    if (!match) throw new ApiError(401, 'DEVICE_UNAUTHORIZED', '设备凭证无效');
    const hash = crypto.createHash('sha256').update(match[1]).digest('hex');
    const device = await AosDevice.findOne({ where: { credentialHash: hash }, transaction });
    if (!device) throw new ApiError(401, 'DEVICE_UNAUTHORIZED', '设备凭证无效');
    if (!device.enabled) throw new ApiError(403, 'DEVICE_DISABLED', '设备已禁用');
    return device;
  } catch (error) {
    logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
    throw error;
  }
}

/** 创建不可预测的设备凭证。 @returns {Object} 明文与摘要 */
function createCredential() {
  const credential = `aos_${crypto.randomBytes(32).toString('base64url')}`;
  return {
    credential,
    credentialHash: crypto.createHash('sha256').update(credential).digest('hex'),
  };
}

/** 分页参数。 @param {Object} query 查询参数 @returns {Object} 分页 */
function pagination(query) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger((page - 1) * limit)
  )
    throw ApiError.badRequest('分页参数无效');
  return { page, limit, offset: (page - 1) * limit };
}

/** 同步非终态资格及当天许可，供切换、设备启停与跨日核对使用。 @param {Object} settings 设置 @param {Object} transaction 事务 @returns {Promise<void>} 结果 */
async function refreshEligibility(settings, transaction) {
  try {
    const { from, toExclusive } = dayBounds();
    await sequelize.query(
      `UPDATE aos_records r SET eligibility = CASE
      WHEN NOT d.enabled THEN 'device_disabled'
      WHEN :source <> 'aos' THEN 'source_disabled'
      WHEN r.eligible_at IS NOT NULL OR (r.order_date >= :from AND r.order_date < :toExclusive) THEN 'allowed'
      ELSE 'out_of_range' END,
      eligible_at = CASE WHEN d.enabled AND :source = 'aos' AND r.order_date >= :from AND r.order_date < :toExclusive THEN COALESCE(r.eligible_at, NOW()) ELSE r.eligible_at END
      FROM aos_devices d WHERE r.device_id = d.id AND r.status NOT IN ('succeeded','duplicate','closed')`,
      { replacements: { source: settings.activeSource, from, toExclusive }, transaction }
    );
  } catch (error) {
    logger.warn('来源资格核对失败', { errorCode: 'DATABASE_TEMPORARY' });
    throw error;
  }
}

module.exports = {
  refreshEligibility,
  Op,
  UUID_PATTERN,
  businessDate,
  dayBounds,
  requireUuid,
  assertFields,
  assertVersion,
  canonical,
  payloadHash,
  lockSettings,
  ingestionTransaction,
  eligibility,
  requireAllowed,
  audit,
  manageOperation,
  authenticateDevice,
  createCredential,
  pagination,
};
