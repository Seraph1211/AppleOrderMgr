/** 四类库存表格的有限解析、加密预览、原子提交及权限一致的导出。 */
const crypto = require('crypto');
const { TextDecoder } = require('util');
const { inflateRawSync } = require('zlib');
const { Op } = require('sequelize');
const XLSX = require('xlsx');
const models = require('../models');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { encryptJson, decryptJson } = require('../utils/fieldEncryption');
const { normalizeDeviceBarcodes } = require('./pickupDeviceRules');
const {
  createReadContext,
  requirePermissions,
  assertVersion,
  runCommand,
  recordEvent,
  updateRow,
} = require('./stockCommandService');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 500;
const MAX_COLUMNS = 64;
const MAX_EXPORT_ROWS = 5000;
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KIND_PERMISSIONS = {
  opening: ['stock.receive'],
  ['historical_sales']: ['stock.sales.read', 'stock.sales.ship'],
  collections: ['stock.collections.read', 'stock.collections.edit'],
  receipts: ['stock.receipts.read', 'stock.receipts.edit'],
};
const LABELS = {
  serialNumber: 'SN',
  productId: '商品ID',
  modelName: '型号',
  storageGb: '容量GB',
  colorName: '颜色',
  locationId: '位置ID',
  locationName: '仓库或代卖位置',
  acquiredOn: '拿货日期',
  receivedAt: '收货或款项时间',
  costAmount: '官网成本',
  costBasis: '成本依据',
  sourceOrderId: '来源订单ID',
  saleKey: '历史销售分组键',
  channel: '销售渠道',
  customerId: '客户ID',
  customerName: '客户名称',
  salespersonId: '销售负责人ID',
  salespersonName: '销售负责人',
  handlerId: '交货人ID',
  handlerName: '交货人',
  consigneeLocationId: '代卖位置ID',
  consigneeLocationName: '代卖位置',
  fromLocationId: '原出货位置ID',
  fromLocationName: '原出货位置',
  shippedAt: '实际出货时间',
  saleAmount: '单台售价',
  saleId: '销售单ID',
  saleNo: '销售单号',
  destination: '客户付款去向',
  collectorId: '代收人ID',
  collectorName: '代收人',
  amount: '款项总额',
  payerId: '转款人ID',
  payerName: '转款人',
  externalRecordKey: '外部记录键',
  allocationSerialNumber: '分配到SN',
  allocationAmount: '本台分配金额',
  notes: '备注',
};
const PRODUCT_FIELDS = ['productId', 'modelName', 'storageGb', 'colorName'];
const UNIT_FIELDS = [
  'serialNumber',
  ...PRODUCT_FIELDS,
  'acquiredOn',
  'costAmount',
  'costBasis',
  'sourceOrderId',
];
const KIND_FIELDS = {
  opening: [...UNIT_FIELDS, 'locationId', 'locationName', 'receivedAt'],
  ['historical_sales']: [
    'saleKey',
    ...UNIT_FIELDS,
    'channel',
    'customerId',
    'customerName',
    'salespersonId',
    'salespersonName',
    'handlerId',
    'handlerName',
    'consigneeLocationId',
    'consigneeLocationName',
    'fromLocationId',
    'fromLocationName',
    'shippedAt',
    'saleAmount',
    'notes',
  ],
  collections: [
    'externalRecordKey',
    'saleId',
    'saleNo',
    'destination',
    'collectorId',
    'collectorName',
    'amount',
    'receivedAt',
    'notes',
  ],
  receipts: [
    'externalRecordKey',
    'payerId',
    'payerName',
    'amount',
    'receivedAt',
    'saleId',
    'saleNo',
    'allocationSerialNumber',
    'allocationAmount',
    'notes',
  ],
};
const COST_FIELDS = new Set(['costAmount', 'costBasis']);

function digest(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest('hex');
}

function assertKind(kind) {
  if (!Object.hasOwn(KIND_FIELDS, kind)) throw ApiError.badRequest('导入类型无效');
}

function textValue(value, field, max = 2000) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!['string', 'number'].includes(typeof value))
    throw ApiError.badRequest(`${LABELS[field] || field}格式无效`);
  const text = String(value).trim();
  if (text.length > max || text.includes('\u0000'))
    throw ApiError.badRequest(`${LABELS[field] || field}超长或含无效字符`);
  return text || undefined;
}

function optionalId(value, field) {
  const text = textValue(value, field);
  if (text === undefined) return undefined;
  if (!UUID_PATTERN.test(text)) throw ApiError.badRequest(`${LABELS[field] || field}必须是UUID`);
  return text.toLowerCase();
}

function moneyValue(value, field) {
  const text = textValue(value, field);
  if (text === undefined) return undefined;
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(text))
    throw new ApiError(400, 'MONEY_INVALID', `${LABELS[field]}须为正金额，最多两位小数`);
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n) throw new ApiError(400, 'MONEY_INVALID', `${LABELS[field]}必须大于0`);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

function dateValue(value, field, dayOnly = false) {
  const text = textValue(value, field);
  if (text === undefined) return undefined;
  const pattern = dayOnly
    ? /^\d{4}-\d{2}-\d{2}$/
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!pattern.test(text) || !Number.isFinite(Date.parse(text)))
    throw new ApiError(
      400,
      'DATE_INVALID',
      `${LABELS[field]}请填写${dayOnly ? 'YYYY-MM-DD' : '含时区的ISO时间，例如2026-10-04T15:30:00+08:00'}`
    );
  const calendarDay = text.slice(0, 10);
  if (new Date(`${calendarDay}T00:00:00Z`).toISOString().slice(0, 10) !== calendarDay)
    throw new ApiError(400, 'DATE_INVALID', `${LABELS[field]}日期无效`);
  return dayOnly ? text : new Date(text).toISOString();
}

/** 金融来源键只在同一来源内去重，不根据金额、时间或文件行号推测。 */
function financialExternalKey(sourceLabel, rawKey) {
  const source = textValue(
    textValue(sourceLabel, 'sourceLabel', 100)?.normalize('NFKC').trim(),
    'sourceLabel',
    100
  );
  const key = textValue(rawKey, 'externalRecordKey', 100);
  if (!source || !key) throw ApiError.badRequest('资金导入必须填写来源名称及稳定的外部记录键');
  return digest(`${source}\u0000${key}`);
}

/** 导出用户文本固定为文本单元格，并中和 Excel/CSV 的公式起始字符。 */
function safeSpreadsheetText(value) {
  const text = value == null ? '' : String(value);
  return /^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text) ? `'${text}` : text;
}

