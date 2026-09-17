/* eslint-disable camelcase */
/**
 * 收件人（取机人）控制器
 * @module controllers/recipientController
 * @description 收件人 CRUD + 分页 + 关键字/标签/Apple ID 过滤
 * @see docs/design/API设计.md
 */

const { Op } = require('sequelize');
const { sequelize, Recipient, AppleId, Order } = require('../models');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');
const { paginatedResponse, parsePositiveInt } = require('../utils/apiResponse');
const XLSX = require('xlsx');
const { ACCOUNT_STATUSES } = require('../constants/business');
const { blindIndex } = require('../utils/fieldEncryption');
const { canDisplayLocalSensitiveFields } = require('../utils/localSensitiveDisplay');
const { PERMISSIONS } = require('../constants/business');
const { generatePhone } = require('../utils/contactGenerator');
const {
  hasPermission,
  assertPermission,
  profileId,
  recipientInput,
} = require('../utils/profileInput');
const {
  lockProfiles,
  bindRecipient,
  resolveAccount,
} = require('../services/profileBindingService');
const {
  maskIdCard,
  maskPhone,
  maskAddress,
  escapeSpreadsheetFormula,
} = require('../utils/masking');

/**
 * 把 Recipient 实例序列化为对外对象
 * @param {Object} recipient - JSON 形态的 Recipient
 * @param {Object} stats - 统计数据 { orderCount, totalAmount, lastOrderDate }
 * @param {boolean} includeSensitive - 是否包含身份证号和手机号明文
 * @param {boolean} includeAddress - 是否允许本地管理员读取详细地址
 * @returns {Object} 对外对象
 */
function serializeRecipient(
  recipient,
  stats = {},
  includeSensitive = false,
  includeAddress = false,
  includePassword = false
) {
  return {
    id: recipient.id,
    name: `${recipient.lastName || ''}${recipient.firstName || ''}`,
    last_name: recipient.lastName,
    first_name: recipient.firstName,
    id_card_number: includeSensitive ? recipient.idCardNumber : maskIdCard(recipient.idCardNumber),
    id_card_last4: recipient.idCardLast4,
    real_phone: includeSensitive ? recipient.realPhone : maskPhone(recipient.realPhone),
    ...(includePassword ? { password: recipient.password || null } : {}),
    bound: Boolean(recipient.appleIdRef),
    phone: includeSensitive ? recipient.phone : maskPhone(recipient.phone),
    email: recipient.email,
    apple_id: recipient.appleId,
    apple_id_ref: recipient.appleIdRef,
    province: recipient.province,
    city: recipient.city,
    district: recipient.district,
    street_address: includeAddress ? recipient.streetAddress : null,
    masked_address: maskAddress(recipient),
    tag: recipient.tag,
    status: recipient.status,
    notes: recipient.notes,
    order_count: stats.orderCount || 0,
    created_at: recipient.createdAt,
    updated_at: recipient.updatedAt,
  };
}

/**
 * 获取多个收件人的订单数量统计
 * @param {Array<number>} recipientIds - 收件人 ID 数组
 * @returns {Promise<Object>} { recipientId: { orderCount } }
 */
async function getOrderCountsByRecipients(recipientIds) {
  if (!recipientIds || recipientIds.length === 0) {
    return {};
  }

  const results = await Order.findAll({
    attributes: ['recipientRef', [sequelize.fn('COUNT', sequelize.col('id')), 'orderCount']],
    where: {
      recipientRef: { [Op.in]: recipientIds },
    },
    group: ['recipientRef'],
    raw: true,
  });

  const statsMap = {};
  results.forEach(row => {
    statsMap[row.recipientRef] = {
      orderCount: parseInt(row.orderCount, 10) || 0,
    };
  });

  return statsMap;
}

/**
 * 一次性查询指定 recipient id 列表的订单统计
 * @param {number[]} ids
 * @returns {Promise<Object>} { [id]: { orderCount, totalAmount, lastOrderDate } }
 */
