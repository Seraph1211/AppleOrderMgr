/** 自有库存的私有附件授权、上传核验和无订单 OCR 入口。 */
const crypto = require('crypto');
const { Op } = require('sequelize');
const models = require('../models');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const oss = require('./ossService');
const ocr = require('./pickupOcrService');
const {
  createReadContext,
  requirePermissions,
  assertVersion,
  recordEvent,
  updateRow,
} = require('./stockCommandService');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREPARE_TTL_MS = 24 * 60 * 60 * 1000;
const VERIFY_TTL_MS = 60 * 1000;
const MAX_TARGETS = 100;
const TARGETS = {
  unit: { model: 'StockUnit', field: 'unitId', read: 'stock.read', write: ['stock.receive'] },
  sale: {
    model: 'StockSale',
    field: 'saleId',
    read: 'stock.sales.read',
    write: ['stock.sales.edit', 'stock.sales.ship'],
  },
  collection: {
    model: 'StockCollection',
    field: 'collectionId',
    read: 'stock.collections.read',
    write: ['stock.collections.edit'],
  },
  receipt: {
    model: 'StockReceipt',
    field: 'receiptId',
    read: 'stock.receipts.read',
    write: ['stock.receipts.edit'],
  },
  expense: {
    model: 'StockExpense',
    field: 'expenseId',
    read: 'stock.expenses.read',
    write: ['stock.expenses.edit'],
  },
};
const KIND_TARGET = {
  ['unit_photo']: 'unit',
  ['sale_document']: 'sale',
  ['collection_proof']: 'collection',
  ['receipt_proof']: 'receipt',
  ['expense_proof']: 'expense',
};

function allowedFields(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw ApiError.badRequest('凭证参数必须是对象');
  if (Object.keys(input).some(key => !fields.includes(key)))
    throw ApiError.badRequest('凭证参数包含未知字段');
}

/** 规范化最多100个唯一业务目标，不接受自由对象路径。 */
function normalizeTargets(targets) {
  if (!Array.isArray(targets) || !targets.length || targets.length > MAX_TARGETS)
    throw ApiError.badRequest('凭证须关联 1 至 100 个有效目标');
  const seen = new Set();
  return targets.map(target => {
    allowedFields(target, ['type', 'id']);
    if (!Object.hasOwn(TARGETS, target.type) || !UUID_PATTERN.test(target.id || ''))
      throw ApiError.badRequest('凭证关联目标无效');
    const item = { type: target.type, id: target.id.toLowerCase() };
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) throw ApiError.badRequest('凭证关联目标重复');
    seen.add(key);
    return item;
  });
}

/** 每个关联目标都要有对应领域权限，并批量确认目标仍然存在。 */
async function authorizeTargets(ctx, targets, mode) {
  try {
    requirePermissions(ctx, 'stock.read');
    for (const type of [...new Set(targets.map(item => item.type))]) {
      const config = TARGETS[type];
      requirePermissions(ctx, config.read);
      if (mode === 'write' && !config.write.some(code => ctx.permissions.has(code)))
        throw new ApiError(403, 'FORBIDDEN', '缺少凭证关联目标的操作权限');
      const ids = targets.filter(item => item.type === type).map(item => item.id);
      const rows = await models[config.model].findAll({
        where: { id: { [Op.in]: ids } },
        attributes: ['id'],
        transaction: ctx.transaction,
      });
      if (rows.length !== ids.length) throw ApiError.notFound('凭证关联目标不存在或不可访问');
    }
  } catch (error) {
    logger.warn('库存文件操作未完成', { code: error.code || error.name });
    throw error;
  }
}

async function loadAttachment(ctx, id, mode) {
  try {
    if (!UUID_PATTERN.test(id || '')) throw ApiError.badRequest('凭证标识无效');
    const row = await models.StockAttachment.findByPk(id, { transaction: ctx.transaction });
    if (!row) throw ApiError.notFound('凭证不存在');
    const links = await models.StockAttachmentLink.findAll({
      where: { attachmentId: row.id },
      transaction: ctx.transaction,
    });
    const targets = links.map(link => {
      const matched = Object.entries(TARGETS).filter(([, config]) => link[config.field]);
      if (matched.length !== 1) throw ApiError.internal('凭证关联状态异常');
      const [type, config] = matched[0];
      return { type, id: link[config.field] };
    });
    if (!targets.length) throw ApiError.notFound('凭证没有可访问的关联目标');
    await authorizeTargets(ctx, targets, mode);
    return { row, targets };
  } catch (error) {
    logger.warn('库存文件操作未完成', { code: error.code || error.name });
    throw error;
  }
}

