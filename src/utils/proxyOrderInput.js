const { randomInt } = require('node:crypto');
const ApiError = require('./ApiError');
const STORES = require('../config/proxyStores.json');
const COMPOUND_NAMES = [
  '欧阳',
  '司马',
  '上官',
  '诸葛',
  '东方',
  '皇甫',
  '尉迟',
  '公孙',
  '慕容',
  '司徒',
  '司空',
  '令狐',
  '长孙',
  '宇文',
  '夏侯',
];
const norm = value =>
  String(value || '')
    .normalize('NFKC')
    .trim();
const compact = value => norm(value).replace(/\s/g, '').toLowerCase();

/** 规范化机型、容量与颜色，不猜测未知型号。 @param {string} value 商品文字 @returns {Object} 商品 */
function parseProduct(value) {
  const input = norm(value).toLowerCase();
  const model = input.match(/(?:iphone\s*)?(\d{1,2})\s*(pro\s*max|pm|pro|plus|air|p)?\b/i);
  const capacity = input.match(/\b(\d+)\s*(gb|g|tb|t)\b/i);
  const quantity = input.match(/(\d+)\s*(台|部|件)/);
  const color = input.match(
    /勃艮第酒红色|酒红色?|银色?|冰川蓝色?|黑色?|深蓝色?|白色?|沙漠色?|原色|蓝色?|橙色?|星宇橙色?|绿色?|粉色?|紫色?/
  );
  const suffix = model
    ? { pm: 'Pro Max', promax: 'Pro Max', pro: 'Pro', p: 'Pro', plus: 'Plus', air: 'Air' }[
      compact(model[2])
    ] || ''
    : '';
  return {
    productModel: model ? `iPhone ${model[1]}${suffix ? ` ${suffix}` : ''}` : '',
    storage: capacity ? `${capacity[1]}${capacity[2].startsWith('t') ? 'TB' : 'GB'}` : '',
    color: color
      ? { 酒红: '酒红色', 银: '银色', 勃艮第酒红色: '酒红色' }[color[0]] || color[0]
      : '',
    quantity: quantity ? Number(quantity[1]) : 1,
  };
}

/** 解析一位客户的固定文本，返回待核对草稿而不写库。 @param {string} text 原文 @returns {Object} 草稿 */
function parseProxyText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 10000)
    throw ApiError.badRequest('请粘贴一位客户的信息（最多 10000 字）');
  const fields = {};
  for (const line of text.normalize('NFKC').split(/\r?\n/)) {
    const match = line
      .trim()
      .replace(/^\d+[、.．)）]\s*/, '')
      .match(/^([^:：]+)[:：]\s*(.*)$/);
    if (match) {
      const key = match[1].trim();
      if (key === '姓名' && fields[key]) throw ApiError.badRequest('每次只能录入一位客户');
      fields[key] = match[2].trim();
    }
  }
  const name = fields['姓名'] || '';
  const parts = name.split(/\s+/).filter(Boolean);
  const surname = COMPOUND_NAMES.find(s => name.startsWith(s));
  const lastName = parts.length > 1 ? parts[0] : surname || name.slice(0, 1);
  const firstName = parts.length > 1 ? parts.slice(1).join('') : name.slice(lastName.length);
  const productText = fields['机型'] || fields['型号'] || '';
  const product = parseProduct(productText);
  if (fields['颜色']) product.color = fields['颜色'];
  if (fields['容量'] || fields['内存'])
    product.storage = parseProduct(`18pm ${fields['容量'] || fields['内存']}`).storage;
  if (fields['数量']) product.quantity = Number(fields['数量'].replace(/\s*(台|部|件)$/, ''));
  const place = [
    fields['取机城市苹果直营店'],
    fields['取机城市'],
    fields['苹果直营店'],
    fields['门店'],
  ]
    .filter(Boolean)
    .join(' ');
  const cities = [...new Set(STORES.filter(s => place.includes(s.city)).map(s => s.city))];
  const candidates = STORES.filter(
    s =>
      (!cities.length || cities.includes(s.city)) &&
      (place.includes(s.code) ||
        place.includes(s.name.replace(/^Apple\s*/, '')) ||
        (cities.includes(s.city) &&
          place.includes(s.name.replace(/^Apple\s*/, '').replace(s.city, ''))))
  );
  const warnings = ['请核对姓名拆分、商品及门店范围；特殊颜色/门店要求请填写备注'];
  if (!fields['数量'] && !/\d+\s*(台|部|件)/.test(productText))
    warnings.push('未填写数量，已预填 1 台，请核对');
  if (!candidates.length) warnings.push('门店未唯一确定，请选定门店或明确选择城市内任意门店');
  if (!parts[1] || surname) warnings.push('姓名已尝试拆分为姓和名，请确认复姓或少数民族姓名');
  return {
    draft: {
      lastName,
      firstName,
      phone: fields['手机号'] || fields['手机号码'] || '',
      email: fields['邮箱'] || fields['Email'] || '',
      idLast4: fields['身份证后四号'] || fields['身份证后四位'] || '',
      ...product,
      storeCodes: candidates.map(s => s.code),
      storeMode: 'selected',
      storeCity: cities.length === 1 ? cities[0] : '',
      paymentMethod: fields['支付方式'] || '',
      notes: fields['备注'] || '',
      platformOrderNumber: /^\(选填\)$/.test(fields['平台订单号'] || '')
        ? ''
        : fields['平台订单号'] || '',
      rawText: text,
    },
    warnings,
  };
}