async function getOrderStatsByRecipients(ids) {
  if (ids.length === 0) return {};
  const { Order } = require('../models');

  // 查询订单数和最后下单日期
  const rows = await Order.findAll({
    attributes: [
      'recipientRef',
      [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
      [sequelize.fn('MAX', sequelize.col('created_at')), 'lastOrderDate'],
    ],
    where: { recipientRef: { [Op.in]: ids } },
    group: ['recipientRef'],
    raw: true,
  });

  const out = {};
  rows.forEach(r => {
    out[r.recipientRef] = {
      orderCount: parseInt(r.count, 10),
      totalAmount: 0, // 暂时为 0，后续可从 products JSONB 计算
      lastOrderDate: r.lastOrderDate,
    };
  });
  return out;
}

/**
 * GET /api/recipients?page=1&limit=20&tag=北京&keyword=李&status=active&apple_id_ref=1
 */
async function listRecipients(req, res) {
  try {
    const page = parsePositiveInt(req.query.page, { defaultValue: 1, min: 1, max: 100000 });
    const limit = parsePositiveInt(req.query.limit, { defaultValue: 20, min: 1, max: 100 });

    const where = {};
    if (['true', 'false'].includes(req.query.bound))
      where.appleIdRef = req.query.bound === 'true' ? { [Op.ne]: null } : null;
    if (req.query.tag) {
      where.tag = req.query.tag;
    }
    if (req.query.status) {
      if (!ACCOUNT_STATUSES.includes(req.query.status)) {
        throw ApiError.badRequest(`status 非法，可选值: ${ACCOUNT_STATUSES.join(', ')}`, {
          received: req.query.status,
        });
      }
      where.status = req.query.status;
    }
    if (req.query.apple_id_ref) {
      const ref = parseInt(req.query.apple_id_ref, 10);
      if (Number.isNaN(ref) || ref <= 0) {
        throw ApiError.badRequest('apple_id_ref 必须是正整数', {
          received: req.query.apple_id_ref,
        });
      }
      where.appleIdRef = ref;
    }
    if (req.query.keyword) {
      const kw = String(req.query.keyword).trim();
      if (kw.length > 0) {
        where[Op.or] = [
          { lastName: { [Op.iLike]: `%${kw}%` } },
          { firstName: { [Op.iLike]: `%${kw}%` } },
          sequelize.where(
            sequelize.fn('concat', sequelize.col('last_name'), sequelize.col('first_name')),
            { [Op.iLike]: `%${kw}%` }
          ),
          { idCardLast4: kw },
          { phone: { [Op.iLike]: `%${kw}%` } },
        ];
      }
    }

    const { count, rows } = await Recipient.findAndCountAll({
      where,
      order: [['id', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });

    const orderStats = await getOrderStatsByRecipients(rows.map(r => r.id));
    const includeSensitive = Boolean(req.user?.permissions?.includes(PERMISSIONS.RECIPIENTS_READ));
    const includeAddress =
      hasPermission(req, PERMISSIONS.RECIPIENTS_EDIT) ||
      hasPermission(req, PERMISSIONS.RECIPIENTS_EXPORT_SENSITIVE) ||
      canDisplayLocalSensitiveFields(req, PERMISSIONS.RECIPIENTS_EXPORT_SENSITIVE);

    res.set('Cache-Control', 'no-store');
    res.json(
      paginatedResponse(
        rows.map(r =>
          serializeRecipient(
            r.toJSON(),
            orderStats[r.id] || {},
            includeSensitive,
            includeAddress,
            hasPermission(req, PERMISSIONS.APPLE_IDS_READ)
          )
        ),
        count,
        page,
        limit,
        'recipients'
      )
    );
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('查询收件人列表失败', { error: error.message });
    throw ApiError.database('查询收件人列表失败', { reason: error.message });
  }
}

/**
 * GET /api/recipients/:id
 */
async function getRecipientDetail(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || id <= 0) {
      throw ApiError.badRequest('收件人 ID 必须是正整数', { received: req.params.id });
    }

    const recipient = await Recipient.findByPk(id, {
      include: [{ model: AppleId, as: 'appleAccount' }],
    });
    if (!recipient) {
      throw ApiError.notFound('收件人不存在', { id });
    }

    const orderCounts = await getOrderCountsByRecipients([id]);
    const includeSensitive = Boolean(req.user?.permissions?.includes(PERMISSIONS.RECIPIENTS_READ));
    const includeAddress =
      hasPermission(req, PERMISSIONS.RECIPIENTS_EDIT) ||
      hasPermission(req, PERMISSIONS.RECIPIENTS_EXPORT_SENSITIVE) ||
      canDisplayLocalSensitiveFields(req, PERMISSIONS.RECIPIENTS_EXPORT_SENSITIVE);
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      data: serializeRecipient(
        recipient.toJSON(),
        orderCounts[id] || {},
        includeSensitive,
        includeAddress,
        hasPermission(req, PERMISSIONS.APPLE_IDS_READ)
      ),
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('查询收件人详情失败', { id: req.params.id, error: error.message });
    throw ApiError.database('查询收件人详情失败', { reason: error.message });
  }
}

/**
 * POST /api/recipients
 */
async function createRecipient(req, res) {
  try {
    const payload = req.body || {};
    const data = recipientInput(payload, true);
    const created = await sequelize.transaction(async transaction => {
      await lockProfiles(transaction, req.user?.id);
      const duplicate = await Recipient.findOne({
        where: { idCardHash: blindIndex(data.idCardNumber) },
        transaction,
      });
      if (duplicate) throw ApiError.conflict('该身份证号已存在');
      let ref = payload.appleIdRef ?? null;
      if (payload.appleId) ref = await resolveAccount(payload.appleId, transaction);
      if (ref !== null) assertPermission(req, PERMISSIONS.RECIPIENTS_BIND_APPLE_IDS);
      const recipient = await Recipient.create(data, { transaction });
      if (ref !== null) await bindRecipient(recipient, profileId(ref), transaction, null);
      return recipient;
    });
    res.status(201).json({ success: true, data: serializeRecipient(created.toJSON()) });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.name === 'SequelizeUniqueConstraintError')
      throw ApiError.conflict('身份证或当前账号绑定已存在');
    logger.error('创建取机人失败', { errorType: error.name });
    throw ApiError.database('创建取机人失败');
  }
}

