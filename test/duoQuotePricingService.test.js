jest.mock('../src/models', () => ({
  sequelize: { transaction: jest.fn(), query: jest.fn() },
  DuoQuotePricingSetting: { findByPk: jest.fn() },
  DuoQuotePriceAdjustment: { findAll: jest.fn(), bulkCreate: jest.fn() },
  DuoQuotePricingVersion: { findByPk: jest.fn(), create: jest.fn(), findAndCountAll: jest.fn() },
}));
jest.mock('../src/repositories/quoteSourceRepository', () => ({ fetchLatestDuoBatch: jest.fn() }));
const models = require('../src/models');
const repository = require('../src/repositories/quoteSourceRepository');
const service = require('../src/services/duoQuotePricingService');
let source;
let setting;
let data;
const actor = { id: 7, nickname: '报价管理员' };

beforeEach(async () => {
  jest.clearAllMocks();
  models.sequelize.query.mockResolvedValue([[], {}]);
  const sourceUpdatedAt = new Date(Date.now() - 60000);
  source = {
    sourceUpdatedAt,
    lastCheckedAt: new Date(),
    items: [256, 512, 1024, 2048].flatMap(storageGb =>
      ['星光白色', '夜空色'].map(color => ({
        productModel: 'Duo',
        storageGb,
        color,
        sourceUpdatedAt,
        wholesalePrice: '16000.25',
        officialPrice: '15999',
      }))
    ),
  };
  setting = {
    version: 0,
    pricingUpdatedAt: null,
    update: jest.fn(values => Promise.resolve(Object.assign(setting, values))),
  };
  models.sequelize.transaction.mockImplementation(callback =>
    Promise.resolve(callback({ LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } }))
  );
  models.DuoQuotePricingSetting.findByPk.mockResolvedValue(setting);
  models.DuoQuotePriceAdjustment.findAll.mockResolvedValue([]);
  models.DuoQuotePricingVersion.findByPk.mockResolvedValue(null);
  models.DuoQuotePricingVersion.create.mockResolvedValue({});
  repository.fetchLatestDuoBatch.mockResolvedValue(source);
  data = await service.getAdminQuotes();
});

function body(extra = {}) {
  return {
    productKeys: [data.items[0].productKey],
    mode: 'markup',
    amount: 80,
    expectedVersion: data.version,
    expectedSourceVersion: data.sourceVersion,
    ...extra,
  };
}

test('初始化不冒充人工调价时间，预览不写入，缺价不补0', async () => {
  expect(data.updatedAt).toEqual(source.sourceUpdatedAt);
  expect(data.pricingUpdatedAt).toBeNull();
  const preview = await service.preview({
    operation: 'adjust',
    ...body({ mode: 'retail', amount: '16100.50' }),
  });
  expect(preview.items[0]).toMatchObject({
    previousMarkup: 50,
    markup: 100.25,
    previousRetailPrice: 16050.25,
    retailPrice: 16100.5,
    selected: true,
  });
  expect(preview.items[1].selected).toBe(false);
  expect(models.DuoQuotePriceAdjustment.bulkCreate).not.toHaveBeenCalled();
  expect(models.DuoQuotePricingVersion.create).not.toHaveBeenCalled();
});

test('零售价输入只保存加价、完整8款历史含操作时基价和前后价', async () => {
  expect(await service.saveAdjustments(actor, body({ mode: 'retail', amount: 16100.5 }))).toEqual({
    version: 1,
    selectedCount: 1,
  });
  const saved = models.DuoQuotePriceAdjustment.bulkCreate.mock.calls[0][0];
  expect(saved[0]).toMatchObject({ markup: 100.25, updatedBy: 7 });
  expect(saved[0]).not.toHaveProperty('retailPrice');
  expect(saved[0]).not.toHaveProperty('wholesalePrice');
  const history = models.DuoQuotePricingVersion.create.mock.calls[0][0];
  expect(history.snapshot).toHaveLength(8);
  expect(history.summary.changes[0]).toMatchObject({
    previousMarkup: 50,
    markup: 100.25,
    wholesalePrice: 16000.25,
    previousRetailPrice: 16050.25,
    retailPrice: 16100.5,
  });
  expect(history.actorName).toBe('报价管理员');
  expect(repository.fetchLatestDuoBatch).toHaveBeenCalledTimes(3);
});

test('预览和提交都拒绝旧设置或旧来源版本', async () => {
  await expect(
    service.preview({ operation: 'adjust', ...body({ expectedVersion: 2 }) })
  ).rejects.toMatchObject({ statusCode: 409, code: 'CONCURRENT_MODIFICATION' });
  source.items[0].wholesalePrice = 16001;
  await expect(service.saveAdjustments(actor, body())).rejects.toMatchObject({
    code: 'DUO_SOURCE_CHANGED',
  });
  expect(models.DuoQuotePriceAdjustment.bulkCreate).not.toHaveBeenCalled();
});

test('提交末次来源变化拒绝，历史失败传播至外层事务回滚', async () => {
  const changed = structuredClone(source);
  changed.items[0].wholesalePrice = 17000;
  repository.fetchLatestDuoBatch.mockResolvedValueOnce(source).mockResolvedValueOnce(changed);
  await expect(service.saveAdjustments(actor, body())).rejects.toMatchObject({
    code: 'DUO_SOURCE_CHANGED',
  });
  setting.version = 0;
  repository.fetchLatestDuoBatch.mockResolvedValue(source);
  models.DuoQuotePricingVersion.create.mockRejectedValueOnce(new Error('history failure'));
  await expect(service.saveAdjustments(actor, body())).rejects.toThrow('history failure');
});

