/* eslint-disable camelcase */
/**
 * 收件人（取机人）控制器
 * @module controllers/recipientController
 * @description 收件人 CRUD + 分页 + 关键字/标签/Apple ID 过滤
 * @see docs/05-API接口设计方案.md 3.2
 */

const { Op } = require('sequelize');
const { sequelize, Recipient, AppleId, Order } = require('../models');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');
const {
  paginatedResponse,
  parsePositiveInt,
} = require('../utils/apiResponse');
const XLSX = require('xlsx');

const RECIPIENT_STATUSES = ['未使用', '使用中', '已下架', '异常'];

/**
 * 把 Recipient 实例序列化为对外对象
 * @param {Object} recipient - JSON 形态的 Recipient
 * @param {Object} stats - 统计数据 { orderCount, totalAmount, lastOrderDate }
 * @returns {Object} 对外对象
 */
function serializeRecipient(recipient, stats = {}) {
  return {
    id: recipient.id,
    name: `${recipient.lastName || ''}${recipient.firstName || ''}`,
    last_name: recipient.lastName,
    first_name: recipient.firstName,
    id_card_number: recipient.idCardNumber,
    id_card_last4: recipient.idCardLast4,
    phone: recipient.phone,
    email: recipient.email,
    apple_id: recipient.appleId,
    apple_id_ref: recipient.appleIdRef,
    province: recipient.province,
    city: recipient.city,
    district: recipient.district,
    street_address: recipient.streetAddress,
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
    attributes: [
      'recipientRef',
      [sequelize.fn('COUNT', sequelize.col('id')), 'orderCount'],
    ],
    where: {
      recipientRef: { [Op.in]: recipientIds },
    },
    group: ['recipientRef'],
    raw: true,
  });

  const statsMap = {};
  results.forEach((row) => {
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
  rows.forEach((r) => {
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
    if (req.query.tag) {
      where.tag = req.query.tag;
    }
    if (req.query.status) {
      if (!RECIPIENT_STATUSES.includes(req.query.status)) {
        throw ApiError.badRequest(
          `status 非法，可选值: ${RECIPIENT_STATUSES.join(', ')}`,
          { received: req.query.status },
        );
      }
      where.status = req.query.status;
    }
    if (req.query.apple_id_ref) {
      const ref = parseInt(req.query.apple_id_ref, 10);
      if (Number.isNaN(ref) || ref <= 0) {
        throw ApiError.badRequest('apple_id_ref 必须是正整数', { received: req.query.apple_id_ref });
      }
      where.appleIdRef = ref;
    }
    if (req.query.keyword) {
      const kw = String(req.query.keyword).trim();
      if (kw.length > 0) {
        where[Op.or] = [
          { lastName: { [Op.iLike]: `%${kw}%` } },
          { firstName: { [Op.iLike]: `%${kw}%` } },
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

    const orderStats = await getOrderStatsByRecipients(rows.map((r) => r.id));

    res.json(paginatedResponse(
      rows.map((r) => serializeRecipient(r.toJSON(), orderStats[r.id] || {})),
      count,
      page,
      limit,
      'recipients',
    ));
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
    res.json({
      success: true,
      data: serializeRecipient(recipient.toJSON(), orderCounts[id] || 0),
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
    if (!payload.lastName || !payload.firstName) {
      throw ApiError.badRequest('lastName 与 firstName 必填');
    }
    if (!payload.idCardNumber || !/^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/.test(payload.idCardNumber)) {
      throw ApiError.badRequest('idCardNumber 格式无效（必须 18 位身份证号）');
    }
    if (payload.status && !RECIPIENT_STATUSES.includes(payload.status)) {
      throw ApiError.badRequest(
        `status 非法，可选值: ${RECIPIENT_STATUSES.join(', ')}`,
        { received: payload.status },
      );
    }
    if (payload.appleIdRef) {
      const ref = parseInt(payload.appleIdRef, 10);
      if (Number.isNaN(ref) || ref <= 0) {
        throw ApiError.badRequest('appleIdRef 必须是正整数', { received: payload.appleIdRef });
      }
      const exists = await AppleId.findByPk(ref);
      if (!exists) {
        throw ApiError.badRequest('关联的 Apple ID 不存在', { appleIdRef: ref });
      }
    }

    const created = await Recipient.create({
      lastName: payload.lastName,
      firstName: payload.firstName,
      idCardNumber: payload.idCardNumber,
      phone: payload.phone || null,
      email: payload.email || null,
      province: payload.province || null,
      city: payload.city || null,
      district: payload.district || null,
      streetAddress: payload.streetAddress || null,
      appleId: payload.appleId || null,
      password: payload.password || null,
      appleIdRef: payload.appleIdRef ? parseInt(payload.appleIdRef, 10) : null,
      tag: payload.tag || null,
      status: payload.status || 'active',
      notes: payload.notes || null,
    });

    logger.info('收件人创建成功', { id: created.id, name: `${created.lastName}${created.firstName}` });

    res.status(201).json({
      success: true,
      data: serializeRecipient(created.toJSON(), 0),
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (error.name === 'SequelizeUniqueConstraintError') {
      throw ApiError.conflict('该身份证号已存在');
    }
    logger.error('创建收件人失败', { error: error.message });
    throw ApiError.database('创建收件人失败', { reason: error.message });
  }
}

/**
 * PUT /api/recipients/:id
 */
async function updateRecipient(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || id <= 0) {
      throw ApiError.badRequest('收件人 ID 必须是正整数', { received: req.params.id });
    }

    const recipient = await Recipient.findByPk(id);
    if (!recipient) {
      throw ApiError.notFound('收件人不存在', { id });
    }

    const payload = req.body || {};
    const allowed = [
      'lastName', 'firstName', 'idCardNumber', 'phone', 'email',
      'province', 'city', 'district', 'streetAddress',
      'appleId', 'password', 'appleIdRef', 'tag', 'status', 'notes',
    ];
    const updates = {};
    for (const key of allowed) {
      if (payload[key] !== undefined) {
        updates[key] = payload[key];
      }
    }

    if (updates.status !== undefined && !RECIPIENT_STATUSES.includes(updates.status)) {
      throw ApiError.badRequest(
        `status 非法，可选值: ${RECIPIENT_STATUSES.join(', ')}`,
        { received: updates.status },
      );
    }
    if (updates.idCardNumber !== undefined
      && !/^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/.test(updates.idCardNumber)) {
      throw ApiError.badRequest('idCardNumber 格式无效（必须 18 位身份证号）');
    }
    if (updates.appleIdRef !== undefined && updates.appleIdRef !== null) {
      const ref = parseInt(updates.appleIdRef, 10);
      if (Number.isNaN(ref) || ref <= 0) {
        throw ApiError.badRequest('appleIdRef 必须是正整数', { received: updates.appleIdRef });
      }
      const exists = await AppleId.findByPk(ref);
      if (!exists) {
        throw ApiError.badRequest('关联的 Apple ID 不存在', { appleIdRef: ref });
      }
      updates.appleIdRef = ref;
    }

    await recipient.update(updates);

    logger.info('收件人更新成功', { id, fields: Object.keys(updates) });

    res.json({
      success: true,
      data: serializeRecipient(recipient.toJSON()),
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (error.name === 'SequelizeUniqueConstraintError') {
      throw ApiError.conflict('该身份证号已存在');
    }
    logger.error('更新收件人失败', { id: req.params.id, error: error.message });
    throw ApiError.database('更新收件人失败', { reason: error.message });
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

    await recipient.destroy();

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
 * 生成随机11位电话号码
 * @returns {string} 随机11位手机号
 */
function generatePhone() {
  // 中国移动：134-139, 147, 150-152, 157-159, 178, 182-184, 187-188, 198
  // 中国联通：130-132, 145, 155-156, 166, 175-176, 185-186
  // 中国电信：133, 149, 153, 173, 177, 180-181, 189, 191, 199
  const prefixes = [
    '134', '135', '136', '137', '138', '139', '147', '150', '151', '152',
    '157', '158', '159', '178', '182', '183', '184', '187', '188', '198',
    '130', '131', '132', '145', '155', '156', '166', '175', '176', '185', '186',
    '133', '149', '153', '173', '177', '180', '181', '189', '191', '199'
  ];

  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const suffix = Math.floor(10000000 + Math.random() * 90000000).toString();
  return prefix + suffix;
}

/**
 * POST /api/recipients/batch-generate-contact
 * 批量生成取机人的电话和邮箱
 */
async function batchGenerateContact(req, res) {
  const transaction = await sequelize.transaction();

  try {
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

    // 批量更新
    let updated = 0;
    for (const recipient of recipients) {
      const updates = {};

      // 先生成电话号码（如果需要）
      let phone = recipient.phone;
      if (!phone) {
        phone = generatePhone();
        updates.phone = phone;
      }

      // 使用电话号码生成邮箱（如果需要）
      if (!recipient.email) {
        updates.email = `${phone}@8lvv.com`;
      }

      if (Object.keys(updates).length > 0) {
        await recipient.update(updates, { transaction });
        updated++;
        logger.info('生成取机人联系方式', {
          id: recipient.id,
          name: `${recipient.lastName}${recipient.firstName}`,
          updates
        });
      }
    }

    await transaction.commit();

    res.json({
      success: true,
      message: `成功生成 ${updated} 个取机人的联系方式`,
      data: {
        total: ids.length,
        found: recipients.length,
        updated,
        skipped: recipients.length - updated,
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
  const streetSuffixes = ['街', '路', '巷', '弄', '里', '村', '大道', '小区', '花园', '公寓', '广场'];
  const streetNames = ['建设', '人民', '中山', '解放', '和平', '新华', '光明', '胜利', '红旗', '友谊', '文化', '民主', '团结', '幸福', '安康'];

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
        name: `${recipient.lastName}${recipient.firstName}`,
        address: `${province} ${city} ${district} ${updates.streetAddress}`
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
    tag = ''
  } = recipient;

  const appleId = appleIdData?.appleId || '';
  const password = appleIdData?.password || '';

  // Excel公式格式：A2,B2,,,1,指定地址,C2,I2,J2,,D2,E2,F2,G2,,,H2,,,,,,WECHAT,0,,,,否##0#7-1-8-9-2-0#0#0#否#否#否#否#否#5000#0#0#否#0#0#0#0#否#否##否##否#,K2,L2,,,
  const fixedPart = 'WECHAT,0,,,,否##0#7-1-8-9-2-0#0#0#否#否#否#否#否#5000#0#0#否#0#0#0#0#否#否##否##否#';

  return `${appleId},${password},,,1,指定地址,${phone},${lastName},${firstName},,${email},${province},${city},${district},,,${streetAddress},,,,,,${fixedPart},${idCardNumber},${tag},,,`;
}

/**
 * GET /api/recipients/export
 * 导出取机人数据为Excel
 */
async function exportRecipients(req, res) {
  try {
    const {
      status,
      tag,
      keyword,
      apple_id: appleIdFilter,
      ids,
    } = req.query;

    // 构建查询条件
    const where = {};

    // 如果提供了ID列表，优先使用ID过滤（只导出选中的）
    if (ids) {
      const idArray = ids.split(',').map(id => parseInt(id, 10)).filter(id => !isNaN(id));
      if (idArray.length > 0) {
        where.id = { [Op.in]: idArray };
      }
    } else {
      // 未提供ID列表时，使用其他过滤条件
      if (status && RECIPIENT_STATUSES.includes(status)) {
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
          { idCardNumber: { [Op.like]: `%${keyword}%` } },
        ];
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
    const excelData = recipients.map(recipient => {
      const appleIdData = recipient.appleAccount;

      return {
        'Apple ID': appleIdData?.appleId || '',
        '密码': appleIdData?.password || '',
        '下单手机号码': recipient.phone || '',
        'Email': recipient.email || '',
        '省': recipient.province || '',
        '市': recipient.city || '',
        '区': recipient.district || '',
        '街道地址': recipient.streetAddress || '',
        '姓': recipient.lastName || '',
        '名': recipient.firstName || '',
        '身份证号码': recipient.idCardNumber || '',
        'TAG': recipient.tag || '',
        '信息导入模版': generateImportTemplate(
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
        ),
      };
    });

    // 创建工作簿
    const worksheet = XLSX.utils.json_to_sheet(excelData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '取机人数据');

    // 设置列宽
    worksheet['!cols'] = [
      { wch: 30 }, // Apple ID
      { wch: 15 }, // 密码
      { wch: 15 }, // 下单手机号码
      { wch: 25 }, // Email
      { wch: 10 }, // 省
      { wch: 10 }, // 市
      { wch: 10 }, // 区
      { wch: 30 }, // 街道地址
      { wch: 8 },  // 姓
      { wch: 8 },  // 名
      { wch: 20 }, // 身份证号码
      { wch: 15 }, // TAG
      { wch: 150 }, // 信息导入模版
    ];

    // 生成Excel文件
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // 设置响应头
    const filename = `取机人数据_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

    logger.info('导出取机人数据', {
      count: recipients.length,
      filters: { status, tag, keyword, appleIdFilter },
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
  const transaction = await sequelize.transaction();

  try {
    const { recipientIds } = req.body;

    // 验证输入
    if (!Array.isArray(recipientIds) || recipientIds.length === 0) {
      throw ApiError.badRequest('recipientIds 必须是非空数组');
    }

    // 验证所有ID是否有效
    const validIds = recipientIds.filter(id => {
      const parsed = parseInt(id, 10);
      return !Number.isNaN(parsed) && parsed > 0;
    });

    if (validIds.length === 0) {
      throw ApiError.badRequest('没有有效的取机人ID');
    }

    // 查询选中的取机人
    const recipients = await Recipient.findAll({
      where: { id: validIds },
      transaction,
    });

    if (recipients.length === 0) {
      throw ApiError.notFound('未找到任何取机人');
    }

    // 查询未使用的 Apple ID（按创建时间升序，先创建的先分配）
    const availableAppleIds = await AppleId.findAll({
      where: { status: '未使用' },
      order: [['createdAt', 'ASC']],
      limit: recipients.length,
      transaction,
    });

    const availableCount = availableAppleIds.length;
    const requestCount = recipients.length;

    // 执行绑定
    const boundRecipients = [];
    const unboundRecipients = [];

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];

      if (i < availableAppleIds.length) {
        const appleId = availableAppleIds[i];

        // 更新取机人：绑定 Apple ID
        await recipient.update({
          appleIdRef: appleId.id,
          appleId: appleId.appleId,
          password: appleId.password,
        }, { transaction });

        // 更新 Apple ID：状态改为使用中
        await appleId.update({
          status: '使用中',
        }, { transaction });

        boundRecipients.push({
          recipientId: recipient.id,
          recipientName: `${recipient.lastName}${recipient.firstName}`,
          appleId: appleId.appleId,
        });

        logger.info('绑定 Apple ID 成功', {
          recipientId: recipient.id,
          recipientName: `${recipient.lastName}${recipient.firstName}`,
          appleIdId: appleId.id,
          appleId: appleId.appleId,
        });
      } else {
        // 超出可用数量
        unboundRecipients.push({
          recipientId: recipient.id,
          recipientName: `${recipient.lastName}${recipient.firstName}`,
          reason: '没有可用的 Apple ID',
        });
      }
    }

    await transaction.commit();

    logger.info('批量绑定 Apple ID 完成', {
      requestCount,
      availableCount,
      boundCount: boundRecipients.length,
      unboundCount: unboundRecipients.length,
    });

    res.json({
      success: true,
      message: `成功绑定 ${boundRecipients.length} 个取机人，${unboundRecipients.length} 个取机人因库存不足未绑定`,
      data: {
        requestCount,
        availableCount,
        boundCount: boundRecipients.length,
        unboundCount: unboundRecipients.length,
        boundRecipients,
        unboundRecipients,
      },
    });
  } catch (error) {
    await transaction.rollback();

    if (error instanceof ApiError) {
      throw error;
    }

    logger.error('批量绑定 Apple ID 失败', { error: error.message, stack: error.stack });
    throw ApiError.database('批量绑定 Apple ID 失败', { reason: error.message });
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
};
