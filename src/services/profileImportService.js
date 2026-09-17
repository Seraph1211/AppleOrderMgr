const logger = require('../utils/logger');
const crypto = require('crypto');
const { AppleId, Recipient } = require('../models');
const { blindIndex } = require('../utils/fieldEncryption');
const {
  recipientInput,
  validateSecurityQa,
  assertPermission,
  validateAccountText,
} = require('../utils/profileInput');
const { PERMISSIONS, ACCOUNT_STATUSES } = require('../constants/business');
const { maskIdCard } = require('../utils/masking');
const { bindRecipient } = require('./profileBindingService');
const ApiError = require('../utils/ApiError');

const ACCOUNT_FIELDS = ['appleId', 'password', 'country', 'status', 'notes', 'securityQa'];
const RECIPIENT_FIELDS = [
  'lastName',
  'firstName',
  'idCardNumber',
  'realPhone',
  'phone',
  'email',
  'province',
  'city',
  'district',
  'streetAddress',
  'tag',
  'status',
  'notes',
  'appleId',
];
const LABELS = {
  lastName: '姓',
  firstName: '名',
  idCardNumber: '身份证',
  realPhone: '真实联系电话',
  phone: '下单手机号',
  email: '下单邮箱',
  province: '省',
  city: '市',
  district: '区',
  streetAddress: '街道地址',
  tag: 'TAG',
  status: '状态',
  notes: '备注',
  appleId: 'Apple ID',
  password: '密码',
  securityQa: '密保',
  country: '国家',
};

/** 批量读取档案，避免逐行读取数据库；摘要只在服务端用于旧预览检测。 */
async function loadProfiles(transaction) {
  try {
    const accounts = await AppleId.findAll({ order: [['id', 'ASC']], transaction });
    const recipients = await Recipient.findAll({ order: [['id', 'ASC']], transaction });
    const plain = {
      accounts: accounts.map(x => x.toJSON()),
      recipients: recipients.map(x => x.toJSON()),
    };
    return {
      ...plain,
      fingerprint: crypto.createHash('sha256').update(JSON.stringify(plain)).digest('hex'),
    };
  } catch (error) {
    logger.warn('基础档案操作未完成', { errorType: error.name });
    throw error;
  }
}

function displayValue(field, value) {
  if (['password', 'securityQa'].includes(field)) return '已填写（内容不回显）';
  if (field === 'idCardNumber') return maskIdCard(value);
  return value;
}

/** 合并跨文件与数据库档案；每个有差异的字段必须选定来源或跳过整条档案。 */
function buildImportPlan(rows, type, profiles, decisions = {}) {
  const groups = new Map();
  const accountIndex = new Map(
    profiles.accounts.map(item => [item.appleId.trim().toLowerCase(), item])
  );
  const recipientIndex = new Map(
    profiles.recipients.map(item => [item.idCardHash || blindIndex(item.idCardNumber), item])
  );
  const errors = [];
  function add(kind, key, data, source) {
    const mapKey = `${kind}:${key}`;
    if (!groups.has(mapKey)) {
      const existing = (kind === 'account' ? accountIndex : recipientIndex).get(key);
      groups.set(mapKey, { id: `g${groups.size}`, kind, key, existing, rows: [] });
    }
    groups.get(mapKey).rows.push({ data, source });
  }
  for (const row of rows) {
    try {
      if (row.issues?.length) throw ApiError.badRequest(row.issues.map(x => x.message).join('；'));
      const data = row.data;
      validateAccountText(data);
      const source = `${row.fileName} / ${row.sheetName} / 第${row.rowNumber}行`;
      if (type === 'recipients') {
        const normalized = recipientInput(data, true);
        if (!data.status) delete normalized.status;
        if (data.appleId && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.appleId))
          throw ApiError.badRequest('Apple ID 邮箱格式错误');
        add(
          'recipient',
          blindIndex(normalized.idCardNumber),
          { ...normalized, appleId: data.appleId },
          source
        );
        if (data.appleId && data.password)
          add('account', data.appleId, { appleId: data.appleId, password: data.password }, source);
      } else {
        if (!data.appleId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.appleId))
          throw ApiError.badRequest('Apple ID 邮箱格式错误');
        if (data.status && !ACCOUNT_STATUSES.includes(data.status))
          throw ApiError.badRequest('状态未映射，请确认后修正源表');
        let securityQa;
        if ([1, 2, 3].some(i => data[`question${i}`] || data[`answer${i}`])) {
          securityQa = validateSecurityQa(
            Object.fromEntries(
              [1, 2, 3].flatMap(i => [
                [`question${i}`, data[`question${i}`]],
                [`answer${i}`, data[`answer${i}`]],
              ])
            )
          );
        }
        add('account', data.appleId, { ...data, securityQa }, source);
      }
    } catch (error) {
      errors.push({
        fileName: row.fileName,
        sheetName: row.sheetName,
        rowNumber: row.rowNumber,
        error: error instanceof ApiError ? error.message : '资料格式错误',
      });
    }
  }
  const conflicts = [],
    records = [],
    writes = [];
  for (const group of groups.values()) {
    const { existing, kind, id } = group;
    const fields = kind === 'account' ? ACCOUNT_FIELDS : RECIPIENT_FIELDS;
    const data = {};
    const skipped = decisions[`${id}:skip`] === true;
    for (const field of fields) {
      const variants = [];
      const variant = (value, source, key) => {
        if (value === null || value === undefined || value === '') return;
        if (!variants.some(v => JSON.stringify(v.value) === JSON.stringify(value)))
          variants.push({ key, source, value });
      };
      variant(existing?.[field], '系统已有档案', 'existing');
      group.rows.forEach((row, index) => variant(row.data[field], row.source, `source${index}`));
      if (variants.length === 1) data[field] = variants[0].value;
      if (variants.length > 1) {
        const conflictId = `${id}:${field}`;
        const selected = variants.find(v => v.key === decisions[conflictId]);
        data[field] = (selected || variants[0]).value;
        conflicts.push({
          id: conflictId,
          groupId: id,
          field: LABELS[field],
          resolved: skipped || Boolean(selected),
          options: variants.map(v => ({
            key: v.key,
            source: v.source,
            value: displayValue(field, v.value),
          })),
        });
      }
    }
    if (!existing) {
      data.status ||= '未使用';
      if (kind === 'account') data.country ||= '中国';
    }
    const changed = fields.filter(
      field =>
        data[field] !== undefined &&
        JSON.stringify(data[field]) !== JSON.stringify(existing?.[field])
    );
    const record = {
      id,
      kind,
      existingId: existing?.id || null,
      label:
        kind === 'account'
          ? data.appleId
          : `${data.lastName}${data.firstName} ${maskIdCard(data.idCardNumber)}`,
      sources: group.rows.map(r => r.source),
      action: skipped ? '跳过' : !existing ? '新增' : changed.length ? '更新' : '重复',
      fields: Object.fromEntries(
        Object.entries(data).map(([field, value]) => [LABELS[field], displayValue(field, value)])
      ),
      problems: [],
    };
    if (!skipped && kind === 'account' && !data.password)
      record.problems.push('缺少密码，请先补齐账号资料');
    records.push(record);
    if (!skipped) writes.push({ ...group, data, changed, record });
  }
  const accounts = new Set(profiles.accounts.map(x => x.appleId.trim().toLowerCase()));
  writes
    .filter(x => x.kind === 'account' && x.data.password)
    .forEach(x => accounts.add(x.data.appleId));
  const occupancy = new Map(
    profiles.recipients
      .filter(x => x.appleIdRef)
      .map(x => [x.appleId?.trim().toLowerCase(), `existing:${x.id}`])
  );
  for (const write of writes.filter(x => x.kind === 'recipient')) {
    const account = write.data.appleId?.toLowerCase();
    const owner = write.existing ? `existing:${write.existing.id}` : write.id;
    if (account && !accounts.has(account))
      write.record.problems.push('绑定账号不存在或缺少密码，请先导入账号');
    if (account && occupancy.has(account) && occupancy.get(account) !== owner)
      write.record.problems.push('该账号当前或本批次已关联其他取机人，请先解决占用或跳过冲突档案');
    if (account) occupancy.set(account, owner);
  }
  return {
    writes,
    records,
    conflicts,
    errors,
    summary: {
      total: rows.length,
      valid: rows.length - errors.length,
      invalid: errors.length,
      records: records.length,
      conflicts: conflicts.filter(x => !x.resolved).length,
      blocked: records.filter(x => x.problems.length).length,
    },
  };
}

