/* eslint-disable camelcase, no-magic-numbers -- 独立验收使用数据库列及固定合成金额。 */
const enabled = process.env.RUN_DUO_PRICING_ACCEPTANCE === 'true';
const suite = enabled ? describe : describe.skip;
const TEST_DATABASE = 'apple_order_mgr_duo_pricing_qa_20261025';
jest.mock('../src/repositories/quoteSourceRepository', () => ({ fetchLatestDuoBatch: jest.fn() }));
const sourceRepository = require('../src/repositories/quoteSourceRepository');

suite('Duo报价：独立 PostgreSQL 事务、并发、HTTP 权限验收', () => {
  let db;
  let service;
  let publicService;
  let server;
  let origin;
  let source;
  let oldSnapshot;
  const actor = { id: 7, role: 'admin', nickname: '独立报价验收员', username: 'synthetic-duo-qa' };
  const migration = require('../migrations/20261025000001-create-duo-quote-pricing');
  const sourceTime = new Date(Date.now() - 600000);
  const clone = value => structuredClone(value);
  const tokens = quote => ({
    expectedVersion: quote.version,
    expectedSourceVersion: quote.sourceVersion,
  });
  const tables = [
    'duo_quote_pricing_settings',
    'duo_quote_price_adjustments',
    'duo_quote_pricing_versions',
  ];

  async function state() {
    try {
      const result = {};
      for (const table of tables) {
        const [rows] = await db.sequelize.query(`SELECT * FROM ${table} ORDER BY 1`);
        result[table] = rows;
      }
      return JSON.stringify(result);
    } catch (error) {
      throw new Error('独立报价状态回读失败', { cause: error });
    }
  }

  async function legacyState() {
    try {
      const result = {};
      for (const table of [
        'quote_pricing_settings',
        'quote_price_adjustments',
        'quote_pricing_versions',
      ]) {
        const [rows] = await db.sequelize.query(`SELECT * FROM ${table} ORDER BY 1`);
        result[table] = rows;
      }
      return JSON.stringify(result);
    } catch (error) {
      throw new Error('旧报价状态回读失败', { cause: error });
    }
  }

  async function request(endpoint, method = 'GET', body, role = 'admin') {
    try {
      const response = await fetch(`${origin}/api/quote-pricing/duo${endpoint}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-QA-Role': role },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        cache: response.headers.get('cache-control'),
        body: await response.json(),
      };
    } catch (error) {
      throw new Error('独立报价 HTTP 请求失败', { cause: error });
    }
  }

  beforeAll(async () => {
    if (
      process.env.DB_NAME !== TEST_DATABASE ||
      process.env.DB_NAME_TEST !== TEST_DATABASE ||
      process.env.DATABASE_URL ||
      process.env.DB_HOST !== 'postgres'
    ) {
      throw new Error('仅允许本轮命名专库和开发postgres容器，且DATABASE_URL必须为空');
    }
    try {
      process.env.QUOTE_DUO_PUBLIC_ENABLED = 'true';
      db = require('../src/models');
      const qi = db.sequelize.getQueryInterface();
      const { Sequelize } = require('sequelize');
      await db.sequelize.authenticate();
      const qaTables = [
        ...tables,
        'quote_pricing_versions',
        'quote_price_adjustments',
        'quote_pricing_settings',
        'users',
      ];
      await db.sequelize.query(`DROP TABLE IF EXISTS ${qaTables.join(', ')} CASCADE`);
      // 仅创建本模块所需的空外键父表与正式报价表，不执行其他待迁移业务模块。
      await qi.createTable('users', { id: { type: Sequelize.INTEGER, primaryKey: true } });
      await qi.bulkInsert('users', [{ id: actor.id }]);
      await require('../migrations/20260924000002-create-quote-pricing').up(qi, Sequelize);
      await require('../migrations/20260925000001-add-quote-display-order').up(qi, Sequelize);
      await db.QuotePricingSetting.update(
        { publicEnabled: true, version: 17, displayOrder: ['legacy-proof'] },
        { where: { id: 1 } }
      );
      await db.QuotePriceAdjustment.create({
        productKey: 'legacy-proof',
        productModel: '18 Pro',
        storageGb: 256,
        color: '黑色',
        percentage: '1.50',
        fixedAmount: '-7.00',
      });
      await db.QuotePricingVersion.create({
        id: '00000000-0000-4000-8000-000000000017',
        revision: 17,
        action: 'bulk_adjust',
        snapshot: [{ legacy: true }],
        summary: { preserve: true },
        actorName: '旧报价操作人',
      });
      oldSnapshot = await legacyState();
      await migration.up(qi, Sequelize);
      service = require('../src/services/duoQuotePricingService');
      publicService = require('../src/services/duoQuoteService');
      const express = require('express');
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        const role = req.get('X-QA-Role');
        if (role && role !== 'anonymous') req.user = { ...actor, role };
        next();
      });
      app.use('/api/quote-pricing', require('../src/routes/quotePricing'));
      app.use((error, _req, res, _next) =>
        res
          .status(error.statusCode || 500)
          .json({ success: false, error: { code: error.code, message: error.message } })
      );
      server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
      });
      origin = `http://127.0.0.1:${server.address().port}`;
    } catch (error) {
      throw new Error('独立报价隔离库初始化失败', { cause: error });
    }
  });

  beforeEach(async () => {
    try {
      source = {
        sourceUpdatedAt: sourceTime,
        lastCheckedAt: new Date(),
        items: [256, 512, 1024, 2048].flatMap((storageGb, index) =>
          ['星光白色', '夜空色'].map((color, colorIndex) => ({
            productModel: 'Duo',
            storageGb,
            color,
            sourceUpdatedAt: sourceTime,
            wholesalePrice: 16000 + index * 1000 + colorIndex * 100,
            officialPrice: 15999 + index * 1000,
          }))
        ),
      };
      sourceRepository.fetchLatestDuoBatch
        .mockReset()
        .mockImplementation(() => Promise.resolve(clone(source)));
      await db.DuoQuotePricingVersion.destroy({ where: {} });
      await db.DuoQuotePriceAdjustment.destroy({ where: {} });
      await db.DuoQuotePricingSetting.update(
        { version: 0, pricingUpdatedAt: null, updatedBy: null },
        { where: { id: 1 } }
      );
    } catch (error) {
      throw new Error('独立报价夹具重置失败', { cause: error });
    }
  });

  afterEach(async () => {
    expect(await legacyState()).toBe(oldSnapshot);
  });

  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) await db.sequelize.close();
  });

  test('正式up/down/up保留旧模块；初始化无人工时间且全部默认+50', async () => {
    const qi = db.sequelize.getQueryInterface();
    await migration.down(qi);
    await migration.up(qi, require('sequelize').Sequelize);
    const setting = await db.DuoQuotePricingSetting.findByPk(1);
    expect(setting.pricingUpdatedAt).toBeNull();
    expect(setting.version).toBe(0);
    const quote = await service.getAdminQuotes();
    expect(quote.items).toHaveLength(8);
    expect(quote.items.every(item => item.markup === 50)).toBe(true);
    expect(new Date(quote.updatedAt).getTime()).toBe(sourceTime.getTime());
    expect(new Date((await publicService.getPublicDuoQuotes()).updatedAt).getTime()).toBe(
      sourceTime.getTime()
    );
  });

  test('预览零写入；检查时间变化不冲突，实际价格变化即使同来源时间也409', async () => {
    const quote = await service.getAdminQuotes();
    const before = await state();
    source.lastCheckedAt = new Date(Date.now() + 500);
    const body = {
      ...tokens(quote),
      productKeys: quote.items.slice(0, 2).map(item => item.productKey),
      mode: 'retail',
      amount: '16666.66',
    };
    const preview = await service.preview({ operation: 'adjust', ...body });
    expect(preview.items.slice(0, 2).map(item => item.markup)).toEqual([666.66, 566.66]);
    expect(await state()).toBe(before);
    source.items[0].wholesalePrice++;
    await expect(service.saveAdjustments(actor, body)).rejects.toMatchObject({
      statusCode: 409,
      code: 'DUO_SOURCE_CHANGED',
    });
    expect(await state()).toBe(before);
  });

  test('零售价只持久化markup，来源涨跌跟随；完整历史与公开字段隔离', async () => {
    const quote = await service.getAdminQuotes();
    await service.saveAdjustments(actor, {
      ...tokens(quote),
      productKeys: quote.items.slice(0, 2).map(item => item.productKey),
      mode: 'retail',
      amount: '16666.66',
    });
    const adjustments = await db.DuoQuotePriceAdjustment.findAll({
      order: [
        ['storageGb', 'ASC'],
        ['color', 'ASC'],
      ],
      raw: true,
    });
    expect(adjustments).toHaveLength(2);
    expect(adjustments.map(row => Number(row.markup)).sort()).toEqual([566.66, 666.66]);
    expect(adjustments.every(row => !('retailPrice' in row) && !('wholesalePrice' in row))).toBe(
      true
    );
    const history = await service.listVersions();
    expect(history.total).toBe(1);
    expect(history.items[0]).toMatchObject({
      actorName: actor.nickname,
      action: 'adjust',
      revision: 1,
    });
    expect(history.items[0].snapshot).toHaveLength(8);
    expect(history.items[0].changes).toHaveLength(2);
    expect(
      history.items[0].snapshot.every(
        row =>
          Object.keys(row).sort().join(',') === 'color,markup,productKey,productModel,storageGb'
      )
    ).toBe(true);
    source.items[0].wholesalePrice += 100;
    source.items[1].wholesalePrice -= 200;
    source.lastCheckedAt = new Date(Date.now() - 600000);
    const result = await publicService.getPublicDuoQuotes();
    expect(result.items.slice(0, 2).map(item => item.retailPrice)).toEqual([16766.66, 16466.66]);
    expect(result.stale).toBe(true);
    expect(new Date(result.updatedAt).getTime()).toBeGreaterThan(sourceTime.getTime());
    expect(Object.keys(result.items[0]).sort()).toEqual(
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
    expect(JSON.stringify(result)).not.toMatch(
      /wholesale|markup|snapshot|actor|history|sourceVersion/
    );
    const newerSource = new Date(Date.now() + 1000);
    source.sourceUpdatedAt = newerSource;
    source.items.forEach(row => {
      row.sourceUpdatedAt = newerSource;
    });
    expect(new Date((await publicService.getPublicDuoQuotes()).updatedAt).getTime()).toBe(
      newerSource.getTime()
    );
  });

  test('NULL不能按零售价换算；markup/reset保存后NULL仍不变0', async () => {
    source.items[0].wholesalePrice = null;
    const quote = await service.getAdminQuotes();
    const body = {
      ...tokens(quote),
      productKeys: quote.items.slice(0, 2).map(item => item.productKey),
      mode: 'retail',
      amount: 17000,
    };
    const before = await state();
    await expect(service.saveAdjustments(actor, body)).rejects.toMatchObject({
      code: 'DUO_BASE_PRICE_REQUIRED',
      statusCode: 400,
    });
    expect(await state()).toBe(before);
    await service.saveAdjustments(actor, { ...body, mode: 'markup', amount: '-20.25' });
    let current = await service.getAdminQuotes();
    expect(current.items[0]).toMatchObject({
      wholesalePrice: null,
      retailPrice: null,
      markup: -20.25,
      premiumAmount: null,
    });
    await service.resetAdjustments(actor, {
      ...tokens(current),
      productKeys: [current.items[0].productKey],
    });
    current = await service.getAdminQuotes();
    expect(current.items[0]).toMatchObject({ retailPrice: null, markup: 50 });
  });

  test('后续base下降令旧负markup失效时仍可读取并逐款修复', async () => {
    let quote = await service.getAdminQuotes();
    await service.saveAdjustments(actor, {
      ...tokens(quote),
      productKeys: [quote.items[0].productKey],
      mode: 'markup',
      amount: -15900,
    });
    source.items[0].wholesalePrice = 100;
    quote = await service.getAdminQuotes();
    expect(quote.items[0]).toMatchObject({
      retailPrice: null,
      pricingError: 'DUO_RETAIL_PRICE_INVALID',
      markup: -15900,
    });
    const publicQuote = await publicService.getPublicDuoQuotes();
    expect(publicQuote.items[0]).toMatchObject({ retailPrice: null, premiumAmount: null });
    expect(publicQuote.items[0]).not.toHaveProperty('pricingError');
    const unaffectedBody = {
      ...tokens(quote),
      productKeys: [quote.items[1].productKey],
      mode: 'markup',
      amount: 70,
    };
    await service.saveAdjustments(actor, unaffectedBody);
    quote = await service.getAdminQuotes();
    await expect(
      service.preview({
        operation: 'adjust',
        ...tokens(quote),
        productKeys: [quote.items[0].productKey],
        mode: 'markup',
        amount: -101,
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    const reset = await service.preview({
      operation: 'reset',
      ...tokens(quote),
      productKeys: [quote.items[0].productKey],
    });
    expect(reset.items[0]).toMatchObject({ retailPrice: 150, markup: 50 });
    await service.resetAdjustments(actor, {
      ...tokens(quote),
      productKeys: [quote.items[0].productKey],
    });
    expect((await service.getAdminQuotes()).items[0]).toMatchObject({
      retailPrice: 150,
      markup: 50,
    });
  });

  test('同版本真实并发只有一笔成功，一份历史与一个新版本', async () => {
    const quote = await service.getAdminQuotes();
    const body = { ...tokens(quote), productKeys: [quote.items[0].productKey], mode: 'markup' };
    const result = await Promise.allSettled([
      service.saveAdjustments(actor, { ...body, amount: 60 }),
      service.saveAdjustments(actor, { ...body, amount: 70 }),
    ]);
    expect(result.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(result.find(row => row.status === 'rejected').reason).toMatchObject({
      statusCode: 409,
      code: 'CONCURRENT_MODIFICATION',
    });
    expect((await db.DuoQuotePricingSetting.findByPk(1)).version).toBe(1);
    expect(await db.DuoQuotePricingVersion.count()).toBe(1);
    expect(await db.DuoQuotePriceAdjustment.count()).toBe(1);
  });

  test('提交末次源价变化整笔回滚setting、markup与history', async () => {
    const quote = await service.getAdminQuotes();
    const before = await state();
    const changed = clone(source);
    changed.items[0].officialPrice += 1;
    sourceRepository.fetchLatestDuoBatch
      .mockResolvedValueOnce(clone(source))
      .mockResolvedValueOnce(changed);
    await expect(
      service.saveAdjustments(actor, {
        ...tokens(quote),
        productKeys: [quote.items[0].productKey],
        mode: 'markup',
        amount: 99,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'DUO_SOURCE_CHANGED' });
    expect(await state()).toBe(before);
  });

  test('真实审计写失败整笔回滚，不留下已改报价', async () => {
    const quote = await service.getAdminQuotes();
    const before = await state();
    db.DuoQuotePricingVersion.addHook('beforeCreate', 'qa-audit-failure', () => {
      throw new Error('synthetic audit failure');
    });
    try {
      await expect(
        service.saveAdjustments(actor, {
          ...tokens(quote),
          productKeys: [quote.items[0].productKey],
          mode: 'markup',
          amount: 99,
        })
      ).rejects.toThrow('synthetic audit failure');
    } finally {
      db.DuoQuotePricingVersion.removeHook('beforeCreate', 'qa-audit-failure');
    }
    expect(await state()).toBe(before);
  });

  test('恢复历史markup使用最新base；坏身份快照拒绝且完整保留历史', async () => {
    let quote = await service.getAdminQuotes();
    await service.saveAdjustments(actor, {
      ...tokens(quote),
      productKeys: [quote.items[0].productKey],
      mode: 'markup',
      amount: 200,
    });
    const original = (await service.listVersions()).items[0];
    quote = await service.getAdminQuotes();
    await service.resetAdjustments(actor, {
      ...tokens(quote),
      productKeys: [quote.items[0].productKey],
    });
    source.items[0].wholesalePrice += 500;
    quote = await service.getAdminQuotes();
    const plan = await service.preview({
      operation: 'restore',
      versionId: original.id,
      ...tokens(quote),
    });
    expect(plan.items[0]).toMatchObject({ markup: 200, wholesalePrice: 16500, retailPrice: 16700 });
    await service.restoreVersion(actor, original.id, tokens(quote));
    expect((await service.getAdminQuotes()).items[0].retailPrice).toBe(16700);
    const history = await service.listVersions({ limit: '1', offset: '0' });
    expect(history.total).toBe(3);
    expect(history.items[0]).toMatchObject({
      action: 'restore',
      summary: { restoredFromRevision: 1 },
    });
    expect((await db.DuoQuotePricingVersion.findByPk(original.id)).snapshot).toEqual(
      original.snapshot
    );
    const invalidSnapshot = clone(original.snapshot);
    invalidSnapshot[0].color = '未知';
    await db.DuoQuotePricingVersion.update(
      { snapshot: invalidSnapshot },
      { where: { id: original.id } }
    );
    quote = await service.getAdminQuotes();
    const before = await state();
    await expect(service.restoreVersion(actor, original.id, tokens(quote))).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(await state()).toBe(before);
  });

  test('全部管理HTTP端点拒绝匿名与普通账号，管理员读取禁止缓存', async () => {
    const quote = await service.getAdminQuotes();
    const body = {
      ...tokens(quote),
      productKeys: [quote.items[0].productKey],
      mode: 'markup',
      amount: 99,
    };
    const endpoints = [
      ['', 'GET'],
      ['/versions', 'GET'],
      ['/preview', 'POST'],
      ['/adjustments', 'PUT'],
      ['/adjustments/reset', 'POST'],
      ['/versions/00000000-0000-4000-8000-000000000001/restore', 'POST'],
    ];
    const before = await state();
    for (const [endpoint, method] of endpoints) {
      for (const role of ['operator', 'readOnly', 'anonymous']) {
        const response = await request(endpoint, method, method === 'GET' ? undefined : body, role);
        expect(response.status).toBe(role === 'anonymous' ? 401 : 403);
      }
    }
    const response = await request('');
    expect(response.status).toBe(200);
    expect(response.cache).toBe('no-store');
    expect(await state()).toBe(before);
  });

  test.each([null, true, '', ' 50 ', '5e1', '1.001', 100000.01, Infinity])(
    '非法金额%p拒绝且不写入',
    async amount => {
      const quote = await service.getAdminQuotes();
      const before = await state();
      await expect(
        service.saveAdjustments(actor, {
          ...tokens(quote),
          productKeys: [quote.items[0].productKey],
          mode: 'markup',
          amount,
        })
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(await state()).toBe(before);
    }
  );
});