/** ZIP逐项受限解压校验，不能相信攻击者在目录中自报的展开大小。 */
function validateXlsxArchive(buffer) {
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw ApiError.badRequest('XLSX 文件内容无效');
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw ApiError.badRequest('XLSX 压缩结构无效');
  const entries = buffer.readUInt16LE(end + 10);
  const directoryLength = buffer.readUInt32LE(end + 12);
  let cursor = buffer.readUInt32LE(end + 16);
  const directoryStart = cursor;
  if (!entries || entries > 1024 || cursor + directoryLength > end)
    throw ApiError.badRequest('XLSX 压缩结构或文件数超限');
  let total = 0;
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50)
      throw ApiError.badRequest('XLSX 压缩目录无效');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const expandedSize = buffer.readUInt32LE(cursor + 24);
    total += expandedSize;
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    if (flags & 1 || ![0, 8].includes(method) || total > MAX_EXPANDED_BYTES)
      throw ApiError.badRequest('不支持加密表格或解压后超过50MiB的文件');
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if (localOffset + 30 > directoryStart || buffer.readUInt32LE(localOffset) !== 0x04034b50)
      throw ApiError.badRequest('XLSX文件内容位置无效');
    const dataStart =
      localOffset +
      30 +
      buffer.readUInt16LE(localOffset + 26) +
      buffer.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > directoryStart) throw ApiError.badRequest('XLSX文件内容越界');
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const actualSize =
      method === 0
        ? compressed.length
        : inflateRawSync(compressed, { maxOutputLength: Math.max(expandedSize, 1) }).length;
    if (actualSize !== expandedSize) throw ApiError.badRequest('XLSX实际展开大小与目录不一致');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (cursor > end) throw ApiError.badRequest('XLSX 压缩目录越界');
  }
}

/** 有限解析表格，保留原始行号；公式单元格拒绝，未知列不静默丢弃。 */
function parseImportFile(file, kind) {
  assertKind(kind);
  if (!Buffer.isBuffer(file?.buffer) || !file.buffer.length || file.buffer.length > MAX_FILE_BYTES)
    throw ApiError.badRequest('请选择10MiB以内的XLSX或UTF-8 CSV文件');
  const filename = String(file.originalname || '');
  const csv = /\.csv$/i.test(filename);
  if (!csv && !/\.xlsx$/i.test(filename)) throw ApiError.badRequest('仅支持.xlsx或.csv文件');
  let book;
  try {
    if (csv) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
      book = XLSX.read(text, {
        type: 'string',
        raw: true,
        sheetRows: MAX_ROWS + 2,
        cellFormula: true,
      });
    } else {
      if (file.buffer.length < 22) throw ApiError.badRequest('XLSX文件不完整');
      validateXlsxArchive(file.buffer);
      book = XLSX.read(file.buffer, {
        type: 'buffer',
        raw: true,
        sheetRows: MAX_ROWS + 2,
        cellFormula: true,
      });
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw ApiError.badRequest('表格无法解析，请检查文件格式和UTF-8编码');
  }
  if (!book.SheetNames.length) throw ApiError.badRequest('表格为空');
  const name = book.SheetNames.includes('数据') ? '数据' : book.SheetNames[0];
  if (
    book.SheetNames.some(
      sheetName => ![name, '填写说明'].includes(sheetName) && book.Sheets[sheetName]['!ref']
    )
  )
    throw ApiError.badRequest('只允许一张数据工作表，请按模板导入');
  const sheet = book.Sheets[name];
  const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref'] || 'A1');
  if (range.e.r > MAX_ROWS) throw new ApiError(400, 'IMPORT_ROW_LIMIT', '每次最多500条数据行');
  if (range.e.c >= MAX_COLUMNS) throw ApiError.badRequest('导入列数超限');
  const aliases = new Map(
    KIND_FIELDS[kind].flatMap(field => [
      [field, field],
      [LABELS[field], field],
    ])
  );
  const headers = [];
  const seen = new Set();
  for (let column = 0; column <= range.e.c; column++) {
    const cell = sheet[XLSX.utils.encode_cell({ r: 0, c: column })];
    if (cell?.f) throw ApiError.badRequest('表头不能是公式');
    const label = String(cell?.v || '').trim();
    const field = aliases.get(label);
    if (!field || seen.has(field))
      throw ApiError.badRequest(`表头未知或重复：${label.slice(0, 80)}`);
    seen.add(field);
    headers.push(field);
  }
  const rows = [];
  for (let rowNumber = 2; rowNumber <= range.e.r + 1; rowNumber++) {
    const data = {};
    const errors = [];
    headers.forEach((field, column) => {
      const cell = sheet[XLSX.utils.encode_cell({ r: rowNumber - 1, c: column })];
      if (cell?.f)
        errors.push({ field, code: 'FORMULA_NOT_ALLOWED', message: '请将公式转换为真实值后导入' });
      if (cell && cell.v !== '' && cell.v !== undefined && cell.v !== null) data[field] = cell.v;
    });
    if (Object.keys(data).length || errors.length) rows.push({ rowNumber, data, errors });
  }
  if (!rows.length) throw ApiError.badRequest('表格没有数据行');
  return { rows, fileHash: digest(file.buffer), sheetName: name };
}

function assertImportPermissions(ctx, kind, rows = []) {
  assertKind(kind);
  requirePermissions(ctx, 'stock.read', 'stock.import', ...KIND_PERMISSIONS[kind]);
  if (
    rows.some(row =>
      [...COST_FIELDS].some(field => row.data[field] !== undefined && row.data[field] !== '')
    )
  )
    requirePermissions(ctx, 'stock.cost.read', 'stock.cost.edit');
  if (rows.some(row => row.data.sourceOrderId !== undefined && row.data.sourceOrderId !== ''))
    requirePermissions(ctx, 'stock.source.link', 'pickups.read', 'pickups.edit', 'orders.read');
  if (
    kind === 'collections' &&
    rows.some(row => ['company', '公司'].includes(row.data.destination))
  )
    requirePermissions(ctx, 'stock.receipts.read', 'stock.receipts.edit');
}

