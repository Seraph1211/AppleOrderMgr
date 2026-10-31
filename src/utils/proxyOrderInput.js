const { randomInt } = require('node:crypto');
const ApiError = require('./ApiError');
const { normalizeProxyFee } = require('./proxyFee');
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
const IPHONE_18_PRO_COLOR_ALIASES = {
  红: '勃艮第酒红色',
  红色: '勃艮第酒红色',
  酒红: '勃艮第酒红色',
  酒红色: '勃艮第酒红色',
  勃艮第酒红: '勃艮第酒红色',
  勃艮第酒红色: '勃艮第酒红色',
  黑: '黑色',
  黑色: '黑色',
  银: '银色',
  银色: '银色',
  蓝: '冰川蓝色',
  蓝色: '冰川蓝色',
  冰川蓝: '冰川蓝色',
  冰川蓝色: '冰川蓝色',
};

const PAYMENT_METHODS = Object.freeze({
  微信: 'WECHAT',
  支付宝: 'ALIPAY',
  花呗12期: 'installments0001243254',
  招行12期: 'installments0001321713-2',
  招行24期: 'installments0001321713',
  建行12期: 'installments0000882476-2',
  建行24期: 'installments0000882476',
  工行12期: 'installments0000833448-2',
  工行24期: 'installments0000833448',
});
const PAYMENT_BANK_ALIASES = Object.freeze({
  招行: '招行',
  招商银行: '招行',
  工行: '工行',
  工商银行: '工行',
  建行: '建行',
  建设银行: '建行',
});

/**
 * 只规范已核实支付名称与明确期数，未知或混合要求保留供校验拒绝。
 * @param {string} value 客户支付名称
 * @returns {string} 规范名称或原输入
 */
function normalizeProxyPayment(value) {
  if (typeof value !== 'string') return value;
  const original = value.trim();
  if (/[\r\n]/.test(original) || [...original].some(char => char.charCodeAt(0) < 32))
    return original;
  const normalized = original.normalize('NFKC');
  if (Object.hasOwn(PAYMENT_METHODS, normalized)) return normalized;
  if (/^花呗 *(?:分期 *)?12 *期 *免息$/.test(normalized)) return '花呗12期';
  const match = normalized.match(
    /^(招商银行|招行|工商银行|工行|建设银行|建行) *(?:分期 *)?(12|24) *期$/
  );
  return match ? `${PAYMENT_BANK_ALIASES[match[1]]}${match[2]}期` : original;
}

const STORE_SOFTWARE_NAMES = Object.freeze({
  R448: '北京王府井',
  R572: '郑州万象城',
  R401: '上海环贸 iapm',
  R683: '上海环球港',
  R678: '上海静安',
  R359: '上海南京东路',
  R389: '上海浦东',
  R705: '上海七宝',
  R581: '上海五角场',
  R390: '上海香港广场',
  R574: '无锡恒隆广场',
  R320: '北京三里屯',
  R557: '青岛万象城',
  R576: '沈阳万象城',
  R534: '沈阳中街大悦城',
  R580: '成都太古里',
  R502: '成都万象城',
  R577: '广州天环广场',
  R648: '济南恒隆广场',
  R645: '北京朝阳大悦城',
  R479: '北京华贸购物中心',
  R388: '北京西单大悦城',
  R792: '北京荟聚',
  R571: '南宁万象城',
  R793: '深圳前海壹方城',
  R761: '深圳万象城',
  R484: '深圳益田假日广场',
  R765: '合肥万象城',
  R476: '重庆北城天街',
  R480: '重庆解放碑',
  R573: '重庆万象城',
  R646: '福州泰禾广场',
  R644: '厦门新生活广场',
  R639: '广州珠江新城',
  R575: '武汉',
  R617: '长沙',
  R643: '南京虹悦城',
  R493: '南京新街口',
  R703: '南京玄武湖',
  R688: '苏州',
  R609: '大连恒隆广场',
  R637: '天津大悦城',
  R579: '天津恒隆广场',
  R638: '天津万象城',
  R670: '昆明',
  R532: '杭州万象城',
  R471: '杭州西湖',
  R531: '宁波天一广场',
  R766: '温州万象城',
});
const PRODUCT_CANDIDATES = [];
for (const [productModel, colors, sizes] of [
  ['iPhone 18 Pro Max', ['银色', '勃艮第酒红色', '冰川蓝色', '黑色'], ['256GB', '512GB']],
  ['iPhone 18 Pro Max', ['银色', '勃艮第酒红色'], ['1TB']],
  ['iPhone 18 Pro', ['银色'], ['512GB']],
  ['iPhone Duo', ['星光白色', '夜空色'], ['256GB', '512GB', '1TB', '2TB']],
])
  for (const color of colors)
    for (const storage of sizes)
      PRODUCT_CANDIDATES.push({
        productModel,
        color,
        storage,
        softwareName: `${productModel} ${color} ${storage.replace('GB', 'G').replace('TB', 'T')}`,
      });