function assertPrepared(ctx, row) {
  if (row.status !== 'prepared') throw ApiError.conflict('凭证已确认，不能重新上传');
  if (new Date(row.expiresAt).getTime() <= Date.now())
    throw new ApiError(410, 'ATTACHMENT_EXPIRED', '上传准备已过期，请重新选择文件');
  if (Number(row.createdBy) !== Number(ctx.user.id) && ctx.user.role !== 'admin')
    throw new ApiError(403, 'FORBIDDEN', '只能确认本人准备的凭证');
}

/** 在统一命令事务中建立预备记录；文件仍需直传和独立确认。 */
async function prepareAttachment(ctx, input) {
  try {
    allowedFields(input, [
      'requestKey',
      'kind',
      'originalName',
      'contentType',
      'sizeBytes',
      'targets',
    ]);
    const targets = normalizeTargets(input.targets);
    if (
      !Object.hasOwn(KIND_TARGET, input.kind) ||
      !targets.some(item => item.type === KIND_TARGET[input.kind])
    )
      throw ApiError.badRequest('凭证类型与关联目标不匹配');
    await authorizeTargets(ctx, targets, 'write');
    const id = crypto.randomUUID();
    const file = oss.createStockUpload(id, input.kind, input);
    const row = await models.StockAttachment.create(
      {
        id,
        kind: input.kind,
        objectKey: file.objectKey,
        originalName: file.originalName,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        status: 'prepared',
        expiresAt: new Date(Date.now() + PREPARE_TTL_MS),
        createdBy: ctx.user.id,
        updatedBy: ctx.user.id,
      },
      { transaction: ctx.transaction }
    );
    await models.StockAttachmentLink.bulkCreate(
      targets.map(target => ({
        attachmentId: id,
        [TARGETS[target.type].field]: target.id,
        createdBy: ctx.user.id,
        updatedBy: ctx.user.id,
      })),
      { transaction: ctx.transaction }
    );
    await recordEvent(ctx, 'attachment', row, 'attachment.prepare', null);
    return { attachmentId: id };
  } catch (error) {
    logger.warn('库存文件操作未完成', { code: error.code || error.name });
    throw error;
  }
}

/** 准备命令或其幂等重放之后再次鉴权并签发短期上传地址。 */
async function readUpload(user, id) {
  try {
    const ctx = await createReadContext(user);
    const { row, targets } = await loadAttachment(ctx, id, 'write');
    assertPrepared(ctx, row);
    return {
      attachmentId: row.id,
      version: row.version,
      status: row.status,
      originalName: row.originalName,
      contentType: row.contentType,
      sizeBytes: Number(row.sizeBytes),
      targets,
      ...oss.createStockUploadUrl(row.objectKey, row),
    };
  } catch (error) {
    logger.warn('库存文件操作未完成', { code: error.code || error.name });
    throw error;
  }
}

/** 在取得模块锁前进行网络 HEAD；结果仅供服务端内部传入确认命令。 */
async function verifyAttachment(user, id) {
  try {
    const ctx = await createReadContext(user);
    const { row } = await loadAttachment(ctx, id, 'write');
    if (row.status === 'confirmed') return { attachmentId: row.id, alreadyConfirmed: true };
    assertPrepared(ctx, row);
    const verification = await oss.confirmStockUpload(row.objectKey, row);
    return { ...verification, attachmentId: row.id, version: row.version, verifiedAt: Date.now() };
  } catch (error) {
    logger.warn('库存凭证核验未完成', { actorId: user?.id, attachmentId: id, code: error.code });
    throw error;
  }
}

/** 锁内复核版本、权限和上传状态，禁止客户端自报上传成功。 */
async function confirmAttachment(ctx, id, input, verification) {
  try {
    allowedFields(input, ['requestKey', 'expectedVersion']);
    const { row } = await loadAttachment(ctx, id, 'write');
    assertVersion(row, input.expectedVersion);
    assertPrepared(ctx, row);
    if (
      !verification ||
      verification.attachmentId !== row.id ||
      verification.objectKey !== row.objectKey ||
      verification.version !== row.version ||
      verification.sizeBytes !== Number(row.sizeBytes) ||
      verification.contentType !== row.contentType ||
      !Number.isFinite(verification.verifiedAt) ||
      Date.now() - verification.verifiedAt > VERIFY_TTL_MS
    )
      throw ApiError.conflict('凭证核验已变化或过期，请重新确认');
    await updateRow(ctx, row, { status: 'confirmed' }, 'attachment.confirm');
    return { attachmentId: row.id };
  } catch (error) {
    logger.warn('库存文件操作未完成', { code: error.code || error.name });
    throw error;
  }
}