function normalizedRow(kind, raw) {
  const data = {};
  for (const field of KIND_FIELDS[kind]) {
    const value = raw[field];
    if (field.endsWith('Id') && field !== 'sourceOrderId') data[field] = optionalId(value, field);
    else if (['costAmount', 'saleAmount', 'amount', 'allocationAmount'].includes(field))
      data[field] = moneyValue(value, field);
    else if (['receivedAt', 'shippedAt'].includes(field)) data[field] = dateValue(value, field);
    else if (field === 'acquiredOn') data[field] = dateValue(value, field, true);
    else
      data[field] = textValue(
        value,
        field,
        field === 'notes' ? 2000 : field === 'costBasis' ? 1000 : 100
      );
    if (data[field] === undefined) delete data[field];
  }
  for (const field of ['serialNumber', 'allocationSerialNumber']) {
    if (data[field])
      data[field] = normalizeDeviceBarcodes({ serialBarcode: data[field] }).serialNumber;
  }
  if (data.sourceOrderId) {
    if (
      !/^\d+$/.test(data.sourceOrderId) ||
      !Number.isSafeInteger(Number(data.sourceOrderId)) ||
      Number(data.sourceOrderId) < 1
    )
      throw ApiError.badRequest('来源订单ID必须为正整数');
    data.sourceOrderId = Number(data.sourceOrderId);
  }
  if (data.storageGb) {
    if (!/^\d+$/.test(data.storageGb) || Number(data.storageGb) <= 0)
      throw ApiError.badRequest('容量GB须为正整数');
    data.storageGb = Number(data.storageGb);
  }
  if (data.channel)
    data.channel =
      { 重庆自销: 'local', 自销: 'local', 代卖: 'consignment' }[data.channel] || data.channel;
  if (data.destination)
    data.destination = { 公司: 'company', 代收: 'agent' }[data.destination] || data.destination;
  if (data.costAmount && (!data.acquiredOn || !data.costBasis))
    throw ApiError.badRequest('填写官网成本时必须同时填写拿货日期和成本依据');
  if (data.costBasis && !data.costAmount) throw ApiError.badRequest('成本依据需同时填写官网成本');
  return data;
}

function publicError(error) {
  return {
    code: error instanceof ApiError ? error.code : 'IMPORT_ROW_INVALID',
    message: error instanceof ApiError ? error.message : '本行数据无法校验',
  };
}

function requireValue(data, field) {
  if (data[field] === undefined || data[field] === '')
    throw ApiError.badRequest(`${LABELS[field]}不能为空`);
  return data[field];
}

function costInput(data) {
  return data.costAmount
    ? { status: 'confirmed', amount: data.costAmount, source: 'manual', basis: data.costBasis }
    : undefined;
}

function resolveNamed(rows, id, name, label, predicate = () => true) {
  const candidates = rows.filter(row => (id ? row.id === id : row.name === name) && predicate(row));
  if (candidates.length !== 1 || (id && name && candidates[0].name !== name))
    throw ApiError.badRequest(`${label}不存在、同名不唯一或ID与名称不一致`);
  return candidates[0];
}

function resolveProduct(rows, data) {
  const candidates = rows.filter(row =>
    data.productId
      ? row.id === data.productId
      : row.modelName === data.modelName &&
        Number(row.storageGb) === data.storageGb &&
        row.colorName === data.colorName
  );
  const product = candidates[0];
  if (
    candidates.length !== 1 ||
    (data.modelName && product.modelName !== data.modelName) ||
    (data.colorName && product.colorName !== data.colorName) ||
    (data.storageGb && Number(product.storageGb) !== data.storageGb)
  )
    throw ApiError.badRequest('商品不存在或规格与商品ID不一致，请精确匹配型号、容量和颜色');
  return product;
}

function resolveParty(parties, data, field, role, required = true) {
  const id = data[`${field}Id`];
  const name = data[`${field}Name`];
  if (!id && !name && !required) return undefined;
  return resolveNamed(
    parties,
    id,
    name,
    LABELS[`${field}Name`],
    row => row.isActive && (!role || row.roles.includes(role))
  ).id;
}

function resolveSale(sales, data) {
  const candidates = sales.filter(row =>
    data.saleId ? row.id === data.saleId : row.saleNo === data.saleNo
  );
  if (
    candidates.length !== 1 ||
    (data.saleNo && candidates[0].saleNo !== data.saleNo) ||
    candidates[0].status !== 'shipped'
  )
    throw ApiError.badRequest('销售单不存在、尚未出货或销售单号与ID不一致');
  return candidates[0];
}

function addMoney(amounts) {
  return amounts.reduce((sum, amount) => sum + BigInt(String(amount).replace('.', '')), 0n);
}

function fingerprintRows(rows) {
  return rows
    .map(row => [
      String(row.id),
      row.version ?? null,
      row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    ])
    .sort((left, right) => left[0].localeCompare(right[0]));
}

async function readBatch(readers) {
  try {
    // 同一事务只有一条PG连接；并发发查询会依赖驱动内部排队而不是实际并行。
    const results = [];
    for (const read of readers) results.push(await read());
    return results;
  } catch (error) {
    logger.warn('库存导入批量读取未完成', { code: error.code || error.name });
    throw error;
  }
}

/** 一次批量读取相关资料和资金，避免逐台查库以及在预览中泄漏未授权目标。 */
async function loadSnapshot(ctx, normalized, kind) {
  try {
    const dataRows = normalized.filter(row => row.data).map(row => row.data);
    const serials = [
      ...new Set(
        dataRows.flatMap(row => [row.serialNumber, row.allocationSerialNumber]).filter(Boolean)
      ),
    ];
    const externalKeys = [...new Set(dataRows.map(row => row.externalKey).filter(Boolean))];
    const saleIds = dataRows.map(row => row.saleId).filter(Boolean);
    const saleNos = dataRows.map(row => row.saleNo).filter(Boolean);
    const sourceIds = dataRows.map(row => row.sourceOrderId).filter(Boolean);
    const options = { transaction: ctx.transaction };
    const [settings, products, locations, parties, units, sales, existingFinancial, orders] =
      await readBatch([
        () => models.StockSetting.findByPk(1, options),
        () => models.StockProduct.findAll(options),
        () => models.StockLocation.findAll(options),
        () => models.StockParty.findAll(options),
        () => {
          if (!serials.length) return [];
          return models.StockUnit.findAll({
            ...options,
            where: { serialNumber: { [Op.in]: serials } },
          });
        },
        () => {
          if (!saleIds.length && !saleNos.length) return [];
          return models.StockSale.findAll({
            ...options,
            where: { [Op.or]: [{ id: { [Op.in]: saleIds } }, { saleNo: { [Op.in]: saleNos } }] },
          });
        },
        () => {
          if (!externalKeys.length || !['collections', 'receipts'].includes(kind)) return [];
          return models[kind === 'collections' ? 'StockCollection' : 'StockReceipt'].findAll({
            ...options,
            where: { externalRecordKey: { [Op.in]: externalKeys } },
          });
        },
        () => {
          if (!sourceIds.length) return [];
          return models.Order.findAll({
            ...options,
            where: require('./orderAccessService').scopeOrderWhere(ctx.user, {
              id: { [Op.in]: sourceIds },
            }),
            attributes: ['id'],
          });
        },
      ]);
    const scopedSaleIds = sales.map(row => row.id);
    const [lines, collections, bindings] = await readBatch([
      () => {
        if (!scopedSaleIds.length) return [];
        return models.StockSaleLine.findAll({
          ...options,
          where: { saleId: { [Op.in]: scopedSaleIds } },
        });
      },
      () => {
        if (!scopedSaleIds.length) return [];
        return models.StockCollection.findAll({
          ...options,
          where: { saleId: { [Op.in]: scopedSaleIds }, status: 'posted' },
        });
      },
      () => {
        if (!serials.length) return [];
        return models.PickupDevice.findAll({
          ...options,
          where: { serialNumber: { [Op.in]: serials } },
          attributes: ['id', 'serialNumber', 'orderId'],
        });
      },
    ]);
    let saleUnits = [];
    if (lines.length) {
      saleUnits = await models.StockSaleUnit.findAll({
        ...options,
        where: { saleLineId: { [Op.in]: lines.map(row => row.id) }, status: 'shipped' },
      });
    }
    let allocations = [];
    if (saleUnits.length) {
      allocations = await models.StockReceiptAllocation.findAll({
        ...options,
        where: { saleUnitId: { [Op.in]: saleUnits.map(row => row.id) }, status: 'active' },
      });
    }
    const snapshot = {
      settings,
      products,
      locations,
      parties,
      units,
      sales,
      existingFinancial,
      orders,
      lines,
      collections,
      bindings,
      saleUnits,
      allocations,
    };
    snapshot.fingerprint = digest(
      Object.fromEntries(
        Object.entries(snapshot).map(([key, value]) => [
          key,
          Array.isArray(value)
            ? fingerprintRows(value)
            : value
              ? [value.id, value.version, value.cutoverAt]
              : null,
        ])
      )
    );
    return snapshot;
  } catch (error) {
    logger.warn('库存文件操作未完成', { code: error.code || error.name });
    throw error;
  }
}

