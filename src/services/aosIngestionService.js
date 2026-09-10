/* eslint-disable no-control-regex -- 校验并拒绝路径中的控制字符。 */
/** AOS 可靠接收、处理租约与人工异常处理。 */
const crypto = require('crypto');
const {
  sequelize,
  AosDevice,
  AosRecord,
  IngestionOperation,
  Order,
  OrderSource,
  PickupStore,
} = require('../models');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { parseAosLine, requireAosDraft } = require('./aosParser');
const { createOrderInTransaction } = require('./orderIngestionCore');
const repo = require('./ingestionRepository');
const { Op } = repo;
const TERMINAL = new Set(['succeeded', 'duplicate', 'closed']);
const STATUSES = [
  'received',
  'parsing',
  'ready',
  'processing',
  'succeeded',
  'duplicate',
  'retry_wait',
  'manual_review',
  'closed',
];
const ELIGIBILITIES = ['allowed', 'source_disabled', 'device_disabled', 'out_of_range'];

function maskedEmail(email) {
  if (!email) return null;
  const at = email.indexOf('@');
  return at > 0 ? `${email[0]}***${email.slice(at)}` : '***';
}

/** 只返回非敏感字段及掩码，草稿和普通列表不得泄露密码。 @param {Object} data 解析资料 @returns {Object} 安全预览 */
function safePreview(data = {}) {
  return {
    ...Object.fromEntries(
      [
        'orderNumber',
        'lastName',
        'firstName',
        'pickupStoreCode',
        'products',
        'paymentMethod',
        'recipientTag',
        'orderDate',
      ].map(key => [key, data[key] ?? null])
    ),
    contactEmail: maskedEmail(data.contactEmail),
    appleId: maskedEmail(data.appleId),
    contactPhone: data.contactPhone
      ? `${data.contactPhone.slice(0, 3)}****${data.contactPhone.slice(-4)}`
      : null,
    hasOrderUrl: Boolean(data.orderUrl),
  };
}

/** 返回普通记录 DTO。 @param {Object} row 记录 @returns {Object} DTO */
function recordDto(row) {
  return {
    ...Object.fromEntries(
      [
        'id',
        'deviceId',
        'eventId',
        'fileName',
        'lineNumber',
        'orderNumber',
        'orderDate',
        'receivedAt',
        'status',
        'eligibility',
        'outcome',
        'orderId',
        'version',
        'attemptCount',
        'nextRetryAt',
        'errorCode',
        'issues',
        'safePreview',
        'createdAt',
        'updatedAt',
      ].map(k => [k, row[k] ?? null])
    ),
    hasDraft: Boolean(row.draft),
    hasPassword: Boolean(row.draft?.password || row.payload?.rawLine?.split('\t')[3]),
    history: row.history || [],
  };
}

function validTimestamp(value, optional = false) {
  if (optional && value === null) return true;
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validateRecord(input) {
  repo.assertFields(input, [
    'eventId',
    'directoryId',
    'fileInstanceId',
    'fileName',
    'lineNumber',
    'observedAt',
    'scanRequestId',
    'capturePermitId',
    'rawLine',
  ]);
  for (const key of ['eventId', 'directoryId', 'fileInstanceId']) repo.requireUuid(input[key]);
  for (const key of ['scanRequestId', 'capturePermitId'])
    if (input[key] != null) repo.requireUuid(input[key]);
  if (
    typeof input.fileName !== 'string' ||
    input.fileName.length > 255 ||
    !/^AOS订单记录-[^/\\\u0000-\u001f]+\.txt$/.test(input.fileName) ||
    input.fileName.includes('..') ||
    !Number.isSafeInteger(input.lineNumber) ||
    input.lineNumber < 1 ||
    input.lineNumber > 2147483647 ||
    !validTimestamp(input.observedAt) ||
    typeof input.rawLine !== 'string' ||
    !input.rawLine ||
    /[\r\n]/.test(input.rawLine)
  ) {
    throw ApiError.badRequest('记录元数据无效');
  }
  if (Buffer.byteLength(input.rawLine, 'utf8') > 16384)
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '单行超过容量限制');
}