function normalizeCandidate(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !['18pm', '18promax', 'iphone18promax', '18pro', 'iphone18pro', 'duo', 'iphoneduo'].includes(
      compact(value.productModel)
    )
  )
    throw ApiError.badRequest('商品型号尚未核实，请核对');
  field(value.color, '颜色');
  if (!/^\d+\s*(?:gb|g|tb|t)$/i.test(norm(value.storage)))
    throw ApiError.badRequest('容量尚未核实，请核对');
  field(value.productModel, '机型');
  field(value.storage, '容量', 20);
  const normalized = normalizeProxyProduct(value.productModel, value.color);
  const storage = parseProduct(`18pm ${value.storage}`).storage;
  const candidate = PRODUCT_CANDIDATES.find(
    p =>
      p.productModel === normalized.productModel &&
      p.color === normalized.color &&
      p.storage === storage
  );
  if (!candidate) throw ApiError.badRequest('商品组合尚未核实，请核对型号、颜色和容量');
  return {
    productModel: candidate.productModel,
    color: candidate.color,
    storage: candidate.storage,
  };
}

/** 只对当前已核实的 iPhone 18 Pro 系列颜色应用别名。 @param {string} value 客户颜色 @param {string} model 规范机型 @returns {string} 颜色 */
function normalizeColor(value, model) {
  const color = norm(value);
  if (/Duo/i.test(model))
    return (
      {
        白: '星光白色',
        白色: '星光白色',
        星光白: '星光白色',
        星光白色: '星光白色',
        黑: '夜空色',
        黑色: '夜空色',
        夜空: '夜空色',
        夜空色: '夜空色',
      }[color] || color
    );
  if (!/^iPhone 18 Pro(?: Max)?$/i.test(model)) return color;
  return IPHONE_18_PRO_COLOR_ALIASES[compact(color)] || color;
}

/** 规范已识别的机型和颜色，其余客户原文保留待人工核对。 @param {string} model 机型 @param {string} color 颜色 @returns {Object} 商品 */
function normalizeProxyProduct(model, color) {
  const normalizedModel = parseProduct(model).productModel || norm(model);
  return { productModel: normalizedModel, color: normalizeColor(color, normalizedModel) };
}

// 仅对明确机型及颜色后紧邻的已核实裸容量补 GB，不将型号或台数作为容量。
function normalizeBareProductCapacity(value) {
  const text = norm(value);
  if (!/(?:iphone\s*)?(?:18\s*(?:pro\s*max|pm|pro)\b|duo\b)/i.test(text)) return text;
  return text.replace(
    /(星光白色?|夜空色?|勃艮第酒红色?|酒红色?|红色?|冰川蓝色?|蓝色?|银色?|黑色?|白色?)\s*(256|512)(?=$|[\s,/|])/g,
    '$1 $2GB'
  );
}

