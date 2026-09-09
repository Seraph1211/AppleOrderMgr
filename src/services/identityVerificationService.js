const crypto = require('crypto');
const { Op } = require('sequelize');
const {
  sequelize,
  User,
  IdentityVerificationBatch: Batch,
  IdentityVerificationItem: Item,
} = require('../models');
const { PERMISSIONS } = require('../constants/business');
const { getEffectivePermissions } = require('./permissionService');
const { blindIndex } = require('../utils/fieldEncryption');
const ApiError = require('../utils/ApiError');
const provider = require('./identityProviderService');
const { validateIdentity, parseIdentityWorkbook } = require('./identityInputService');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ACTIVE = ['queued', 'running'];

/** 在事务中锁定账号并复查当前权限。 @returns {Promise<Object>} 用户 */
async function authorize(actor, permission, transaction) {
  try {
    const user = await User.findByPk(actor.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user || user.status === 'locked') throw new ApiError(403, 'FORBIDDEN', '账号已停用');
    const permissions = await getEffectivePermissions(user, { transaction });
    if (!permissions.includes(PERMISSIONS.IDENTITY_READ) || !permissions.includes(permission))
      throw new ApiError(403, 'FORBIDDEN', '没有身份核验操作权限');
    return user;
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}

/** 检查服务已配置且启用。 @returns {void} */
function assertReady() {
  const status = provider.getStatus();
  if (!status.configured || !status.enabled)
    throw new ApiError(503, 'IDENTITY_NOT_READY', '身份核验服务未配置或未启用，请联系管理员');
}

async function findBatch(actor, id, transaction) {
  if (!UUID.test(id)) throw ApiError.badRequest('批次编号无效');
  try {
    const batch = await Batch.findOne({
      where: { id, ...(actor.role === 'admin' ? {} : { userId: actor.id }) },
      transaction,
      ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!batch) throw ApiError.notFound('核验批次不存在');
    return batch;
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}

async function checkCapacity(userId, transaction) {
  try {
    const count = await Batch.count({
      where: { userId, status: { [Op.in]: ['draft', ...ACTIVE, 'paused'] } },
      transaction,
    });
    if (count >= 10) throw ApiError.badRequest('最多保留10个未结束批次，请先处理或停止已有批次');
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}

/** 单人提交带幂等键，响应未知时可以原键重试而不重复消费。 @returns {Promise<Object>} 批次 */
async function createSingle(actor, input, key) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw ApiError.badRequest('请提供姓名和身份证号');
    const message = validateIdentity(input.name, input.idCardNumber);
    if (message) throw ApiError.badRequest(message);
    if (!UUID.test(key || '')) throw ApiError.badRequest('请提供UUID格式的Idempotency-Key');
    const requestHash = blindIndex(
      Buffer.from(JSON.stringify([input.name, input.idCardNumber])).toString('hex')
    );
    return await sequelize.transaction(async transaction => {
      const user = await authorize(actor, PERMISSIONS.IDENTITY_VERIFY, transaction);
      const existing = await Batch.findOne({
        where: { userId: user.id, idempotencyKey: key },
        transaction,
      });
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw ApiError.conflict('同一提交编号的姓名或身份证内容已改变，请重新提交');
        return { batchId: existing.id };
      }
      assertReady();
      await checkCapacity(user.id, transaction);
      const batch = await Batch.create(
        {
          id: crypto.randomUUID(),
          userId: user.id,
          source: 'single',
          status: 'queued',
          idempotencyKey: key,
          requestHash,
          summary: { total: 1, valid: 1, invalid: 0, duplicates: 0, empty: 0 },
        },
        { transaction }
      );
      await Item.create(
        {
          batchId: batch.id,
          rowNumber: 1,
          name: input.name,
          idCardNumber: input.idCardNumber,
          status: 'pending',
        },
        { transaction }
      );
      return { batchId: batch.id };
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}

/** 上传预览只持久化加密草稿，不调用供应商。 @returns {Promise<Object>} 详情 */
async function preview(actor, buffer) {
  try {
    const parsed = parseIdentityWorkbook(buffer);
    const id = crypto.randomUUID();
    await sequelize.transaction(async transaction => {
      await authorize(actor, PERMISSIONS.IDENTITY_BATCH, transaction);
      await checkCapacity(actor.id, transaction);
      await Batch.create(
        {
          id,
          userId: actor.id,
          source: 'excel',
          status: 'draft',
          summary: parsed.summary,
          expiresAt: new Date(Date.now() + 15 * 60_000),
        },
        { transaction }
      );
      await Item.bulkCreate(
        parsed.rows.map(row => ({ ...row, batchId: id })),
        { transaction }
      );
    });
    return await detail(actor, id);
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}

/** 开始或停止批次；序列化并发开始与停止。 @returns {Promise<Object>} 详情 */
async function control(actor, id, action) {
  try {
    await sequelize.transaction(async transaction => {
      // 始终先用户、后批次，避免与撤权和领取产生逆序锁。
      const user = await authorize(actor, PERMISSIONS.IDENTITY_READ, transaction);
      const batch = await findBatch(user, id, transaction);
      const required =
        batch.source === 'single' ? PERMISSIONS.IDENTITY_VERIFY : PERMISSIONS.IDENTITY_BATCH;
      if (!(await getEffectivePermissions(user, { transaction })).includes(required))
        throw new ApiError(403, 'FORBIDDEN', '没有此批次的操作权限');
      if (action === 'stop') {
        if (['completed', 'cancelled'].includes(batch.status)) return;
        await Item.update(
          { status: 'cancelled', message: '用户停止核验', finishedAt: new Date() },
          { where: { batchId: id, status: 'pending' }, transaction }
        );
        await batch.update(
          { status: 'cancelled', message: '未开始项目已停止；已发送请求仍可能返回结果' },
          { transaction }
        );
        return;
      }
      if (ACTIVE.includes(batch.status)) return;
      if (!['draft', 'paused'].includes(batch.status)) throw ApiError.conflict('此批次已结束');
      if (batch.status === 'draft' && batch.expiresAt <= new Date())
        throw ApiError.conflict('预览已过期，请停止此草稿后重新上传');
      assertReady();
      const pending = await Item.count({ where: { batchId: id, status: 'pending' }, transaction });
      if (!pending) throw ApiError.conflict('没有待核验的有效项目');
      await batch.update({ status: 'queued', message: null }, { transaction });
    });
    return await detail(actor, id);
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}

/** 在权限事务内读取完整原始数据；重复行解析对应首行结果。 @returns {Promise<Object>} 批次及行 */
async function detail(actor, id, permission = PERMISSIONS.IDENTITY_READ) {
  try {
    return await sequelize.transaction(async transaction => {
      const user = await authorize(actor, permission, transaction);
      const batch = await findBatch(user, id, transaction);
      const items = await Item.findAll({
        where: { batchId: id },
        order: [['rowNumber', 'ASC']],
        transaction,
      });
      const byRow = new Map(items.map(item => [item.rowNumber, item]));
      const counts = {};
      const rows = items.map(item => {
        const result = item.duplicateOf ? byRow.get(item.duplicateOf) : item;
        const status = result?.status || 'unknown';
        counts[status] = (counts[status] || 0) + 1;
        return {
          rowNumber: item.rowNumber,
          name: item.name,
          idCardNumber: item.idCardNumber,
          status,
          duplicateOf: item.duplicateOf,
          message: result?.message,
          resultData: result?.resultData,
          startedAt: result?.startedAt,
          finishedAt: result?.finishedAt,
        };
      });
      return {
        batch: { ...batch.toJSON(), requestHash: undefined, idempotencyKey: undefined },
        rows,
        counts,
      };
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}

/** 分页批次列表，用户范围与详情一致。 @returns {Promise<Object>} 分页结果 */
async function list(actor, query) {
  try {
    const page = Number(query.page || 1);
    const limit = Number(query.limit || 20);
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw ApiError.badRequest('分页参数无效');
    return await sequelize.transaction(async transaction => {
      const user = await authorize(actor, PERMISSIONS.IDENTITY_READ, transaction);
      const where = user.role === 'admin' ? {} : { userId: user.id };
      if (query.source) {
        if (!['single', 'excel'].includes(query.source)) throw ApiError.badRequest('来源无效');
        where.source = query.source;
      }
      for (const [key, op] of [
        ['from', Op.gte],
        ['to', Op.lte],
      ]) {
        if (!query[key]) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(query[key]) || Number.isNaN(Date.parse(query[key])))
          throw ApiError.badRequest('日期格式必须为YYYY-MM-DD');
        where.createdAt = {
          ...where.createdAt,
          [op]: new Date(`${query[key]}T${key === 'from' ? '00:00:00' : '23:59:59.999'}+08:00`),
        };
      }
      const result = await Batch.findAndCountAll({
        where,
        order: [
          ['createdAt', 'DESC'],
          ['id', 'DESC'],
        ],
        limit,
        offset: (page - 1) * limit,
        transaction,
      });
      const ids = result.rows.map(row => row.id);
      const counts = ids.length
        ? await Item.findAll({
          attributes: [
            'batchId',
            'status',
            [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
          ],
          where: { batchId: ids },
          group: ['batchId', 'status'],
          raw: true,
          transaction,
        })
        : [];
      return {
        total: result.count,
        page,
        limit,
        batches: result.rows.map(row => ({
          ...row.toJSON(),
          requestHash: undefined,
          idempotencyKey: undefined,
          counts: Object.fromEntries(
            counts
              .filter(count => count.batchId === row.id)
              .map(count => [count.status, Number(count.count)])
          ),
        })),
      };
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error('身份核验操作失败');
  }
}

module.exports = { authorize, assertReady, createSingle, preview, control, detail, list, ACTIVE };
