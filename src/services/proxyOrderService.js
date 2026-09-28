const { Op } = require('sequelize');
const {
  sequelize,
  ProxyOrder,
  ProxyAssignment,
  ProxyEvent,
  AppleId,
  Order,
  Recipient,
} = require('../models');
const { lockProfiles } = require('./profileBindingService');
const input = require('../utils/proxyOrderInput');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

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
      products: order.products,
      pickupStore: order.pickupStore,
      pickupStoreCode: order.pickupStoreCode,
      status: order.emailOrderStatus || order.status,
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
  'emailOrderStatus',
  'status',
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
      const count = values.count == null ? 1 : id(values.count);
      if (count > 20) throw ApiError.badRequest('每次最多追加 20 个账号');
      const [available] = await sequelize.query(
        `SELECT a.id FROM apple_ids a
        WHERE a.is_proxy_pool=true AND a.status='未使用'
        AND NOT EXISTS(SELECT 1 FROM proxy_assignments p WHERE p.apple_id_ref=a.id AND p.ended_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM recipients r WHERE r.apple_id_ref=a.id)
        ORDER BY a.id LIMIT :count FOR UPDATE`,
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
      accounts.some(a => !a.isProxyPool || a.status !== '未使用')
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
    const orderIds = rows.map(r => r.orderId).filter(Boolean);
    const orders = orderIds.length
      ? await Order.findAll({ where: { id: orderIds }, attributes: SUMMARY_FIELDS })
      : [];
    return {
      count: result.count,
      rows: rows.map(r => ({
        ...r,
        ...input.normalizeProxyProduct(r.productModel, r.color),
        assignments: assignments.filter(a => a.proxyOrderId === r.id),
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
    const [assignments, events, order] = await Promise.all([
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
      row.orderId ? Order.findByPk(row.orderId, { attributes: SUMMARY_FIELDS }) : null,
    ]);
    const data = row.toJSON();
    delete data.rejectedOrderIds;
    return {
      ...data,
      ...input.normalizeProxyProduct(data.productModel, data.color),
      assignments,
      events,
      officialOrder: summary(order),
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
          const row = await ProxyOrder.create({ ...values, createdBy: actorId }, { transaction });
          await event('create', row.id, actorId, {}, transaction);
          const assigned = await assign(row, { allowEmpty: true }, transaction, actorId);
          return { id: row.id, version: row.version, assigned: assigned.length };
        }
        const row = await lockedOrder(orderId, body.expectedVersion, transaction);
        let values;
        if (['succeeded', 'cancelled'].includes(row.status)) {
          if (Object.keys(body).some(k => !['expectedVersion', 'notes'].includes(k)))
            throw ApiError.conflict('已结束订单只允许修改备注');
          if (typeof body.notes !== 'string' || body.notes.length > 10000)
            throw ApiError.badRequest('备注格式不正确');
          values = { notes: body.notes };
        } else values = input.validateProxyInput(body);
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
        if (action === 'notes') {
          if (typeof body.notes !== 'string' || body.notes.length > 10000)
            throw ApiError.badRequest('备注格式不正确');
          row.notes = body.notes;
          audit = { changed: true };
        } else if (action === 'status') {
          if (!['pending', 'rushing', 'cancelled'].includes(body.status))
            throw ApiError.badRequest('抢购成功只能通过官方订单关联产生');
          if (['succeeded', 'cancelled'].includes(row.status))
            throw ApiError.conflict('已结束订单保持原状态；重抢请新建');
          if (
            body.status === 'rushing' &&
            !(await ProxyAssignment.count({
              where: { proxyOrderId: row.id, endedAt: null },
              transaction,
            }))
          )
            throw ApiError.conflict('请先分配账号');
          audit = { from: row.status, to: body.status };
          row.status = body.status;
        } else if (action === 'accounts') {
          const added = await assign(row, body, transaction, actorId);
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
            if (!row.orderId) throw ApiError.conflict('尚未关联官方订单');
            audit = { previousOrderId: row.orderId };
            row.rejectedOrderIds = [...new Set([...row.rejectedOrderIds, row.orderId])];
            row.orderId = null;
            row.status = row.status === 'cancelled' ? 'cancelled' : 'pending';
            row.anomaly = '人工解除误关联，待重新核对';
          } else {
            if (row.orderId) throw ApiError.conflict('请先解除已有误关联');
            if (!/^W\d{10}$/.test(body.orderNumber || ''))
              throw ApiError.badRequest('请输入有效 Apple 订单号');
            const order = await Order.findOne({
              where: { orderNumber: body.orderNumber },
              transaction,
            });
            if (!order) throw ApiError.notFound('官方订单不存在');
            // 人工可以确认备注中的替代颜色；账号历史和客户姓名仍须一致，避免跨客户任意关联。
            const assignments = await ProxyAssignment.findAll({
              where: { proxyOrderId: row.id },
              transaction,
            });
            const clean = v =>
              String(v || '')
                .replace(/\s/g, '')
                .toLowerCase();
            if (
              !assignments.some(a => clean(a.accountEmail) === clean(order.appleId)) ||
              clean(order.recipientName) !== clean(row.lastName + row.firstName)
            )
              throw ApiError.conflict('官方订单账号或客户姓名与该委托不符');
            if (await ProxyOrder.count({ where: { orderId: order.id }, transaction }))
              throw ApiError.conflict('该官方订单已关联其他代抢单');
            row.orderId = order.id;
            row.anomaly =
              row.status === 'cancelled' ? '已取消后发现抢购成功订单，请核对并停止软件任务' : null;
            if (row.status !== 'cancelled') row.status = 'succeeded';
            audit = { orderId: order.id };
          }
          // 原因可包含人工业务说明，单独加密存储，列表只显示操作类型。
          const { encrypt } = require('../utils/fieldEncryption');
          audit.reasonEncrypted = encrypt(body.reason.trim());
        } else throw ApiError.badRequest('不支持的操作');
        row.version += 1;
        await row.save({ transaction });
        await event(action, row.id, actorId, audit, transaction);
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

/** 读取账号池/待核对候选，无密码。 @param {Object} query 筛选 @returns {Promise<Object>} 列表 */
async function listAccounts(query) {
  try {
    const where = { isProxyPool: query.scope !== 'candidates' };
    if (query.scope === 'candidates') where.notes = { [Op.iLike]: '%代抢%' };
    if (query.keyword) where.appleId = { [Op.iLike]: `%${String(query.keyword).slice(0, 100)}%` };
    const result = await AppleId.findAndCountAll({
      where,
      ...pageQuery(query),
      attributes: ['id', 'appleId', 'status', 'notes', 'isProxyPool', 'updatedAt'],
      order: [['id', 'ASC']],
    });
    const accountIds = result.rows.map(a => a.id);
    const [assignments, recipients] = accountIds.length
      ? await Promise.all([
        ProxyAssignment.findAll({ where: { appleIdRef: accountIds, endedAt: null }, raw: true }),
        Recipient.findAll({
          where: { appleIdRef: accountIds },
          attributes: ['id', 'appleIdRef'],
          raw: true,
        }),
      ])
      : [[], []];
    const [[availability]] = await sequelize.query(
      `SELECT COUNT(*)::integer AS count FROM apple_ids a
       WHERE a.is_proxy_pool=true AND a.status='未使用'
       AND NOT EXISTS(SELECT 1 FROM proxy_assignments p WHERE p.apple_id_ref=a.id AND p.ended_at IS NULL)
       AND NOT EXISTS(SELECT 1 FROM recipients r WHERE r.apple_id_ref=a.id)`
    );
    return {
      count: result.count,
      availableCount: availability.count,
      rows: result.rows.map(a => ({
        ...a.toJSON(),
        assignment: assignments.find(s => s.appleIdRef === a.id) || null,
        boundRecipient: recipients.some(r => r.appleIdRef === a.id),
      })),
    };
  } catch (error) {
    logger.debug('代抢操作错误由统一中间件处理', { errorType: error.name });
    throw error;
  }
}

/** 导入、核对纳入或更新池账号。 @param {string} action 动作 @param {Object} body 输入 @param {number} actorId 操作人 @param {number} accountId 账号 @returns {Promise<Object>} 结果 */
async function changeAccounts(action, body, actorId, accountId) {
  try {
    const parsed = action === 'import' ? input.parsePoolAccounts(body.text) : null;
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
          if (
            accounts.length !== accountIds.length ||
            (await Recipient.count({ where: { appleIdRef: accountIds }, transaction }))
          )
            throw ApiError.conflict('部分账号不存在或已绑定普通取机人');
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
            !['未使用', '使用中', '已下架', '异常'].includes(body.status) ||
            typeof body.notes !== 'string' ||
            body.notes.length > 10000
          )
            throw ApiError.badRequest('状态或备注不正确');
          await row.update({ status: body.status, notes: body.notes }, { transaction });
          accountIds = [row.id];
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
/** 周期性恢复匹配，按批次循环，不依赖页面访问。 @returns {Promise<number>} 扫描量 */
async function reconcile() {
  try {
    return await transact(null, async transaction => {
      try {
        const rows = await ProxyOrder.findAll({
          where: { id: { [Op.gt]: scanCursor }, orderId: null },
          order: [['id', 'ASC']],
          limit: 100,
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        scanCursor = rows.length === 100 ? rows.at(-1).id : 0;
        if (!rows.length) return 0;
        const assignments = await ProxyAssignment.findAll({
          where: { proxyOrderId: rows.map(r => r.id) },
          transaction,
        });
        if (!assignments.length) return rows.length;
        const emails = [...new Set(assignments.map(a => a.accountEmail.toLowerCase()))];
        const earliest = new Date(Math.min(...assignments.map(a => a.startedAt.getTime())));
        const orders = await Order.findAll({
          where: {
            [Op.and]: [
              sequelize.where(sequelize.fn('lower', sequelize.col('apple_id')), {
                [Op.in]: emails,
              }),
              { orderDate: { [Op.gte]: earliest } },
            ],
          },
          order: [
            ['orderDate', 'ASC'],
            ['id', 'ASC'],
          ],
          transaction,
        });
        const linked = orders.length
          ? await ProxyOrder.findAll({
            where: { orderId: orders.map(o => o.id) },
            attributes: ['orderId'],
            transaction,
          })
          : [];
        const used = new Set(linked.map(r => r.orderId));
        for (const row of rows) {
          const matches = orders.filter(
            o =>
              !used.has(o.id) &&
              input.isProxyMatch(
                row,
                o,
                assignments.filter(a => a.proxyOrderId === row.id)
              )
          );
          if (!matches.length) continue;
          const order = matches[0];
          // 同一官方订单若可能满足多个委托，不以扫描顺序选择归属。
          const ambiguous = rows.some(
            other =>
              other.id !== row.id &&
              input.isProxyMatch(
                other,
                order,
                assignments.filter(a => a.proxyOrderId === other.id)
              )
          );
          if (ambiguous) {
            if (row.anomaly !== '存在多个可能归属，请人工关联')
              await row.update(
                { anomaly: '存在多个可能归属，请人工关联', version: row.version + 1 },
                { transaction }
              );
            continue;
          }
          const anomaly =
            row.status === 'cancelled'
              ? '已取消后发现抢购成功订单，请核对并停止软件任务'
              : matches.length > 1
                ? '匹配到多个官方订单，已关联最早一笔，请核对重复抢购'
                : null;
          await row.update(
            {
              orderId: order.id,
              status: row.status === 'cancelled' ? 'cancelled' : 'succeeded',
              anomaly,
              version: row.version + 1,
            },
            { transaction }
          );
          used.add(order.id);
          await event(
            'auto_link',
            row.id,
            null,
            { orderId: order.id, candidates: matches.length },
            transaction
          );
        }
        return rows.length;
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
module.exports = {
  listOrders,
  detail,
  saveOrder,
  changeOrder,
  listAccounts,
  changeAccounts,
  copyTemplates,
  reconcile,
};