/** 编辑档案及可选绑定，绑定变化必须携带预期值。 */
async function updateRecipient(req, res) {
  try {
    const id = profileId(req.params.id);
    const payload = req.body || {};
    const updates = recipientInput(payload);
    const recipient = await sequelize.transaction(async transaction => {
      await lockProfiles(transaction, req.user?.id);
      const row = await Recipient.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!row) throw ApiError.notFound('取机人不存在');
      if (updates.idCardNumber) {
        const duplicate = await Recipient.findOne({
          where: {
            idCardHash: blindIndex(updates.idCardNumber),
            id: { [Op.ne]: id },
          },
          transaction,
        });
        if (duplicate) throw ApiError.conflict('该身份证号已存在');
      }
      if (payload.appleId !== undefined || payload.appleIdRef !== undefined) {
        assertPermission(req, PERMISSIONS.RECIPIENTS_BIND_APPLE_IDS);
        if (payload.expectedAppleIdRef === undefined) throw ApiError.badRequest('请提交当前绑定值');
        const ref =
          payload.appleId !== undefined
            ? await resolveAccount(payload.appleId, transaction)
            : payload.appleIdRef;
        await bindRecipient(
          row,
          ref === null ? null : profileId(ref),
          transaction,
          payload.expectedAppleIdRef
        );
      }
      await row.update(updates, { transaction });
      return row;
    });
    res.json({ success: true, data: serializeRecipient(recipient.toJSON()) });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.name === 'SequelizeUniqueConstraintError')
      throw ApiError.conflict('身份证或当前账号绑定已存在');
    logger.error('更新取机人失败', { id: req.params.id, errorType: error.name });
    throw ApiError.database('更新取机人失败');
  }
}

