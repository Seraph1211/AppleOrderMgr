/* eslint-disable camelcase -- MySQL 返回的原始列名即为 snake_case */

const mockConnection = {
  query: jest.fn(),
  beginTransaction: jest.fn(),
  execute: jest.fn(),
  rollback: jest.fn(),
  release: jest.fn(),
};
const mockPool = { getConnection: jest.fn(), end: jest.fn() };

jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => mockPool) }));
jest.mock('../src/config/quoteSourceDatabase', () => ({
  host: 'quote-db',
  port: 3306,
  user: 'readonly',
  password: 'secret',
  database: 'ppspider_data',
  connectionLimit: 3,
  connectTimeout: 5000,
}));

const mysql = require('mysql2/promise');
const repository = require('../src/repositories/quoteSourceRepository');

describe('iPhone 18 报价来源仓库', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPool.getConnection.mockResolvedValue(mockConnection);
    mockConnection.execute
      .mockResolvedValueOnce([
        [
          {
            product_model: '18 Pro',
            storage_gb: 256,
            color: '黑色',
            spec_code: 'TQ4/T74',
            wholesale_price: '10000',
            official_price: '9999',
            site_update_time: new Date('2026-09-24T10:01:21.000Z'),
            crawl_time: new Date('2026-09-24T10:04:01.000Z'),
          },
        ],
      ])
      .mockResolvedValueOnce([[{ last_checked_at: new Date('2026-09-24T10:05:00.000Z') }]]);
  });

  afterAll(async () => {
    await repository.closeQuoteSourcePool();
  });

  test('只读事务仅选择 28 款完整批次', async () => {
    const result = await repository.fetchLatestIphone18Batch();

    expect(mysql.createPool).toHaveBeenCalledWith(expect.objectContaining({ user: 'readonly' }));
    expect(mockConnection.query).toHaveBeenCalledWith('SET SESSION TRANSACTION READ ONLY');
    expect(mockConnection.beginTransaction).toHaveBeenCalled();
    const sourceSql = mockConnection.execute.mock.calls[0][0];
    expect(sourceSql).toContain('COUNT(*) = 28');
    expect(sourceSql).toContain("SUM(product_model = '18 Pro') = 12");
    expect(sourceSql).toContain("SUM(product_model = '18 Pro Max') = 16");
    expect(sourceSql).toContain('official_price IS NULL');
    expect(sourceSql).toContain("FIELD(color, '黑色', '银色', '冰川蓝色', '勃艮第酒红色')");
    expect(result.items[0]).toMatchObject({ basePrice: 10000, officialPrice: 9999 });
    expect(mockConnection.rollback).toHaveBeenCalledTimes(1);
    expect(mockConnection.release).toHaveBeenCalledTimes(1);
  });
});
