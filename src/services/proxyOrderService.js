const { serializePublicProducts } = require('../utils/orderSerialization');
const { Op } = require('sequelize');
const {
  sequelize,
  ProxyOrder,
  ProxyAssignment,
  ProxyOrderLink,
  ProxyEvent,
  AppleId,
  Order,
} = require('../models');
const { lockProfiles } = require('./profileBindingService');
const input = require('../utils/proxyOrderInput');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { ACCOUNT_STATUSES } = require('../constants/business');

function id(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw ApiError.badRequest('编号必须为正整数');
  return parsed;
}
function ids(values, max = 100) {
  if (!Array.isArray(values) || !values.length || values.length > max)
    throw ApiError.badRequest(`请选择 1–${max} 条记录`);
  return [...new Set(values.map(id))];
}
function pageQuery(query = {}) {
  const page = query.page == null ? 1 : id(query.page);
  const limit = query.limit == null ? 30 : Math.min(id(query.limit), 100);
  return { limit, offset: (page - 1) * limit };
}
function summary(order) {
  return order
    ? {
      id: order.id,
      orderNumber: order.orderNumber,
      products: serializePublicProducts(order.products),
      pickupStore: order.pickupStore,
      pickupStoreCode: order.pickupStoreCode,
      status: order.officialStatusObservedAt ? order.officialRawStatus : null,
      officialRawStatus: order.officialStatusObservedAt ? order.officialRawStatus : null,
      officialStatusObservedAt: order.officialStatusObservedAt,
      orderDate: order.orderDate,
    }
    : null;
}
const SUMMARY_FIELDS = [
  'id',
  'orderNumber',
  'products',
  'pickupStore',
  'pickupStoreCode',
  'officialRawStatus',
  'officialStatusObservedAt',
  'orderDate',
];