function resolveStockRow(data, snapshot, kind) {
  requireValue(data, 'serialNumber');
  const product = resolveProduct(snapshot.products, data);
  if (!product.isActive) throw ApiError.badRequest('商品已停用，不能导入');
  const existing = snapshot.units.find(unit => unit.serialNumber === data.serialNumber);
  if (existing && existing.state !== 'registered')
    throw new ApiError(409, 'UNIT_STATE_CONFLICT', 'SN已入实物或销售账，不能重复导入');
  if (data.sourceOrderId) {
    if (!snapshot.orders.some(order => Number(order.id) === data.sourceOrderId))
      throw ApiError.notFound('来源订单不存在或不可访问');
    const binding = snapshot.bindings.find(row => row.serialNumber === data.serialNumber);
    if (binding && Number(binding.orderId) !== data.sourceOrderId)
      throw new ApiError(409, 'SOURCE_BINDING_CONFLICT', 'SN已有不同来源，需通过来源更正处理');
  }
  const result = {
    serialBarcode: data.serialNumber,
    productId: product.id,
    ...(data.acquiredOn && { acquiredOn: data.acquiredOn }),
    ...(data.sourceOrderId && { sourceOrderId: data.sourceOrderId }),
    ...(costInput(data) && { cost: costInput(data) }),
  };
  if (kind === 'opening') {
    const location = resolveNamed(
      snapshot.locations,
      data.locationId,
      data.locationName,
      '库存位置',
      row => row.isActive && ['warehouse', 'consignee'].includes(row.kind)
    );
    if (
      data.receivedAt &&
      Date.parse(data.receivedAt) !== new Date(snapshot.settings.cutoverAt).getTime()
    )
      throw ApiError.badRequest('期初收货时点须等于管理员配置的启用盘点时点');
    return {
      ...result,
      locationId: location.id,
      receivedAt: data.receivedAt || new Date(snapshot.settings.cutoverAt).toISOString(),
    };
  }
  const historical = snapshot.locations.find(location => location.kind === 'historical');
  const location =
    data.fromLocationId || data.fromLocationName
      ? resolveNamed(snapshot.locations, data.fromLocationId, data.fromLocationName, '历史出货位置')
      : historical;
  if (!location) throw ApiError.badRequest('历史出货待核实位置尚未配置');
  return { ...result, fromLocationId: location.id, saleAmount: requireValue(data, 'saleAmount') };
}