/** 单独换绑或解绑。 */
async function updateBinding(req, res) {
  try {
    assertPermission(req, PERMISSIONS.RECIPIENTS_BIND_APPLE_IDS);
    const { appleIdRef, expectedAppleIdRef } = req.body || {};
    if (expectedAppleIdRef === undefined || appleIdRef === undefined)
      throw ApiError.badRequest('缺少当前或目标绑定值');
    await sequelize.transaction(async transaction => {
      await lockProfiles(transaction, req.user.id);
      const row = await Recipient.findByPk(profileId(req.params.id), {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!row) throw ApiError.notFound('取机人不存在');
      await bindRecipient(row, appleIdRef, transaction, expectedAppleIdRef);
    });
    res.json({ success: true });
  } catch (error) {
    logger.warn('基础档案操作未完成', { errorType: error.name });
    throw error;
  }
}

/** 查询不含密码和身份证的绑定历史。 */
async function listBindings(req, res) {
  try {
    const id = profileId(req.params.id);
    const byApple = req.baseUrl.endsWith('/apple-ids');
    const [rows] = await sequelize.query(
      `SELECT id, recipient_id, apple_id_ref, recipient_name, apple_id, started_at, ended_at, observed_at
       FROM profile_bindings WHERE ${byApple ? 'apple_id_ref' : 'recipient_id'}=:id ORDER BY id DESC LIMIT 200`,
      { replacements: { id } }
    );
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: rows });
  } catch (error) {
    logger.warn('基础档案操作未完成', { errorType: error.name });
    throw error;
  }
}

/**
 * DELETE /api/recipients/:id
 */
async function deleteRecipient(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || id <= 0) {
      throw ApiError.badRequest('收件人 ID 必须是正整数', { received: req.params.id });
    }

    const recipient = await Recipient.findByPk(id);
    if (!recipient) {
      throw ApiError.notFound('收件人不存在', { id });
    }

    await sequelize.transaction(async transaction => {
      await lockProfiles(transaction, req.user?.id);
      await recipient.destroy({ transaction });
    });

    logger.info('收件人删除成功', { id });

    res.json({
      success: true,
      message: '收件人已删除',
      data: { id },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('删除收件人失败', { id: req.params.id, error: error.message });
    throw ApiError.database('删除收件人失败', { reason: error.message });
  }
}

/**
 * POST /api/recipients/batch-generate-contact
 * 为选中的取机人重新生成电话和邮箱
 */
async function batchGenerateContact(req, res) {
  const transaction = await sequelize.transaction();

  try {
    await lockProfiles(transaction, req.user?.id);
    const { recipient_ids } = req.body;

    if (!Array.isArray(recipient_ids) || recipient_ids.length === 0) {
      throw ApiError.badRequest('recipient_ids 必须是非空数组');
    }

    // 验证所有ID都是正整数
    const ids = recipient_ids.map(id => {
      const num = parseInt(id, 10);
      if (Number.isNaN(num) || num <= 0) {
        throw ApiError.badRequest('recipient_ids 中包含无效的ID', { received: id });
      }
      return num;
    });

    // 查找所有取机人
    const recipients = await Recipient.findAll({
      where: { id: { [Op.in]: ids } },
      transaction,
    });

    if (recipients.length === 0) {
      throw ApiError.notFound('未找到任何匹配的取机人');
    }

    // 选中的记录均重新生成，避免已有联系方式导致按钮无可见变化。
    for (const recipient of recipients) {
      const phone = generatePhone();
      const updates = {
        phone,
        email: `${phone}@vvv8.net`,
      };

      await recipient.update(updates, { transaction });
      logger.info('生成取机人联系方式', {
        id: recipient.id,
        updatedFields: Object.keys(updates),
      });
    }

    await transaction.commit();

    res.json({
      success: true,
      message: `成功生成 ${recipients.length} 个取机人的联系方式`,
      data: {
        total: ids.length,
        found: recipients.length,
        updated: recipients.length,
        skipped: 0,
      },
    });
  } catch (error) {
    await transaction.rollback();

    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('批量生成联系方式失败', { error: error.message });
    throw ApiError.database('批量生成联系方式失败', { reason: error.message });
  }
}