function field(value, label, max = 100, required = true) {
  if (typeof value !== 'string') {
    if (!required && value == null) return '';
    throw ApiError.badRequest(`${label}必须为文本`);
  }
  const result = value.trim();
  if (
    (required && !result) ||
    result.length > max ||
    /[,\r\n]/.test(result) ||
    [...result].some(c => c.charCodeAt(0) < 32)
  )
    throw ApiError.badRequest(`${label}为空、过长或包含模板分隔符`);
  return result;
}

/** 校验已确认资料，仅返回白名单字段。 @param {Object} input 输入 @returns {Object} 资料 */
function validateProxyInput(input) {
  if (!input || typeof input !== 'object') throw ApiError.badRequest('资料格式不正确');
  const result = {};
  for (const [key, label, max] of [
    ['lastName', '姓', 50],
    ['firstName', '名', 50],
    ['phone', '手机号', 20],
    ['email', '邮箱', 255],
    ['idLast4', '身份证后四位', 4],
    ['productModel', '机型', 100],
    ['color', '颜色', 100],
    ['storage', '容量', 20],
  ])
    result[key] = field(input[key], label, max);
  if (!/^1[3-9]\d{9}$/.test(result.phone)) throw ApiError.badRequest('手机号须为 11 位大陆手机号');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) throw ApiError.badRequest('邮箱格式不正确');
  if (!/^\d{3}[\dXx]$/.test(result.idLast4))
    throw ApiError.badRequest('身份证后四位必须为四位文本');
  result.idLast4 = result.idLast4.toUpperCase();
  result.quantity = input.quantity;
  if (!Number.isInteger(result.quantity) || result.quantity < 1 || result.quantity > 100)
    throw ApiError.badRequest('数量须为 1–100 的整数');
  if (!['selected', 'city_any'].includes(input.storeMode))
    throw ApiError.badRequest('请选择门店范围');
  result.storeMode = input.storeMode;
  result.storeCity = field(input.storeCity || '', '城市', 100, false);
  result.storeCodes =
    input.storeMode === 'city_any'
      ? STORES.filter(s => s.city === result.storeCity).map(s => s.code)
      : input.storeCodes;
  if (
    !Array.isArray(result.storeCodes) ||
    !result.storeCodes.length ||
    result.storeCodes.length > STORES.length ||
    result.storeCodes.some(code => !STORES.some(s => s.code === code))
  )
    throw ApiError.badRequest('请确认有效直营店范围');
  result.storeCodes = [...new Set(result.storeCodes)];
  if (!input.billing || !result.storeCodes.includes(input.billing.referenceStoreCode))
    throw ApiError.badRequest('请选择范围内的账单参考门店并生成地址');
  result.billing = { referenceStoreCode: input.billing.referenceStoreCode };
  for (const [key, label] of [
    ['province', '省'],
    ['city', '市'],
    ['district', '区'],
    ['streetAddress', '街道地址'],
  ])
    result.billing[key] = field(input.billing[key], label, 200);
  result.platformOrderNumber =
    field(input.platformOrderNumber || '', '平台订单号', 100, false) || null;
  result.paymentMethod = field(input.paymentMethod || '', '支付要求', 50, false);
  for (const key of ['notes', 'rawText']) {
    if (input[key] != null && (typeof input[key] !== 'string' || input[key].length > 10000))
      throw ApiError.badRequest('原文或备注过长');
    result[key] = input[key] || '';
  }
  return result;
}

