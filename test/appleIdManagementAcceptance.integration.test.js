/* eslint-disable camelcase, no-magic-numbers, max-len -- 独立验收使用原生 SQL 和固定边界值。 */
const enabled = process.env.RUN_APPLEID_ACCEPTANCE === 'true';
(enabled ? describe : describe.skip)('AppleID管理独立真实PG与HTTP验收', () => {
  let db, server, origin, tokens, userIds;
  const migration = require('../migrations/20261016000001-add-apple-id-account-number');
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
      !/^apple_order_mgr_appleid_test_acceptance(?:_final)?_20261016$/.test(
        process.env.DB_NAME || ''
      ) ||
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
  test('正式迁移历史ID有洞仍从1连续；业务字段、加密原文、订单关联逐项保全；down/up', async () => {
    await migration.down(db.sequelize.getQueryInterface());
    await db.sequelize.query(
      "INSERT INTO apple_ids(id,apple_id,password,notes,status) VALUES (90,'history90@example.test','opaque-password','历史备注','异常'),(3,'history3@example.test','opaque-password2','另一备注','未使用')"
    );
    await db.sequelize.query(
      "INSERT INTO orders(order_number,apple_id_ref,products) VALUES ('ACCEPT-HISTORY',90,'[]')"
    );
    const snapshot = async () =>
      (
        await db.sequelize.query(
          "SELECT to_jsonb(a) - 'account_number' AS row FROM apple_ids a ORDER BY id"
        )
      )[0];
    const original = await snapshot();
    await migration.up(db.sequelize.getQueryInterface());
    expect(
      (await db.sequelize.query('SELECT id,account_number FROM apple_ids ORDER BY id'))[0]
    ).toEqual([
      { id: 3, account_number: 1 },
      { id: 90, account_number: 2 },
    ]);
    expect(await snapshot()).toEqual(original);
    expect(
      (
        await db.sequelize.query(
          "SELECT apple_id_ref FROM orders WHERE order_number='ACCEPT-HISTORY'"
        )
      )[0][0].apple_id_ref
    ).toBe(90);
    await migration.down(db.sequelize.getQueryInterface());
    expect(await snapshot()).toEqual(original);
    await migration.up(db.sequelize.getQueryInterface());
  });
  test('空库起号1；模型/API/bulkCreate自动编号；删最高号和事务回滚均不重用', async () => {
    const first = await create(1);
    expect(first.accountNumber).toBe(1);
    const bulk = await db.AppleId.bulkCreate(
      [2, 3].map(i => ({ appleId: `synthetic${i}@example.test`, password: 'Synthetic-only!' })),
      { returning: true }
    );
    expect(bulk.map(x => x.accountNumber)).toEqual([2, 3]);
    await bulk[1].destroy();
    expect((await create(4)).accountNumber).toBe(4);
    await expect(
      db.sequelize.transaction(async transaction => {
        await db.AppleId.create(
          { appleId: 'rolled@example.test', password: 'Synthetic-only!' },
          { transaction }
        );
        throw new Error('deliberate');
      })
    ).rejects.toThrow('deliberate');
    const response = await call('/apple-ids', 'admin', 'POST', {
      apple_id: 'api@example.test',
      password: 'Synthetic-only!',
    });
    expect(response.status).toBe(201);
    expect(
      (await db.AppleId.findOne({ where: { appleId: 'api@example.test' } })).accountNumber
    ).toBe(6);
    await expect(
      db.sequelize.query('UPDATE apple_ids SET account_number=99 WHERE id=:id', {
        replacements: { id: first.id },
      })
    ).rejects.toThrow();
  });
  test('批量状态/备注原子更新，省略保留/null清空，所有其他列原样', async () => {
    const a = await create(1),
      b = await create(2);
    const snap = async () =>
      (
        await db.sequelize.query(
          "SELECT to_jsonb(a) - 'notes' - 'status' - 'updated_at' AS row FROM apple_ids a ORDER BY id"
        )
      )[0];
    const original = await snap();
    expect(
      (
        await call('/apple-ids/batch-update', 'admin', 'POST', {
          ids: [a.id, b.id],
          status: '使用中',
        })
      ).status
    ).toBe(200);
    expect((await a.reload()).notes).toBe('保留备注');
    expect(
      (await call('/apple-ids/batch-update', 'admin', 'POST', { ids: [a.id, b.id], notes: null }))
        .status
    ).toBe(200);
    expect((await a.reload()).notes).toBeNull();
    expect(a.status).toBe('使用中');
    expect(await snap()).toEqual(original);
    expect(
      (
        await call('/apple-ids/batch-update', 'admin', 'POST', {
          ids: [a.id, 2147483000],
          status: '异常',
          notes: '不应写入',
        })
      ).status
    ).toBe(404);
    expect((await a.reload()).status).toBe('使用中');
    expect(a.notes).toBeNull();
  });
  test('批量恶意输入/边界拒绝，5000合法上限被受理后才检查不存在', async () => {
    const a = await create(1);
    for (const body of [
      null,
      [],
      {},
      { ids: [] },
      { ids: [a.id, a.id], notes: 'x' },
      { ids: ['1'], notes: 'x' },
      { ids: [0], notes: 'x' },
      { ids: [1.1], notes: 'x' },
      { ids: [2147483648], notes: 'x' },
      { ids: Array.from({ length: 5001 }, (_, i) => i + 1), notes: 'x' },
      { ids: [a.id] },
      { ids: [a.id], status: null },
      { ids: [a.id], notes: 12 },
      { ids: [a.id], notes: 'x'.repeat(10001) },
      { ids: [a.id], password: 'unapproved', notes: 'x' },
    ]) {
      expect((await call('/apple-ids/batch-update', 'admin', 'POST', body)).status).toBe(400);
    }
    expect(
      (
        await call('/apple-ids/batch-update', 'admin', 'POST', {
          ids: Array.from({ length: 5000 }, (_, i) => i + 1),
          notes: 'x',
        })
      ).status
    ).toBe(404);
    expect((await a.reload()).notes).toBe('保留备注');
  });
  test('数据库写入失败整批回滚', async () => {
    const a = await create(1),
      b = await create(2);
    await db.sequelize.query(
      `CREATE FUNCTION acceptance_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${b.id} THEN RAISE EXCEPTION 'synthetic write rejected'; END IF; RETURN NEW; END $$; CREATE TRIGGER acceptance_reject BEFORE UPDATE ON apple_ids FOR EACH ROW EXECUTE FUNCTION acceptance_reject()`
    );
    try {
      expect(
        (
          await call('/apple-ids/batch-update', 'admin', 'POST', {
            ids: [a.id, b.id],
            status: '异常',
          })
        ).status
      ).toBe(500);
      expect((await a.reload()).status).toBe('未使用');
      expect((await b.reload()).status).toBe('未使用');
    } finally {
      await db.sequelize.query(
        'DROP TRIGGER acceptance_reject ON apple_ids; DROP FUNCTION acceptance_reject()'
      );
    }
  });
  test('copy精确尾逗号/换行及编号升序/no-store；非法凭据整批拒绝', async () => {
    const a = await create(1),
      b = await create(2);
    const response = await call('/apple-ids/copy-import', 'read', 'POST', { ids: [b.id, a.id] });
    expect(response.status).toBe(200);
    expect(response.cache).toBe('no-store');
    expect(response.body.data).toEqual({
      count: 2,
      text: 'synthetic1@example.test,Synthetic-1!,\nsynthetic2@example.test,Synthetic-2!,',
    });
    for (const invalid of ['comma,password', 'line\npassword', 'carriage\rpassword']) {
      await b.update({ password: invalid });
      const denied = await call('/apple-ids/copy-import', 'read', 'POST', { ids: [a.id, b.id] });
      expect(denied.status).toBe(400);
      expect(denied.body.data).toBeUndefined();
    }
    expect(
      (await call('/apple-ids/copy-import', 'read', 'POST', { ids: [a.id, 2147483000] })).status
    ).toBe(404);
  });
  test('编号不允许API创建或编辑传入；最后下单业务日期优先且TAG权限隔离', async () => {
    const a = await create(1);
    for (const key of ['account_number', 'accountNumber']) {
      expect(
        (
          await call('/apple-ids', 'admin', 'POST', {
            apple_id: 'blocked@example.test',
            password: 'Synthetic-only!',
            [key]: 999,
          })
        ).status
      ).toBe(400);
      expect((await call(`/apple-ids/${a.id}`, 'admin', 'PUT', { [key]: 999 })).status).toBe(400);
    }
    await db.sequelize.query(
      "INSERT INTO recipients(last_name,first_name,id_card_number,tag) VALUES ('合成','A','synthetic-A','A'),('合成','B','synthetic-B','B')"
    );
    await db.sequelize.query(
      "INSERT INTO orders(order_number,apple_id_ref,recipient_ref,products,order_date,created_at) SELECT 'ACCEPT-'||tag,:id,id,'[]'::jsonb,CASE WHEN tag='A' THEN '2020-01-02'::timestamptz ELSE '2021-01-02'::timestamptz END,'2026-10-01'::timestamptz FROM recipients WHERE id_card_number IN ('synthetic-A','synthetic-B')",
      { replacements: { id: a.id } }
    );
    const noOrders = await call(`/apple-ids/${a.id}`, 'read', 'GET');
    expect(noOrders.body.data.order_count).toBe(0);
    expect(noOrders.body.data.last_order_date).toBeNull();
    await db.UserPermission.create({ userId: userIds.read, permissionCode: 'orders.read' });
    await db.User.update(
      { orderAccess: { mode: 'tags', tags: ['A'] } },
      { where: { id: userIds.read } }
    );
    const scoped = await call(`/apple-ids/${a.id}`, 'read', 'GET');
    expect(scoped.body.data.order_count).toBe(1);
    expect(new Date(scoped.body.data.last_order_date).getUTCFullYear()).toBe(2020);
    const admin = await call(`/apple-ids/${a.id}`, 'admin', 'GET');
    expect(admin.body.data.order_count).toBe(2);
    expect(new Date(admin.body.data.last_order_date).getUTCFullYear()).toBe(2021);
  });
  test('真实认证与权限：read可复制不可改，edit可改不可读，撤权同token即时生效', async () => {
    const a = await create(1);
    expect(
      (await call('/apple-ids/batch-update', 'read', 'POST', { ids: [a.id], status: '异常' }))
        .status
    ).toBe(403);
    expect((await call('/apple-ids/copy-import', 'edit', 'POST', { ids: [a.id] })).status).toBe(
      403
    );
    expect(
      (await call('/apple-ids/batch-update', 'edit', 'POST', { ids: [a.id], status: '异常' }))
        .status
    ).toBe(200);
    expect((await call('/apple-ids/copy-import', 'none', 'POST', { ids: [a.id] })).status).toBe(
      403
    );
    await db.UserPermission.destroy({ where: { userId: userIds.read } });
    expect((await call('/apple-ids/copy-import', 'read', 'POST', { ids: [a.id] })).status).toBe(
      403
    );
  });
});