/** 重新解析并批量校验，预览不调用写业务服务；提交时再次运行同一逻辑。 */
async function buildImportPlan(ctx, kind, sourceLabel, rows) {
  try {
    assertImportPermissions(ctx, kind, rows);
    const normalized = rows.map(row => {
      try {
        if (row.errors?.length) return { rowNumber: row.rowNumber, errors: row.errors };
        const data = normalizedRow(kind, row.data);
        if (['collections', 'receipts'].includes(kind))
          data.externalKey = financialExternalKey(sourceLabel, data.externalRecordKey);
        return { rowNumber: row.rowNumber, data, errors: [] };
      } catch (error) {
        return { rowNumber: row.rowNumber, errors: [publicError(error)] };
      }
    });
    assertImportPermissions(
      ctx,
      kind,
      normalized.filter(row => row.data)
    );
    const snapshot = await loadSnapshot(ctx, normalized, kind);
    const seenSerials = new Set();
    const groups = new Map();
    const plannedBySaleUnit = new Map();
    for (const row of normalized) {
      if (row.errors.length) continue;
      const data = row.data;
      try {
        if (['opening', 'historical_sales'].includes(kind)) {
          if (!snapshot.settings?.cutoverAt)
            throw ApiError.badRequest('请管理员先配置期初启用时点');
          if (seenSerials.has(data.serialNumber))
            throw new ApiError(409, 'SN_EXISTS', '文件中同一SN出现多次');
          seenSerials.add(data.serialNumber);
        }
        if (kind === 'opening') {
          const input = resolveStockRow(data, snapshot, kind);
          groups.set(data.serialNumber, {
            key: data.serialNumber,
            rowNumbers: [row.rowNumber],
            input,
          });
        } else if (kind === 'historical_sales') {
          const key = requireValue(data, 'saleKey');
          const channel = requireValue(data, 'channel');
          if (!['local', 'consignment'].includes(channel))
            throw ApiError.badRequest('销售渠道必须为local或consignment');
          const shippedAt = requireValue(data, 'shippedAt');
          if (Date.parse(shippedAt) >= new Date(snapshot.settings.cutoverAt).getTime())
            throw new ApiError(409, 'IMPORT_PREVIEW_STALE', '历史销售必须早于期初启用时点');
          const header = {
            channel,
            shippedAt,
            salespersonId: resolveParty(snapshot.parties, data, 'salesperson', 'salesperson'),
            customerId: resolveParty(
              snapshot.parties,
              data,
              'customer',
              'customer',
              channel === 'local'
            ),
            handlerId: resolveParty(snapshot.parties, data, 'handler', 'handler'),
            notes: data.notes,
          };
          if (channel === 'consignment')
            header.consigneeLocationId = resolveNamed(
              snapshot.locations,
              data.consigneeLocationId,
              data.consigneeLocationName,
              '代卖位置',
              location => location.kind === 'consignee'
            ).id;
          const unit = resolveStockRow(data, snapshot, kind);
          const old = groups.get(key);
          if (old && JSON.stringify(old.header) !== JSON.stringify(header))
            throw ApiError.badRequest('同一历史销售分组的渠道、人员、时间和备注必须一致');
          const group = old || { key, header, rowNumbers: [], input: { ...header, units: [] } };
          if (group.input.units.length >= 100)
            throw ApiError.badRequest('单笔历史销售最多100台，请拆分真实销售单');
          if (new Set([...group.input.units.map(item => item.productId), unit.productId]).size > 20)
            throw ApiError.badRequest('单笔历史销售最多20个规格');
          group.input.units.push(unit);
          group.rowNumbers.push(row.rowNumber);
          groups.set(key, group);
        } else if (kind === 'collections') {
          if (
            snapshot.existingFinancial.some(record => record.externalRecordKey === data.externalKey)
          )
            throw ApiError.conflict('该外部客户付款记录已导入，不能重复导入');
          if (groups.has(data.externalKey))
            throw ApiError.badRequest('同一客户付款外部记录键在文件中重复');
          const sale = resolveSale(snapshot.sales, data);
          if (
            snapshot.collections.some(collection => collection.saleId === sale.id) ||
            [...groups.values()].some(group => group.input.saleId === sale.id)
          )
            throw ApiError.conflict('该销售单已登记客户全额付款');
          if (!['company', 'agent'].includes(data.destination))
            throw ApiError.badRequest('付款去向须为company或agent');
          const amount = requireValue(data, 'amount');
          const lineIds = snapshot.lines
            .filter(line => line.saleId === sale.id)
            .map(line => line.id);
          const saleUnits = snapshot.saleUnits.filter(unit => lineIds.includes(unit.saleLineId));
          if (addMoney([amount]) !== addMoney(saleUnits.map(unit => unit.saleAmount)))
            throw ApiError.badRequest('客户付款金额必须等于本单全部已售机器售价');
          if (data.destination === 'company' && (data.collectorId || data.collectorName))
            throw ApiError.badRequest('公司直收不能填写代收人');
          const input = {
            saleId: sale.id,
            destination: data.destination,
            amount,
            receivedAt: requireValue(data, 'receivedAt'),
            externalRecordKey: data.externalKey,
            ...(data.destination === 'agent' && {
              collectorId: resolveParty(snapshot.parties, data, 'collector', null),
            }),
            ...(data.notes && { notes: data.notes }),
          };
          groups.set(data.externalKey, {
            key: data.externalRecordKey,
            rowNumbers: [row.rowNumber],
            input,
          });
        } else {
          if (
            snapshot.existingFinancial.some(record => record.externalRecordKey === data.externalKey)
          )
            throw ApiError.conflict('该外部到账记录已导入，不能重复导入');
          const header = {
            source: 'agent_transfer',
            payerId: resolveParty(snapshot.parties, data, 'payer', null),
            amount: requireValue(data, 'amount'),
            receivedAt: requireValue(data, 'receivedAt'),
            externalRecordKey: data.externalKey,
            notes: data.notes,
          };
          const old = groups.get(data.externalKey);
          if (old && JSON.stringify(old.header) !== JSON.stringify(header))
            throw ApiError.badRequest('同一到账外部键的转款人、总额、时间和备注必须一致');
          const group = old || {
            key: data.externalRecordKey,
            header,
            rowNumbers: [],
            input: { ...header, allocations: [] },
          };
          if (data.allocationSerialNumber || data.allocationAmount || data.saleId || data.saleNo) {
            requireValue(data, 'allocationSerialNumber');
            requireValue(data, 'allocationAmount');
            const sale = resolveSale(snapshot.sales, data);
            const collection = snapshot.collections.find(item => item.saleId === sale.id);
            if (
              !collection ||
              collection.destination !== 'agent' ||
              collection.collectorId !== header.payerId
            )
              throw new ApiError(
                409,
                'COLLECTOR_MISMATCH',
                '销售单未登记该转款人的代收款，不能分配'
              );
            const unit = snapshot.units.find(
              item => item.serialNumber === data.allocationSerialNumber
            );
            const lineIds = snapshot.lines
              .filter(line => line.saleId === sale.id)
              .map(line => line.id);
            const saleUnit = snapshot.saleUnits.find(
              item => item.stockUnitId === unit?.id && lineIds.includes(item.saleLineId)
            );
            if (!saleUnit) throw ApiError.badRequest('该SN不属于所选已售单');
            if (group.input.allocations.some(item => item.saleUnitId === saleUnit.id))
              throw ApiError.badRequest('同一到账不能重复分配给同一SN，请合并分配金额');
            const alreadyAllocated = addMoney(
              snapshot.allocations
                .filter(item => item.saleUnitId === saleUnit.id)
                .map(item => item.amount)
            );
            const planned =
              (plannedBySaleUnit.get(saleUnit.id) || 0n) + addMoney([data.allocationAmount]);
            if (alreadyAllocated + planned > addMoney([saleUnit.saleAmount]))
              throw new ApiError(409, 'RECEIPT_OVERALLOCATED', '本台分配超过尚未转回货款');
            if (
              addMoney([
                ...group.input.allocations.map(item => item.amount),
                data.allocationAmount,
              ]) > addMoney([header.amount])
            )
              throw new ApiError(409, 'RECEIPT_OVERALLOCATED', '分配合计超过本笔到账总额');
            plannedBySaleUnit.set(saleUnit.id, planned);
            group.input.allocations.push({
              collectionId: collection.id,
              saleUnitId: saleUnit.id,
              amount: data.allocationAmount,
            });
          }
          group.rowNumbers.push(row.rowNumber);
          groups.set(data.externalKey, group);
        }
      } catch (error) {
        row.errors.push(publicError(error));
      }
    }
    const errors = normalized.flatMap(row =>
      row.errors.map(error => ({ rowNumber: row.rowNumber, ...error }))
    );
    const plan = {
      kind,
      rows: normalized,
      groups: [...groups.values()],
      errors,
      snapshotHash: snapshot.fingerprint,
    };
    plan.previewHash = digest(plan);
    return plan;
  } catch (error) {
    logger.warn('库存文件操作未完成', { code: error.code || error.name });
    throw error;
  }
}

function ensureOwner(ctx, job) {
  if (Number(job.createdBy) !== Number(ctx.user.id) && ctx.user.role !== 'admin')
    throw ApiError.notFound('导入记录不存在或不可访问');
}

