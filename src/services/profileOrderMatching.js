const { Op } = require('sequelize');
const { Recipient } = require('../models');
const { blindIndex } = require('../utils/fieldEncryption');
const logger = require('../utils/logger');

/** 批量加载候选人，供导入历史关联使用，避免逐订单读取。 */
async function loadRecipientCandidates(orders, transaction) {
  try {
    const hashes = [],
      tails = [],
      phones = [];
    for (const order of orders) {
      const card = order.recipientIdCard?.trim().toUpperCase();
      if (card && /^\d{17}[\dX]$/.test(card)) hashes.push(blindIndex(card));
      else if (order.recipientIdLast4) tails.push(order.recipientIdLast4.toUpperCase());
      else if (order.ingestionSource === 'aos' && order.recipientPhone)
        phones.push(order.recipientPhone);
    }
    const conditions = [];
    if (hashes.length) conditions.push({ idCardHash: [...new Set(hashes)] });
    if (tails.length) conditions.push({ idCardLast4: [...new Set(tails)] });
    if (phones.length) conditions.push({ phone: [...new Set(phones)] });
    if (!conditions.length) return [];
    return await Recipient.findAll({ where: { [Op.or]: conditions }, transaction });
  } catch (error) {
    logger.warn('读取订单身份候选失败', { errorType: error.name });
    throw error;
  }
}

/** 只使用订单自身证据；同名、同尾号多候选时返回空。 */
function matchRecipient(order, candidates) {
  const name = order.recipientName?.trim();
  if (!name) return null;
  const card = order.recipientIdCard?.trim().toUpperCase();
  const hash = card && /^\d{17}[\dX]$/.test(card) ? blindIndex(card) : null;
  const matches = candidates.filter(candidate => {
    if (`${candidate.lastName}${candidate.firstName}` !== name) return false;
    if (hash) {
      if ((candidate.idCardHash || blindIndex(candidate.idCardNumber)) !== hash) return false;
    } else if (order.recipientIdLast4) {
      if (candidate.idCardLast4 !== order.recipientIdLast4.toUpperCase()) return false;
    } else if (order.ingestionSource !== 'aos' || !order.recipientPhone) return false;
    if (order.ingestionSource === 'aos') {
      if (order.recipientPhone && candidate.phone !== order.recipientPhone) return false;
      if (
        order.recipientEmail &&
        candidate.email &&
        candidate.email.toLowerCase() !== order.recipientEmail.toLowerCase()
      )
        return false;
    }
    return true;
  });
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