/**
 * 生成随机详细地址
 * @returns {string} 详细地址
 */
function generateDetailAddress() {
  const streetSuffixes = [
    '街',
    '路',
    '巷',
    '弄',
    '里',
    '村',
    '大道',
    '小区',
    '花园',
    '公寓',
    '广场',
  ];
  const streetNames = [
    '建设',
    '人民',
    '中山',
    '解放',
    '和平',
    '新华',
    '光明',
    '胜利',
    '红旗',
    '友谊',
    '文化',
    '民主',
    '团结',
    '幸福',
    '安康',
  ];

  const numbers = Math.floor(Math.random() * 999) + 1;
  const buildingNum = Math.floor(Math.random() * 30) + 1;
  const unitNum = Math.floor(Math.random() * 6) + 1;
  const roomNum = Math.floor(Math.random() * 20) + 101;

  const suffix = streetSuffixes[Math.floor(Math.random() * streetSuffixes.length)];
  const streetName = streetNames[Math.floor(Math.random() * streetNames.length)];

  return `${streetName}${suffix}${numbers}号${buildingNum}栋${unitNum}单元${roomNum}室`;
}

/**
 * POST /api/recipients/batch-generate-address
 * 批量生成取机人的地址信息
 */
async function batchGenerateAddress(req, res) {
  const transaction = await sequelize.transaction();

  try {
    await lockProfiles(transaction, req.user?.id);
    const { recipient_ids, province, city, district } = req.body;

    // 验证参数
    if (!Array.isArray(recipient_ids) || recipient_ids.length === 0) {
      throw ApiError.badRequest('recipient_ids 必须是非空数组');
    }

    if (!province || typeof province !== 'string') {
      throw ApiError.badRequest('province 必须是非空字符串');
    }

    if (!city || typeof city !== 'string') {
      throw ApiError.badRequest('city 必须是非空字符串');
    }

    if (!district || typeof district !== 'string') {
      throw ApiError.badRequest('district 必须是非空字符串');
    }

    // 验证所有ID都是正整数
    const ids = recipient_ids.map(id => {
      const num = parseInt(id, 10);
      if (Number.isNaN(num) || num <= 0) {
        throw ApiError.badRequest('recipient_ids 中包含无效的ID', { received: id });
      }
      return num;
    });

    // 查找所有取机人
    const recipients = await Recipient.findAll({
      where: { id: { [Op.in]: ids } },
      transaction,
    });

    if (recipients.length === 0) {
      throw ApiError.notFound('未找到任何匹配的取机人');
    }

    // 批量更新地址
    let updated = 0;
    for (const recipient of recipients) {
      const updates = {
        province,
        city,
        district,
        streetAddress: generateDetailAddress(city),
      };

      await recipient.update(updates, { transaction });
      updated++;
      logger.info('生成取机人地址', {
        id: recipient.id,
        updatedFields: Object.keys(updates),
      });
    }

    await transaction.commit();

    res.json({
      success: true,
      message: `成功生成 ${updated} 个取机人的地址信息`,
      data: {
        total: ids.length,
        found: recipients.length,
        updated,
        province,
        city,
        district,
      },
    });
  } catch (error) {
    await transaction.rollback();

    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('批量生成地址失败', { error: error.message });
    throw ApiError.database('批量生成地址失败', { reason: error.message });
  }
}

/**
 * 生成信息导入模版字段
 * @param {Object} recipient - 取机人数据
 * @param {Object} appleIdData - Apple ID数据
 * @returns {string} 信息导入模版
 */