/** 根据已核实门店生成可编辑账单地址。 @param {string} code 门店 @returns {Object} 地址 */
function generateProxyAddress(code) {
  const store = STORES.find(s => s.code === code);
  if (!store) throw ApiError.badRequest('门店不存在');
  return {
    referenceStoreCode: code,
    province: store.province || '',
    city: store.city,
    district: store.district || '',
    streetAddress: `建设路${randomInt(1, 999)}号${randomInt(1, 30)}栋${randomInt(101, 2509)}室`,
  };
}

/** 按已核对原公式生成一行软件导入模板。 @param {Object} order 委托 @param {Object} account 账号 @returns {string} 模板 */
function buildProxyTemplate(order, account) {
  const d = validateProxyInput(order);
  const login = field(account.appleId, '账号', 255);
  const password = field(account.password, '账号密码', 1000);
  const b = d.billing;
  return `${login},${password},,,1,指定地址,${d.phone},${d.lastName},${d.firstName},,${d.email},${b.province},${b.city},${b.district},,,${b.streetAddress},,,,,,WECHAT,0,,,,否##0#7-1-8-9-2-0#0#0#否#否#否#否#否#5000#0#0#否#0#0#0#0#否#否##否##否#,${d.idLast4},代抢 网店,,,`;
}

/** 校验粘贴的账号密码列表，不回显密码。 @param {string} text 原文 @returns {Array} 账号 */
function parsePoolAccounts(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 200000)
    throw ApiError.badRequest('请输入账号密码，每行一组（最多 500 组）');
  const rows = text
    .trim()
    .split(/\r?\n/)
    .filter(s => s.trim());
  if (rows.length > 500) throw ApiError.badRequest('每次最多导入 500 个账号');
  const seen = new Set();
  return rows.map((line, index) => {
    const match = line.trim().match(/^([^\s,]+?)(?:\s*----\s*|\s+|,)(.+)$/);
    if (!match || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(match[1]))
      throw ApiError.badRequest(`第 ${index + 1} 行账号格式不正确`);
    const appleId = match[1].toLowerCase();
    const password = field(match[2], `第 ${index + 1} 行密码`, 1000);
    if (seen.has(appleId)) throw ApiError.badRequest(`第 ${index + 1} 行账号重复`);
    seen.add(appleId);
    return { appleId, password };
  });
}

/** 是否唯一证据充分的候选；未付款仍成功，未知来源时间不匹配。 @param {Object} request 委托 @param {Object} order 官方订单 @param {Array} assignments 账号历史 @returns {boolean} 匹配 */
function isProxyMatch(request, order, assignments) {
  const time = order.orderDate && new Date(order.orderDate).getTime();
  if (!time || request.rejectedOrderIds?.includes(order.id)) return false;
  if (
    order.createdAt &&
    request.createdAt &&
    new Date(order.createdAt) < new Date(request.createdAt)
  )
    return false;
  const account = assignments.find(
    a =>
      compact(a.accountEmail) === compact(order.appleId) &&
      time >= new Date(a.startedAt).getTime() &&
      (!a.endedAt || time < new Date(a.endedAt).getTime())
  );
  if (!account || !request.storeCodes.includes(order.pickupStoreCode)) return false;
  if (
    compact(order.recipientName) !== compact(request.lastName + request.firstName) ||
    norm(order.recipientPhone) !== request.phone ||
    norm(order.recipientIdLast4).toUpperCase() !== request.idLast4
  )
    return false;
  for (const email of [order.sourceContactEmail, order.recipientEmail].filter(Boolean))
    if (compact(email) !== compact(request.email)) return false;
  const desired = parseProduct(`${request.productModel} ${request.storage} ${request.color}`);
  if (!desired.productModel || !desired.color || !desired.storage) return false;
  return (order.products || []).some(p => {
    const actual = parseProduct(p.name);
    return (
      compact(actual.productModel) === compact(desired.productModel) &&
      compact(actual.storage) === compact(desired.storage) &&
      compact(actual.color) === compact(desired.color) &&
      p.quantity >= request.quantity
    );
  });
}
module.exports = {
  STORES,
  parseProduct,
  parseProxyText,
  validateProxyInput,
  generateProxyAddress,
  buildProxyTemplate,
  parsePoolAccounts,
  isProxyMatch,
};
