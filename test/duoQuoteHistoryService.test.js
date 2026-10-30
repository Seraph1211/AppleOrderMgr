jest.mock('../src/models', () => ({
  sequelize: { transaction: jest.fn() },
  DuoQuotePricingVersion: { findAll: jest.fn() },
}));
jest.mock('../src/repositories/quoteSourceRepository', () => ({
  fetchDuoHistory: jest.fn(),
}));
jest.mock('../src/services/duoQuotePricingService', () => ({
  getAdminQuotes: jest.fn(),
}));

const models = require('../src/models');
const repository = require('../src/repositories/quoteSourceRepository');
const pricingService = require('../src/services/duoQuotePricingService');
const historyService = require('../src/services/duoQuoteHistoryService');
const { createProductKey } = require('../src/services/quotePricingCore');

const STORAGES = [256, 512, 1024, 2048];
const COLORS = ['夜空色', '星光白色'];

function batch(at, basePrice, officialByColor = {}) {
  return {
    sourceUpdatedAt: new Date(at),
    items: STORAGES.flatMap(storageGb =>
      COLORS.map(color => ({
        productModel: 'Duo',
        storageGb,
        color,
        wholesalePrice: storageGb === 256 ? basePrice : basePrice + storageGb,
        officialPrice: officialByColor[color] ?? 15999 + storageGb,
        sourceUpdatedAt: new Date(at),
      }))
    ),
  };
}

function currentItems(sourceBatch, markup = 50) {
  return sourceBatch.items.map(item => ({
    productKey: createProductKey(item),
    productName: `iPhone Duo ${item.color} ${item.storageGb}G`,
    productModel: 'Duo',
    storageGb: item.storageGb,
    color: item.color,
    retailPrice: item.wholesalePrice === null ? null : Number(item.wholesalePrice) + markup,
    officialPrice: item.officialPrice,
  }));
}

function snapshot(markup) {
  return STORAGES.flatMap(storageGb =>
    COLORS.map(color => ({ productModel: 'Duo', storageGb, color, markup }))
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  models.sequelize.transaction.mockImplementation((_options, callback) => callback({}));
  process.env.QUOTE_DUO_PUBLIC_ENABLED = 'true';
});

afterAll(() => {
  delete process.env.QUOTE_DUO_PUBLIC_ENABLED;
});

test('范围只允许白名单且默认近7天', () => {
  const now = new Date('2026-10-30T06:00:00.000Z');
  expect(historyService.parseRange({}, now)).toMatchObject({ range: '7d' });
  expect(historyService.parseRange({ range: 'all' }, now).requestedFrom).toBeNull();
  expect(() => historyService.parseRange({ range: '1y' }, now)).toThrow('仅支持');
  expect(() => historyService.parseRange({ range: '7d', actor: 'x' }, now)).toThrow('查询参数无效');
});

test('按来源先于同时间调价重建，压缩变化并保留基准与空价断点', async () => {
  const first = batch('2026-10-24T00:00:00.000Z', 15000);
  const changed = batch('2026-10-29T01:00:00.000Z', 15100);
  const missing = batch('2026-10-29T02:00:00.000Z', 15200, {
    夜空色: 16000,
    星光白色: 16100,
  });
  missing.items.find(item => item.storageGb === 256 && item.color === '夜空色').wholesalePrice =
    null;
  repository.fetchDuoHistory.mockResolvedValue({
    availableFrom: first.sourceUpdatedAt,
    sourceUpdatedAt: missing.sourceUpdatedAt,
    batches: [first, changed, missing],
  });
  models.DuoQuotePricingVersion.findAll.mockResolvedValue([
    {
      revision: 1,
      createdAt: changed.sourceUpdatedAt,
      snapshot: snapshot(70),
    },
  ]);
  const current = {
    version: 1,
    sourceUpdatedAt: missing.sourceUpdatedAt,
    updatedAt: missing.sourceUpdatedAt,
    lastCheckedAt: missing.sourceUpdatedAt,
    stale: false,
    items: currentItems(missing, 70),
  };
  const result = await historyService.buildHistory(
    current,
    '24h',
    new Date('2026-10-29T00:00:00.000Z'),
    new Date('2026-10-30T00:00:00.000Z')
  );
  const capacity = result.capacities[0];
  expect(models.sequelize.transaction).toHaveBeenCalledWith(
    { readOnly: true },
    expect.any(Function)
  );
  const midnight = capacity.retailSeries.find(item => item.color === '夜空色');
  expect(midnight.points).toEqual([
    { changedAt: '2026-10-29T00:00:00.000Z', price: 15050, baseline: true },
    { changedAt: '2026-10-29T01:00:00.000Z', price: 15170, baseline: false },
    { changedAt: '2026-10-29T02:00:00.000Z', price: null, baseline: false },
  ]);
  expect(capacity.officialSeries).toHaveLength(2);
  expect(result).not.toHaveProperty('markup');
  expect(JSON.stringify(result)).not.toMatch(/wholesale|actor|sourceVersion/i);
});

test('同容量两色官网价完全一致时合并官网线', async () => {
  const source = batch('2026-10-24T00:00:00.000Z', 15000, {
    夜空色: 15999,
    星光白色: 15999,
  });
  repository.fetchDuoHistory.mockResolvedValue({
    availableFrom: source.sourceUpdatedAt,
    sourceUpdatedAt: source.sourceUpdatedAt,
    batches: [source],
  });
  models.DuoQuotePricingVersion.findAll.mockResolvedValue([]);
  const result = await historyService.buildHistory(
    {
      version: 0,
      sourceUpdatedAt: source.sourceUpdatedAt,
      updatedAt: source.sourceUpdatedAt,
      lastCheckedAt: source.sourceUpdatedAt,
      stale: false,
      items: currentItems(source),
    },
    'all',
    null,
    new Date('2026-10-30T00:00:00.000Z')
  );
  expect(result.capacities[0].officialSeries).toEqual([
    expect.objectContaining({ key: 'official', label: '官网价', color: null }),
  ]);
});

test('暂停与来源异常使用受控公开错误', async () => {
  process.env.QUOTE_DUO_PUBLIC_ENABLED = 'false';
  await expect(historyService.getPublicDuoQuoteHistory()).rejects.toMatchObject({
    code: 'QUOTE_PAGE_PAUSED',
  });
  process.env.QUOTE_DUO_PUBLIC_ENABLED = 'true';
  pricingService.getAdminQuotes.mockRejectedValue(new Error('database host secret'));
  await expect(historyService.getPublicDuoQuoteHistory()).rejects.toMatchObject({
    code: 'QUOTE_SOURCE_UNAVAILABLE',
  });
});