function generateImportTemplate(recipient, appleIdData) {
  const {
    phone = '',
    email = '',
    province = '',
    city = '',
    district = '',
    streetAddress = '',
    lastName = '',
    firstName = '',
    idCardNumber = '',
    tag = '',
  } = Object.fromEntries(Object.entries(recipient).map(([key, value]) => [key, value ?? '']));

  const appleId = appleIdData?.appleId || '';
  const password = appleIdData?.password || '';

  // Excel公式格式：A2,B2,,,1,指定地址,C2,I2,J2,,D2,E2,F2,G2,,,H2,,,,,,WECHAT,0,,,,否##0#7-1-8-9-2-0#0#0#否#否#否#否#否#5000#0#0#否#0#0#0#0#否#否##否##否#,K2,L2,,,
  const fixedPart =
    'WECHAT,0,,,,否##0#7-1-8-9-2-0#0#0#否#否#否#否#否#5000#0#0#否#0#0#0#0#否#否##否##否#';

  return `${appleId},${password},,,1,指定地址,${phone},${lastName},${firstName},,${email},${province},${city},${district},,,${streetAddress},,,,,,${fixedPart},${idCardNumber},${tag},,,`;
}

/**
 * GET /api/recipients/export
 * 导出取机人数据为Excel
 */