async function event(action, proxyOrderId, actorId, detail, transaction) {
  try {
    return await ProxyEvent.create({ action, proxyOrderId, actorId, detail }, { transaction });
  } catch (error) {
    logger.debug('代抢操作错误由统一中间件处理', { errorType: error.name });
    throw error;
  }
}
async function transact(actorId, work) {
  try {
    return await sequelize.transaction(async transaction => {
      try {
        await lockProfiles(transaction, actorId);
        return await work(transaction);
      } catch (error) {
        logger.debug('代抢事务未完成', { errorType: error.name });
        throw error;
      }
    });
  } catch (error) {
    logger.warn('代抢操作未完成', { errorType: error.name });
    if (error.name === 'SequelizeUniqueConstraintError')
      throw ApiError.conflict('平台订单号、官方订单或账号占用已存在，请刷新核对');
    throw error;
  }
}
async function lockedOrder(orderId, expectedVersion, transaction) {
  try {
    const row = await ProxyOrder.findByPk(id(orderId), {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw ApiError.notFound('代抢订单不存在');
    if (!Number.isInteger(expectedVersion) || row.version !== expectedVersion)
      throw ApiError.conflict('资料已变化，请刷新后重试');
    return row;
  } catch (error) {
    logger.debug('代抢操作错误由统一中间件处理', { errorType: error.name });
    throw error;
  }
}
async function assign(row, values, transaction, actorId) {
  try {
    if (['succeeded', 'cancelled'].includes(row.status))
      throw ApiError.conflict('已结束订单不能追加账号');
    let accountIds;
    if (values.accountIds) accountIds = ids(values.accountIds, 20);
    else {
      const requestedCount = values.count == null ? 1 : values.count;
      if (
        typeof requestedCount !== 'number' &&
        (typeof requestedCount !== 'string' || !/^[1-9]\d*$/.test(requestedCount))
      )
        throw ApiError.badRequest('分配数量须为正整数');
      const count = id(requestedCount);
      if (count > 20) throw ApiError.badRequest('每次最多追加 20 个账号');
      const [available] = await sequelize.query(
        `SELECT a.id FROM apple_ids a
        WHERE a.is_proxy_pool=true AND a.status IN ('未使用','使用中')
        AND NOT EXISTS(SELECT 1 FROM proxy_assignments p WHERE p.apple_id_ref=a.id AND p.ended_at IS NULL)
        ORDER BY random() LIMIT :count FOR UPDATE SKIP LOCKED`,
        { replacements: { count }, transaction }
      );
      accountIds = available.map(a => a.id);
      if (!values.allowEmpty && accountIds.length !== count)
        throw ApiError.conflict('可用账号不足，请导入或释放已停抢账号');
    }
    if (!accountIds.length) return [];
    const accounts = await AppleId.findAll({
      where: { id: accountIds },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const occupied = await ProxyAssignment.count({
      where: { appleIdRef: accountIds, endedAt: null },
      transaction,
    });
    if (
      occupied ||
      accounts.length !== accountIds.length ||
      accounts.some(a => !a.isProxyPool || !['未使用', '使用中'].includes(a.status))
    )
      throw ApiError.conflict('选中账号不在可用代抢池或已被占用');
    const assignments = await ProxyAssignment.bulkCreate(
      accounts.map(a => ({
        proxyOrderId: row.id,
        appleIdRef: a.id,
        accountEmail: a.appleId,
        startedAt: new Date(),
      })),
      { transaction }
    );
    await AppleId.update({ status: '使用中' }, { where: { id: accountIds }, transaction });
    await event('assign', row.id, actorId, { accountIds }, transaction);
    return assignments;
  } catch (error) {
    logger.debug('代抢操作错误由统一中间件处理', { errorType: error.name });
    throw error;
  }
}

/** 分页读取全部授权委托；不包含原文和密码。 @param {Object} query 筛选 @returns {Promise<Object>} 列表 */
async function listOrders(query) {
  try {
    const where = {};
    if (query.status) {
      if (!['pending', 'rushing', 'succeeded', 'cancelled'].includes(query.status))
        throw ApiError.badRequest('状态不正确');
      where.status = query.status;
    }
    if (query.keyword) {
      const keyword = String(query.keyword).trim().slice(0, 100);
      where[Op.or] = [
        { platformOrderNumber: { [Op.iLike]: `%${keyword}%` } },
        sequelize.where(
          sequelize.fn('concat', sequelize.col('last_name'), sequelize.col('first_name')),
          { [Op.iLike]: `%${keyword}%` }
        ),
      ];
      if (/^\d+$/.test(keyword) && Number.isSafeInteger(Number(keyword)))
        where[Op.or].push({ id: Number(keyword) });
    }
    const result = await ProxyOrder.findAndCountAll({
      where,
      ...pageQuery(query),
      order: [['id', 'DESC']],
      attributes: { exclude: ['rawText', 'rejectedOrderIds'] },
    });
    const rows = result.rows.map(r => r.toJSON());
    const assignments = rows.length
      ? await ProxyAssignment.findAll({
        where: { proxyOrderId: rows.map(r => r.id), endedAt: null },
        raw: true,
      })
      : [];
    const links = rows.length
      ? await ProxyOrderLink.findAll({
        where: { proxyOrderId: rows.map(r => r.id), unlinkedAt: null },
        raw: true,
      })
      : [];
    const orderIds = links.map(link => link.orderId);
    const orders = orderIds.length
      ? await Order.findAll({ where: { id: orderIds }, attributes: SUMMARY_FIELDS })
      : [];
    return {
      count: result.count,
      rows: rows.map(r => ({
        ...r,
        ...input.normalizeProxyProduct(r.productModel, r.color),
        assignments: assignments.filter(a => a.proxyOrderId === r.id),
        officialOrders: links
          .filter(link => link.proxyOrderId === r.id)
          .map(link => summary(orders.find(o => o.id === link.orderId)))
          .filter(Boolean),
        officialOrder: summary(orders.find(o => o.id === r.orderId)),
      })),
    };
  } catch (error) {
    logger.debug('代抢操作错误由统一中间件处理', { errorType: error.name });
    throw error;
  }
}

/** 查看详情及脱敏历史。 @param {number} orderId 委托编号 @returns {Promise<Object>} 详情 */
async function detail(orderId) {
  try {
    const row = await ProxyOrder.findByPk(id(orderId));
    if (!row) throw ApiError.notFound('代抢订单不存在');
    const [assignments, events, links] = await Promise.all([
      ProxyAssignment.findAll({
        where: { proxyOrderId: row.id },
        order: [['id', 'ASC']],
        raw: true,
      }),
      ProxyEvent.findAll({
        where: { proxyOrderId: row.id },
        order: [['id', 'DESC']],
        limit: 100,
        raw: true,
      }),
      ProxyOrderLink.findAll({
        where: { proxyOrderId: row.id },
        order: [['id', 'ASC']],
        attributes: { exclude: ['reasonEncrypted'] },
        raw: true,
      }),
    ]);
    const orderIds = links.filter(link => !link.unlinkedAt).map(link => link.orderId);
    const orders = orderIds.length
      ? await Order.findAll({ where: { id: orderIds }, attributes: SUMMARY_FIELDS })
      : [];
    const data = row.toJSON();
    delete data.rejectedOrderIds;
    return {
      ...data,
      ...input.normalizeProxyProduct(data.productModel, data.color),
      assignments,
      events,
      links,
      officialOrders: orders.map(summary),
      officialOrder: summary(orders.find(order => order.id === row.orderId) || orders[0]),
    };
  } catch (error) {
    logger.debug('代抢操作错误由统一中间件处理', { errorType: error.name });
    throw error;
  }
}

/** 创建或编辑已核对的委托。 @param {number|null} orderId 编号 @param {Object} body 输入 @param {number} actorId 操作人 @returns {Promise<Object>} 保存结果 */
async function saveOrder(orderId, body, actorId) {
  try {
    return await transact(actorId, async transaction => {
      try {
        if (!orderId) {
          const values = input.validateProxyInput(body);
          const duplicates = await findDuplicates(values, transaction);
          if (duplicates.length && body.confirmedDuplicate !== true)
            throw ApiError.conflict('疑似重复登记，请核对后明确继续另建', {
              duplicateIds: duplicates.map(row => row.id),
            });
          const row = await ProxyOrder.create({ ...values, createdBy: actorId }, { transaction });
          await event('create', row.id, actorId, {}, transaction);
          const assigned = await assign(row, { allowEmpty: true }, transaction, actorId);
          return {
            id: row.id,
            version: row.version,
            assigned: assigned.length,
            assignmentStatus: assigned.length ? 'assigned' : 'awaiting_account',
            assignmentMessage: assigned.length
              ? '已自动分配1个专用账号'
              : '订单已保存，暂无可用专用账号，待分配',
          };
        }
        const row = await lockedOrder(orderId, body.expectedVersion, transaction);
        const values = input.validateProxyInput(
          { ...row.toJSON(), ...body },
          { existing: row.toJSON() }
        );
        await row.update({ ...values, version: row.version + 1 }, { transaction });
        await event('edit', row.id, actorId, { fields: Object.keys(values) }, transaction);
        return { id: row.id, version: row.version };
      } catch (error) {
        logger.debug('代抢事务未完成', { errorType: error.name });
        throw error;
      }
    });
  } catch (error) {
    logger.debug('代抢操作错误由统一中间件处理', { errorType: error.name });
    throw error;
  }
}

/** 执行版本化状态、分配、释放和关联动作。 @param {string} action 动作 @param {number} orderId 编号 @param {Object} body 输入 @param {number} actorId 操作人 @returns {Promise<Object>} 结果 */
async function changeOrder(action, orderId, body, actorId) {
  try {
    return await transact(actorId, async transaction => {
      try {
        const row = await lockedOrder(orderId, body.expectedVersion, transaction);
        let audit = {};
        let assigned;
        const previousStatus = row.status;
        if (action === 'notes') {
          if (typeof body.notes !== 'string' || body.notes.length > 10000)
            throw ApiError.badRequest('备注格式不正确');
          row.notes = body.notes;
          audit = { changed: true };
        } else if (action === 'status') {
          if (!['pending', 'rushing', 'succeeded', 'cancelled'].includes(body.status))
            throw ApiError.badRequest('状态不正确');
          audit = { from: row.status, to: body.status, source: 'manual' };
          if (body.status === 'succeeded' || body.reason || body.notes) {
            const reason = body.reason || body.notes || row.notes || '工作人员手动确认成功';
            if (typeof reason !== 'string' || reason.length > 10000)
              throw ApiError.badRequest('状态说明格式不正确');
            const { encrypt } = require('../utils/fieldEncryption');
            audit.reasonEncrypted = encrypt(reason);
          }
          row.status = body.status;
        } else if (action === 'accounts') {
          const added = await assign(row, body, transaction, actorId);
          assigned = added.length;
          audit = { assignmentIds: added.map(a => a.id) };
        } else if (action === 'release') {
          if (body.confirmedStopped !== true)
            throw ApiError.badRequest('请确认抢购软件已停止对应任务');
          const assignmentIds = ids(body.assignmentIds);
          const assignments = await ProxyAssignment.findAll({
            where: { id: assignmentIds, proxyOrderId: row.id, endedAt: null },
            transaction,
          });
          if (assignments.length !== assignmentIds.length)
            throw ApiError.conflict('账号占用已变化');
          await ProxyAssignment.update(
            { endedAt: new Date() },
            { where: { id: assignmentIds }, transaction }
          );
          await AppleId.update(
            { status: '未使用' },
            { where: { id: assignments.map(a => a.appleIdRef), status: '使用中' }, transaction }
          );
          audit = { assignmentIds };
        } else if (action === 'link') {
          if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500)
            throw ApiError.badRequest('请填写核对/纠错原因（最多 500 字）');
          if (body.orderNumber === null) {
            const active = await ProxyOrderLink.findAll({
              where: { proxyOrderId: row.id, unlinkedAt: null },
              transaction,
            });
            const targetId =
              body.orderId == null && active.length === 1 ? active[0].orderId : id(body.orderId);
            const link = active.find(link => link.orderId === targetId);
            if (!link) throw ApiError.conflict('指定官方订单尚未关联');
            const { encrypt } = require('../utils/fieldEncryption');
            await link.update(
              { unlinkedAt: new Date(), reasonEncrypted: encrypt(body.reason.trim()) },
              { transaction }
            );
            row.rejectedOrderIds = [...new Set([...row.rejectedOrderIds, targetId])];
            row.orderId = active.find(item => item.orderId !== targetId)?.orderId || null;
            audit = { previousOrderId: targetId };
          } else {
            if (!/^W\d{10}$/.test(body.orderNumber || ''))
              throw ApiError.badRequest('请输入有效 Apple 订单号');
            const order = await Order.findOne({
              where: { orderNumber: body.orderNumber },
              transaction,
            });
            if (!order) throw ApiError.notFound('官方订单不存在');
            const assignments = await ProxyAssignment.findAll({
              where: { proxyOrderId: row.id },
              transaction,
            });
            const clean = value =>
              String(value || '')
                .replace(/\s/g, '')
                .toLowerCase();
            if (
              !assignments.some(a => clean(a.accountEmail) === clean(order.appleId)) ||
              clean(order.recipientName) !== clean(row.lastName + row.firstName) ||
              clean(order.recipientPhone) !== clean(row.phone) ||
              clean(order.recipientIdLast4) !== clean(row.idLast4) ||
              [order.sourceContactEmail, order.recipientEmail]
                .filter(Boolean)
                .some(email => clean(email) !== clean(row.email))
            )
              throw ApiError.conflict('官方订单账号或客户身份与该委托不符');
            const existing = await ProxyOrderLink.findOne({
              where: { orderId: order.id, unlinkedAt: null },
              transaction,
            });
            if (existing && existing.proxyOrderId !== row.id)
              throw ApiError.conflict('该官方订单已关联其他代抢单');
            if (!existing) {
              const { encrypt } = require('../utils/fieldEncryption');
              await ProxyOrderLink.create(
                {
                  proxyOrderId: row.id,
                  orderId: order.id,
                  source: 'manual',
                  actorId,
                  linkedAt: new Date(),
                  reasonEncrypted: encrypt(body.reason.trim()),
                },
                { transaction }
              );
              if (!row.orderId) row.orderId = order.id;
              if (row.status !== 'cancelled' && input.isProxyMatch(row, order, assignments))
                row.status = 'succeeded';
            }
            audit = { orderId: order.id, existing: Boolean(existing) };
          }
          // 原因可包含人工业务说明，单独加密存储，列表只显示操作类型。
          const { encrypt } = require('../utils/fieldEncryption');
          audit.reasonEncrypted = encrypt(body.reason.trim());
        } else throw ApiError.badRequest('不支持的操作');
        if (action === 'link' && previousStatus !== row.status)
          audit = { ...audit, from: previousStatus, to: row.status, source: 'manual_link' };
        row.version += 1;
        await row.save({ transaction });
        await event(action, row.id, actorId, audit, transaction);
        return { id: row.id, version: row.version, ...(assigned == null ? {} : { assigned }) };
      } catch (error) {
        logger.debug('代抢事务未完成', { errorType: error.name });
        throw error;
      }
    });
  } catch (error) {
    logger.debug('代抢操作错误由统一中间件处理', { errorType: error.name });
    throw error;
  }
}

/**
 * 隐藏委托并在明确停抢确认后结束占用，保留全部业务和审计历史。
 * @param {number} orderId 委托编号
 * @param {Object} body 版本和停抢确认
 * @param {number} actorId 操作人
 * @returns {Promise<Object>} 删除结果
 */
async function deleteOrder(orderId, body, actorId) {
  try {
    if (!Number.isInteger(body?.expectedVersion) || body.expectedVersion <= 0)
      throw ApiError.badRequest('expectedVersion 必须为正整数');
    return await transact(actorId, async transaction => {
      try {
        const row = await lockedOrder(orderId, body.expectedVersion, transaction);
        const assignments = await ProxyAssignment.findAll({
          where: { proxyOrderId: row.id, endedAt: null },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (assignments.length && body.confirmedStopped !== true)
          throw ApiError.conflict('请先停止外部抢购软件对应任务，并明确确认已停止后删除', {
            requiresStoppedConfirmation: true,
          });
        const now = new Date();
        const assignmentIds = assignments.map(assignment => assignment.id);
        if (assignmentIds.length) {
          await ProxyAssignment.update(
            { endedAt: now },
            {
              where: { id: assignmentIds, proxyOrderId: row.id, endedAt: null },
              transaction,
            }
          );
          await event('release', row.id, actorId, { assignmentIds, source: 'delete' }, transaction);
        }
        await row.update({ deletedAt: now, version: row.version + 1 }, { transaction });
        await event('delete', row.id, actorId, { assignmentIds }, transaction);
        return { id: row.id, version: row.version, deleted: true };
      } catch (error) {
        logger.debug('代抢删除事务未完成', { errorType: error.name });
        throw error;
      }
    });
  } catch (error) {
    logger.debug('代抢删除未完成', { errorType: error.name });
    throw error;
  }
}

/** 读取账号池/待核对候选，无密码。 @param {Object} query 筛选 @returns {Promise<Object>} 列表 */
async function listAccounts(query) {
  try {
    const where = { isProxyPool: query.scope !== 'candidates' };
    if (query.availableOnly != null && !['true', 'false'].includes(String(query.availableOnly)))
      throw ApiError.badRequest('可用账号筛选格式不正确');
    if (String(query.availableOnly) === 'true') {
      if (query.scope === 'candidates') throw ApiError.badRequest('仅专用池支持可用账号筛选');
      where.status = { [Op.in]: ['未使用', '使用中'] };
      where[Op.and] = sequelize.literal(`NOT EXISTS (
        SELECT 1 FROM proxy_assignments active_assignment
        WHERE active_assignment.apple_id_ref="AppleId"."id"
          AND active_assignment.ended_at IS NULL
      )`);
    }
    if (query.scope === 'candidates') where.notes = { [Op.iLike]: '%代抢%' };
    if (query.keyword) where.appleId = { [Op.iLike]: `%${String(query.keyword).slice(0, 100)}%` };
    const result = await AppleId.findAndCountAll({
      where,
      ...pageQuery(query),
      attributes: ['id', 'appleId', 'status', 'notes', 'isProxyPool', 'updatedAt'],
      order: [['id', 'ASC']],
    });
    const accountIds = result.rows.map(a => a.id);
    const assignments = accountIds.length
      ? await ProxyAssignment.findAll({
        where: { appleIdRef: accountIds, endedAt: null },
        raw: true,
      })
      : [];
    const [[availability]] = await sequelize.query(
      `SELECT COUNT(*)::integer AS count FROM apple_ids a
       WHERE a.is_proxy_pool=true AND a.status IN ('未使用','使用中')
       AND NOT EXISTS(SELECT 1 FROM proxy_assignments p WHERE p.apple_id_ref=a.id AND p.ended_at IS NULL)
       `
    );
    return {
      count: result.count,
      availableCount: Number(availability.count),
      rows: result.rows.map(a => ({
        ...a.toJSON(),
        assignment: assignments.find(s => s.appleIdRef === a.id) || null,
      })),
    };
  } catch (error) {
    logger.debug('代抢操作错误由统一中间件处理', { errorType: error.name });
    throw error;
  }
}

/**
 * 导入、核对纳入、单条编辑或批量更新池账号。
 * @param {string} action 动作
 * @param {Object} body 输入
 * @param {number} actorId 操作人
 * @param {number} accountId 账号
 * @returns {Promise<Object>} 结果
 */
async function changeAccounts(action, body, actorId, accountId) {
  try {
    const parsed = action === 'import' ? input.parsePoolAccounts(body.text) : null;
    let requestedAccounts = null;
    if (action === 'status') {
      if (!Array.isArray(body.accounts) || !body.accounts.length || body.accounts.length > 100)
        throw ApiError.badRequest('请选择 1–100 个专用账号');
      if (!ACCOUNT_STATUSES.includes(body.status)) throw ApiError.badRequest('账号状态不正确');
      if (body.status === '未使用' && body.confirmedStopped !== true)
        throw ApiError.badRequest('请先确认所选账号的软件任务已停止');
      requestedAccounts = body.accounts.map(account => ({
        id: id(account?.id),
        expectedUpdatedAt: new Date(account?.expectedUpdatedAt).getTime(),
      }));
      if (
        new Set(requestedAccounts.map(account => account.id)).size !== requestedAccounts.length ||
        requestedAccounts.some(account => !Number.isFinite(account.expectedUpdatedAt))
      )
        throw ApiError.badRequest('账号选择或版本信息不正确');
    }
    return await transact(actorId, async transaction => {
      try {
        let accountIds = [];
        if (action === 'import') {
          const existing = await AppleId.findAll({
            where: sequelize.where(sequelize.fn('lower', sequelize.col('apple_id')), {
              [Op.in]: parsed.map(a => a.appleId),
            }),
            transaction,
          });
          for (const value of parsed) {
            const found = existing.find(a => a.appleId.trim().toLowerCase() === value.appleId);
            if (found && (!found.isProxyPool || found.password !== value.password))
              throw ApiError.conflict(
                '部分账号已存在且归属或密码不同，请在已有账号页核对；本批未导入'
              );
          }
          for (const value of parsed) {
            const found = existing.find(a => a.appleId.trim().toLowerCase() === value.appleId);
            const row =
              found ||
              (await AppleId.create(
                { ...value, isProxyPool: true, status: '未使用', notes: '代抢' },
                { transaction }
              ));
            accountIds.push(row.id);
          }
        } else if (action === 'adopt') {
          accountIds = ids(body.ids, 500);
          const accounts = await AppleId.findAll({ where: { id: accountIds }, transaction });
          if (accounts.length !== accountIds.length) throw ApiError.conflict('部分账号不存在');
          await AppleId.update({ isProxyPool: true }, { where: { id: accountIds }, transaction });
        } else if (action === 'update') {
          const row = await AppleId.findByPk(id(accountId), {
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          if (!row?.isProxyPool) throw ApiError.notFound('代抢账号不存在');
          if (new Date(body.expectedUpdatedAt).getTime() !== row.updatedAt.getTime())
            throw ApiError.conflict('账号已更新，请刷新');
          if (
            !ACCOUNT_STATUSES.includes(body.status) ||
            typeof body.notes !== 'string' ||
            body.notes.length > 10000
          )
            throw ApiError.badRequest('状态或备注不正确');
          if (body.status === '未使用' && row.status !== '未使用') {
            if (body.confirmedStopped !== true)
              throw ApiError.badRequest('请先确认账号的软件任务已停止');
            const occupied = await ProxyAssignment.count({
              where: { appleIdRef: row.id, endedAt: null },
              transaction,
            });
            if (occupied) throw ApiError.conflict('账号仍被代抢单占用，请先确认停抢并释放');
          }
          await row.update({ status: body.status, notes: body.notes }, { transaction });
          accountIds = [row.id];
        } else if (action === 'status') {
          accountIds = requestedAccounts
            .map(account => account.id)
            .sort((left, right) => left - right);
          const accounts = await AppleId.findAll({
            where: { id: accountIds },
            order: [['id', 'ASC']],
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          if (
            accounts.length !== accountIds.length ||
            accounts.some(account => !account.isProxyPool)
          )
            throw ApiError.conflict('部分账号已不在代抢专用池，请刷新后重试');
          const versions = new Map(
            requestedAccounts.map(account => [account.id, account.expectedUpdatedAt])
          );
          if (accounts.some(account => account.updatedAt.getTime() !== versions.get(account.id)))
            throw ApiError.conflict('部分账号已更新，请刷新后重试');
          if (body.status === '未使用') {
            const occupied = await ProxyAssignment.count({
              where: { appleIdRef: accountIds, endedAt: null },
              transaction,
            });
            if (occupied) throw ApiError.conflict('部分账号仍被代抢单占用，请先确认停抢并释放');
          }
          const changedIds = accounts
            .filter(account => account.status !== body.status)
            .map(account => account.id);
          if (changedIds.length)
            await AppleId.update(
              { status: body.status },
              {
                where: { id: changedIds },
                transaction,
              }
            );
          await event(
            'pool_status',
            null,
            actorId,
            {
              accountIds,
              status: body.status,
              changedCount: changedIds.length,
            },
            transaction
          );
          return { count: accountIds.length, changedCount: changedIds.length };
        }
        await event(`pool_${action}`, null, actorId, { accountIds }, transaction);
        return { count: accountIds.length };
      } catch (error) {
        logger.debug('代抢事务未完成', { errorType: error.name });
        throw error;
      }
    });
  } catch (error) {
    logger.debug('代抢操作错误由统一中间件处理', { errorType: error.name });
    throw error;
  }
}

/** 一次性校验全部选中订单并生成模板，不改变状态。 @param {Array} values 编号 @param {number} actorId 操作人 @returns {Promise<Object>} 模板 */
async function copyTemplates(values, actorId) {
  try {
    const selected = ids(values);
    return await transact(actorId, async transaction => {
      try {
        const rows = await ProxyOrder.findAll({
          where: { id: selected },
          order: [['id', 'ASC']],
          transaction,
        });
        if (
          rows.length !== selected.length ||
          rows.some(r => !['pending', 'rushing'].includes(r.status))
        )
          throw ApiError.conflict('选中订单不存在或已结束');
        const assignments = await ProxyAssignment.findAll({
          where: { proxyOrderId: selected, endedAt: null },
          order: [['id', 'ASC']],
          transaction,
        });
        const accounts = assignments.length
          ? await AppleId.findAll({
            where: { id: assignments.map(a => a.appleIdRef) },
            transaction,
          })
          : [];
        const lines = [];
        for (const row of rows) {
          const active = assignments.filter(a => a.proxyOrderId === row.id);
          if (!active.length) throw ApiError.conflict(`代抢单 #${row.id} 尚未分配账号`);
          for (const assignment of active) {
            const account = accounts.find(a => a.id === assignment.appleIdRef);
            if (!account?.isProxyPool || !['未使用', '使用中'].includes(account.status))
              throw ApiError.conflict(`代抢单 #${row.id} 的账号状态不可用`);
            lines.push(input.buildProxyTemplate(row.toJSON(), account));
          }
          await event('copy', row.id, actorId, { lines: active.length }, transaction);
        }
        return { text: lines.join('\n'), count: lines.length };
      } catch (error) {
        logger.debug('代抢事务未完成', { errorType: error.name });
        throw error;
      }
    });
  } catch (error) {
    logger.debug('代抢操作错误由统一中间件处理', { errorType: error.name });
    throw error;
  }
}

let scanCursor = 0;
const officialCursors = new Map();
/** 周期性有界扫描候选官方订单，仅新关联触发状态。 @returns {Promise<number>} 委托扫描量 */
async function reconcile() {
  try {
    return await transact(null, async transaction => {
      try {
        const rows = await ProxyOrder.findAll({
          where: { id: { [Op.gt]: scanCursor } },
          order: [['id', 'ASC']],
          limit: 100,
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        scanCursor = rows.length === 100 ? rows.at(-1).id : 0;
        if (!rows.length) return 0;
        const assignments = await ProxyAssignment.findAll({
          where: { proxyOrderId: rows.map(row => row.id) },
          transaction,
        });
        if (!assignments.length) return rows.length;
        const emails = [...new Set(assignments.map(a => a.accountEmail.toLowerCase()))];
        const earliest = new Date(Math.min(...assignments.map(a => a.startedAt.getTime())));
        const key = rows[0].id;
        const orders = await Order.findAll({
          where: {
            id: { [Op.gt]: officialCursors.get(key) || 0 },
            orderDate: { [Op.gte]: earliest },
            [Op.and]: sequelize.where(sequelize.fn('lower', sequelize.col('apple_id')), {
              [Op.in]: emails,
            }),
          },
          order: [['id', 'ASC']],
          limit: 500,
          transaction,
        });
        officialCursors.set(key, orders.length === 500 ? orders.at(-1).id : 0);
        const linked = orders.length
          ? await ProxyOrderLink.findAll({
            where: { orderId: orders.map(o => o.id), unlinkedAt: null },
            transaction,
          })
          : [];
        const used = new Set(linked.map(link => link.orderId));
        const byRequest = new Map(
          rows.map(row => [row.id, assignments.filter(a => a.proxyOrderId === row.id)])
        );
        for (const order of orders) {
          if (used.has(order.id)) continue;
          const matches = rows.filter(row => input.isProxyMatch(row, order, byRequest.get(row.id)));
          if (matches.length !== 1) continue;
          const row = matches[0];
          await ProxyOrderLink.create(
            { proxyOrderId: row.id, orderId: order.id, source: 'automatic', linkedAt: new Date() },
            { transaction }
          );
          const previousStatus = row.status;
          row.orderId = row.orderId || order.id;
          if (row.status !== 'cancelled') row.status = 'succeeded';
          else row.anomaly = '已取消后发现抢购成功订单，请核对并停止软件任务';
          row.version += 1;
          await row.save({ transaction });
          await event(
            'auto_link',
            row.id,
            null,
            { orderId: order.id, source: 'automatic', from: previousStatus, to: row.status },
            transaction
          );
          used.add(order.id);
        }
        return rows.length;
      } catch (error) {
        logger.debug('代抢匹配事务未完成', { errorType: error.name });
        throw error;
      }
    });
  } catch (error) {
    logger.debug('代抢匹配未完成', { errorType: error.name });
    throw error;
  }
}

async function findDuplicates(values, transaction) {
  try {
    const where = {
      lastName: values.lastName,
      firstName: values.firstName,
      phone: values.phone,
      idLast4: values.idLast4,
      productCandidates: { [Op.eq]: values.productCandidates },
    };
    return await ProxyOrder.findAll({
      where,
      attributes: ['id', 'status', 'platformOrderNumber'],
      limit: 20,
      order: [['id', 'DESC']],
      transaction,
    });
  } catch (error) {
    logger.debug('代抢重复检查未完成', { errorType: error.name });
    throw error;
  }
}
/** 解析并提示已有疑似重复，读操作不改库。 @param {string} text 客户文本 @returns {Promise<Object>} 预览 */
async function parseText(text) {
  try {
    const preview = input.parseProxyText(text);
    preview.duplicates = preview.canSave ? await findDuplicates(preview.draft) : [];
    return preview;
  } catch (error) {
    logger.debug('代抢解析未完成', { errorType: error.name });
    throw error;
  }
}

module.exports = {
  deleteOrder,
  parseText,
  listOrders,
  detail,
  saveOrder,
  changeOrder,
  listAccounts,
  changeAccounts,
  copyTemplates,
  reconcile,
};
