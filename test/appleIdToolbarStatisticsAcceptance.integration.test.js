/* eslint-disable camelcase, no-magic-numbers, max-len -- 独立验收使用原生 SQL 和固定边界值。 */
const enabled = process.env.RUN_APPLEID_TOOLBAR_ACCEPTANCE === 'true';
(enabled ? describe : describe.skip)('AppleID工具栏统计独立真实PG与HTTP验收', () => {
  let db, server, origin, tokens, userIds;
  async function call(path, actor = 'admin', method = 'GET', body) {
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
      !/^apple_order_mgr_appleid_toolbar_acceptance_20261016$/.test(process.env.DB_NAME || '') ||
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
  test('空库统计已知四态均0，选择为空；响应严格无账号和凭据字段', async () => {
    const stats = await call('/apple-ids/statistics');
    expect(stats.status).toBe(200);
    expect(stats.cache).toBe('no-store');
    expect(stats.body.data.total).toBe(0);
    expect(stats.body.data.statuses).toHaveLength(4);
    expect(stats.body.data.statuses.every(x => x.count === 0)).toBe(true);
    expect(Object.keys(stats.body.data).sort()).toEqual(['statuses', 'total']);
    const selection = await call('/apple-ids/selection-ids');
    expect(selection.status).toBe(200);
    expect(selection.cache).toBe('no-store');
    expect(selection.body.data).toEqual({ ids: [], total: 0 });
  });
  test('全局统计四态总和准确，筛选和分页参数不影响；数据库拒绝未知状态', async () => {
    for (const [i, status] of ['未使用', '使用中', '已下架', '异常', '使用中'].entries())
      await create(i, { status });
    await expect(
      db.sequelize.query(
        "INSERT INTO apple_ids(apple_id,password,status) VALUES ('legacy@example.test','opaque-synthetic','历史状态')"
      )
    ).rejects.toThrow();
    const before = (
      await db.sequelize.query('SELECT to_jsonb(a) AS row FROM apple_ids a ORDER BY id')
    )[0];
    const response = await call(
      '/apple-ids/statistics?keyword=missing&status=异常&country=美国&page=99'
    );
    expect(response.status).toBe(200);
    expect(response.body.data.total).toBe(5);
    expect(Object.fromEntries(response.body.data.statuses.map(x => [x.status, x.count]))).toEqual({
      未使用: 1,
      使用中: 2,
      已下架: 1,
      异常: 1,
    });
    expect(response.body.data.statuses.reduce((a, x) => a + x.count, 0)).toBe(5);
    expect(JSON.stringify(response.body)).not.toMatch(
      /password|security|apple_id|example.test|opaque/
    );
    expect(
      (await db.sequelize.query('SELECT to_jsonb(a) AS row FROM apple_ids a ORDER BY id'))[0]
    ).toEqual(before);
  });
  test('statistics与selection仅read许可，edit单独不允许，令牌缺失/许可撤销立即拒绝', async () => {
    for (const path of ['/apple-ids/statistics', '/apple-ids/selection-ids']) {
      expect((await call(path, 'read')).status).toBe(200);
      for (const actor of ['edit', 'none']) {
        const response = await call(path, actor);
        expect(response.status).toBe(403);
        expect(response.cache).toBe('no-store');
      }
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(401);
    }
    await db.UserPermission.destroy({ where: { userId: userIds.read } });
    expect((await call('/apple-ids/statistics', 'read')).status).toBe(403);
    expect((await call('/apple-ids/selection-ids', 'read')).status).toBe(403);
  });
  test('筛选选择与跨页列表完全相同，忽略邮箱大小写，组合country/status，数据只读', async () => {
    for (let i = 0; i < 35; i++)
      await create(i, { country: i % 3 ? '中国' : '美国', status: i % 2 ? '使用中' : '未使用' });
    const before = (
      await db.sequelize.query('SELECT to_jsonb(a) AS row FROM apple_ids a ORDER BY id')
    )[0];
    for (const query of [
      '',
      'keyword=SYNTHETIC',
      'status=使用中',
      'country=美国',
      'country=中国&status=未使用&keyword=synthetic',
      'keyword=no-match',
    ]) {
      const response = await call(`/apple-ids/selection-ids?${encodeURI(query)}`);
      expect(response.status).toBe(200);
      const ids = [];
      for (let page = 1; page <= 4; page++) {
        const list = await call(`/apple-ids?${encodeURI(query)}&limit=10&page=${page}`);
        expect(list.status).toBe(200);
        ids.push(...list.body.data.apple_ids.map(x => x.id));
      }
      expect(response.body.data).toEqual({ ids, total: ids.length });
      expect(Object.keys(response.body.data).sort()).toEqual(['ids', 'total']);
      expect(JSON.stringify(response.body)).not.toMatch(
        /password|security|apple_id|example.test|notes/
      );
    }
    expect(
      (await db.sequelize.query('SELECT to_jsonb(a) AS row FROM apple_ids a ORDER BY id'))[0]
    ).toEqual(before);
  });
  test('选择拒绝未知/对象/重复/过长筛选及非法状态，SQL语法按普通字符串处理', async () => {
    await create(1);
    for (const query of [
      'page=1',
      'recipient_id=1',
      'status=坏状态',
      'keyword[]=a',
      'country[x]=a',
      'keyword=a&keyword=b',
      `keyword=${'x'.repeat(256)}`,
      `country=${'x'.repeat(51)}`,
    ]) {
      const response = await call(`/apple-ids/selection-ids?${encodeURI(query)}`);
      expect(response.status).toBe(400);
      expect(response.cache).toBe('no-store');
      expect(response.body.data?.ids).toBeUndefined();
    }
    expect(
      (await call(`/apple-ids/selection-ids?keyword=${encodeURIComponent("' OR 1=1 --")}`)).body
        .data
    ).toEqual({ ids: [], total: 0 });
    expect(await db.AppleId.count()).toBe(1);
  });
  test('5000匹配完整返回，5001整批400无部分ID，筛选缩小仍可成功', async () => {
    await db.sequelize.query(
      "INSERT INTO apple_ids(apple_id,password,status,country) SELECT 'limit' || x || '@example.test','opaque-synthetic','未使用','中国' FROM generate_series(1,5000) x"
    );
    const selection = await call('/apple-ids/selection-ids');
    expect(selection.status).toBe(200);
    expect(selection.body.data.total).toBe(5000);
    expect(new Set(selection.body.data.ids).size).toBe(5000);
    expect(selection.body.data.ids).toEqual([...selection.body.data.ids].sort((a, b) => b - a));
    await create(5001, { country: '美国' });
    const over = await call('/apple-ids/selection-ids');
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('APPLE_ID_SELECTION_LIMIT_EXCEEDED');
    expect(over.body.data).toBeUndefined();
    expect((await call('/apple-ids/selection-ids?country=中国')).body.data.total).toBe(5000);
    expect((await call('/apple-ids/statistics')).body.data.total).toBe(5001);
  });
});