async function receiveRecord(header, input) {
  validateRecord(input);
  const hash = repo.payloadHash(input);
  try {
    return await repo.ingestionTransaction(async (transaction, settings) => {
      try {
        const device = await repo.authenticateDevice(header, transaction);
        const existing = await AosRecord.findOne({
          where: { deviceId: device.id, eventId: input.eventId },
          transaction,
        });
        if (existing) {
          if (existing.payloadHash !== hash)
            throw ApiError.conflict('事件载荷与首次提交不同', undefined, 'EVENT_PAYLOAD_CONFLICT');
          return receipt(existing, 'already_received');
        }
        const parsed = parseAosLine(input.rawLine);
        let eligibleAt = null;
        if (input.capturePermitId) {
          const permit = await IngestionOperation.findOne({
            where: { id: input.capturePermitId, deviceId: device.id, kind: 'permit' },
            transaction,
          });
          if (
            !permit ||
            !parsed.data.orderDate ||
            permit.data.businessDate !== repo.businessDate(parsed.data.orderDate)
          ) {
            throw ApiError.badRequest('采集许可与设备或订单日期不一致');
          }
          eligibleAt = permit.createdAt;
        }
        if (
          !eligibleAt &&
          settings.activeSource === 'aos' &&
          parsed.data.orderDate &&
          repo.businessDate(parsed.data.orderDate) === repo.businessDate()
        )
          eligibleAt = new Date();
        if (input.scanRequestId) {
          const scan = await IngestionOperation.findOne({
            where: { id: input.scanRequestId, deviceId: device.id, kind: 'scan' },
            transaction,
          });
          if (!scan) throw ApiError.badRequest('扫描指令不属于此设备');
        }
        const row = await AosRecord.create(
          {
            id: crypto.randomUUID(),
            deviceId: device.id,
            eventId: input.eventId,
            payloadHash: hash,
            payload: input,
            fileName: input.fileName,
            lineNumber: input.lineNumber,
            receivedAt: new Date(),
            orderNumber: parsed.data.orderNumber || null,
            orderDate: parsed.data.orderDate || null,
            safePreview: safePreview(parsed.data),
            issues: parsed.issues,
            status: parsed.issues.length ? 'manual_review' : 'ready',
            eligibleAt,
            eligibility: repo.eligibility(
              settings,
              'aos',
              { eligibleAt, orderDate: parsed.data.orderDate },
              device
            ),
            errorCode: parsed.issues[0]?.code || null,
          },
          { transaction }
        );
        return receipt(row, 'accepted');
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

function receipt(row, status) {
  return {
    eventId: row.eventId,
    receiptStatus: status,
    recordId: row.id,
    processingStatus: row.status,
    eligibility: row.eligibility,
    errorCode: row.errorCode || null,
    retryable: false,
  };
}

/** 逐条持久化批量上传，失败仅影响当前行。 @param {string} header 设备认证 @param {Object} body 批量请求 @returns {Promise<Object>} 回执 */
async function receiveBatch(header, body) {
  repo.assertFields(body, ['schemaVersion', 'records']);
  if (body.schemaVersion !== 1)
    throw ApiError.badRequest('协议版本不支持', undefined, 'UNSUPPORTED_SCHEMA_VERSION');
  if (!Array.isArray(body.records) || body.records.length < 1 || body.records.length > 100)
    throw ApiError.badRequest('批次应为 1–100 条');
  const ids = body.records.map(row => row?.eventId);
  if (new Set(ids).size !== ids.length) throw ApiError.badRequest('同批事件 ID 不得重复');
  try {
    await repo.authenticateDevice(header);
    const results = [];
    for (const input of body.records) {
      try {
        results.push(await receiveRecord(header, input));
      } catch (error) {
        results.push({
          eventId:
            typeof input?.eventId === 'string' && repo.UUID_PATTERN.test(input.eventId)
              ? input.eventId
              : null,
          receiptStatus: 'rejected',
          recordId: null,
          processingStatus: null,
          eligibility: null,
          errorCode: error.statusCode ? error.code : 'TEMPORARILY_UNAVAILABLE',
          retryable: !error.statusCode || error.statusCode >= 500,
        });
      }
    }
    return { results };
  } catch (error) {
    logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
    throw error;
  }
}

async function saveParsed(row, parsed, transaction) {
  try {
    row.safePreview = safePreview(parsed.data);
    row.orderNumber = parsed.data.orderNumber || null;
    row.orderDate = parsed.data.orderDate || null;
    row.issues = parsed.issues;
    row.errorCode = parsed.issues[0]?.code || null;
    row.status = parsed.issues.length ? 'manual_review' : 'ready';
    row.version += 1;
    await row.save({ transaction });
  } catch (error) {
    logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
    throw error;
  }
}

/** 在调用方事务中入库，调用方已持有全局来源锁。 @param {Object} row 记录 @param {Object} settings 设置 @param {Object} transaction 事务 @returns {Promise<Object>} 结果 */
async function ingestInTransaction(row, settings, transaction) {
  try {
    const device = await AosDevice.findByPk(row.deviceId, { transaction });
    repo.requireAllowed(repo.eligibility(settings, 'aos', row, device));
    if (!['ready', 'processing'].includes(row.status))
      throw ApiError.conflict('当前状态不能入库', undefined, 'RECORD_STATE_INVALID');
    const parsed = row.draft
      ? { data: requireAosDraft(row.draft.data), password: row.draft.password, issues: [] }
      : parseAosLine(row.payload.rawLine);
    if (parsed.issues.length)
      throw ApiError.badRequest('记录仍有校验问题', { issues: parsed.issues });
    const data = parsed.data;
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:orderNumber))', {
      replacements: { orderNumber: data.orderNumber },
      transaction,
    });
    let order = await Order.findOne({ where: { orderNumber: data.orderNumber }, transaction });
    const outcome = order ? 'duplicate' : 'created';
    if (!order) {
      const store = await PickupStore.findByPk(data.pickupStoreCode, { transaction });
      order = await createOrderInTransaction(
        {
          orderNumber: data.orderNumber,
          appleId: data.appleId,
          applePassword: parsed.password,
          recipient: {
            name: `${data.lastName}${data.firstName}`,
            email: data.contactEmail,
            phone: data.contactPhone,
            tag: data.recipientTag,
          },
          sourceLastName: data.lastName,
          sourceFirstName: data.firstName,
          products: data.products,
          orderStatus: 'pending',
          orderUrl: data.orderUrl,
          orderDate: new Date(data.orderDate),
          paymentMethod: data.paymentMethod,
          pickupStoreCode: data.pickupStoreCode,
          pickupStore: store?.name || null,
        },
        transaction,
        { source: 'aos' }
      );
    }
    await OrderSource.create(
      {
        id: crypto.randomUUID(),
        orderId: order.id,
        source: 'aos',
        aosRecordId: row.id,
        result: outcome,
        receivedAt: row.receivedAt,
      },
      { transaction }
    );
    Object.assign(row, {
      orderId: order.id,
      outcome,
      status: outcome === 'created' ? 'succeeded' : 'duplicate',
      eligibility: 'allowed',
      eligibleAt: row.eligibleAt || new Date(),
      leaseUntil: null,
      leaseToken: null,
      nextRetryAt: null,
      errorCode: null,
      version: row.version + 1,
    });
    await row.save({ transaction });
    return { record: recordDto(row), orderId: order.id, outcome };
  } catch (error) {
    logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
    throw error;
  }
}

/** 处理记录的后台租约，旧执行器失去令牌后不得提交。 @returns {Promise<number>} 处理数量 */
async function processQueue() {
  try {
    const claimed = await repo.ingestionTransaction(async (transaction, settings) => {
      try {
        if (settings.activeSource !== 'aos') return [];
        const devices = await AosDevice.findAll({
          where: { enabled: true },
          attributes: ['id'],
          transaction,
        });
        const { from, toExclusive } = repo.dayBounds();
        const rows = await AosRecord.findAll({
          where: {
            deviceId: { [Op.in]: devices.map(d => d.id) },
            [Op.and]: [
              {
                [Op.or]: [
                  { eligibleAt: { [Op.ne]: null } },
                  { orderDate: { [Op.gte]: from, [Op.lt]: toExclusive } },
                ],
              },
              {
                [Op.or]: [
                  { status: { [Op.in]: ['received', 'ready'] } },
                  { status: 'retry_wait', nextRetryAt: { [Op.lte]: new Date() } },
                  { status: 'processing', leaseUntil: { [Op.lte]: new Date() } },
                ],
              },
            ],
          },
          order: [['receivedAt', 'ASC']],
          limit: 100,
          transaction,
          lock: transaction.LOCK.UPDATE,
          skipLocked: true,
        });
        for (const row of rows) {
          Object.assign(row, {
            status: 'processing',
            leaseToken: crypto.randomUUID(),
            leaseUntil: new Date(Date.now() + 60000),
            eligibleAt: row.eligibleAt || new Date(),
            eligibility: 'allowed',
            version: row.version + 1,
          });
          await row.save({ transaction });
        }
        return rows.map(row => ({ id: row.id, leaseToken: row.leaseToken }));
      } catch (error) {
        logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
        throw error;
      }
    });
    for (const claimedRow of claimed) {
      try {
        await repo.ingestionTransaction(async (transaction, settings) => {
          try {
            const row = await AosRecord.findByPk(claimedRow.id, {
              transaction,
              lock: transaction.LOCK.UPDATE,
            });
            if (row.leaseToken !== claimedRow.leaseToken || row.status !== 'processing') return;
            await ingestInTransaction(row, settings, transaction);
          } catch (error) {
            logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
            throw error;
          }
        });
      } catch (error) {
        await repo.ingestionTransaction(async (transaction, settings) => {
          try {
            const row = await AosRecord.findByPk(claimedRow.id, {
              transaction,
              lock: transaction.LOCK.UPDATE,
            });
            if (!row || row.leaseToken !== claimedRow.leaseToken || TERMINAL.has(row.status))
              return;
            const device = await AosDevice.findByPk(row.deviceId, { transaction });
            const reason = repo.eligibility(settings, 'aos', row, device);
            row.leaseToken = null;
            row.leaseUntil = null;
            row.version += 1;
            if (reason !== 'allowed') {
              row.status = 'ready';
              row.eligibility = reason;
            } else {
              row.attemptCount += 1;
              const retryable = !error.statusCode || error.statusCode >= 500;
              row.status = retryable && row.attemptCount < 3 ? 'retry_wait' : 'manual_review';
              row.nextRetryAt =
                row.status === 'retry_wait'
                  ? new Date(Date.now() + 1000 * 2 ** row.attemptCount)
                  : null;
              row.errorCode = retryable ? 'TEMPORARILY_UNAVAILABLE' : error.code;
              row.issues = error.details?.issues || row.issues;
            }
            await row.save({ transaction });
          } catch (failure) {
            logger.debug('来源操作未完成', { errorCode: failure.code || 'DATABASE_TEMPORARY' });
            throw failure;
          }
        });
      }
    }
    return claimed.length;
  } catch (error) {
    logger.warn('AOS 队列执行失败', { errorCode: error.code || 'DATABASE_TEMPORARY' });
    throw error;
  }
}

/** 手工操作，统一版本、来源、终态和审计检查。 @param {string} action 动作 @param {Object} req 请求 @returns {Promise<Object>} DTO */
function processManual(action, req) {
  repo.requireUuid(req.params.id);
  const fields = {
    reparse: ['expectedVersion'],
    draft: ['expectedVersion', 'data', 'passwordAction', 'password'],
    ingest: ['expectedVersion'],
    retry: ['expectedVersion'],
    resolve: ['expectedVersion', 'action', 'reason', 'orderId'],
  };
  repo.assertFields(req.body, fields[action]);
  return repo.manageOperation(req, async (transaction, settings) => {
    try {
      const row = await AosRecord.findByPk(req.params.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!row) throw ApiError.notFound();
      repo.assertVersion(row, req.body.expectedVersion);
      if (TERMINAL.has(row.status) || row.status === 'processing')
        throw ApiError.conflict('记录当前状态不能修改', undefined, 'RECORD_STATE_INVALID');
      if (action === 'ingest') {
        await repo.audit(req.user, '人工入库', row.id, transaction);
        return ingestInTransaction(row, settings, transaction);
      }
      if (action === 'reparse') {
        const parsed = parseAosLine(row.payload.rawLine);
        if (
          !parsed.data.orderDate ||
          !row.orderDate ||
          repo.businessDate(parsed.data.orderDate) !== repo.businessDate(row.orderDate)
        )
          row.eligibleAt = null;
        row.draft = null;
        await saveParsed(row, parsed, transaction);
      } else if (action === 'draft') {
        const data = requireAosDraft(req.body.data);
        const mode = req.body.passwordAction || 'keep';
        if (
          !['keep', 'replace'].includes(mode) ||
          (mode === 'keep' && Object.hasOwn(req.body, 'password'))
        )
          throw ApiError.badRequest('密码操作无效');
        const password =
          mode === 'replace'
            ? req.body.password
            : row.draft?.password || parseAosLine(row.payload.rawLine).password;
        if (typeof password !== 'string' || !password || password.length > 1024)
          throw ApiError.badRequest('密码必须为 1–1024 字符');
        if (row.orderDate && repo.businessDate(data.orderDate) !== repo.businessDate(row.orderDate))
          row.eligibleAt = null;
        row.draft = { data, password };
        await saveParsed(row, { data, issues: [] }, transaction);
      } else if (action === 'retry') {
        if (row.status !== 'retry_wait')
          throw ApiError.conflict(
            '只有等待重试的记录可以重新排队',
            undefined,
            'RECORD_STATE_INVALID'
          );
        const device = await AosDevice.findByPk(row.deviceId, { transaction });
        repo.requireAllowed(repo.eligibility(settings, 'aos', row, device));
        row.nextRetryAt = new Date();
        row.version += 1;
      } else if (action === 'resolve') {
        if (
          !['close', 'link_existing'].includes(req.body.action) ||
          typeof req.body.reason !== 'string' ||
          !req.body.reason.trim() ||
          req.body.reason.length > 500
        )
          throw ApiError.badRequest('处理动作和原因无效');
        if (req.body.action === 'link_existing') {
          const device = await AosDevice.findByPk(row.deviceId, { transaction });
          repo.requireAllowed(repo.eligibility(settings, 'aos', row, device));
          if (!Number.isSafeInteger(req.body.orderId) || req.body.orderId < 1)
            throw ApiError.badRequest('目标订单无效');
          const order = await Order.findByPk(req.body.orderId, { transaction });
          if (!order || order.orderNumber !== row.orderNumber)
            throw ApiError.badRequest('目标订单号与来源记录不一致');
          await OrderSource.create(
            {
              id: crypto.randomUUID(),
              orderId: order.id,
              source: 'aos',
              aosRecordId: row.id,
              result: 'duplicate',
              receivedAt: row.receivedAt,
            },
            { transaction }
          );
          row.orderId = order.id;
          row.outcome = 'duplicate';
          row.status = 'duplicate';
        } else {
          row.status = 'closed';
          row.outcome = null;
        }
        row.version += 1;
        // 原因可能含个人资料，不复制到普通 DTO；只存加密载荷。
        row.payload = { ...row.payload, resolutionReason: req.body.reason };
      }
      row.history = [...row.history, { at: new Date().toISOString(), action, userId: req.user.id }];
      row.eligibility = repo.eligibility(
        settings,
        'aos',
        row,
        await AosDevice.findByPk(row.deviceId, { transaction })
      );
      await row.save({ transaction });
      await repo.audit(req.user, action, row.id, transaction);
      return { record: recordDto(row), preview: row.safePreview, issues: row.issues };
    } catch (error) {
      logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
      throw error;
    }
  });
}

/** 将本机已回执事件关联到指定扫描，支持重扫已有本地队列。 @param {string} header 凭证 @param {string} scanId 扫描 @param {string[]} eventIds 事件 @returns {Promise<void>} 结果 */
function associateScan(header, scanId, eventIds) {
  repo.requireUuid(scanId);
  return repo.ingestionTransaction(async transaction => {
    try {
      const device = await repo.authenticateDevice(header, transaction);
      const scan = await IngestionOperation.findOne({
        where: { id: scanId, deviceId: device.id, kind: 'scan' },
        transaction,
      });
      if (!scan) throw ApiError.badRequest('扫描任务不属于此设备');
      const rows = await AosRecord.findAll({
        where: { deviceId: device.id, eventId: { [Op.in]: eventIds } },
        attributes: ['id'],
        transaction,
      });
      if (rows.length !== new Set(eventIds).size)
        throw ApiError.badRequest('扫描回执中包含尚未可靠接收的事件');
      await IngestionOperation.bulkCreate(
        rows.map(row => ({
          id: crypto.randomUUID(),
          kind: 'scan_record',
          scope: `scan-record:${scanId}:${row.id}`,
          status: 'received',
          deviceId: device.id,
          data: { scanRequestId: scanId, aosRecordId: row.id },
        })),
        { transaction, ignoreDuplicates: true }
      );
    } catch (error) {
      logger.debug('扫描回执关联未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
      throw error;
    }
  });
}

module.exports = {
  associateScan,
  STATUSES,
  ELIGIBILITIES,
  TERMINAL,
  validTimestamp,
  safePreview,
  recordDto,
  receiveBatch,
  processQueue,
  processManual,
  ingestInTransaction,
};
