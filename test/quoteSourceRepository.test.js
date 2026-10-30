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
      .mockResolvedValueOnce([
        [
          {
            last_checked_at: new Date('2026-09-24T10:05:00.000Z'),
            latest_observed_at: new Date('2026-09-24T10:01:21.000Z'),
          },
        ],
      ]);
  });

  afterAll(async () => {
    await repository.closeQuoteSourcePool();
  });

  test('只读事务选择最新批次且不固定商品数量', async () => {
    const result = await repository.fetchLatestIphone18Batch();

    expect(mysql.createPool).toHaveBeenCalledWith(expect.objectContaining({ user: 'readonly' }));
    expect(mockConnection.query).toHaveBeenCalledWith('SET SESSION TRANSACTION READ ONLY');
    expect(mockConnection.beginTransaction).toHaveBeenCalled();
    const sourceSql = mockConnection.execute.mock.calls[0][0];
    expect(sourceSql).toContain('SELECT MAX(site_update_time)');
    expect(sourceSql).not.toMatch(/COUNT\(\*\)|HAVING|SUM\(product_model/);
    expect(sourceSql).toContain("FIELD(color, '黑色', '银色', '冰川蓝色', '勃艮第酒红色')");
    expect(result.items[0]).toMatchObject({ basePrice: '10000', officialPrice: '9999' });
    expect(result.latestObservedAt).toEqual(new Date('2026-09-24T10:01:21.000Z'));
    expect(mockConnection.rollback).toHaveBeenCalledTimes(1);
    expect(mockConnection.release).toHaveBeenCalledTimes(1);
  });

  test('数据库 NULL 价格原样交给业务层，不能在仓库转换成 0', async () => {
    mockConnection.execute.mockReset();
    mockConnection.execute
      .mockResolvedValueOnce([
        [
          {
            product_model: '18 Pro Max',
            storage_gb: 512,
            color: '冰川蓝色',
            wholesale_price: null,
            official_price: null,
          },
        ],
      ])
      .mockResolvedValueOnce([[]]);
    const result = await repository.fetchLatestIphone18Batch();
    expect(result.items[0]).toMatchObject({ basePrice: null, officialPrice: null });
  });

  test('应该独立读取最新Duo批次且重叠跳过不作为有效检查', async () => {
    await repository.fetchLatestDuoBatch();
    expect(mockConnection.execute.mock.calls[0][0]).toContain("product_model = 'Duo'");
    expect(mockConnection.execute.mock.calls[1][0]).toContain(
      "spider_name = 'ecommerce.hnmwdx.duo'"
    );
    expect(mockConnection.execute.mock.calls[1][0]).toContain(
      "error_message LIKE '页面更新时间未变化:%'"
    );
    expect(mockConnection.release).toHaveBeenCalled();
  });

  test('应该只读查询Duo历史并补入范围开始前的基准批次', async () => {
    mockConnection.execute.mockReset();
    mockConnection.execute
      .mockResolvedValueOnce([
        [
          {
            available_from: new Date('2026-10-24T11:08:06.000Z'),
            source_updated_at: new Date('2026-10-30T05:03:56.000Z'),
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            product_model: 'Duo',
            storage_gb: 256,
            color: '夜空色',
            wholesale_price: '15900',
            official_price: '15999',
            site_update_time: new Date('2026-10-29T05:00:00.000Z'),
          },
        ],
      ]);
    const result = await repository.fetchDuoHistory({
      from: new Date('2026-10-30T00:00:00.000Z'),
      to: new Date('2026-10-30T06:00:00.000Z'),
    });
    const sql = mockConnection.execute.mock.calls[1][0];
    expect(sql).toContain('MAX(previous.site_update_time)');
    expect(sql).toContain('site_update_time >= ?');
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0].items[0]).toMatchObject({
      productModel: 'Duo',
      storageGb: 256,
      wholesalePrice: '15900',
    });
    expect(mockConnection.rollback).toHaveBeenCalled();
    expect(mockConnection.release).toHaveBeenCalled();
  });
});