async function exportRecipients(req, res) {
  try {
    const { status, tag, keyword, apple_id: appleIdFilter, ids, bound } = req.query;

    // 构建查询条件
    const where = {};

    // 如果提供了ID列表，优先使用ID过滤（只导出选中的）
    if (ids) {
      const idArray = ids.split(',').map(profileId);
      if (idArray.length > 0) {
        where.id = { [Op.in]: idArray };
      }
    } else {
      // 未提供ID列表时，使用其他过滤条件
      if (bound === 'true') where.appleIdRef = { [Op.ne]: null };
      if (bound === 'false') where.appleIdRef = null;
      if (status && ACCOUNT_STATUSES.includes(status)) {
        where.status = status;
      }

      if (tag) {
        where.tag = tag;
      }

      if (appleIdFilter) {
        where.appleId = appleIdFilter;
      }

      if (keyword) {
        where[Op.or] = [
          { firstName: { [Op.iLike]: `%${keyword}%` } },
          { lastName: { [Op.iLike]: `%${keyword}%` } },
          { phone: { [Op.like]: `%${keyword}%` } },
          { email: { [Op.like]: `%${keyword}%` } },
        ];
        if (
          /^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/.test(keyword)
        ) {
          where[Op.or].push({ idCardHash: blindIndex(keyword) });
        }
      }
    }

    // 查询所有符合条件的取机人，包含关联的Apple ID
    const recipients = await Recipient.findAll({
      where,
      include: [
        {
          model: AppleId,
          as: 'appleAccount',
          attributes: ['id', 'appleId', 'password', 'status'],
          required: false,
        },
      ],
      order: [['createdAt', 'DESC']],
    });

    if (recipients.length === 0) {
      throw ApiError.notFound('没有符合条件的取机人数据');
    }

    // 构建Excel数据
    const includeSensitive = req.query.includeSensitive === 'true';
    if (includeSensitive) assertPermission(req, PERMISSIONS.RECIPIENTS_EXPORT_SENSITIVE);
    res.set('Cache-Control', 'no-store');
    const excelData = recipients.map(recipient => {
      const appleIdData = recipient.appleAccount;

      return {
        'Apple ID': escapeSpreadsheetFormula(appleIdData?.appleId || ''),
        密码: includeSensitive ? escapeSpreadsheetFormula(appleIdData?.password || '') : '******',
        下单手机号码: includeSensitive ? recipient.phone || '' : maskPhone(recipient.phone) || '',
        Email: escapeSpreadsheetFormula(recipient.email || ''),
        省: escapeSpreadsheetFormula(recipient.province || ''),
        市: escapeSpreadsheetFormula(recipient.city || ''),
        区: escapeSpreadsheetFormula(recipient.district || ''),
        街道地址: includeSensitive
          ? escapeSpreadsheetFormula(recipient.streetAddress || '')
          : '详细地址已隐藏',
        使用状态: recipient.status,
        姓: escapeSpreadsheetFormula(recipient.lastName || ''),
        名: escapeSpreadsheetFormula(recipient.firstName || ''),
        身份证号码: includeSensitive
          ? recipient.idCardNumber || ''
          : maskIdCard(recipient.idCardNumber) || '',
        TAG: escapeSpreadsheetFormula(recipient.tag || ''),
        信息导入模板: includeSensitive
          ? escapeSpreadsheetFormula(
            generateImportTemplate(
              {
                phone: recipient.phone,
                email: recipient.email,
                province: recipient.province,
                city: recipient.city,
                district: recipient.district,
                streetAddress: recipient.streetAddress,
                lastName: recipient.lastName,
                firstName: recipient.firstName,
                idCardNumber: recipient.idCardNumber,
                tag: recipient.tag,
              },
              appleIdData
            )
          )
          : '',
        真实联系电话: includeSensitive
          ? recipient.realPhone || ''
          : maskPhone(recipient.realPhone) || '',
        备注: escapeSpreadsheetFormula(recipient.notes || ''),
      };
    });

    // 创建工作簿
    const worksheet = XLSX.utils.json_to_sheet(excelData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '取机人数据');

    // 设置列宽
    worksheet['!cols'] = [30, 18, 18, 28, 12, 12, 12, 35, 12, 10, 10, 22, 20, 80, 18, 30].map(
      wch => ({ wch })
    );
    for (const [key, cell] of Object.entries(worksheet)) {
      if (!key.startsWith('!') && cell.t === 's') cell.z = '@';
    }

    // 生成Excel文件
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // 设置响应头
    const filename = `取机人数据_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

    logger.info('导出取机人数据', {
      count: recipients.length,
      includeSensitive,
      userId: req.user.id,
      filters: {
        hasStatus: Boolean(status),
        hasTag: Boolean(tag),
        hasKeyword: Boolean(keyword),
        hasAppleIdFilter: Boolean(appleIdFilter),
      },
    });

    res.send(buffer);
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('导出取机人数据失败', { error: error.message });
    throw ApiError.internal('导出取机人数据失败', { reason: error.message });
  }
}

/**
 * POST /api/recipients/bind-apple-ids
 * 批量绑定 Apple ID 到取机人
 * @description 为选中的取机人自动绑定未使用的 Apple ID
 */
async function batchBindAppleIds(req, res) {
  try {
    const values = req.body?.recipientIds;
    if (!Array.isArray(values) || !values.length || values.length > 1000)
      throw ApiError.badRequest('请选择 1–1000 个取机人');
    const ids = [...new Set(values.map(profileId))];
    const result = await sequelize.transaction(async transaction => {
      await lockProfiles(transaction, req.user?.id);
      const recipients = await Recipient.findAll({
        where: { id: ids },
        order: [['id', 'ASC']],
        transaction,
      });
      const [accounts] = await sequelize.query(
        `SELECT a.id FROM apple_ids a WHERE a.status='未使用'
         AND NOT EXISTS (SELECT 1 FROM recipients r WHERE r.apple_id_ref=a.id)
         ORDER BY a.created_at, a.id LIMIT :limit FOR UPDATE`,
        { replacements: { limit: ids.length }, transaction }
      );
      const boundRecipients = [],
        unboundRecipients = [];
      let index = 0;
      for (const row of recipients) {
        if (row.appleIdRef || !accounts[index]) {
          unboundRecipients.push({
            recipientId: row.id,
            reason: row.appleIdRef ? '已有绑定，保持不变' : '无可用账号',
          });
          continue;
        }
        await bindRecipient(row, accounts[index++].id, transaction, null);
        boundRecipients.push({ recipientId: row.id });
      }
      for (const id of ids)
        if (!recipients.some(row => row.id === id))
          unboundRecipients.push({ recipientId: id, reason: '取机人不存在' });
      return {
        requestCount: ids.length,
        availableCount: accounts.length,
        boundCount: boundRecipients.length,
        unboundCount: unboundRecipients.length,
        boundRecipients,
        unboundRecipients,
      };
    });
    res.json({ success: true, data: result });
  } catch (error) {
    logger.warn('基础档案操作未完成', { errorType: error.name });
    throw error;
  }
}

module.exports = {
  listRecipients,
  getRecipientDetail,
  createRecipient,
  updateRecipient,
  deleteRecipient,
  batchGenerateContact,
  batchGenerateAddress,
  exportRecipients,
  batchBindAppleIds,
  updateBinding,
  listBindings,
  generateImportTemplate,
};
