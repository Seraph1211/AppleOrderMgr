jest.mock('../src/models', () => ({
  sequelize: { transaction: jest.fn() },
  QuotePricingSetting: { findByPk: jest.fn() },
  QuotePriceAdjustment: { findAll: jest.fn() },
  QuotePricingVersion: { findAll: jest.fn() },
}));

jest.mock('../src/repositories/quoteSourceRepository', () => ({
  fetchLatestIphone18Batch: jest.fn(),
  closeQuoteSourcePool: jest.fn(),
}));

const {
  sequelize,
  QuotePricingSetting: Setting,
  QuotePriceAdjustment: Adjustment,
} = require('../src/models');
const sourceRepository = require('../src/repositories/quoteSourceRepository');
const service = require('../src/services/quotePricingService');
const { createProductKey } = require('../src/services/quotePricingCore');

const updatedAt = new Date();
const rows = [
  {
    productModel: '18 Pro',
    storageGb: 256,
    color: '黑色',
    specCode: 'TQ4/T74',
    basePrice: 10000,
    officialPrice: 9999,
    sourceUpdatedAt: updatedAt,
    crawledAt: updatedAt,
  },
  {
    productModel: '18 Pro Max',
    storageGb: 256,
    color: '银色',
    specCode: 'YQ4/Y74',
    basePrice: 11000,
    officialPrice: 10999,
    sourceUpdatedAt: updatedAt,
    crawledAt: updatedAt,
  },
];

describe('iPhone 18 公开报价字段边界', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Setting.findByPk.mockResolvedValue({
      publicEnabled: true,
      updatedAt,
      version: 3,
      displayOrder: [createProductKey(rows[1]), createProductKey(rows[0])],
    });
    sourceRepository.fetchLatestIphone18Batch.mockResolvedValue({
      items: rows,
      sourceUpdatedAt: updatedAt,
      lastCheckedAt: updatedAt,
    });
    Adjustment.findAll.mockResolvedValue([
      {
        productKey: createProductKey(rows[0]),
        percentage: '5.0000',
        fixedAmount: '-100.00',
        updatedAt,
      },
    ]);
  });

  test('保存完整逐行顺序并递增乐观锁版本', async () => {
    const setting = {
      publicEnabled: true,
      updatedAt,
      version: 3,
      displayOrder: [],
      update: jest.fn(function update(values) {
        Object.assign(this, values);
        return Promise.resolve(this);
      }),
    };
    Setting.findByPk.mockResolvedValue(setting);
    sequelize.transaction.mockImplementation(callback => callback({ LOCK: { UPDATE: 'UPDATE' } }));
    const productKeys = rows.map(createProductKey).reverse();

    await expect(
      service.saveDisplayOrder(
        { id: 7, nickname: '报价管理员' },
        { productKeys, expectedVersion: 3 }
      )
    ).resolves.toEqual({ version: 4, itemCount: 2 });
    expect(setting.update).toHaveBeenCalledWith(
      { displayOrder: productKeys, version: 4, updatedBy: 7 },
      expect.objectContaining({ transaction: expect.any(Object) })
    );
  });

  test('展示顺序缺少当前商品时拒绝保存', async () => {
    await expect(
      service.saveDisplayOrder(
        { id: 7 },
        { productKeys: [createProductKey(rows[0])], expectedVersion: 3 }
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_PRODUCTS_CHANGED' });
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  test('公开响应只返回最终报价白名单', async () => {
    const result = await service.getPublicQuotes();
    expect(result.enabled).toBe(true);
    expect(result.items[0]).toEqual({
      productKey: createProductKey(rows[1]),
      productName: 'iPhone 18 Pro Max 256GB 银色',
      productModel: '18 Pro Max',
      storageGb: 256,
      color: '银色',
      quotePrice: 11000,
      officialPrice: 10999,
    });
    expect(result.items[0]).not.toHaveProperty('basePrice');
    expect(result.items[0]).not.toHaveProperty('percentage');
    expect(result.items[0]).not.toHaveProperty('fixedAmount');
    expect(result.items[0]).not.toHaveProperty('specCode');
    expect(result.filters.colors).toEqual(['黑色', '银色']);
  });

  test('公开开关关闭时不访问来源库', async () => {
    Setting.findByPk.mockResolvedValue({ publicEnabled: false, updatedAt, version: 4 });
    await expect(service.getPublicQuotes()).rejects.toMatchObject({ code: 'QUOTE_PAGE_PAUSED' });
    expect(sourceRepository.fetchLatestIphone18Batch).not.toHaveBeenCalled();
  });

  test('管理员响应包含原价和调整字段', async () => {
    const result = await service.getAdminQuotes();
    expect(result).toMatchObject({ publicEnabled: true, version: 3 });
    expect(result.items[1]).toMatchObject({
      basePrice: 10000,
      percentage: 5,
      fixedAmount: -100,
      quotePrice: 10400,
      specCode: 'TQ4/T74',
    });
    expect(result.defaultOrder).toEqual(rows.map(createProductKey));
  });
});