/** 规范化机型、容量与颜色，不猜测未知型号。 @param {string} value 商品文字 @returns {Object} 商品 */
function parseProduct(value) {
  const input = normalizeBareProductCapacity(value).toLowerCase();
  const model = input.match(/(?:iphone\s*)?(\d{1,2})\s*(pro\s*max|pm|pro|plus|air|p)?\b/i);
  const capacity = input.match(/\b(\d+)\s*(gb|g|tb|t)\b/i);
  const quantity = input.match(/(\d+)\s*(台|部|件)/);
  const color = input.match(
    /星光白色?|夜空色?|勃艮第酒红色?|酒红色?|红色?|冰川蓝色?|深蓝色?|蓝色?|银色?|黑色?|白色?|沙漠色?|原色|星宇橙色?|橙色?|绿色?|粉色?|紫色?/
  );
  const suffix = model
    ? { pm: 'Pro Max', promax: 'Pro Max', pro: 'Pro', p: 'Pro', plus: 'Plus', air: 'Air' }[
      compact(model[2])
    ] || ''
    : '';
  return {
    productModel: /\bduo\b/i.test(input)
      ? 'iPhone Duo'
      : model
        ? `iPhone ${model[1]}${suffix ? ` ${suffix}` : ''}`
        : '',
    storage: capacity ? `${capacity[1]}${capacity[2].startsWith('t') ? 'TB' : 'GB'}` : '',
    color: color
      ? normalizeColor(
        color[0],
        /\bduo\b/i.test(input)
          ? 'iPhone Duo'
          : model
            ? `iPhone ${model[1]}${suffix ? ` ${suffix}` : ''}`
            : ''
      )
      : '',
    quantity: quantity ? Number(quantity[1]) : 1,
  };
}

/**
 * 从尾号或合法完整身份证提取后四位，异常不回显证件原值。
 * @param {string} value 证件文本
 * @returns {string} 大写尾号
 */
function extractProxyIdLast4(value) {
  if (typeof value !== 'string') throw ApiError.badRequest('身份证后四位或完整号码必须为文本');
  const card = norm(value).toUpperCase();
  if (/^\d{3}[\dX]$/.test(card)) return card;
  if (/^[1-9]\d{16}[\dX]$/.test(card)) {
    const { validateIdentity } = require('../services/identityInputService');
    if (!validateIdentity('客户', card)) return card.slice(-4);
  } else if (/^[1-9]\d{14}$/.test(card)) {
    const year = 1900 + Number(card.slice(6, 8));
    const month = Number(card.slice(8, 10));
    const day = Number(card.slice(10, 12));
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day &&
      date <= new Date()
    )
      return card.slice(-4);
  }
  throw ApiError.badRequest('身份证须为四位尾号或有效的15/18位完整号码，请核对');
}

/**
 * 严格解析城市范围；只接受已核实城市与明确的全店修饰，不按子串猜测。
 * @param {string} value 城市文本
 * @returns {Array<string>} 有序城市集合
 */
function parseProxyCities(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 200 ||
    [...value].some(char => char.charCodeAt(0) < 32)
  )
    throw ApiError.badRequest('请填写有效取机城市');
  const cities = norm(value)
    .replace(/\s+(?=(?:全部门店|所有门店|全部直营店|全店)$)/, '')
    .replace(/\s*([、,|/])\s*/g, '$1')
    .split(/[、,|/]|\s+/)
    .map(token => {
      const city = token
        .trim()
        .replace(/(?:全部门店|所有门店|全部直营店|全店)$/, '')
        .trim()
        .replace(/市$/, '');
      if (!STORES.some(store => store.city === city))
        throw ApiError.badRequest('取机城市未核实或包含不明确要求，请核对');
      return city;
    });
  if (new Set(cities).size !== cities.length) throw ApiError.badRequest('取机城市重复，请核对');
  return cities;
}

/**
 * 从保存的城市说明或完整已知门店集合派生城市，不扩张门店范围。
 * @param {Object} order 已保存委托
 * @returns {Array<string>} 城市集合，无法确认时为空
 */
