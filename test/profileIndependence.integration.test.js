/* eslint-disable camelcase -- 接口及数据库字段 */
const integration = process.env.RUN_PROFILE_MANAGEMENT_TEST === 'true' ? describe : describe.skip;

integration('独立档案、迁移保护和订单权限 PostgreSQL 回归', () => {
  let models, recipients, apples, orders, imports, migration, user;
  const response = () => ({
    json: jest.fn(),
    set: jest.fn(),
    setHeader: jest.fn(),
    send: jest.fn(),
    status: jest.fn().mockReturnThis(),
  });
  const query = async sql => (await models.sequelize.query(sql))[0];
  beforeAll(async () => {
    if (
      !/^apple_order_mgr_profiles_test_\d+$/.test(process.env.DB_NAME || '') ||
      process.env.DATABASE_URL
    )
      throw new Error('仅允许隔离库');
    models = require('../src/models');
    recipients = require('../src/controllers/recipientController');
    apples = require('../src/controllers/appleIdController');
    orders = require('../src/controllers/orderController');
    imports = require('../src/services/profileImportService');
    migration = require('../migrations/20261012000001-retire-profile-bindings');
    user = {
      role: 'admin',
      permissions: Object.values(require('../src/constants/business').PERMISSIONS),
    };
    await models.sequelize.authenticate();
    const [[state]] = await models.sequelize.query(
      "SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='chk_recipients_profiles_independent') AS ready"
    );
    if (!state.ready) await migration.up(models.sequelize.getQueryInterface());
    await models.sequelize.query(
      'TRUNCATE users, apple_ids, recipients, orders RESTART IDENTITY CASCADE'
    );
  });
  afterAll(async () => {
    if (models) await models.sequelize.close();
  });

  test('迁移结束旧关系和清空冗余列；全表订单、库存、付款、账号保护；down不恢复关系', async () => {
    const qi = models.sequelize.getQueryInterface();
    await migration.down(qi);
    const a = await models.AppleId.create({
      appleId: 'migration-synthetic@example.invalid',
      password: 'synthetic',
    });
    const p = await models.Recipient.create({
      lastName: '迁',
      firstName: '移',
      idCardNumber: '110101199001019001',
      appleIdRef: a.id,
    });
    await models.Order.create({
      orderNumber: 'W8120000001',
      appleIdRef: a.id,
      recipientRef: p.id,
      appleId: a.appleId,
      applePassword: 'snapshot',
      recipientName: '迁移',
      recipientIdLast4: '9001',
      tag: '合成TAG',
      products: [{ name: '合成商品', quantity: 1 }],
    });
    const tables = [
      'orders',
      'apple_ids',
      'stock_units',
      'stock_events',
      'payment_tasks',
      'payment_task_events',
    ];
    const snapshot = async () => {
      const out = {};
      for (const table of tables) out[table] = await query(`SELECT * FROM ${table} ORDER BY id`);
      return out;
    };
    const before = await snapshot();
    const historyBefore = await query(`SELECT * FROM profile_bindings WHERE recipient_id=${p.id}`);
    expect(historyBefore).toHaveLength(1);
    await migration.up(qi);
    expect(await snapshot()).toEqual(before);
    const history = await query(`SELECT * FROM profile_bindings WHERE recipient_id=${p.id}`);
    expect(history[0]).toMatchObject({ ...historyBefore[0], ended_at: expect.any(Date) });
    expect(
      (await query(`SELECT apple_id_ref,apple_id,password FROM recipients WHERE id=${p.id}`))[0]
    ).toEqual({ apple_id_ref: null, apple_id: null, password: null });
    for (const column of ['apple_id_ref', 'apple_id', 'password']) {
      const value = column === 'apple_id_ref' ? String(a.id) : "'old-write'";
      await expect(
        query(`UPDATE recipients SET ${column}=${value} WHERE id=${p.id}`)
      ).rejects.toThrow();
    }
    await a.update({ password: 'new-password' });
    expect((await p.reload()).password).toBeNull();
    await migration.down(qi);
    expect((await p.reload()).appleIdRef).toBeNull();
    expect(await query(`SELECT * FROM profile_bindings WHERE recipient_id=${p.id}`)).toEqual(
      history
    );
    await migration.up(qi);
    expect((await p.reload()).appleIdRef).toBeNull();
  });

  test('一人多账号及一账号多人按订单分别统计，TAG相交且无orders.read不查询泄露', async () => {
    const a = await models.AppleId.create({
      appleId: 'independent-a@example.invalid',
      password: 'synthetic',
    });
    const b = await models.AppleId.create({
      appleId: 'independent-b@example.invalid',
      password: 'synthetic',
    });
    const p = await models.Recipient.create({
      lastName: '张',
      firstName: '三',
      idCardNumber: '110101199001019002',
      tag: '可见',
    });
    const q = await models.Recipient.create({
      lastName: '李',
      firstName: '四',
      idCardNumber: '110101199001019003',
      tag: '可见',
    });
    const hidden = await models.Recipient.create({
      lastName: '隐',
      firstName: '藏',
      idCardNumber: '110101199001019010',
      tag: '隐藏',
    });
    for (const [n, account, person, tag] of [
      [2, a, p, '可见'],
      [3, b, p, '可见'],
      [4, a, q, '可见'],
      [5, a, hidden, '隐藏'],
    ]) {
      await models.Order.create({
        orderNumber: `W812000000${n}`,
        appleIdRef: account.id,
        recipientRef: person.id,
        recipientName: person.lastName + person.firstName,
        tag,
        products: [{ name: '合成商品', quantity: 1 }],
      });
    }
    const scoped = {
      role: 'operator',
      permissions: ['recipients.read', 'apple_ids.read', 'orders.read'],
      orderAccess: { mode: 'tags', tags: ['可见'] },
    };
    const personRes = response(),
      appleRes = response();
    await recipients.getRecipientDetail({ params: { id: p.id }, user: scoped }, personRes);
    await apples.getAppleIdDetail({ params: { id: a.id }, query: {}, user: scoped }, appleRes);
    expect(personRes.json.mock.lastCall[0].data.order_count).toBe(2);
    expect(appleRes.json.mock.lastCall[0].data.order_count).toBe(2);
    for (const [filter, id] of [
      ['recipient_id', p.id],
      ['apple_id', a.id],
    ]) {
      const res = response();
      await orders.listOrders({ query: { [filter]: String(id) }, user: scoped }, res);
      expect(res.json.mock.lastCall[0].data.orders).toHaveLength(2);
      expect(res.json.mock.lastCall[0].data.orders.every(row => row.tag === '可见')).toBe(true);
    }
    const noOrders = { ...scoped, permissions: ['recipients.read', 'apple_ids.read'] };
    const hiddenRes = response();
    await apples.getAppleIdDetail({ params: { id: a.id }, query: {}, user: noOrders }, hiddenRes);
    expect(hiddenRes.json.mock.lastCall[0].data).toMatchObject({
      order_count: 0,
      last_order_date: null,
    });
    expect(hiddenRes.json.mock.lastCall[0].data).not.toHaveProperty('recipients');
    const noPersonOrders = response();
    await recipients.getRecipientDetail({ params: { id: p.id }, user: noOrders }, noPersonOrders);
    expect(noPersonOrders.json.mock.lastCall[0].data.order_count).toBe(0);
    expect(noPersonOrders.json.mock.lastCall[0].data).not.toHaveProperty('apple_id');
  });

  test('旧接口410与非空旧CRUD字段400；取机人导入不改账号，TXT账号密码留空', async () => {
    await expect(recipients.updateBinding({}, response())).rejects.toMatchObject({
      statusCode: 410,
      code: 'PROFILE_BINDING_RETIRED',
    });
    await expect(recipients.batchBindAppleIds({}, response())).rejects.toMatchObject({
      statusCode: 410,
    });
    for (const field of [
      'appleId',
      'appleIdRef',
      'apple_id',
      'apple_id_ref',
      'password',
      'expectedAppleIdRef',
    ]) {
      await expect(
        recipients.createRecipient({ body: { [field]: 'legacy' }, user }, response())
      ).rejects.toMatchObject({ statusCode: 400, code: 'PROFILE_BINDING_RETIRED' });
    }
    const profiles = await imports.loadProfiles();
    const before = await query('SELECT * FROM apple_ids ORDER BY id');
    const plan = imports.buildImportPlan(
      [
        {
          fileName: '合成.xlsx',
          sheetName: '取机人',
          rowNumber: 2,
          data: {
            lastName: '独',
            firstName: '立',
            idCardNumber: '110101199001019004',
            appleId: 'independent-a@example.invalid',
            password: 'MUST_NOT_CHANGE',
          },
        },
      ],
      'recipients',
      profiles
    );
    expect(plan.records[0].warnings).toHaveLength(1);
    await models.sequelize.transaction(transaction =>
      imports.applyImportPlan(plan, { user: { permissions: ['recipients.import'] } }, transaction)
    );
    expect(await query('SELECT * FROM apple_ids ORDER BY id')).toEqual(before);
    const p = await models.Recipient.findOne({ where: { lastName: '独' } });
    expect(p.appleIdRef).toBeNull();
    const exported = response();
    await recipients.exportRecipients(
      { query: { ids: String(p.id), includeSensitive: 'true' }, user },
      exported
    );
    expect(exported.send.mock.lastCall[0].toString()).toMatch(/^,,,,1,指定地址,/);
    expect(exported.setHeader).toHaveBeenCalledWith(
      'X-Profile-Export-Notice',
      'ACCOUNT_COLUMNS_EMPTY'
    );
  });
});
