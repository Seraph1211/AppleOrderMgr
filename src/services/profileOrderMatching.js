const { Op } = require('sequelize');
const { Recipient } = require('../models');
const logger = require('../utils/logger');

/** 提取订单自身的有效证件尾号；冲突证据不用于自动关联。 */
function recipientTail(order) {
  const tail = order.recipientIdLast4?.trim().toUpperCase();
  const card = order.recipientIdCard?.trim().toUpperCase();
  const cardTail = card && /^\d{17}[\dX]$/.test(card) ? card.slice(-4) : null;
  if (tail) {
    if (!/^\d{3}[\dX]$/.test(tail) || (cardTail && cardTail !== tail)) return null;
    return tail;
  }
  return cardTail;
}

/** 批量加载证件尾号候选，供新订单和历史关联共用。 */
async function loadRecipientCandidates(orders, transaction) {
  try {
    const tails = [...new Set(orders.map(recipientTail).filter(Boolean))];
    if (!tails.length) return [];
    return await Recipient.findAll({
      where: { idCardLast4: { [Op.in]: tails } },
      transaction,
    });
  } catch (error) {
    logger.warn('读取订单身份候选失败', { errorType: error.name });
    throw error;
  }
}

/** 仅使用全名＋证件后四位唯一匹配；手机号、邮箱和当前账号不参与判断。 */
function matchRecipient(order, candidates) {
  const name = order.recipientName?.trim();
  const tail = recipientTail(order);
  if (!name || !tail) return null;
  const matches = candidates.filter(
    candidate =>
      `${candidate.lastName}${candidate.firstName}` === name && candidate.idCardLast4 === tail
  );
  return matches.length === 1 ? matches[0] : null;
}

/** 新订单按同一规则匹配，不通过当前账号绑定推断取机人。 */
async function findRecipientForOrder(order, transaction) {
  try {
    return matchRecipient(order, await loadRecipientCandidates([order], transaction));
  } catch (error) {
    logger.warn('订单身份匹配未完成', { errorType: error.name });
    throw error;
  }
}
module.exports = { loadRecipientCandidates, matchRecipient, findRecipientForOrder };