function getProxyStoreCities(order) {
  try {
    if (Array.isArray(order.storeCodes) && order.storeCodes.length) {
      const stores = order.storeCodes.map(code => STORES.find(store => store.code === code));
      if (stores.every(Boolean)) return [...new Set(stores.map(store => store.city))];
    }
    return order.storeCity ? parseProxyCities(order.storeCity) : [];
  } catch (_error) {
    return [];
  }
}

function cityStoreCodes(cities) {
  return cities.flatMap(city =>
    STORES.filter(store => store.city === city).map(store => store.code)
  );
}

// 兼容旧“取机城市苹果直营店”字段的省、市、区及已核实门店组合。
function parseLegacyStoreLocation(value) {
  const matches = STORES.filter(store => {
    let remainder = norm(value);
    for (const token of [store.province, `${store.city}市`, store.city, store.district]) {
      if (token) remainder = remainder.replace(token, '');
    }
    remainder = remainder
      .replace(/^省/, '')
      .replace(/^Apple\s*/i, '')
      .trim();
    const name = store.name
      .replace(/^Apple\s*/, '')
      .replace(store.city, '')
      .trim();
    return value.includes(store.city) && compact(remainder) === compact(name);
  });
  return matches.length === 1 ? matches[0] : null;
}

/** 解析一位客户的固定文本，返回待核对草稿而不写库。 @param {string} text 原文 @returns {Object} 草稿 */
function parseProxyText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 10000)
    throw ApiError.badRequest('请粘贴一位客户的信息（最多 10000 字）');
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line
      .trim()
      .replace(/^\d+[、.．)）]\s*/, '')
      .match(/^([^:：]+)[:：]\s*(.*)$/);
    if (match) {
      const key = norm(match[1]);
      if (key === '姓名' && fields[key]) throw ApiError.badRequest('每次只能录入一位客户');
      if (fields[key] != null && fields[key] !== match[2].trim())
        throw ApiError.badRequest('同一字段出现多个值，请先核对');
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
  if (fields['颜色']) product.color = normalizeColor(fields['颜色'], product.productModel);
  if (fields['容量'] || fields['内存'])
    product.storage = parseProduct(`18pm ${fields['容量'] || fields['内存']}`).storage;
  if (fields['数量']) product.quantity = Number(fields['数量'].replace(/\s*(台|部|件)$/, ''));
  const cityText = fields['取机城市'] || fields['取机城市苹果直营店'] || '';
  const storeText = fields['取机门店'] || fields['苹果直营店'] || fields['门店'] || '';
  const errors = [];
  let cities = [];
  let legacyStore;
  try {
    cities = parseProxyCities(cityText);
  } catch (error) {
    legacyStore = fields['取机城市苹果直营店'] && parseLegacyStoreLocation(cityText);
    if (legacyStore) cities = [legacyStore.city];
    else errors.push(error.message);
  }
  const city = cities.join('、');
  if (storeText && /全店|全部门店|所有门店|全部直营店/.test(cityText))
    errors.push('全店与指定门店要求冲突，请核对');
  let idLast4 = '';
  const identityValues = [
    '身份证后四号',
    '身份证后四位',
    '后四位',
    '身份证后4位',
    '身份证',
    '身份证号',
    '身份证号码',
  ]
    .filter(key => fields[key])
    .map(key => fields[key]);
  try {
    const tails = identityValues.map(extractProxyIdLast4);
    if (new Set(tails).size > 1) throw ApiError.badRequest('身份证信息存在冲突，请核对后四位');
    idLast4 = tails[0] || '';
  } catch (error) {
    errors.push(error.message);
  }
  let storeCodes = legacyStore ? [legacyStore.code] : cityStoreCodes(cities);
  if (storeText) {
    storeCodes = [];
    for (const token of storeText.split('|').map(norm)) {
      const matches = STORES.filter(
        s =>
          cities.includes(s.city) &&
          [s.code, s.name, s.name.replace(/^Apple\s*/, ''), STORE_SOFTWARE_NAMES[s.code]].some(
            name => compact(name) === compact(token)
          )
      );
      if (matches.length !== 1) errors.push('门店未明确或与取机城市不符，请核对');
      else if (storeCodes.includes(matches[0].code)) errors.push('取机门店重复，请核对');
      else storeCodes.push(matches[0].code);
    }
  }
  const warnings = [];
  if (idLast4 && identityValues.some(value => norm(value).length > 4))
    warnings.push('完整身份证已校验格式并仅提取后四位，请核对尾号');
  if (!fields['数量'] && !/\d+\s*(台|部|件)/.test(productText))
    warnings.push('未填写数量，已预填 1 台，请核对');
  if (!fields['支付方式']) warnings.push('未填写支付方式，已预填微信');
  const productCandidates = productText.split('|').map(text => {
    const candidate = text === productText ? product : parseProduct(text);
    try {
      const normalizedText = normalizeBareProductCapacity(text);
      if (
        /\d+\s*(台|部|件)/.test(normalizedText) &&
        parseProduct(text).quantity !== product.quantity
      )
        throw ApiError.badRequest('候选数量不一致，请核对统一数量');
      const quantityTokens = normalizedText.match(/\d+\s*(台|部|件)/g) || [];
      if (quantityTokens.length > 1) throw ApiError.badRequest('候选包含多个数量，请核对');
      const modelTokens =
        normalizedText
          .replace(/\d+\s*(台|部|件)/g, '')
          .match(/(?:iphone\s*)?(?:\d{1,2}\s*(?:pro\s*max|pm|pro|plus|air|p)?\b|duo\b)/gi) || [];
      const capacityTokens = normalizedText.match(/\b\d+\s*(?:gb|g|tb|t)\b/gi) || [];
      const colorTokens =
        normalizedText.match(
          /星光白色?|夜空色?|勃艮第酒红色?|酒红色?|红色?|冰川蓝色?|深蓝色?|蓝色?|银色?|黑色?|白色?|沙漠色?|原色|星宇橙色?|橙色?|绿色?|粉色?|紫色?/g
        ) || [];
      if (
        modelTokens.length !== 1 ||
        capacityTokens.length > 1 ||
        colorTokens.length > 1 ||
        /任选|或者?|及|、|与|&|未知|待定/.test(normalizedText)
      )
        throw ApiError.badRequest('候选包含歧义，请使用 | 分隔完整商品');
      let remainder = normalizedText;
      for (const token of [...modelTokens, ...capacityTokens, ...colorTokens])
        remainder = remainder.replace(token, '');
      remainder = remainder
        .replace(/\d+\s*(台|部|件)/g, '')
        .replace(/型号|机型|颜色|内存|容量|数量/g, '');
      if (/[\p{L}\p{N}]/u.test(remainder))
        throw ApiError.badRequest('商品包含未识别要求，请核对后分隔完整候选');
      return normalizeCandidate(candidate);
    } catch (_error) {
      errors.push('商品组合尚未核实，请核对型号、颜色和容量');
      return candidate;
    }
  });
  const draft = {
    lastName,
    firstName,
    phone: fields['手机号'] || fields['手机号码'] || '',
    email: fields['邮箱'] || fields['Email'] || '',
    idLast4,
    ...productCandidates[0],
    productCandidates,
    quantity: product.quantity,
    storeCodes,
    storeMode: storeText || legacyStore ? 'selected' : 'city_any',
    storeCity: city,
    storeCities: cities,
    billing: storeCodes.length ? generateProxyAddress(storeCodes[0]) : null,
    paymentMethod: normalizeProxyPayment(fields['支付方式'] || '微信'),
    orderSource: fields['订单来源'] || '',
    notes: fields['备注'] || '',
    platformOrderNumber: /^\(选填\)$/.test(norm(fields['平台订单号']))
      ? ''
      : fields['平台订单号'] || '',
    rawText: text,
  };
  try {
    validateProxyInput(draft);
  } catch (error) {
    errors.push(error.message);
  }
  return { draft, warnings, errors: [...new Set(errors)], canSave: errors.length === 0 };
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

/** 校验已确认资料，仅返回白名单字段。 @param {Object} input 输入 @param {Object} [options] 历史资料兼容 @returns {Object} 资料 */
function validateProxyInput(input, options = {}) {
  if (!input || typeof input !== 'object') throw ApiError.badRequest('资料格式不正确');
  const result = {};
  result.proxyFee = normalizeProxyFee(input.proxyFee);
  for (const [key, label, max] of [
    ['lastName', '姓', 50],
    ['firstName', '名', 50],
    ['phone', '手机号', 20],
    ['email', '邮箱', 255],
    ['idLast4', '身份证后四位', 18],
    ['productModel', '机型', 100],
    ['color', '颜色', 100],
    ['storage', '容量', 20],
  ])
    result[key] = field(input[key] ?? input.productCandidates?.[0]?.[key], label, max);
  const candidates = input.productCandidates == null ? [result] : input.productCandidates;
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > 19)
    throw ApiError.badRequest('请选择 1–19 个候选商品');
  result.productCandidates = candidates.map(candidate => {
    try {
      return normalizeCandidate(candidate);
    } catch (error) {
      if (
        options.existing &&
        (options.existing.productCandidates || []).some(
          old => JSON.stringify(old) === JSON.stringify(candidate)
        )
      )
        return {
          productModel: field(candidate.productModel, '机型'),
          color: field(candidate.color, '颜色'),
          storage: field(candidate.storage, '容量', 20),
        };
      throw error;
    }
  });
  Object.assign(result, result.productCandidates[0]);
  if (!/^1[3-9]\d{9}$/.test(result.phone)) throw ApiError.badRequest('手机号须为 11 位大陆手机号');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) throw ApiError.badRequest('邮箱格式不正确');
  result.idLast4 = extractProxyIdLast4(result.idLast4);
  result.quantity = input.quantity == null ? 1 : input.quantity;
  if (!Number.isInteger(result.quantity) || result.quantity < 1 || result.quantity > 100)
    throw ApiError.badRequest('数量须为 1–100 的整数');
  if (input.storeMode != null && !['selected', 'city_any'].includes(input.storeMode))
    throw ApiError.badRequest('请选择门店范围');
  result.storeMode = input.storeMode || (input.storeCodes?.length ? 'selected' : 'city_any');
  let cities;
  if (input.storeCities != null) {
    if (
      !Array.isArray(input.storeCities) ||
      !input.storeCities.length ||
      input.storeCities.some(
        city => typeof city !== 'string' || !STORES.some(store => store.city === city)
      )
    )
      throw ApiError.badRequest('请确认有效取机城市集合');
    if (new Set(input.storeCities).size !== input.storeCities.length)
      throw ApiError.badRequest('取机城市重复，请核对');
    cities = [...input.storeCities];
    if (
      input.storeCity &&
      JSON.stringify(parseProxyCities(input.storeCity)) !== JSON.stringify(cities)
    )
      throw ApiError.badRequest('取机城市字段存在冲突，请核对');
  } else if (!input.storeCity && (options.existing || options.allowCityInference)) {
    cities = getProxyStoreCities(input);
    if (!cities.length) throw ApiError.badRequest('请确认有效取机城市');
  } else {
    cities = parseProxyCities(input.storeCity);
  }
  result.storeCity = field(cities.join('、'), '城市', 100);
  result.storeCodes =
    Array.isArray(input.storeCodes) && input.storeCodes.length
      ? [...input.storeCodes]
      : result.storeMode === 'city_any'
        ? cityStoreCodes(cities)
        : input.storeCodes;
  if (
    !Array.isArray(result.storeCodes) ||
    !result.storeCodes.length ||
    result.storeCodes.length > STORES.length ||
    result.storeCodes.some(
      code => !STORES.some(store => store.code === code && cities.includes(store.city))
    ) ||
    cities.some(
      city =>
        !result.storeCodes.some(code =>
          STORES.some(store => store.code === code && store.city === city)
        )
    )
  )
    throw ApiError.badRequest('请确认有效直营店范围');
  if (new Set(result.storeCodes).size !== result.storeCodes.length)
    throw ApiError.badRequest('取机门店重复，请核对');
  if (options.expandCityStores && result.storeMode === 'city_any')
    result.storeCodes = cityStoreCodes(cities);
  const billing = input.billing || generateProxyAddress(result.storeCodes[0]);
  if (!result.storeCodes.includes(billing.referenceStoreCode))
    throw ApiError.badRequest('请选择范围内的账单参考门店并生成地址');
  result.billing = { referenceStoreCode: billing.referenceStoreCode };
  for (const [key, label] of [
    ['province', '省'],
    ['city', '市'],
    ['district', '区'],
    ['streetAddress', '街道地址'],
  ])
    result.billing[key] = field(billing[key], label, 200);
  result.platformOrderNumber =
    field(input.platformOrderNumber || '', '平台订单号', 100, false) || null;
  result.paymentMethod = normalizeProxyPayment(
    field(input.paymentMethod || '微信', '支付要求', 50)
  );
  if (
    !Object.hasOwn(PAYMENT_METHODS, result.paymentMethod) &&
    result.paymentMethod !== options.existing?.paymentMethod
  )
    throw ApiError.badRequest('支付方式没有已核实软件映射');
  result.orderSource =
    options.existing && !options.existing.orderSource && !input.orderSource
      ? null
      : field(input.orderSource, '订单来源', 100);
  if (result.orderSource?.includes('|')) throw ApiError.badRequest('订单来源包含模板分隔符');
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
  const d = validateProxyInput(order, { allowCityInference: true });
  const login = field(account.appleId, '账号', 255);
  const password = field(account.password, '账号密码', 1000);
  const b = d.billing;
  const products = d.productCandidates
    .map(
      c =>
        PRODUCT_CANDIDATES.find(
          p => p.productModel === c.productModel && p.color === c.color && p.storage === c.storage
        ).softwareName
    )
    .join('|');
  const stores = d.storeCodes
    .map(code => {
      if (!STORE_SOFTWARE_NAMES[code]) throw ApiError.badRequest('门店缺少软件映射');
      return STORE_SOFTWARE_NAMES[code];
    })
    .join('|');
  return `${login},${password},${stores},${products},${d.quantity},指定地址,${d.phone},${d.lastName},${d.firstName},,${d.email},${b.province},${b.city},${b.district},,,${b.streetAddress},,,,,,${PAYMENT_METHODS[d.paymentMethod]},0,,,,否##0#7-1-8-9-2-0#0#0#否#否#否#否#否#5000#0#0#否#0#0#0#0#否#否##否##否#,${d.idLast4},代抢 ${d.orderSource},,,`;
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
    const appleId = match[1];
    const accountKey = appleId.toLowerCase();
    const password = field(match[2], `第 ${index + 1} 行密码`, 1000);
    if (seen.has(accountKey)) throw ApiError.badRequest(`第 ${index + 1} 行账号重复`);
    seen.add(accountKey);
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
  const candidates = request.productCandidates?.length ? request.productCandidates : [request];
  return candidates.some(candidate => {
    const desired = parseProduct(
      `${candidate.productModel} ${candidate.storage} ${candidate.color}`
    );
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
  });
}
module.exports = {
  STORES,
  PAYMENT_METHODS,
  normalizeProxyPayment,
  PRODUCT_CANDIDATES,
  STORE_SOFTWARE_NAMES,
  parseProduct,
  normalizeProxyProduct,
  parseProxyText,
  parseProxyCities,
  getProxyStoreCities,
  extractProxyIdLast4,
  validateProxyInput,
  generateProxyAddress,
  buildProxyTemplate,
  parsePoolAccounts,
  isProxyMatch,
};
