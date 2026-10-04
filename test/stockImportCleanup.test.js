jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/models', () => ({
  sequelize: { query: jest.fn(), transaction: jest.fn() },
  StockImportJob: { count: jest.fn(), findAll: jest.fn(), update: jest.fn() },
  StockOperation: { create: jest.fn() },
  StockEvent: { bulkCreate: jest.fn() },
}));
jest.mock('../src/services/stockCommandService', () => ({ lockStock: jest.fn() }));
const db = require('../src/models');
const { parseArgs, cleanExpiredPreviews } = require('../scripts/cleanupStockImportPreviews');
const { decryptJson } = require('../src/utils/fieldEncryption');
const originalEnv = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    ...originalEnv,
    DATABASE_URL: '',
    DB_NAME: 'apple_order_mgr_stock_test_1004',
    FIELD_ENCRYPTION_KEY: '31'.repeat(32),
  };
  db.sequelize.query.mockResolvedValue([[{ name: 'apple_order_mgr_stock_test_1004' }]]);
  db.sequelize.transaction.mockImplementation(work => work({ id: 'maintenance-tx' }));
  db.StockImportJob.count.mockResolvedValue(2);
  db.StockImportJob.findAll.mockResolvedValue([
    { id: 'synthetic-preview', version: 0, kind: 'opening', status: 'preview' },
  ]);
  db.StockOperation.create.mockResolvedValue({ id: 'synthetic-operation' });
  db.StockImportJob.update.mockResolvedValue([1]);
  db.StockEvent.bulkCreate.mockResolvedValue([]);
});
afterAll(() => {
  process.env = originalEnv;
});

test('维护命令默认预演，未知或未来参数拒绝', () => {
  expect(parseArgs([])).toMatchObject({ apply: false });
  expect(
    parseArgs(['--apply', '--created-by', '7', '--confirm-database', 'named-db'])
  ).toMatchObject({ apply: true, createdBy: 7, confirmDatabase: 'named-db' });
  expect(() => parseArgs(['--apply-all'])).toThrow('未知');
  expect(() => parseArgs(['--before', '2099-01-01T00:00:00Z'])).toThrow('未来');
  expect(() => parseArgs(['--created-by', '-1'])).toThrow('正整数');
});

test('默认只读取候选数量，没有写入或事务', async () => {
  try {
    const result = await cleanExpiredPreviews({ createdBy: 7 });
    expect(result).toMatchObject({ dryRun: true, eligibleCount: 2, cleanedCount: 0 });
    expect(db.StockImportJob.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ status: 'preview', createdBy: 7 }),
    });
    expect(db.sequelize.transaction).not.toHaveBeenCalled();
    expect(db.StockImportJob.update).not.toHaveBeenCalled();
  } catch (error) {
    throw new Error('清理预演回归失败', { cause: error });
  }
});

test('非隔离数据库未确认或确认不匹配时拒绝写入', async () => {
  try {
    db.sequelize.query.mockResolvedValue([[{ name: 'synthetic_shared_database' }]]);
    await expect(cleanExpiredPreviews({ apply: true })).rejects.toMatchObject({
      code: 'DATABASE_CONFIRMATION_REQUIRED',
    });
    await expect(
      cleanExpiredPreviews({ apply: true, confirmDatabase: 'different_database' })
    ).rejects.toMatchObject({ code: 'DATABASE_CONFIRMATION_REQUIRED' });
    expect(db.sequelize.transaction).not.toHaveBeenCalled();
  } catch (error) {
    throw new Error('清理数据库保护回归失败', { cause: error });
  }
});

test('实际清理仅命中过期preview，保留元信息和refs并追加加密审计', async () => {
  try {
    const result = await cleanExpiredPreviews({ apply: true, createdBy: 7 });
    expect(result).toMatchObject({ dryRun: false, cleanedCount: 1, remainingCount: 2 });
    expect(db.StockImportJob.findAll.mock.calls[0][0]).toMatchObject({
      where: { status: 'preview', createdBy: 7 },
      limit: 500,
    });
    const update = db.StockImportJob.update.mock.calls[0][0];
    expect(update).toMatchObject({ status: 'expired', payloadCiphertext: {} });
    expect(update).not.toHaveProperty('resultRefs');
    expect(update).not.toHaveProperty('sourceLabel');
    const event = db.StockEvent.bulkCreate.mock.calls[0][0][0];
    expect(event.changesCiphertext).toHaveProperty('__encrypted');
    expect(decryptJson(event.changesCiphertext).after).toMatchObject({
      status: 'expired',
      payloadCleared: true,
      version: 1,
    });
  } catch (error) {
    throw new Error('过期清理回归失败', { cause: error });
  }
});

test('重复清理没有候选时不创建空操作', async () => {
  try {
    db.StockImportJob.findAll.mockResolvedValue([]);
    expect(await cleanExpiredPreviews({ apply: true })).toEqual({
      dryRun: false,
      cleanedCount: 0,
      remainingCount: 0,
    });
    expect(db.StockOperation.create).not.toHaveBeenCalled();
  } catch (error) {
    throw new Error('重复清理回归失败', { cause: error });
  }
});
