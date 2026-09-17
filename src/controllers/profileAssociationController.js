const { scopeOrderWhere } = require('../services/orderAccessService');
const logger = require('../utils/logger');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { sequelize, Order, AppleId } = require('../models');
const { loadRecipientCandidates, matchRecipient } = require('../services/profileOrderMatching');
const { lockProfiles } = require('../services/profileBindingService');
const { profileId } = require('../utils/profileInput');
const ApiError = require('../utils/ApiError');
const sessions = new Map();
const digest = row =>
  crypto.createHash('sha256').update(JSON.stringify(row.toJSON())).digest('hex');

/** 只读预览未关联订单，每批最多 500 条，不获取官网。 */
async function previewAssociations(req, res) {
  try {
    for (const [key, session] of sessions)
      if (session.expiresAt <= Date.now()) sessions.delete(key);
    if ([...sessions.values()].filter(x => x.userId === req.user.id).length >= 5)
      throw ApiError.badRequest('未完成预览过多');
    const cursor = req.body?.cursor ? profileId(req.body.cursor) : 0;
    const orders = await Order.findAll({
      where: scopeOrderWhere(req.user, {
        id: { [Op.gt]: cursor },
        [Op.or]: [{ recipientRef: null }, { appleIdRef: null }],
      }),
      order: [['id', 'ASC']],
      limit: 500,
    });
    const accounts = await AppleId.findAll({ attributes: ['id', 'appleId'] });
    const accountMap = new Map(accounts.map(x => [x.appleId.toLowerCase(), x.id]));
    const candidates = await loadRecipientCandidates(orders);
    const records = [];
    for (const order of orders) {
      const recipient = !order.recipientRef ? matchRecipient(order, candidates) : null;
      records.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        recipientId: recipient?.id || null,
        recipientName: recipient ? `${recipient.lastName}${recipient.firstName}` : null,
        appleIdRef: !order.appleIdRef ? accountMap.get(order.appleId?.toLowerCase()) || null : null,
        fingerprint: digest(order),
      });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { userId: req.user.id, records, expiresAt: Date.now() + 5 * 60 * 1000 });
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      data: {
        token,
        nextCursor: orders.length === 500 ? orders[orders.length - 1].id : null,
        records: records.map(({ fingerprint: _fingerprint, ...record }) => ({
          ...record,
          matchable: Boolean(record.recipientId || record.appleIdRef),
        })),
      },
    });
  } catch (error) {
    logger.warn('基础档案操作未完成', { errorType: error.name });
    throw error;
  }
}

/** 执行选中候选，重验身份与档案，整批只补空外键。 */
async function executeAssociations(req, res) {
  try {
    const session = sessions.get(req.body?.token);
    if (!session || session.userId !== req.user.id || session.expiresAt <= Date.now())
      throw ApiError.badRequest('预览失效，请重新预览');
    if (
      !Array.isArray(req.body.orderIds) ||
      !req.body.orderIds.length ||
      req.body.orderIds.length > 500
    )
      throw ApiError.badRequest('请选择候选订单');
    const ids = [...new Set(req.body.orderIds.map(profileId))];
    const selected = ids.map(id => session.records.find(x => x.orderId === id));
    if (selected.some(x => !x || (!x.recipientId && !x.appleIdRef)))
      throw ApiError.badRequest('不能关联无证据订单');
    sessions.delete(req.body.token);
    await sequelize.transaction(async transaction => {
      await lockProfiles(transaction, req.user.id);
      const orders = await Order.findAll({
        where: scopeOrderWhere(req.user, { id: ids }),
        transaction,
        lock: transaction.LOCK.UPDATE,
        order: [['id', 'ASC']],
      });
      const candidates = await loadRecipientCandidates(orders, transaction);
      const accounts = await AppleId.findAll({ attributes: ['id', 'appleId'], transaction });
      for (const record of selected.sort((a, b) => a.orderId - b.orderId)) {
        const order = orders.find(row => row.id === record.orderId);
        if (!order || digest(order) !== record.fingerprint)
          throw ApiError.conflict('订单已变化，请重新预览');
        const updates = {};
        if (record.recipientId) {
          const match = matchRecipient(order, candidates);
          if (match?.id !== record.recipientId)
            throw ApiError.conflict('取机人匹配已变化，请重新预览');
          updates.recipientRef = match.id;
        }
        if (record.appleIdRef) {
          const account = accounts.find(row => row.id === record.appleIdRef);
          if (!account || account.appleId.toLowerCase() !== order.appleId?.toLowerCase())
            throw ApiError.conflict('账号匹配已变化');
          updates.appleIdRef = account.id;
        }
        await order.update(updates, { transaction, silent: true });
      }
    });
    res.json({ success: true, data: { updated: selected.length } });
  } catch (error) {
    logger.warn('基础档案操作未完成', { errorType: error.name });
    throw error;
  }
}
module.exports = { previewAssociations, executeAssociations };