/** 执行已裁定合并计划；调用方负责事务、档案锁和预览摘要复核。 */
async function applyImportPlan(plan, req, transaction) {
  try {
    if (plan.conflicts.some(x => !x.resolved) || plan.records.some(x => x.problems.length))
      throw ApiError.conflict('仍有未裁定差异或绑定问题，请先确认或跳过相关档案');
    let imported = 0,
      updated = 0,
      skipped = plan.records.filter(x => x.action === '跳过' || x.action === '重复').length;
    for (const write of plan.writes.filter(x => x.kind === 'account')) {
      const { data, existing, changed } = write;
      if (existing && !changed.length) continue;
      assertPermission(req, existing ? PERMISSIONS.APPLE_IDS_EDIT : PERMISSIONS.APPLE_IDS_IMPORT);
      if (existing && changed.includes('securityQa'))
        assertPermission(req, PERMISSIONS.APPLE_IDS_SECRETS_READ);
      if (existing) {
        await AppleId.update(data, {
          where: { id: existing.id },
          transaction,
          individualHooks: true,
        });
        updated++;
      } else {
        await AppleId.create(data, { transaction });
        imported++;
      }
    }
    const accounts = await AppleId.findAll({ attributes: ['id', 'appleId'], transaction });
    const accountMap = new Map(accounts.map(x => [x.appleId.trim().toLowerCase(), x.id]));
    for (const write of plan.writes.filter(x => x.kind === 'recipient')) {
      const { data, existing, changed } = write;
      if (existing && !changed.length) continue;
      assertPermission(req, existing ? PERMISSIONS.RECIPIENTS_EDIT : PERMISSIONS.RECIPIENTS_IMPORT);
      const { appleId, ...fields } = data;
      let recipient;
      if (existing) {
        recipient = await Recipient.findByPk(existing.id, { transaction });
        await recipient.update(fields, { transaction });
        updated++;
      } else {
        recipient = await Recipient.create(fields, { transaction });
        imported++;
      }
      if (appleId && recipient.appleIdRef !== accountMap.get(appleId.toLowerCase())) {
        assertPermission(req, PERMISSIONS.RECIPIENTS_BIND_APPLE_IDS);
        await bindRecipient(recipient, accountMap.get(appleId.toLowerCase()), transaction);
      }
    }
    return { imported, updated, skipped, errors: plan.errors };
  } catch (error) {
    logger.warn('基础档案操作未完成', { errorType: error.name });
    throw error;
  }
}

module.exports = { loadProfiles, buildImportPlan, applyImportPlan };
