const suite = process.env.RUN_PROXY_FEE_TEST === 'true' ? describe : describe.skip;
const migration = require('../migrations/20261031000001-add-proxy-order-fee');

suite('费用正式迁移与隔离PostgreSQL/API', () => {
  let models, server, origin, actor;
  const evidence = [];
  const payload = (extra = {}) => ({
    lastName: '合',
    firstName: '成',
    phone: '13800000000',
    email: 'synthetic@example.test',
    idLast4: '0123',
    orderSource: '闲鱼',
    productModel: 'Duo',
    color: '白',
    storage: '256GB',
    quantity: 3,
    storeMode: 'city_any',
    storeCity: '重庆',
    confirmedDuplicate: true,
    ...extra,
  });
  const api = async (path, method = 'GET', body, permissions = 'proxy_orders.read') => {
    const response = await fetch(origin + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-test-permissions': permissions },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: await response.json() };
  };
  beforeAll(async () => {
    const database = 'apple_order_mgr_proxy_fee_test_20261031';
    if (
      process.env.DB_NAME !== database ||
      process.env.DB_NAME_TEST !== database ||
      process.env.DATABASE_URL
    )
      throw new Error('仅允许本次独立费用测试库');
    models = require('../src/models');
    const [actual] = await models.sequelize.query('SELECT current_database() AS name');
    expect(actual[0].name).toBe(database);
    actor = await models.User.create({
      username: `synthetic_fee_${Date.now()}`,
      password: 'Synthetic-Only',
      role: 'admin',
      status: 'active',
    });
    const app = require('express')();
    app.use(require('express').json());
    app.use((req, _res, next) => {
      req.user = {
        id: actor.id,
        role: 'operator',
        permissions: String(req.headers['x-test-permissions'] || '').split(','),
      };
      next();
    });
    app.use('/api/proxy-orders', require('../src/routes/proxyOrders'));
    app.use(require('../src/middleware/errorHandler'));
    server = app.listen(0, '0.0.0.0');
    await new Promise(resolve => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}/api/proxy-orders`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (models) await models.sequelize.close();
    if (process.env.PROXY_FEE_EVIDENCE)
      require('node:fs').writeFileSync(
        process.env.PROXY_FEE_EVIDENCE,
        JSON.stringify(evidence, null, 2)
      );
  });
  test('登记实际落库，重新查询列表和详情金额一致且不乘数量', async () => {
    const created = await api('', 'POST', payload({ proxyFee: '120.50' }));
    expect(created.status).toBe(200);
    const { id } = created.json.data;
    expect(created.json.data.proxyFee).toBe('120.50');
    expect((await api(`/${id}`)).json.data.proxyFee).toBe('120.50');
    expect((await api('')).json.data.rows.find(row => row.id === id).proxyFee).toBe('120.50');
    const [stored] = await models.sequelize.query(
      'SELECT proxy_fee::text AS fee FROM proxy_orders WHERE id = :id',
      { replacements: { id } }
    );
    expect(stored[0].fee).toBe('120.50');
    evidence.push({
      case: '登记独立回读',
      request: { quantity: 3, proxyFee: '120.50' },
      status: created.status,
      response: created.json.data.proxyFee,
      sql: stored[0].fee,
    });
  });
  test('编辑省略保留、0可保存、null/空白清空、非法输入不写任何数据', async () => {
    const { json } = await api('', 'POST', payload({ proxyFee: '99.99' }));
    const id = json.data.id;
    let version = json.data.version;
    for (const [body, expected] of [
      [{ notes: '改备注' }, '99.99'],
      [{ proxyFee: 0 }, '0.00'],
      [{ proxyFee: null }, null],
      [{ proxyFee: '88.10' }, '88.10'],
      [{ proxyFee: ' ' }, null],
    ]) {
      const saved = await api(`/${id}`, 'PUT', { ...body, expectedVersion: version });
      expect(saved.status).toBe(200);
      version = saved.json.data.version;
      expect(saved.json.data.proxyFee).toBe(expected);
      expect((await api(`/${id}`)).json.data.proxyFee).toBe(expected);
      const [stored] = await models.sequelize.query(
        'SELECT proxy_fee::text AS fee FROM proxy_orders WHERE id = :id',
        { replacements: { id } }
      );
      expect(stored[0].fee).toBe(expected);
      evidence.push({
        case: '编辑独立回读',
        request: body,
        response: saved.json.data.proxyFee,
        sql: stored[0].fee,
      });
    }
    const events = await models.ProxyEvent.count();
    for (const proxyFee of [-1, '1.005', '1e2', true, [], '10000000000']) {
      expect((await api(`/${id}`, 'PUT', { expectedVersion: version, proxyFee })).status).toBe(400);
      expect((await api('', 'POST', payload({ proxyFee }))).status).toBe(400);
    }
    expect((await api(`/${id}`)).json.data).toMatchObject({ version, proxyFee: null });
    expect(await models.ProxyEvent.count()).toBe(events);
    evidence.push({
      case: '非法输入拒绝',
      status: 400,
      version,
      proxyFee: null,
      auditUnchanged: true,
    });
    const empty = await api('', 'POST', payload());
    expect(empty.json.data.proxyFee).toBeNull();
  });
  test('并发编辑只有一笔通过；失权写入403且不覆盖费用', async () => {
    const { json } = await api('', 'POST', payload({ proxyFee: '10' }));
    const { id, version } = json.data;
    const responses = await Promise.all(
      ['20.01', '30.02'].map(proxyFee =>
        api(`/${id}`, 'PUT', { expectedVersion: version, proxyFee })
      )
    );
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const saved = (await api(`/${id}`)).json.data;
    expect(saved.proxyFee).toBe(responses.find(r => r.status === 200).json.data.proxyFee);
    expect(
      (await api(`/${id}`, 'PUT', { expectedVersion: saved.version, proxyFee: '999' }, '')).status
    ).toBe(403);
    expect((await api(`/${id}`)).json.data.proxyFee).toBe(saved.proxyFee);
    evidence.push({
      case: '同版本并发与失权',
      statuses: responses.map(r => r.status).sort(),
      winnerFee: saved.proxyFee,
      forbiddenStatus: 403,
      preserved: true,
    });
  });
  test('数据库范围约束、含0及软删除费用的down保护、无费用回退再升级不填0', async () => {
    const queryInterface = models.sequelize.getQueryInterface();
    const { json } = await api('', 'POST', payload({ proxyFee: 0 }));
    const id = json.data.id;
    await models.ProxyOrder.update({ deletedAt: new Date() }, { where: { id } });
    for (const value of ['-0.01', 'NaN', '10000000000']) {
      await expect(
        models.sequelize.query('UPDATE proxy_orders SET proxy_fee = :value WHERE id = :id', {
          replacements: { value, id },
        })
      ).rejects.toThrow();
    }
    await expect(migration.down(queryInterface)).rejects.toThrow('已有委托费用');
    await models.sequelize.query('UPDATE proxy_orders SET proxy_fee = NULL');
    const count = await models.ProxyOrder.unscoped().count();
    await migration.down(queryInterface);
    await migration.up(queryInterface);
    expect(await models.ProxyOrder.unscoped().count()).toBe(count);
    expect(await models.ProxyOrder.unscoped().count({ where: { proxyFee: null } })).toBe(count);
    evidence.push({
      case: '迁移保护',
      softDeletedZeroBlocksDown: true,
      rangeConstraint: true,
      rowsBefore: count,
      rowsAfter: count,
      allNullAfterUp: true,
    });
  });
});
