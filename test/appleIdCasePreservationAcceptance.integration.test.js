/* eslint-disable camelcase, no-magic-numbers, max-len -- 独立验收使用原生 SQL 和固定边界值。 */
const enabled = process.env.RUN_APPLEID_CASE_ACCEPTANCE === 'true';
(enabled ? describe : describe.skip)('AppleID大小写保留独立真实PG与HTTP验收', () => {
  let db, server, origin, tokens, userIds;
  async function call(path, actor = 'admin', method = 'POST', body) {
    try {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: { Authorization: `Bearer ${tokens[actor]}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        cache: response.headers.get('cache-control'),
        body: await response.json(),
      };
    } catch (error) {
      throw new Error(`验收HTTP失败: ${error.message}`);
    }
  }
  beforeAll(async () => {
    if (
      !/^apple_order_mgr_appleid_case_acceptance_20261016$/.test(process.env.DB_NAME || '') ||
      process.env.DB_NAME_TEST !== process.env.DB_NAME ||
      process.env.DATABASE_URL
    )
      throw new Error('拒绝非独立合成库');
    db = require('../src/models');
    await db.sequelize.query('TRUNCATE users,recipients RESTART IDENTITY CASCADE');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use(require('../src/middleware/authMiddleware').authenticate);
    app.use('/apple-ids', require('../src/routes/appleIds'));
    app.use('/import', require('../src/routes/importRoutes'));
    app.use('/proxy-orders', require('../src/routes/proxyOrders'));
    app.use(require('../src/middleware/errorHandler'));
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    const session = {
      id: 'appleid-acceptance',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    tokens = {};
    userIds = {};
    for (const name of ['admin', 'read', 'edit', 'none']) {
      const user = await db.User.create({
        username: `accept_${name}`,
        password: 'Synthetic-only-123!',
        role: name === 'admin' ? 'admin' : 'operator',
        status: 'active',
        activeSessions: [session],
      });
      userIds[name] = user.id;
      tokens[name] = require('../src/utils/jwtUtils').generateToken({
        userId: user.id,
        username: user.username,
        role: user.role,
        sessionId: session.id,
      });
      if (['read', 'edit'].includes(name))
        await db.UserPermission.create({ userId: user.id, permissionCode: `apple_ids.${name}` });
    }
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) await db.sequelize.close();
  });
  beforeEach(async () => {
    await db.sequelize.query('TRUNCATE apple_ids RESTART IDENTITY CASCADE');
  });
  async function create(index, extra = {}) {
    try {
      return await db.AppleId.create({
        appleId: `synthetic${index}@example.test`,
        password: `Synthetic-${index}!`,
        notes: '保留备注',
        ...extra,
      });
    } catch (error) {
      throw new Error(`合成样本创建失败: ${error.name}`);
    }
  }
  async function snapshot() {
    try {
      const result = {};
      for (const table of ['apple_ids', 'orders', 'proxy_orders', 'proxy_assignments'])
        result[table] = (
          await db.sequelize.query(`SELECT to_jsonb(a) AS row FROM ${table} a ORDER BY id`)
        )[0];
      return result;
    } catch (error) {
      throw new Error(`快照失败: ${error.name}`);
    }
  }
  async function seedRelated(appleId = 'Existing.Mixed@Example.TEST', extra = {}) {
    try {
      const account = await create(1, {
        appleId,
        country: '美国',
        status: '异常',
        notes: '历史备注保持',
        nickname: '历史昵称',
        securityQa: {
          question1: '130',
          answer1: 'Synthetic-answer',
          question2: '136',
          answer2: 'Synthetic-answer-2',
          question3: '142',
          answer3: 'Synthetic-answer-3',
        },
        ...extra,
      });
      await db.Order.create({
        orderNumber: 'W1234567890',
        appleIdRef: account.id,
        appleId,
        products: [{ name: 'iPhone synthetic', quantity: 1 }],
        notes: '订单原值',
      });
      const request = await db.ProxyOrder.create({
        lastName: '合成',
        firstName: '测试',
        phone: '13800000000',
        email: 'proxy@example.test',
        idLast4: '1234',
        productModel: 'iPhone 17 Pro',
        color: '银色',
        storage: '256GB',
        quantity: 1,
        storeCodes: ['R390'],
        storeMode: 'selected',
        billing: {},
        productCandidates: [{ productModel: 'iPhone 17 Pro', color: '银色', storage: '256GB' }],
        createdBy: userIds.admin,
      });
      await db.ProxyAssignment.create({
        proxyOrderId: request.id,
        appleIdRef: account.id,
        accountEmail: appleId,
        startedAt: new Date(),
      });
      return account;
    } catch (error) {
      throw new Error(`关联合成样本失败: ${error.name}`);
    }
  }
  async function preview(sheets) {
    try {
      const XLSX = require('xlsx');
      const book = XLSX.utils.book_new();
      for (const [name, rows] of sheets)
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
      const file = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
      const data = new FormData();
      data.append('file', new Blob([file]), 'Synthetic-case.xlsx');
      const response = await fetch(`${origin}/import/preview?type=apple_ids`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.admin}` },
        body: data,
      });
      return { status: response.status, body: await response.json() };
    } catch (error) {
      throw new Error(`预览失败: ${error.name}`);
    }
  }
  function execute(sessionToken, decisions = {}) {
    return call('/import/execute?type=apple_ids', 'admin', 'POST', {
      type: 'apple_ids',
      sessionToken,
      decisions,
    });
  }
  test('HTTP新增保留原始大小写；列表详情与批量复制均原文；异大小写重复不能改变已有整行或关联', async () => {
    const response = await call('/apple-ids', 'admin', 'POST', {
      apple_id: 'MiXeD.New@Example.COM',
      password: 'Synthetic-New!',
      country: '中国',
      notes: '新增合成',
    });
    expect(response.status).toBe(201);
    expect(response.body.data.apple_id).toBe('MiXeD.New@Example.COM');
    const id = response.body.data.id;
    expect((await call(`/apple-ids/${id}`, 'admin', 'GET')).body.data.apple_id).toBe(
      'MiXeD.New@Example.COM'
    );
    expect(
      (await call('/apple-ids?keyword=mixed.new', 'admin', 'GET')).body.data.apple_ids[0].apple_id
    ).toBe('MiXeD.New@Example.COM');
    const copy = await call('/apple-ids/copy-import', 'admin', 'POST', { ids: [id] });
    expect(copy.body.data.text).toBe('MiXeD.New@Example.COM,Synthetic-New!,');
    const existing = await seedRelated();
    const before = await snapshot();
    const duplicate = await call('/apple-ids', 'admin', 'POST', {
      apple_id: existing.appleId.toLowerCase(),
      password: 'Other-synthetic!',
      country: '中国',
      status: '未使用',
      notes: '不应写入',
    });
    expect(duplicate.status).toBe(409);
    expect(await snapshot()).toEqual(before);
  });
  test('并发新增同一忽略大小写身份只写入一个，数据库直接插入也拒绝跨大小写重复', async () => {
    const results = await Promise.all(
      ['Race.Mixed@Example.TEST', 'race.mixed@example.test'].map(apple_id =>
        call('/apple-ids', 'admin', 'POST', { apple_id, password: 'Synthetic-Race!' })
      )
    );
    expect(results.map(x => x.status).sort()).toEqual([201, 409]);
    const rows = await db.AppleId.findAll();
    expect(rows).toHaveLength(1);
    expect(['Race.Mixed@Example.TEST', 'race.mixed@example.test']).toContain(rows[0].appleId);
    await expect(
      db.sequelize.query(
        "INSERT INTO apple_ids(apple_id,password) VALUES ('RACE.MIXED@EXAMPLE.TEST','opaque-synthetic')"
      )
    ).rejects.toThrow();
    expect(await db.AppleId.count()).toBe(1);
  });
  test('标准Excel多行异大小写合并不产生账号字段冲突，新账号采用首次出现原文并保留密码', async () => {
    const result = await preview([
      [
        'Apple IDs',
        [
          ['Apple ID', '密码', '国家', '状态', '备注'],
          ['First.Mixed@Example.COM', 'Synthetic-Import!', '中国', '未使用', '源备注'],
          ['first.mixed@example.com', 'Synthetic-Import!', '中国', '未使用', '源备注'],
        ],
      ],
    ]);
    expect(result.status).toBe(200);
    expect(result.body.data.summary.records).toBe(1);
    expect(result.body.data.conflicts).toEqual([]);
    expect(result.body.data.records[0].label).toBe('First.Mixed@Example.COM');
    const applied = await execute(result.body.data.sessionToken);
    expect(applied.status).toBe(200);
    expect(applied.body.data.imported).toBe(1);
    const row = await db.AppleId.findOne();
    expect(row.appleId).toBe('First.Mixed@Example.COM');
    expect(
      (await call('/apple-ids/copy-import', 'admin', 'POST', { ids: [row.id] })).body.data.text
    ).toBe('First.Mixed@Example.COM,Synthetic-Import!,');
  });
  test('腾讯中国/香港表实际解析导入均保留大小写；跨sheet重复仍只生成首次原文', async () => {
    const header = [
      'AppleID',
      '密码',
      '国家地区',
      '密保问题1',
      '密保答案1',
      '密保问题2',
      '密保答案2',
      '密保问题3',
      '密保答案3',
      '其他',
      '状态',
      '备注',
    ];
    const result = await preview([
      [
        '26年AppleID中国',
        [
          header,
          [
            'CN.Mixed@Example.COM',
            'Synthetic-CN!',
            '',
            '130',
            'Synthetic-answer',
            '136',
            'Synthetic-answer-2',
            '142',
            'Synthetic-answer-3',
            '',
            '未使用',
            '源备注',
          ],
        ],
      ],
      [
        '26年AppleID香港',
        [
          header,
          ['HK.Mixed@Example.COM', 'Synthetic-HK!', '', '', '', '', '', '', '', '', '使用中', ''],
          [
            'cn.mixed@example.com',
            'Synthetic-CN!',
            '',
            '130',
            'Synthetic-answer',
            '136',
            'Synthetic-answer-2',
            '142',
            'Synthetic-answer-3',
            '',
            '未使用',
            '',
          ],
        ],
      ],
    ]);
    expect(result.status).toBe(200);
    expect(result.body.data.errors).toEqual([]);
    expect(result.body.data.summary.records).toBe(2);
    expect(result.body.data.conflicts).toEqual([]);
    expect((await execute(result.body.data.sessionToken)).status).toBe(200);
    expect((await db.AppleId.findAll({ order: [['id', 'ASC']] })).map(x => x.appleId)).toEqual([
      'CN.Mixed@Example.COM',
      'HK.Mixed@Example.COM',
    ]);
  });
  test('标准Excel同账号仅大小写不同为重复，整行/密文/订单/代抢占用原样；其他字段冲突未裁定不写', async () => {
    const existing = await seedRelated();
    const before = await snapshot();
    const header = ['Apple ID', '密码', '国家', '状态', '备注'];
    const duplicate = await preview([
      [
        'Apple IDs',
        [
          header,
          [
            existing.appleId.toLowerCase(),
            existing.password,
            existing.country,
            existing.status,
            existing.notes,
          ],
        ],
      ],
    ]);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.data.conflicts).toEqual([]);
    expect(duplicate.body.data.records[0].action).toBe('重复');
    expect((await execute(duplicate.body.data.sessionToken)).status).toBe(200);
    expect(await snapshot()).toEqual(before);
    const conflict = await preview([
      [
        'Apple IDs',
        [
          header,
          [existing.appleId.toLowerCase(), 'Other-synthetic!', '中国', '未使用', '不应自动覆盖'],
        ],
      ],
    ]);
    expect(conflict.body.data.conflicts.length).toBeGreaterThan(0);
    expect(conflict.body.data.conflicts.some(x => x.field === 'Apple ID')).toBe(false);
    expect((await execute(conflict.body.data.sessionToken)).status).toBe(409);
    expect(await snapshot()).toEqual(before);
    const decisions = { [`${conflict.body.data.records[0].id}:skip`]: true };
    expect((await execute(conflict.body.data.sessionToken, decisions)).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });
  test('代抢文本新账号保留原文，批内跨大小写重复整批拒绝；已有pool重复及普通档案冲突保全整行与关联', async () => {
    const response = await call('/proxy-orders/accounts/import', 'admin', 'POST', {
      text: 'Pool.Mixed@Example.COM----Synthetic-Pool!',
    });
    expect(response.status).toBe(200);
    const pool = await db.AppleId.findOne();
    expect(pool.appleId).toBe('Pool.Mixed@Example.COM');
    expect(pool.isProxyPool).toBe(true);
    const beforePool = await snapshot();
    expect((await call('/proxy-orders/accounts', 'admin', 'GET')).body.data.rows[0].appleId).toBe(
      'Pool.Mixed@Example.COM'
    );
    expect(
      (await call('/apple-ids/copy-import', 'admin', 'POST', { ids: [pool.id] })).body.data.text
    ).toBe('Pool.Mixed@Example.COM,Synthetic-Pool!,');
    expect(
      (
        await call('/proxy-orders/accounts/import', 'admin', 'POST', {
          text: 'pool.mixed@example.com----Different-synthetic!',
        })
      ).status
    ).toBe(409);
    expect(await snapshot()).toEqual(beforePool);
    expect(
      (
        await call('/proxy-orders/accounts/import', 'admin', 'POST', {
          text: 'pool.mixed@example.com----Synthetic-Pool!',
        })
      ).status
    ).toBe(200);
    expect(await snapshot()).toEqual(beforePool);
    expect(
      (
        await call('/proxy-orders/accounts/import', 'admin', 'POST', {
          text: 'Batch.Mixed@Example.COM----Synthetic-Pool!\nbatch.mixed@example.com----Synthetic-Pool!',
        })
      ).status
    ).toBe(400);
    expect(await snapshot()).toEqual(beforePool);
    await seedRelated();
    const before = await snapshot();
    expect(
      (
        await call('/proxy-orders/accounts/import', 'admin', 'POST', {
          text: 'New.Valid@Example.COM----Synthetic-Pool!\nexisting.mixed@example.test----Synthetic-1!',
        })
      ).status
    ).toBe(409);
    expect(await snapshot()).toEqual(before);
  });
  test('显式裁定仅备注差异时保留账号原拼写、密码/密保密文、编号和全部关系', async () => {
    const account = await seedRelated();
    const before = await snapshot();
    const result = await preview([
      [
        'Apple IDs',
        [
          ['Apple ID', '密码', '国家', '状态', '备注'],
          [
            account.appleId.toLowerCase(),
            account.password,
            account.country,
            account.status,
            '明确裁定的新备注',
          ],
        ],
      ],
    ]);
    expect(result.status).toBe(200);
    expect(result.body.data.conflicts).toHaveLength(1);
    const conflict = result.body.data.conflicts[0];
    expect(conflict.field).toBe('备注');
    expect(
      (await execute(result.body.data.sessionToken, { [conflict.id]: 'source0' })).status
    ).toBe(200);
    const after = await snapshot();
    expect(after.apple_ids[0].row.notes).toBe('明确裁定的新备注');
    for (const key of ['notes', 'updated_at']) {
      delete before.apple_ids[0].row[key];
      delete after.apple_ids[0].row[key];
    }
    expect(after).toEqual(before);
  });
});
