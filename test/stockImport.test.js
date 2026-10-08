const crypto = require('crypto');
const XLSX = require('xlsx');
const ApiError = require('../src/utils/ApiError');
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn() }));

jest.mock('../src/models', () =>
  Object.fromEntries(
    [
      'StockSetting',
      'StockProduct',
      'StockLocation',
      'StockParty',
      'StockUnit',
      'StockSale',
      'StockCollection',
      'StockReceipt',
      'Order',
      'StockSaleLine',
      'PickupDevice',
      'StockSaleUnit',
      'StockReceiptAllocation',
      'StockImportJob',
    ].map(name => [name, { findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn() }])
  )
);
jest.mock('../src/services/stockCommandService', () => ({
  createReadContext: jest.fn(),
  runCommand: jest.fn(),
  recordEvent: jest.fn(),
  updateRow: jest.fn(),
  requirePermissions: (ctx, ...codes) => {
    if (codes.some(code => !ctx.permissions.has(code)))
      throw new (require('../src/utils/ApiError'))(403, 'FORBIDDEN', '没有此操作权限');
  },
  assertVersion: (row, version) => {
    if (row.version !== version)
      throw new (require('../src/utils/ApiError'))(409, 'VERSION_CONFLICT', '版本冲突');
  },
}));
jest.mock('../src/services/stockUnitService', () => ({ receiveUnits: jest.fn() }));
jest.mock('../src/services/stockSalesService', () => ({ importHistoricalSale: jest.fn() }));
jest.mock(
  '../src/services/stockFinanceService',
  () => ({ createCollection: jest.fn(), createReceipt: jest.fn() }),
  { virtual: true }
);
jest.mock('../src/services/orderAccessService', () => ({
  scopeOrderWhere: (_user, where) => where,
}));
jest.mock('../src/services/stockProjectionService', () => ({
  listUnits: jest.fn(),
  listSales: jest.fn(),
  listReceipts: jest.fn(),
}));