function projectPlan(plan) {
  return {
    rowCount: plan.rows.length,
    validRowCount: plan.rows.filter(row => !row.errors.length).length,
    groupCount: plan.groups.length,
    canCommit: plan.errors.length === 0,
    rows: plan.rows.map(row => ({
      rowNumber: row.rowNumber,
      data: row.data
        ? Object.fromEntries(Object.entries(row.data).filter(([key]) => key !== 'externalKey'))
        : null,
      errors: row.errors,
    })),
    errors: plan.errors,
    groups: plan.groups.map(group => ({
      key: group.key,
      rowNumbers: group.rowNumbers,
      unitCount: group.input.units?.length || (group.input.serialBarcode ? 1 : undefined),
    })),
  };
}

async function authorizeSavedSources(ctx, plan) {
  try {
    const orderIds = [
      ...new Set(
        plan.groups.flatMap(group =>
          (group.input.units || [group.input]).map(unit => unit.sourceOrderId).filter(Boolean)
        )
      ),
    ];
    if (!orderIds.length) return;
    const allowed = await models.Order.findAll({
      where: require('./orderAccessService').scopeOrderWhere(ctx.user, {
        id: { [Op.in]: orderIds },
      }),
      attributes: ['id'],
      transaction: ctx.transaction,
    });
    if (allowed.length !== orderIds.length)
      throw new ApiError(403, 'FORBIDDEN', '导入中的来源订单权限已变化，请重新预览');
  } catch (error) {
    logger.warn('库存导入来源范围校验未完成', {
      actorId: ctx.user.id,
      code: error.code || error.name,
    });
    throw error;
  }
}

/** 预览只持久化加密的有限行数据，24小时后不允许确认。 */
async function previewImport(user, { kind, sourceLabel, file }) {
  try {
    const ctx = await createReadContext(user);
    assertImportPermissions(ctx, kind);
    const source = textValue(
      textValue(sourceLabel, 'sourceLabel', 100)?.normalize('NFKC').trim(),
      'sourceLabel',
      100
    );
    if (!source) throw ApiError.badRequest('请填写来源名称，重导同一来源时保持名称不变');
    const parsed = parseImportFile(file, kind);
    assertImportPermissions(ctx, kind, parsed.rows);
    const refs = await runCommand(
      user,
      { requestKey: crypto.randomUUID(), kind, sourceLabel: source, fileHash: parsed.fileHash },
      'import.preview',
      ['stock.import'],
      async commandCtx => {
        try {
          const plan = await buildImportPlan(commandCtx, kind, source, parsed.rows);
          const job = await models.StockImportJob.create(
            {
              kind,
              sourceLabel: source,
              fileHash: parsed.fileHash,
              previewHash: plan.previewHash,
              payloadCiphertext: encryptJson({ rows: parsed.rows, plan }),
              status: 'preview',
              expiresAt: new Date(Date.now() + PREVIEW_TTL_MS),
              resultRefs: {},
              createdBy: commandCtx.user.id,
              updatedBy: commandCtx.user.id,
            },
            { transaction: commandCtx.transaction }
          );
          await recordEvent(
            commandCtx,
            'StockImportJob',
            {
              id: job.id,
              version: job.version,
              kind: job.kind,
              sourceLabel: job.sourceLabel,
              fileHash: job.fileHash,
              previewHash: job.previewHash,
              rowCount: plan.rows.length,
              status: job.status,
              expiresAt: job.expiresAt,
            },
            'import.preview',
            null
          );
          return { importId: job.id };
        } catch (error) {
          logger.warn('库存文件事务未完成', { code: error.code || error.name });
          throw error;
        }
      }
    );
    return await getImport(user, refs.importId);
  } catch (error) {
    logger.warn('库存文件操作未完成', { code: error.code || error.name });
    throw error;
  } finally {
    if (file) file.buffer = null;
  }
}

/** 本人或管理员读取预览；每次按当前权限检查所有载荷领域。 */
async function getImport(user, id) {
  try {
    const ctx = await createReadContext(user);
    requirePermissions(ctx, 'stock.import');
    if (!UUID_PATTERN.test(id || '')) throw ApiError.badRequest('导入预览标识无效');
    const job = await models.StockImportJob.findByPk(id, { transaction: ctx.transaction });
    if (!job) throw ApiError.notFound('导入预览不存在');
    ensureOwner(ctx, job);
    if (job.status === 'expired') {
      assertImportPermissions(ctx, job.kind);
      return {
        id: job.id,
        previewId: job.id,
        kind: job.kind,
        sourceLabel: job.sourceLabel,
        version: job.version,
        previewHash: job.previewHash,
        status: 'expired',
        expiresAt: job.expiresAt,
        resultRefs: job.resultRefs,
        rowCount: 0,
        validRowCount: 0,
        groupCount: 0,
        rows: [],
        errors: [],
        groups: [],
        canCommit: false,
      };
    }
    const payload = decryptJson(job.payloadCiphertext);
    assertImportPermissions(ctx, job.kind, payload.rows);
    await authorizeSavedSources(ctx, payload.plan);
    return {
      id: job.id,
      previewId: job.id,
      kind: job.kind,
      sourceLabel: job.sourceLabel,
      version: job.version,
      previewHash: job.previewHash,
      status:
        job.status === 'preview' && new Date(job.expiresAt).getTime() <= Date.now()
          ? 'expired'
          : job.status,
      expiresAt: job.expiresAt,
      resultRefs: job.resultRefs,
      ...projectPlan(payload.plan),
      canCommit:
        job.status === 'preview' &&
        new Date(job.expiresAt).getTime() > Date.now() &&
        payload.plan.errors.length === 0,
    };
  } catch (error) {
    logger.warn('库存文件操作未完成', { code: error.code || error.name });
    throw error;
  }
}

