const { Op, Sequelize } = require('sequelize');
const {
  sequelize,
  PaymentTagRule,
  PaymentDispatchEvent,
  User,
  UserPermission,
  Order,
} = require('../models');
const { PAYMENT_ASSIGNMENT_LOCK_ID } = require('./permissionService');
const { PAYMENT_EXECUTION_PERMISSIONS } = require('../constants/permissionCatalog');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

/**
 * 校验并规范化完整规则输入。
 * @param {Object} input 请求
 * @returns {Object} 规则
 */
function normalizeRule(input) {
  if (
    !input ||
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.trim().length > 100
  ) {
    throw ApiError.badRequest('规则名称须为 1–100 个字符');
  }
  if (typeof input.enabled !== 'boolean') throw ApiError.badRequest('规则启用状态必须为布尔值');
  if (
    !Array.isArray(input.recipientTags) ||
    !input.recipientTags.length ||
    input.recipientTags.length > 100 ||
    input.recipientTags.some(
      tag => typeof tag !== 'string' || !tag.trim() || tag.trim().length > 500
    )
  ) {
    throw ApiError.badRequest('请选择或填写 1–100 个 TAG，每项 1–500 个字符');
  }
  const ids = input.assigneeUserIds;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 100 ||
    ids.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2147483647) ||
    new Set(ids).size !== ids.length
  ) {
    throw ApiError.badRequest('请选择 1–100 个不同的有效用户账号');
  }
  return {
    name: input.name.trim(),
    enabled: input.enabled,
    recipientTags: [...new Set(input.recipientTags.map(tag => tag.trim()))],
    assigneeUserIds: [...ids].sort((a, b) => a - b),
  };
}

/**
 * 为启用规则建立完整 TAG 索引。
 * @param {Object[]} rules 规则
 * @returns {Map} 索引
 */
function buildRuleIndex(rules) {
  const index = new Map();
  for (const rule of rules) {
    if (rule.enabled) for (const tag of rule.recipientTags) index.set(tag, rule);
  }
  return index;
}

/**
 * 只匹配 AOS 订单入库 TAG。
 * @param {Object} order 订单
 * @param {Map} index 索引
 * @returns {Object|null} 规则
 */
function matchRule(order, index) {
  if (order?.ingestionSource !== 'aos') return null;
  const tag = (order.sourceRecipientTag || order.tag || '').trim();
  return tag ? index.get(tag) || null : null;
}

/**
 * 查询管理员规则及全部 AOS TAG 候选。
 * @returns {Promise<Object>} 列表
 */
async function listRules() {
  try {
    const expression = Sequelize.literal('COALESCE(NULLIF("source_recipient_tag", \'\'), "tag")');
    const [items, tags] = await Promise.all([
      PaymentTagRule.findAll({ order: [['id', 'ASC']] }),
      Order.findAll({
        where: { ingestionSource: 'aos' },
        attributes: [[expression, 'value']],
        group: [expression],
        raw: true,
      }),
    ]);
    return {
      items,
      tagOptions: [...new Set(tags.map(row => row.value?.trim()).filter(Boolean))].sort(),
    };
  } catch (error) {
    logger.error('查询 TAG 分配规则失败', { errorCode: error.code || 'TAG_RULE_READ_FAILED' });
    throw error;
  }
}

function validateVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw ApiError.badRequest('expectedVersion 必须是非负整数');
  return value;
}

/**
 * 原子新增、修改或删除规则并保存审计。
 * @param {number|null} id 规则 ID
 * @param {Object} input 请求
 * @param {number} actorUserId 操作人
 * @param {boolean} remove 是否删除
 * @returns {Promise<Object>} 结果
 */
async function saveRule(id, input, actorUserId, remove = false) {
  try {
    if (id !== null && (!Number.isSafeInteger(id) || id <= 0))
      throw ApiError.badRequest('规则 ID 无效');
    const normalized = remove ? null : normalizeRule(input);
    const expectedVersion = id === null ? null : validateVersion(input.expectedVersion);
    return await sequelize.transaction(async transaction => {
      try {
        await sequelize.query('SELECT pg_advisory_xact_lock(:lockId)', {
          replacements: { lockId: PAYMENT_ASSIGNMENT_LOCK_ID },
          transaction,
        });
        const rule =
          id === null
            ? null
            : await PaymentTagRule.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
        if (id !== null && !rule) throw ApiError.notFound('TAG 分配规则不存在');
        if (rule && rule.version !== expectedVersion) {
          throw ApiError.conflict(
            '规则已被其他管理员修改，请重新加载后再编辑',
            { currentVersion: rule.version },
            'CONCURRENT_MODIFICATION'
          );
        }
        const before = rule?.toJSON() || null;
        let after = null;
        if (remove) {
          await rule.destroy({ transaction });
        } else {
          if (normalized.enabled) {
            const others = await PaymentTagRule.findAll({
              where: { enabled: true, ...(id === null ? {} : { id: { [Op.ne]: id } }) },
              transaction,
            });
            const existing = buildRuleIndex(others);
            const duplicate = normalized.recipientTags.find(tag => existing.has(tag));
            if (duplicate)
              throw ApiError.conflict(
                '该 TAG 已存在于其他启用规则中',
                { tag: duplicate, ruleId: existing.get(duplicate).id },
                'TAG_RULE_CONFLICT'
              );
          }
          const addedIds = normalized.assigneeUserIds.filter(
            userId => !before?.assigneeUserIds.includes(userId)
          );
          if (addedIds.length) {
            const users = await User.findAll({
              where: { id: { [Op.in]: addedIds }, status: 'active' },
              include: [
                { model: UserPermission, as: 'permissionGrants', attributes: ['permissionCode'] },
              ],
              transaction,
              lock: { level: transaction.LOCK.UPDATE, of: User },
            });
            if (
              users.length !== addedIds.length ||
              users.some(
                user =>
                  user.role !== 'admin' &&
                  !PAYMENT_EXECUTION_PERMISSIONS.every(code =>
                    user.permissionGrants.some(row => row.permissionCode === code)
                  )
              )
            ) {
              throw ApiError.badRequest('新增目标账号必须正常且具备完整付款执行权限');
            }
          }
          const values = {
            ...normalized,
            updatedBy: actorUserId,
            version: rule ? rule.version + 1 : 0,
          };
          after = rule
            ? await rule.update(values, { transaction })
            : await PaymentTagRule.create(values, { transaction });
        }
        await PaymentDispatchEvent.create(
          {
            eventType: remove ? 'tag_rule_deleted' : rule ? 'tag_rule_updated' : 'tag_rule_created',
            actorUserId,
            details: { before, after: after?.toJSON() || null },
          },
          { transaction }
        );
        return after || { id };
      } catch (error) {
        logger.error('TAG 分配操作失败', { errorCode: error.code || 'TAG_RULE_FAILED' });
        throw error;
      }
    });
  } catch (error) {
    if (!(error instanceof ApiError))
      logger.error('保存 TAG 分配规则失败', {
        ruleId: id,
        actorUserId,
        errorCode: error.code || 'TAG_RULE_WRITE_FAILED',
      });
    throw error;
  }
}

module.exports = { normalizeRule, buildRuleIndex, matchRule, listRules, saveRule };
