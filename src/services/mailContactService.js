const { Op } = require('sequelize');
const { MailContact } = require('../models');
const { validateForwardInput } = require('./orderMailContent');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

/** 验证姓名和单邮箱；大小写及首尾空白不产生重复联系人。 */
function validateContact(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 100 || [...name].some(character => character.charCodeAt(0) < 32))
    throw ApiError.badRequest('联系人名必填，最多100字且不能包含控制字符');
  const { recipient } = validateForwardInput({
    recipient: body?.email,
    idempotencyKey: 'contact-validation',
  });
  return { name, email: recipient.toLowerCase() };
}

/** 验证联系人编号。 */
function contactId(value) {
  if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value)))
    throw ApiError.badRequest('联系人ID无效');
  return Number(value);
}

/** 分页搜索全局通讯录。 */
async function listContacts(query = {}) {
  try {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 50);
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 100000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw ApiError.badRequest('分页参数无效');
    if (
      query.search !== undefined &&
      (typeof query.search !== 'string' || query.search.length > 100)
    )
      throw ApiError.badRequest('搜索内容最多100字');
    const search = (query.search || '').trim().replace(/[\\%_]/g, '\\$&');
    const where = search
      ? {
        [Op.or]: [
          { name: { [Op.iLike]: '%' + search + '%' } },
          { email: { [Op.iLike]: '%' + search + '%' } },
        ],
      }
      : {};
    const { rows, count } = await MailContact.findAndCountAll({
      where,
      order: [
        ['name', 'ASC'],
        ['id', 'ASC'],
      ],
      limit,
      offset: (page - 1) * limit,
    });
    return { items: rows, total: count, page, limit };
  } catch (error) {
    logger.warn('邮件联系人查询失败', { errorType: error.name, errorCode: error.code });
    throw error;
  }
}

/** 新增或更新联系人，依靠数据库唯一约束保护并发。 */
async function saveContact(id, body) {
  try {
    const input = validateContact(body);
    if (id === undefined) return await MailContact.create(input);
    const item = await MailContact.findByPk(contactId(id));
    if (!item) throw ApiError.notFound('联系人不存在');
    return await item.update(input);
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError')
      throw ApiError.conflict('该邮箱已存在，请编辑已有联系人');
    logger.warn('邮件联系人保存失败', { errorType: error.name, errorCode: error.code });
    throw error;
  }
}

/** 删除通讯录条目，保留转发历史。 */
async function deleteContact(id) {
  try {
    const count = await MailContact.destroy({ where: { id: contactId(id) } });
    if (!count) throw ApiError.notFound('联系人不存在');
    return { id: Number(id) };
  } catch (error) {
    logger.warn('邮件联系人删除失败', { errorType: error.name, errorCode: error.code });
    throw error;
  }
}
module.exports = { validateContact, listContacts, saveContact, deleteContact };