/** 同一模块事务内再次校验所有行，再逐组调用业务命令；任何一行失败全部回滚。 */
async function commitImport(ctx, id, input) {
  try {
    requirePermissions(ctx, 'stock.import');
    if (
      Object.keys(input).some(
        key => !['requestKey', 'expectedVersion', 'previewHash'].includes(key)
      )
    )
      throw ApiError.badRequest('导入确认包含未知字段');
    if (!UUID_PATTERN.test(id || '')) throw ApiError.badRequest('导入预览标识无效');
    const job = await models.StockImportJob.findByPk(id, { transaction: ctx.transaction });
    if (!job) throw ApiError.notFound('导入预览不存在');
    ensureOwner(ctx, job);
    const payload = decryptJson(job.payloadCiphertext);
    assertImportPermissions(ctx, job.kind, payload.rows);
    assertVersion(job, input.expectedVersion);
    if (
      job.status !== 'preview' ||
      new Date(job.expiresAt).getTime() <= Date.now() ||
      input.previewHash !== job.previewHash
    )
      throw new ApiError(409, 'IMPORT_PREVIEW_STALE', '导入预览已失效，请重新预览');
    const plan = await buildImportPlan(ctx, job.kind, job.sourceLabel, payload.rows);
    if (plan.errors.length || plan.previewHash !== job.previewHash)
      throw new ApiError(409, 'IMPORT_PREVIEW_STALE', '相关数据已变化或有错误，请重新预览', {
        errors: plan.errors,
      });
    const resultRefs = { unitIds: [], saleIds: [], collectionIds: [], receiptIds: [] };
    const importCtx = { ...ctx, importing: true };
    if (job.kind === 'opening') {
      // 接口100台限制只约束交互请求；有限500行导入仍在同一外层事务中分组调用。
      for (let offset = 0; offset < plan.groups.length; offset += 100) {
        const refs = await require('./stockUnitService').receiveUnits(importCtx, {
          mode: 'opening',
          units: plan.groups.slice(offset, offset + 100).map(group => group.input),
        });
        resultRefs.unitIds.push(...refs.unitIds);
      }
    } else {
      for (const group of plan.groups) {
        if (job.kind === 'historical_sales') {
          const refs = await require('./stockSalesService').importHistoricalSale(
            importCtx,
            group.input
          );
          resultRefs.saleIds.push(refs.saleId);
          if (refs.unitIds) resultRefs.unitIds.push(...refs.unitIds);
        } else if (job.kind === 'collections') {
          const refs = await require('./stockFinanceService').createCollection(
            importCtx,
            group.input
          );
          resultRefs.collectionIds.push(refs.collectionId);
          if (refs.receiptId) resultRefs.receiptIds.push(refs.receiptId);
        } else {
          const refs = await require('./stockFinanceService').createReceipt(importCtx, group.input);
          resultRefs.receiptIds.push(refs.receiptId);
        }
      }
    }
    await updateRow(ctx, job, { status: 'committed', resultRefs }, 'import.commit');
    return { importId: job.id };
  } catch (error) {
    logger.warn('库存文件操作未完成', { code: error.code || error.name });
    throw error;
  }
}