test('缺批发价允许markup而retail拒绝，负加价保留null', async () => {
  source.items[0].wholesalePrice = null;
  data = await service.getAdminQuotes();
  await expect(
    service.preview({ operation: 'adjust', ...body({ mode: 'retail', amount: 100 }) })
  ).rejects.toMatchObject({ code: 'DUO_BASE_PRICE_REQUIRED' });
  const result = await service.preview({ operation: 'adjust', ...body({ amount: -100 }) });
  expect(result.items[0]).toMatchObject({ markup: -100, retailPrice: null });
});

test('重置明确恢复50；恢复完整历史按当前来源重新计算', async () => {
  models.DuoQuotePriceAdjustment.findAll.mockResolvedValue([
    { productKey: data.items[0].productKey, markup: -50 },
  ]);
  const reset = await service.preview({
    operation: 'reset',
    productKeys: [data.items[0].productKey],
    expectedVersion: 0,
    expectedSourceVersion: data.sourceVersion,
  });
  expect(reset.items[0]).toMatchObject({ previousMarkup: -50, markup: 50, retailPrice: 16050.25 });
  const target = {
    revision: 9,
    snapshot: data.items.map(item => ({
      productKey: item.productKey,
      productModel: item.productModel,
      storageGb: item.storageGb,
      color: item.color,
      markup: 80,
    })),
  };
  models.DuoQuotePricingVersion.findByPk.mockResolvedValue(target);
  const id = '00000000-0000-4000-8000-000000000000';
  const restored = await service.preview({
    operation: 'restore',
    versionId: id,
    expectedVersion: 0,
    expectedSourceVersion: data.sourceVersion,
  });
  expect(restored.items[0]).toMatchObject({ markup: 80, retailPrice: 16080.25 });
  target.snapshot.pop();
  await expect(
    service.restoreVersion(actor, id, {
      expectedVersion: 0,
      expectedSourceVersion: data.sourceVersion,
    })
  ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
});

test('历史支持全部分页并验证参数与快照结构', async () => {
  models.DuoQuotePricingVersion.findAndCountAll.mockResolvedValue({
    count: 23,
    rows: [
      {
        id: 'example',
        revision: 3,
        action: 'adjust',
        summary: { changes: [] },
        actorName: '管理员',
        snapshot: [],
      },
    ],
  });
  expect(await service.listVersions({ limit: '20', offset: '20' })).toMatchObject({
    total: 23,
    offset: 20,
    limit: 20,
  });
  await expect(service.listVersions({ offset: '-1' })).rejects.toMatchObject({
    code: 'VALIDATION_ERROR',
  });
  await expect(service.listVersions({ limit: true })).rejects.toMatchObject({
    code: 'VALIDATION_ERROR',
  });
});

test.each([
  { amount: null },
  { amount: true },
  { amount: '1.001' },
  { amount: '1e2' },
  { productKeys: [] },
  { expectedSourceVersion: null },
  { mode: 'other' },
  { wholesalePrice: 100 },
])('写入拒绝非法输入 %p', async extra => {
  await expect(service.saveAdjustments(actor, body(extra))).rejects.toMatchObject({
    code: 'VALIDATION_ERROR',
  });
  expect(models.DuoQuotePriceAdjustment.bulkCreate).not.toHaveBeenCalled();
});

test('旧负加价遇来源降价后台仍可打开并重置，拟保存负价仍拒绝', async () => {
  source.items[0].wholesalePrice = 10;
  models.DuoQuotePriceAdjustment.findAll.mockResolvedValue([
    { productKey: data.items[0].productKey, markup: -50 },
  ]);
  data = await service.getAdminQuotes();
  expect(data.items[0]).toMatchObject({
    markup: -50,
    retailPrice: null,
    pricingError: 'DUO_RETAIL_PRICE_INVALID',
  });
  const reset = await service.preview({
    operation: 'reset',
    productKeys: [data.items[0].productKey],
    expectedVersion: 0,
    expectedSourceVersion: data.sourceVersion,
  });
  expect(reset.items[0]).toMatchObject({ previousRetailPrice: null, markup: 50, retailPrice: 60 });
  expect(reset.items[0]).not.toHaveProperty('pricingError');
  await expect(
    service.preview({ operation: 'adjust', ...body({ amount: -20 }) })
  ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
});

test('事务末尾在最终来源校验后排队只含版本的通知，SQL失败向事务传播', async () => {
  await service.saveAdjustments(actor, body());
  expect(models.sequelize.query).toHaveBeenCalledWith(
    'SELECT pg_notify(:channel, :payload)',
    expect.objectContaining({
      replacements: { channel: 'duo_quote_pricing_changed', payload: '{"version":1}' },
      transaction: expect.any(Object),
    })
  );
  setting.version = 0;
  models.sequelize.query.mockRejectedValueOnce(new Error('notify unavailable'));
  await expect(service.saveAdjustments(actor, body())).rejects.toThrow('notify unavailable');
});
