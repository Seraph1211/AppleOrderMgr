jest.mock('../src/services/duoQuotePricingService', () => ({ getAdminQuotes: jest.fn() }));
jest.mock('../src/repositories/quoteSourceRepository', () => ({ fetchLatestDuoBatch: jest.fn() }));
const repository = require('../src/repositories/quoteSourceRepository');
const pricingService = require('../src/services/duoQuotePricingService');
const { sourceFreshness } = require('../src/services/duoQuotePricingCore');
const { normalizeDuoItems, getPublicDuoQuotes } = require('../src/services/duoQuoteService');

function batch() {
  const sourceUpdatedAt = new Date(Date.now() - 60000);
  return {
    sourceUpdatedAt,
    lastCheckedAt: new Date(),
    items: [256, 512, 1024, 2048].flatMap(storageGb =>
      ['星光白色', '夜空色'].map(color => ({
        productModel: 'Duo',
        storageGb,
        color,
        sourceUpdatedAt,
        wholesalePrice: '16350',
        officialPrice: '15999',
        secret: 'excluded',
      }))
    ),
  };
}

beforeEach(() => {
  process.env.QUOTE_DUO_PUBLIC_ENABLED = 'true';
  pricingService.getAdminQuotes.mockImplementation(async () => {
    const source = await repository.fetchLatestDuoBatch();
    return {
      version: 3,
      updatedAt: source.sourceUpdatedAt,
      ...sourceFreshness(source),
      items: normalizeDuoItems(source),
    };
  });
});
afterEach(() => {
  delete process.env.QUOTE_DUO_PUBLIC_ENABLED;
  delete process.env.QUOTE_SOURCE_STALE_MINUTES;
});

test('应该固定八款排序、保留2TB并只返回公开字段', () => {
  const source = batch();
  source.items.reverse();
  const items = normalizeDuoItems(source);
  expect(items).toHaveLength(8);
  expect(items[0]).toMatchObject({
    storageGb: 256,
    color: '夜空色',
    retailPrice: 16400,
    premiumAmount: 400,
  });
  expect(items[7]).toMatchObject({ storageGb: 2048, color: '星光白色' });
  expect(Object.keys(items[0]).sort()).toEqual(
    [
      'productKey',
      'productName',
      'productModel',
      'storageGb',
      'color',
      'retailPrice',
      'officialPrice',
      'premiumAmount',
    ].sort()
  );
});

test.each([
  [16350, 15999, 16400, 400],
  [18700, 17999, 18750, 750],
  [16250, 15999, 16300, 300],
  [18700, 18000, 18750, 750],
  [15949, 15999, 15999, 0],
  [15900, 15999, 15950, -50],
  [15950.25, 15999, 16000.25, 0],
  [null, 15999, null, null],
  [0, 15999, null, null],
  ['', 15999, null, null],
  [16350, null, 16400, null],
])(
  '应该将批发价%s加50为%s并将差额整十处理',
  (wholesalePrice, officialPrice, retailPrice, premiumAmount) => {
    const source = batch();
    source.items[1].wholesalePrice = wholesalePrice;
    source.items[1].officialPrice = officialPrice;
    expect(normalizeDuoItems(source)[0]).toMatchObject({
      retailPrice,
      officialPrice: officialPrice || null,
      premiumAmount,
    });
  }
);

test.each([
  source => source.items.pop(),
  source => {
    source.items[1] = source.items[0];
  },
  source => {
    source.items[0].color = '未知';
  },
  source => {
    source.items[0].storageGb = 4096;
  },
  source => {
    source.items[0].productModel = '18 Pro';
  },
  source => {
    source.items[0].sourceUpdatedAt = new Date(0);
  },
  source => {
    source.items[0].wholesalePrice = 'NaN';
  },
  source => {
    source.items[0].officialPrice = -1;
  },
  source => {
    source.sourceUpdatedAt = null;
  },
])('应该拒绝缺项、重复、未知规格、时间冲突或非法价格', mutate => {
  const source = batch();
  mutate(source);
  expect(() => normalizeDuoItems(source)).toThrow('报价数据暂不可用');
});

test('应该使用Duo检查时间判断延迟，并保留来源时间', async () => {
  const source = batch();
  repository.fetchLatestDuoBatch.mockResolvedValue(source);
  expect(await getPublicDuoQuotes()).toMatchObject({
    stale: false,
    version: 3,
    updatedAt: source.sourceUpdatedAt,
  });
  source.lastCheckedAt = new Date(Date.now() - 360000);
  expect((await getPublicDuoQuotes()).stale).toBe(true);
  source.lastCheckedAt = null;
  expect((await getPublicDuoQuotes()).stale).toBe(true);
});

test('应该独立控制Duo开关并封装来源错误', async () => {
  process.env.QUOTE_DUO_PUBLIC_ENABLED = 'false';
  await expect(getPublicDuoQuotes()).rejects.toMatchObject({ code: 'QUOTE_PAGE_PAUSED' });
  process.env.QUOTE_DUO_PUBLIC_ENABLED = 'true';
  repository.fetchLatestDuoBatch.mockRejectedValue(new Error('private database detail'));
  await expect(getPublicDuoQuotes()).rejects.toMatchObject({
    code: 'QUOTE_SOURCE_UNAVAILABLE',
    message: '报价数据暂不可用',
  });
});