/** 生成无示例业务记录的中文模板；字段说明明确精确匹配、金额和时间口径。 */
async function readTemplate(user, kind) {
  try {
    const ctx = await createReadContext(user);
    assertImportPermissions(ctx, kind);
    const fields = KIND_FIELDS[kind].filter(
      field =>
        (!COST_FIELDS.has(field) ||
          (ctx.permissions.has('stock.cost.read') && ctx.permissions.has('stock.cost.edit'))) &&
        (field !== 'sourceOrderId' ||
          ['stock.source.link', 'orders.read', 'pickups.read', 'pickups.edit'].every(code =>
            ctx.permissions.has(code)
          ))
    );
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([fields.map(field => LABELS[field])]);
    sheet['!cols'] = fields.map(() => ({ wch: 24 }));
    XLSX.utils.book_append_sheet(book, sheet, '数据');
    const instructions = [
      ['项目', '填写规则'],
      ['上限', '单文件10MiB、数据最多500行；整批确认，任何错误都不会部分入账。'],
      ['规格', '商品ID或型号+容量GB+颜色二选一；两者同时填写时必须完全一致。容量填整数，例如256。'],
      [
        '业务资料',
        'ID或名称二选一；名称须唯一且完全匹配已配置资料。导入不自动创建仓库、人员或商品。',
      ],
      ['SN', '每台真实SN必填；来源订单ID可以留空，之后补关联。'],
      [
        '时间',
        '时间按文本填写，例如2026-10-04T15:30:00+08:00；拿货日期为YYYY-MM-DD。不使用Excel序号。',
      ],
      ['成本', '未核实时留空；填写时必须同时提供拿货日期及成本依据，金额为拿货当天对应官网价。'],
      ['期初', '期初未填收货时间时采用管理员配置的期初时点；已入实物账的SN不能再次导入。'],
      [
        '历史销售',
        '同一历史销售分组键代表一次真实销售；同组渠道、人员、时间、备注必须一致。实际出货早于期初时点。',
      ],
      ['渠道', 'local=重庆自销，consignment=代卖；代卖位置必填，最终客户未知可留空。'],
      [
        '客户付款',
        'company=公司直收，agent=代收；公司直收会同时记公司到账，请勿再次导入相同到账。付款总额等于全单售价。',
      ],
      [
        '外部记录键',
        '资金必填来源内稳定键，换文件或排序不换键。同金额同日期仍可能是不同真实款项。',
      ],
      [
        '到账分配',
        '同一外部记录键可占多行分配给不同SN；每行款项总额是同一笔总额，不能累计。销售单号、SN和本台分配金额一起填写，全部留空表示未分配。',
      ],
      [
        '备注与公式',
        '不支持公式单元格，请先转换为真实值；备注是纯文本。不得在备注中填写账户密码或支付链接。',
      ],
      ...fields.map(field => [LABELS[field], field]),
    ];
    const help = XLSX.utils.aoa_to_sheet(instructions);
    help['!cols'] = [{ wch: 22 }, { wch: 110 }];
    XLSX.utils.book_append_sheet(book, help, '填写说明');
    return {
      filename: `自有库存-${kind}-导入模板.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }),
    };
  } catch (error) {
    logger.warn('库存文件操作未完成', { code: error.code || error.name });
    throw error;
  }
}

const EXPORT_FIELDS = {
  units: {
    id: { label: '实物ID' },
    serialNumber: { label: 'SN' },
    modelName: { label: '型号', path: ['product.modelName', 'modelName'] },
    storageGb: { label: '容量GB', path: ['product.storageGb', 'storageGb'] },
    colorName: { label: '颜色', path: ['product.colorName', 'colorName'] },
    locationName: { label: '位置', path: ['location.name', 'locationName'] },
    state: { label: '状态' },
    acquiredOn: { label: '拿货日期', permission: 'stock.cost.read' },
    firstReceivedAt: { label: '首次入账时间' },
    costStatus: { label: '成本状态', permission: 'stock.cost.read' },
    officialCostAmount: { label: '官网成本', money: true, permission: 'stock.cost.read' },
  },
  sales: {
    id: { label: '销售单ID' },
    saleNo: { label: '销售单号' },
    channel: { label: '渠道' },
    status: { label: '状态' },
    shippedAt: { label: '实际出货时间' },
    customerName: { label: '客户', path: ['customer.name', 'customerName'] },
    salespersonName: { label: '销售负责人', path: ['salesperson.name', 'salespersonName'] },
    handlerName: { label: '交货人', path: ['handler.name', 'handlerName'] },
    saleAmount: {
      label: '售价合计',
      money: true,
      path: ['totalAmount', 'saleAmount'],
    },
    costAmount: {
      label: '已确认成本合计',
      money: true,
      permission: 'stock.cost.read',
      path: ['confirmedCostAmount', 'costAmount'],
    },
    grossProfit: {
      label: '已确认毛利',
      money: true,
      permission: 'stock.profit.read',
      path: ['grossProfit', 'totals.grossProfit'],
    },
    expenseAmount: {
      label: '已登记费用',
      money: true,
      permission: 'stock.expenses.read',
      path: ['expenseAmount', 'totals.expenseAmount'],
    },
    feesComplete: { label: '费用已登记完整', permission: 'stock.expenses.read' },
    isHistorical: { label: '历史补录' },
  },
  receipts: {
    id: { label: '到账ID' },
    source: { label: '到账来源' },
    status: { label: '状态' },
    payerName: { label: '转款人', path: ['payer.name', 'payerName'] },
    amount: { label: '到账金额', money: true },
    receivedAt: { label: '实际到账时间' },
    allocatedAmount: { label: '已分配金额', money: true },
    unallocatedAmount: { label: '未分配金额', money: true },
  },
};
const EXPORT_CONFIG = {
  units: {
    method: 'listUnits',
    permission: 'stock.read',
    defaults: ['serialNumber', 'modelName', 'storageGb', 'colorName', 'locationName', 'state'],
    filters: ['q', 'productIds', 'locationIds', 'states', 'sourceLinked'],
  },
  sales: {
    method: 'listSales',
    permission: 'stock.sales.read',
    defaults: [
      'saleNo',
      'channel',
      'status',
      'shippedAt',
      'customerName',
      'salespersonName',
      'saleAmount',
    ],
    filters: ['channel', 'status', 'customerId', 'salespersonId', 'dateField', 'from', 'to'],
  },
  receipts: {
    method: 'listReceipts',
    permission: 'stock.receipts.read',
    defaults: [
      'id',
      'source',
      'payerName',
      'amount',
      'receivedAt',
      'allocatedAmount',
      'unallocatedAmount',
    ],
    filters: ['status', 'source', 'payerId', 'from', 'to'],
  },
};

/** 校验导出对象、字段白名单及字段级读权限。 */
function selectExportFields(ctx, entity, requested) {
  if (!Object.hasOwn(EXPORT_CONFIG, entity)) throw ApiError.badRequest('导出对象无效');
  requirePermissions(ctx, 'stock.read', 'stock.export', EXPORT_CONFIG[entity].permission);
  let fields = requested;
  if (typeof fields === 'string') {
    try {
      fields = JSON.parse(fields);
    } catch (_error) {
      throw ApiError.badRequest('导出字段须为JSON数组');
    }
  }
  if (fields === undefined) fields = EXPORT_CONFIG[entity].defaults;
  if (
    !Array.isArray(fields) ||
    !fields.length ||
    fields.length > MAX_COLUMNS ||
    new Set(fields).size !== fields.length
  )
    throw ApiError.badRequest('导出字段无效或重复');
  for (const field of fields) {
    if (!Object.hasOwn(EXPORT_FIELDS[entity], field))
      throw ApiError.badRequest('包含不支持的导出字段');
    const permission = EXPORT_FIELDS[entity][field].permission;
    if (permission && !ctx.permissions.has(permission))
      throw new ApiError(403, 'FIELD_FORBIDDEN', '无权导出所选金额字段');
  }
  return fields;
}

function cellValue(item, field, config) {
  let value;
  for (const path of config.path || [field]) {
    const candidate = path.split('.').reduce((object, key) => object?.[key], item);
    if (candidate !== undefined) {
      value = candidate;
      break;
    }
  }
  if (value === undefined || value === null) return { t: 's', v: '' };
  if (config.money) {
    if (!/^-?\d{1,12}\.\d{2}$/.test(String(value))) throw ApiError.internal('导出金额投影无效');
    return { t: 'n', v: Number(value), z: '0.00' };
  }
  return {
    t: 's',
    v: safeSpreadsheetText(typeof value === 'boolean' ? (value ? '是' : '否') : value),
  };
}

/** 只从与列表相同的权限投影生成文件，不从模型补回未授权字段。 */
async function exportStock(user, query = {}) {
  try {
    const entity = query.entity;
    const initial = await createReadContext(user);
    const fields = selectExportFields(initial, entity, query.fields);
    const config = EXPORT_CONFIG[entity];
    if (Object.keys(query).some(key => !['entity', 'fields', ...config.filters].includes(key)))
      throw ApiError.badRequest('导出参数包含未知筛选');
    const filters = Object.fromEntries(
      config.filters.filter(key => query[key] !== undefined).map(key => [key, query[key]])
    );
    const items = await models.sequelize.transaction(
      { isolationLevel: 'REPEATABLE READ', readOnly: true },
      async transaction => {
        try {
          const ctx = await createReadContext(user, transaction);
          selectExportFields(ctx, entity, fields);
          const read = require('./stockProjectionService')[config.method];
          const first = await read(ctx, {
            ...filters,
            page: 1,
            pageSize: MAX_EXPORT_ROWS,
            internalExport: true,
          });
          if (first.total > MAX_EXPORT_ROWS)
            throw ApiError.badRequest('导出最多5000条，请缩小筛选范围');
          if (first.items.length !== first.total) throw ApiError.conflict('导出状态异常，请重试');
          return first.items;
        } catch (error) {
          logger.warn('库存文件事务未完成', { code: error.code || error.name });
          throw error;
        }
      }
    );
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      fields.map(field => EXPORT_FIELDS[entity][field].label),
    ]);
    items.forEach((item, row) =>
      fields.forEach((field, column) => {
        sheet[XLSX.utils.encode_cell({ r: row + 1, c: column })] = cellValue(
          item,
          field,
          EXPORT_FIELDS[entity][field]
        );
      })
    );
    sheet['!ref'] = XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: items.length, c: fields.length - 1 },
    });
    sheet['!cols'] = fields.map(() => ({ wch: 24 }));
    XLSX.utils.book_append_sheet(book, sheet, '导出数据');
    return {
      filename: `自有库存-${entity}-${new Date().toISOString().slice(0, 10)}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }),
    };
  } catch (error) {
    logger.warn('库存文件操作未完成', { code: error.code || error.name });
    throw error;
  }
}

module.exports = {
  parseImportFile,
  financialExternalKey,
  safeSpreadsheetText,
  buildImportPlan,
  previewImport,
  getImport,
  commitImport,
  readTemplate,
  exportStock,
  selectExportFields,
};