const db = require('../src/models');
const command = require('../src/services/stockCommandService');
const stockUnits = require('../src/services/stockUnitService');
const stockSales = require('../src/services/stockSalesService');
const finance = require('../src/services/stockFinanceService');
const projection = require('../src/services/stockProjectionService');
const { encryptJson, decryptJson } = require('../src/utils/fieldEncryption');
const service = require('../src/services/stockImportService');
const id = value => `10000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const ALL_PERMISSIONS = [
  'stock.read',
  'stock.import',
  'stock.export',
  'stock.receive',
  'stock.sales.read',
  'stock.sales.ship',
  'stock.cost.read',
  'stock.cost.edit',
  'stock.profit.read',
  'stock.expenses.read',
  'stock.collections.read',
  'stock.collections.edit',
  'stock.receipts.read',
  'stock.receipts.edit',
  'stock.source.link',
  'orders.read',
  'pickups.read',
  'pickups.edit',
];
let ctx;
let savedJob;

function makeFile(rows, sheetMutator) {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (sheetMutator) sheetMutator(sheet);
  XLSX.utils.book_append_sheet(book, sheet, '数据');
  return {
    originalname: '库存.xlsx',
    buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }),
  };
}

function row(data, rowNumber = 2) {
  return { rowNumber, data, errors: [] };
}
function opening(extra = {}) {
  return {
    serialNumber: 'F2LTEST001',
    modelName: 'iPhone 测试',
    storageGb: '256',
    colorName: '蓝色',
    locationName: '重庆测试仓',
    ...extra,
  };
}
function historical(extra = {}) {
  return {
    ...opening(),
    saleKey: '旧销售1',
    channel: 'local',
    customerName: '测试客户',
    salespersonName: '测试负责人',
    handlerName: '测试交货人',
    shippedAt: '2026-09-30T10:00:00+08:00',
    saleAmount: '9000.00',
    ...extra,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.FIELD_ENCRYPTION_KEY = '31'.repeat(32);
  ctx = {
    user: { id: 7, role: 'operator' },
    permissions: new Set(ALL_PERMISSIONS),
    transaction: { id: 'test-tx' },
    operationId: id(99),
  };
  savedJob = undefined;
  Object.values(db).forEach(model => {
    model.findAll?.mockResolvedValue([]);
    model.findByPk?.mockResolvedValue(null);
  });
  db.StockSetting.findByPk.mockResolvedValue({
    id: 1,
    version: 0,
    cutoverAt: new Date('2026-10-01T00:00:00+08:00'),
  });
  db.StockProduct.findAll.mockResolvedValue([
    {
      id: id(1),
      version: 0,
      modelName: 'iPhone 测试',
      storageGb: 256,
      colorName: '蓝色',
      isActive: true,
    },
  ]);
  db.StockLocation.findAll.mockResolvedValue([
    { id: id(2), version: 0, name: '重庆测试仓', kind: 'warehouse', isActive: true },
    { id: id(3), version: 0, name: '历史出货地点待核实', kind: 'historical', isActive: false },
    { id: id(4), version: 0, name: '测试代卖', kind: 'consignee', isActive: true },
  ]);
  db.StockParty.findAll.mockResolvedValue([
    { id: id(10), version: 0, name: '测试负责人', roles: ['salesperson'], isActive: true },
    { id: id(11), version: 0, name: '测试客户', roles: ['customer'], isActive: true },
    { id: id(12), version: 0, name: '测试交货人', roles: ['handler'], isActive: true },
    { id: id(13), version: 0, name: '另一负责人', roles: ['salesperson'], isActive: true },
  ]);
  command.createReadContext.mockImplementation(() => Promise.resolve(ctx));
  db.sequelize = { transaction: jest.fn((_options, work) => work(ctx.transaction)) };
  command.runCommand.mockImplementation((_user, _input, _action, _permissions, work) => work(ctx));
  command.recordEvent.mockResolvedValue();
  command.updateRow.mockImplementation((_ctx, target, values) => {
    Object.assign(target, values, { version: target.version + 1 });
    return Promise.resolve(target);
  });
  db.StockImportJob.create.mockImplementation(values => {
    savedJob = { id: id(30), version: 0, ...values };
    return Promise.resolve(savedJob);
  });
  db.StockImportJob.findByPk.mockImplementation(() => Promise.resolve(savedJob));
  stockUnits.receiveUnits.mockResolvedValue({ unitIds: [id(20)] });
  stockSales.importHistoricalSale.mockResolvedValue({ saleId: id(40) });
  finance.createCollection.mockResolvedValue({ collectionId: id(50) });
  finance.createReceipt.mockResolvedValue({ receiptId: id(60) });
});

describe('导出读取同一权限投影', () => {
  test('只导出白名单列，文本不是公式，金额保持数值及两位格式', async () => {
    try {
      projection.listSales.mockResolvedValue({
        total: 1,
        items: [
          {
            saleNo: '=HYPERLINK("https://example.invalid")',
            totalAmount: '18000.50',
            customer: { name: '@SUM(A1)' },
            confirmedCostAmount: '16000.00',
            hidden: '禁止导出',
          },
        ],
      });
      const result = await service.exportStock(ctx.user, {
        entity: 'sales',
        fields: '["saleNo","customerName","saleAmount","costAmount"]',
        channel: 'local',
      });
      const book = XLSX.read(result.buffer);
      const sheet = book.Sheets.导出数据;
      expect(sheet.A2.t).toBe('s');
      expect(sheet.A2.v).toMatch(/^'=/);
      expect(sheet.A2.f).toBeUndefined();
      expect(sheet.B2.v).toBe("'@SUM(A1)");
      expect(sheet.C2.t).toBe('n');
      expect(sheet.C2.v).toBe(18000.5);
      expect(sheet.D2.v).toBe(16000);
      expect(sheet['!ref']).toBe('A1:D2');
      expect(db.sequelize.transaction).toHaveBeenCalledWith(
        { isolationLevel: 'REPEATABLE READ', readOnly: true },
        expect.any(Function)
      );
      expect(projection.listSales).toHaveBeenCalledWith(ctx, {
        channel: 'local',
        page: 1,
        pageSize: 5000,
        internalExport: true,
      });
    } catch (error) {
      error.message = `库存导出回归失败：${error.message}`;
      throw error;
    }
  });

  test('权限撤销、超5000行和未知筛选字段拒绝，缺失金额留空而不是0', async () => {
    try {
      ctx.permissions.delete('stock.receipts.read');
      await expect(service.exportStock(ctx.user, { entity: 'receipts' })).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(service.exportStock(ctx.user, { entity: 'units', hidden: 'x' })).rejects.toThrow(
        '未知'
      );
      projection.listUnits.mockResolvedValue({ total: 5001, items: [] });
      await expect(service.exportStock(ctx.user, { entity: 'units' })).rejects.toThrow('5000');
      projection.listUnits.mockResolvedValue({
        total: 1,
        items: [{ serialNumber: 'F2LTEST001', officialCostAmount: null }],
      });
      const result = await service.exportStock(ctx.user, {
        entity: 'units',
        fields: ['serialNumber', 'officialCostAmount'],
      });
      expect(XLSX.read(result.buffer).Sheets.导出数据.B2.v).toBe('');
    } catch (error) {
      error.message = `库存导出回归失败：${error.message}`;
      throw error;
    }
  });
});

describe('库存表格安全解析与模板', () => {
  test('中文表头、SN原始字符串和UTF-8 CSV可读取', () => {
    const file = makeFile([
      ['SN', '型号', '容量GB', '颜色', '仓库或代卖位置'],
      ['F2LTEST001', 'iPhone 测试', '256', '蓝色', '重庆测试仓'],
    ]);
    expect(service.parseImportFile(file, 'opening').rows[0]).toMatchObject({
      rowNumber: 2,
      data: opening(),
      errors: [],
    });
    const csv = {
      originalname: '导入.csv',
      buffer: Buffer.from(
        '\uFEFFSN,型号,容量GB,颜色,仓库或代卖位置\r\nF2LTEST001,iPhone 测试,256,蓝色,重庆测试仓'
      ),
    };
    expect(service.parseImportFile(csv, 'opening').rows).toHaveLength(1);
  });

  test('未知列和重复别名拒绝，公式数据行只报错不执行', () => {
    expect(() =>
      service.parseImportFile(
        makeFile([
          ['SN', '__proto__'],
          ['F2LTEST001', 'x'],
        ]),
        'opening'
      )
    ).toThrow('未知');
    expect(() =>
      service.parseImportFile(
        makeFile([
          ['SN', 'serialNumber'],
          ['F2LTEST001', 'F2LTEST001'],
        ]),
        'opening'
      )
    ).toThrow('重复');
    const file = makeFile([['SN'], ['F2LTEST001']], sheet => {
      sheet.A2.f = 'HYPERLINK("https://example.invalid")';
    });
    expect(service.parseImportFile(file, 'opening').rows[0].errors[0].code).toBe(
      'FORMULA_NOT_ALLOWED'
    );
  });

  test('500行通过，501行和超大文件拒绝', () => {
    const rows = Array.from({ length: 500 }, (_, index) => [
      `F2L${String(index).padStart(7, '0')}`,
    ]);
    expect(service.parseImportFile(makeFile([['SN'], ...rows]), 'opening').rows).toHaveLength(500);
    expect(() =>
      service.parseImportFile(makeFile([['SN'], ...rows, ['F2L9999999']]), 'opening')
    ).toThrow('500');
    expect(() =>
      service.parseImportFile(
        { originalname: 'a.csv', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) },
        'opening'
      )
    ).toThrow('10MiB');
    expect(() =>
      service.parseImportFile({ originalname: 'a.xlsm', buffer: Buffer.from('x') }, 'opening')
    ).toThrow('仅支持');
  });

  test('压缩包虚报巨大展开量时在解析前拒绝', () => {
    const file = makeFile([['SN'], ['F2LTEST001']]);
    const central = file.buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    file.buffer.writeUInt32LE(60 * 1024 * 1024, central + 24);
    expect(() => service.parseImportFile(file, 'opening')).toThrow('50MiB');
  });

  test('正常DEFLATE表格可解析，虚报过小展开量不能绕过实际大小校验', () => {
    const file = makeFile([['SN'], ['F2LTEST001']]);
    const book = XLSX.read(file.buffer);
    file.buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true });
    expect(service.parseImportFile(file, 'opening').rows).toHaveLength(1);
    const central = file.buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    file.buffer.writeUInt32LE(1, central + 24);
    expect(() => service.parseImportFile(file, 'opening')).toThrow();
  });

  test('稳定资金键保留原键大小写，不使用文件名行号', () => {
    expect(service.financialExternalKey(' Ａ渠道 ', ' txn-01 ')).toBe(
      service.financialExternalKey('A渠道', 'txn-01')
    );
    expect(service.financialExternalKey('A渠道', 'txn-01')).not.toBe(
      service.financialExternalKey('A渠道', 'TXN-01')
    );
    expect(service.financialExternalKey('A渠道', 'txn-01')).not.toBe(
      service.financialExternalKey('B渠道', 'txn-01')
    );
  });

  test.each(['=1+1', '+SUM(A1)', '-cmd', '@SUM(A1)', ' \t=1', '\nunsafe'])(
    '导出危险文本按纯文本转义：%s',
    value => {
      expect(service.safeSpreadsheetText(value)).toBe(`'${value}`);
    }
  );

  test('模板无示例记录，缺成本和订单权限时不暴露可填写敏感列', async () => {
    try {
      ctx.permissions.delete('stock.cost.edit');
      ctx.permissions.delete('stock.source.link');
      const result = await service.readTemplate(ctx.user, 'opening');
      const book = XLSX.read(result.buffer);
      const rows = XLSX.utils.sheet_to_json(book.Sheets.数据, { header: 1 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toContain('官网成本');
      expect(rows[0]).not.toContain('来源订单ID');
      expect(book.SheetNames).toEqual(['数据', '填写说明']);
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });
});

describe('四类导入预览业务校验', () => {
  test('SN有值但来源为空可期初入库；默认采用盘点时点且不臆造拿货日期', async () => {
    try {
      const plan = await service.buildImportPlan(ctx, 'opening', '旧台账', [row(opening())]);
      expect(plan.errors).toEqual([]);
      expect(plan.groups[0].input).toEqual({
        serialBarcode: 'F2LTEST001',
        productId: id(1),
        locationId: id(2),
        receivedAt: '2026-09-30T16:00:00.000Z',
      });
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });

  test('现货SN、文件内重复SN、未知来源订单及错误成本分别拒绝', async () => {
    try {
      db.StockUnit.findAll.mockResolvedValue([
        { id: id(20), version: 0, serialNumber: 'F2LTEST001', state: 'in_stock' },
      ]);
      expect(
        (await service.buildImportPlan(ctx, 'opening', '旧台账', [row(opening())])).errors[0].code
      ).toBe('UNIT_STATE_CONFLICT');
      db.StockUnit.findAll.mockResolvedValue([]);
      expect(
        (
          await service.buildImportPlan(ctx, 'opening', '旧台账', [
            row(opening()),
            row(opening(), 3),
          ])
        ).errors[0].code
      ).toBe('SN_EXISTS');
      expect(
        (
          await service.buildImportPlan(ctx, 'opening', '旧台账', [
            row(opening({ sourceOrderId: '2' })),
          ])
        ).errors[0].code
      ).toBe('NOT_FOUND');
      expect(
        (
          await service.buildImportPlan(ctx, 'opening', '旧台账', [
            row(opening({ costAmount: '7999.001' })),
          ])
        ).errors[0].code
      ).toBe('MONEY_INVALID');
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });

  test('历史销售按真实销售键归组，未知出货地使用历史位置，不经过当前仓库', async () => {
    try {
      const plan = await service.buildImportPlan(ctx, 'historical_sales', '旧台账', [
        row(historical()),
        row(historical({ serialNumber: 'F2LTEST002' }), 3),
      ]);
      expect(plan.errors).toEqual([]);
      expect(plan.groups).toHaveLength(1);
      expect(plan.groups[0].input.units).toHaveLength(2);
      expect(plan.groups[0].input.units[0].fromLocationId).toBe(id(3));
      expect(plan.groups[0].input.units[0].saleAmount).toBe('9000.00');
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });

  test('历史销售晚于切换点或同组表头冲突拒绝', async () => {
    try {
      expect(
        (
          await service.buildImportPlan(ctx, 'historical_sales', '旧台账', [
            row(historical({ shippedAt: '2026-10-02T12:00:00+08:00' })),
          ])
        ).errors
      ).toHaveLength(1);
      expect(
        (
          await service.buildImportPlan(ctx, 'historical_sales', '旧台账', [
            row(historical()),
            row(historical({ serialNumber: 'F2LTEST002', salespersonName: '另一负责人' }), 3),
          ])
        ).errors[0].message
      ).toContain('必须一致');
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });

  test('权限撤销后成本预览、公司直收、指定金额导出均不可访问', async () => {
    try {
      ctx.permissions.delete('stock.cost.edit');
      await expect(
        service.buildImportPlan(ctx, 'opening', '旧台账', [
          row(
            opening({ costAmount: '7999.00', acquiredOn: '2026-09-30', costBasis: '当日官网价' })
          ),
        ])
      ).rejects.toMatchObject({ statusCode: 403 });
      ctx.permissions.delete('stock.receipts.edit');
      await expect(
        service.buildImportPlan(ctx, 'collections', '旧台账', [row({ destination: 'company' })])
      ).rejects.toMatchObject({ statusCode: 403 });
      ctx.permissions.delete('stock.cost.read');
      expect(() => service.selectExportFields(ctx, 'units', ['officialCostAmount'])).toThrow(
        '无权'
      );
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });

  function setupSales() {
    db.StockSale.findAll.mockResolvedValue([
      { id: id(40), version: 0, saleNo: 'SYN-1', status: 'shipped' },
    ]);
    db.StockSaleLine.findAll.mockResolvedValue([{ id: id(41), version: 0, saleId: id(40) }]);
    db.StockSaleUnit.findAll.mockResolvedValue([
      { id: id(42), version: 0, saleLineId: id(41), stockUnitId: id(20), saleAmount: '9000.00' },
      { id: id(43), version: 0, saleLineId: id(41), stockUnitId: id(21), saleAmount: '9000.00' },
    ]);
    db.StockUnit.findAll.mockResolvedValue([
      { id: id(20), version: 0, serialNumber: 'F2LTEST001', state: 'sold' },
      { id: id(21), version: 0, serialNumber: 'F2LTEST002', state: 'sold' },
    ]);
  }

  test('客户付款必须是销售全额；已存在稳定键拒绝重导', async () => {
    try {
      setupSales();
      const data = {
        externalRecordKey: 'pay-1',
        saleNo: 'SYN-1',
        destination: 'company',
        amount: '18000',
        receivedAt: '2026-10-01T12:00:00+08:00',
      };
      expect(
        (await service.buildImportPlan(ctx, 'collections', '旧台账', [row(data)])).errors
      ).toEqual([]);
      expect(
        (
          await service.buildImportPlan(ctx, 'collections', '旧台账', [
            row({ ...data, amount: '9000' }),
          ])
        ).errors[0].message
      ).toContain('全部已售');
      db.StockCollection.findAll.mockResolvedValue([
        {
          id: id(50),
          version: 0,
          externalRecordKey: service.financialExternalKey('旧台账', 'pay-1'),
        },
      ]);
      expect(
        (await service.buildImportPlan(ctx, 'collections', '旧台账', [row(data)])).errors[0].message
      ).toContain('已导入');
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });

  test('同一笔到账分配多台不累计头金额，跨代收人和超额拒绝', async () => {
    try {
      setupSales();
      db.StockCollection.findAll.mockImplementation(options => {
        if (options.where.externalRecordKey) return Promise.resolve([]);
        return Promise.resolve([
          { id: id(50), version: 0, saleId: id(40), destination: 'agent', collectorId: id(10) },
        ]);
      });
      const data = {
        externalRecordKey: 'receipt-1',
        payerName: '测试负责人',
        amount: '18000',
        receivedAt: '2026-10-02T12:00:00+08:00',
        saleNo: 'SYN-1',
        allocationSerialNumber: 'F2LTEST001',
        allocationAmount: '9000',
      };
      const plan = await service.buildImportPlan(ctx, 'receipts', '旧台账', [
        row(data),
        row({ ...data, allocationSerialNumber: 'F2LTEST002' }, 3),
      ]);
      expect(plan.errors).toEqual([]);
      expect(plan.groups[0].input.amount).toBe('18000.00');
      expect(plan.groups[0].input.allocations).toHaveLength(2);
      expect(
        (
          await service.buildImportPlan(ctx, 'receipts', '旧台账', [
            row({ ...data, payerName: '另一负责人' }),
          ])
        ).errors[0].code
      ).toBe('COLLECTOR_MISMATCH');
      expect(
        (
          await service.buildImportPlan(ctx, 'receipts', '旧台账', [
            row({ ...data, allocationAmount: '9000.01' }),
          ])
        ).errors[0].code
      ).toBe('RECEIPT_OVERALLOCATED');
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });
});

describe('预览加密与确认', () => {
  test('来源订单TAG范围撤销后不能回读成功预览中的旧来源信息', async () => {
    try {
      db.Order.findAll.mockResolvedValue([{ id: 42 }]);
      const input = opening({ sourceOrderId: '42' });
      const preview = await service.previewImport(ctx.user, {
        kind: 'opening',
        sourceLabel: '旧台账',
        file: makeFile([Object.keys(input), Object.values(input)]),
      });
      expect(preview.canCommit).toBe(true);
      db.Order.findAll.mockResolvedValue([]);
      await expect(service.getImport(ctx.user, preview.id)).rejects.toMatchObject({
        statusCode: 403,
      });
    } catch (error) {
      error.message = `库存来源回归失败：${error.message}`;
      throw error;
    }
  });
  test('预览原文只加密保存；确认重读数据且只传业务服务受控参数', async () => {
    try {
      const file = makeFile([Object.keys(opening()), Object.values(opening())]);
      const preview = await service.previewImport(ctx.user, {
        kind: 'opening',
        sourceLabel: '旧台账',
        file,
      });
      expect(JSON.stringify(savedJob.payloadCiphertext)).not.toContain('F2LTEST001');
      expect(decryptJson(savedJob.payloadCiphertext).rows[0].data.serialNumber).toBe('F2LTEST001');
      expect(file.buffer).toBeNull();
      await service.commitImport(ctx, preview.id, {
        requestKey: crypto.randomUUID(),
        expectedVersion: 0,
        previewHash: preview.previewHash,
      });
      expect(stockUnits.receiveUnits).toHaveBeenCalledWith(
        { ...ctx, importing: true },
        {
          mode: 'opening',
          units: [expect.objectContaining({ serialBarcode: 'F2LTEST001' })],
        }
      );
      expect(savedJob.status).toBe('committed');
      expect(savedJob.resultRefs.unitIds).toEqual([id(20)]);
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });

  test('预览之后实物入库、权限撤销、他人查询、过期或错误hash均拒绝', async () => {
    try {
      const file = makeFile([Object.keys(opening()), Object.values(opening())]);
      const preview = await service.previewImport(ctx.user, {
        kind: 'opening',
        sourceLabel: '旧台账',
        file,
      });
      const input = {
        requestKey: crypto.randomUUID(),
        expectedVersion: 0,
        previewHash: preview.previewHash,
      };
      db.StockUnit.findAll.mockResolvedValue([
        { id: id(20), version: 1, serialNumber: 'F2LTEST001', state: 'in_stock' },
      ]);
      await expect(service.commitImport(ctx, preview.id, input)).rejects.toMatchObject({
        code: 'IMPORT_PREVIEW_STALE',
      });
      expect(stockUnits.receiveUnits).not.toHaveBeenCalled();
      db.StockUnit.findAll.mockResolvedValue([]);
      ctx.permissions.delete('stock.receive');
      await expect(service.commitImport(ctx, preview.id, input)).rejects.toMatchObject({
        statusCode: 403,
      });
      ctx.permissions.add('stock.receive');
      ctx.user.id = 8;
      await expect(service.getImport(ctx.user, preview.id)).rejects.toMatchObject({
        statusCode: 404,
      });
      ctx.user.id = 7;
      await expect(
        service.commitImport(ctx, preview.id, { ...input, previewHash: 'invalid' })
      ).rejects.toMatchObject({ code: 'IMPORT_PREVIEW_STALE' });
      savedJob.expiresAt = new Date(0);
      await expect(service.commitImport(ctx, preview.id, input)).rejects.toMatchObject({
        code: 'IMPORT_PREVIEW_STALE',
      });
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });

  test('历史提交仅调用历史服务，不能调用收货扣减当前库存', async () => {
    try {
      const rows = [row(historical())];
      const plan = await service.buildImportPlan(ctx, 'historical_sales', '旧台账', rows);
      savedJob = {
        id: id(30),
        version: 0,
        kind: 'historical_sales',
        createdBy: 7,
        sourceLabel: '旧台账',
        status: 'preview',
        expiresAt: new Date(Date.now() + 10000),
        previewHash: plan.previewHash,
        payloadCiphertext: encryptJson({ rows, plan }),
      };
      await service.commitImport(ctx, savedJob.id, {
        expectedVersion: 0,
        previewHash: plan.previewHash,
      });
      expect(stockSales.importHistoricalSale).toHaveBeenCalledTimes(1);
      expect(stockUnits.receiveUnits).not.toHaveBeenCalled();
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });

  test('业务写入失败时不把job标记成功，错误交外层统一事务回滚', async () => {
    try {
      const rows = [row(opening())];
      const plan = await service.buildImportPlan(ctx, 'opening', '旧台账', rows);
      savedJob = {
        id: id(30),
        version: 0,
        kind: 'opening',
        createdBy: 7,
        sourceLabel: '旧台账',
        status: 'preview',
        expiresAt: new Date(Date.now() + 10000),
        previewHash: plan.previewHash,
        payloadCiphertext: encryptJson({ rows, plan }),
      };
      stockUnits.receiveUnits.mockRejectedValueOnce(new ApiError(409, 'SN_EXISTS', '并发冲突'));
      await expect(
        service.commitImport(ctx, savedJob.id, {
          expectedVersion: 0,
          previewHash: plan.previewHash,
        })
      ).rejects.toMatchObject({ code: 'SN_EXISTS' });
      expect(savedJob.status).toBe('preview');
      expect(command.updateRow).not.toHaveBeenCalled();
    } catch (error) {
      error.message = `库存文件回归失败：${error.message}`;
      throw error;
    }
  });
});