/** 读取前重新校验全部关联领域，短期 URL 不保存到业务记录。 */
async function readAttachment(user, id) {
  try {
    const ctx = await createReadContext(user);
    const { row, targets } = await loadAttachment(ctx, id, 'read');
    if (row.status !== 'confirmed') throw ApiError.notFound('凭证尚未确认');
    return {
      attachmentId: row.id,
      version: row.version,
      kind: row.kind,
      originalName: row.originalName,
      contentType: row.contentType,
      sizeBytes: Number(row.sizeBytes),
      targets,
      readUrl: oss.createStockReadUrl(row.objectKey),
      expiresInSeconds: 300,
    };
  } catch (error) {
    logger.warn('库存文件操作未完成', { code: error.code || error.name });
    throw error;
  }
}

/** 列表中的文件名也按全部目标鉴权；一次批量加载避免逐个附件查库。 */
async function listAttachmentMetadata(ctx, field, id) {
  try {
    const ownerConfig = Object.values(TARGETS).find(config => config.field === field);
    if (!ownerConfig || !UUID_PATTERN.test(id || '')) throw ApiError.badRequest('凭证列表目标无效');
    requirePermissions(ctx, 'stock.read', ownerConfig.read);
    const related = await models.StockAttachmentLink.findAll({
      where: { [field]: id },
      attributes: ['attachmentId'],
      transaction: ctx.transaction,
    });
    const attachmentIds = [...new Set(related.map(link => link.attachmentId))];
    if (!attachmentIds.length) return [];
    const [attachments, links] = await Promise.all([
      models.StockAttachment.findAll({
        where: { id: { [Op.in]: attachmentIds }, status: 'confirmed' },
        transaction: ctx.transaction,
      }),
      models.StockAttachmentLink.findAll({
        where: { attachmentId: { [Op.in]: attachmentIds } },
        transaction: ctx.transaction,
      }),
    ]);
    const existingByType = new Map();
    for (const [type, config] of Object.entries(TARGETS)) {
      if (!ctx.permissions.has(config.read)) continue;
      const ids = [...new Set(links.map(link => link[config.field]).filter(Boolean))];
      let rows = [];
      if (ids.length) {
        rows = await models[config.model].findAll({
          where: { id: { [Op.in]: ids } },
          attributes: ['id'],
          transaction: ctx.transaction,
        });
      }
      existingByType.set(type, new Set(rows.map(row => row.id)));
    }
    return attachments
      .filter(row => {
        const ownLinks = links.filter(link => link.attachmentId === row.id);
        return (
          ownLinks.length > 0 &&
          ownLinks.every(link => {
            const targets = Object.entries(TARGETS).filter(([, config]) => link[config.field]);
            return (
              targets.length === 1 &&
              targets.every(([type, config]) => existingByType.get(type)?.has(link[config.field]))
            );
          })
        );
      })
      .map(row => ({
        id: row.id,
        kind: row.kind,
        originalName: row.originalName,
        contentType: row.contentType,
        sizeBytes: Number(row.sizeBytes),
        version: row.version,
      }));
  } catch (error) {
    logger.warn('库存凭证列表读取未完成', { actorId: ctx.user.id, code: error.code || error.name });
    throw error;
  }
}

/** 无订单识别复用取货 OCR 服务与月额度；只返回待人工确认的候选。 */
async function recognizeSerial(user, file) {
  try {
    const ctx = await createReadContext(user);
    requirePermissions(ctx, 'stock.read');
    if (!ctx.permissions.has('stock.receive') && !ctx.permissions.has('stock.sales.ship'))
      throw new ApiError(403, 'FORBIDDEN', '缺少收货或出货权限');
    const result = await ocr.recognize(file);
    logger.info('库存序列号识别完成', {
      actorId: ctx.user.id,
      candidateCount: result.candidates.length,
    });
    return result;
  } catch (error) {
    logger.warn('库存序列号识别未完成', { actorId: user?.id, code: error.code });
    throw error;
  } finally {
    if (file) file.buffer = null;
  }
}

module.exports = {
  normalizeTargets,
  authorizeTargets,
  prepareAttachment,
  readUpload,
  verifyAttachment,
  confirmAttachment,
  readAttachment,
  listAttachmentMetadata,
  recognizeSerial,
};
