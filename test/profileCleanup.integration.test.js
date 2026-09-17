/* eslint-disable camelcase -- 隔离库 SQL 字段 */
const describeIntegration =
  process.env.RUN_PROFILE_CLEANUP_TEST === 'true' ? describe : describe.skip;

describeIntegration('基础资料清理与可空手机号隔离数据库验证', () => {
  let models;
  let clearTestProfiles;
  let apple;
  let recipient;
  let order;
  beforeAll(async () => {
    if (
      !/^apple_order_mgr_profiles_test_\d+$/.test(process.env.DB_NAME || '') ||
      process.env.DATABASE_URL
    )
      throw new Error('仅允许专用隔离库');
    models = require('../src/models');
    ({ clearTestProfiles } = require('../scripts/clearTestProfiles'));
    await models.sequelize.authenticate();
    if (
      (await models.Order.count()) ||
      (await models.AppleId.count()) ||
      (await models.Recipient.count())
    )
      throw new Error('隔离库必须为空');
    apple = await models.AppleId.create({
      appleId: 'synthetic-cleanup@example.invalid',
      password: 'synthetic-profile-only',
    });
    recipient = await models.Recipient.create({
      lastName: '测',
      firstName: '试',
      idCardNumber: '110101199001011234',
      phone: null,
      appleIdRef: apple.id,
    });
    order = await models.Order.create({
      orderNumber: 'W7333333333',
      appleIdRef: apple.id,
      recipientRef: recipient.id,
      appleId: apple.appleId,
      applePassword: apple.password,
      recipientName: '测试快照',
      recipientIdCard: recipient.idCardNumber,
      recipientPhone: '13800000000',
      products: [{ name: '合成商品', quantity: 2 }],
      status: 'pending',
      tag: '保留快照',
    });
    await models.PaymentTask.create({ orderId: order.id, processingStatus: 'pending' });
  });
  afterAll(async () => {
    if (models) await models.sequelize.close();
  });

  test('联系电话可空、设值后可清空，密码和身份证仍为密文', async () => {
    await recipient.update({ phone: '13800000000' });
    await recipient.update({ phone: null });
    await recipient.reload();
    expect(recipient.phone).toBeNull();
    const [rows] = await models.sequelize.query(
      'SELECT id_card_number FROM recipients WHERE id = :id',
      { replacements: { id: recipient.id } }
    );
    expect(rows[0].id_card_number).not.toBe(recipient.idCardNumber);
    const [apples] = await models.sequelize.query('SELECT password FROM apple_ids WHERE id = :id', {
      replacements: { id: apple.id },
    });
    expect(apples[0].password).not.toBe(apple.password);
  });

  test('真实控制器保存空电话、拒绝非法值，读取无地址/密保扩权', async () => {
    const recipients = require('../src/controllers/recipientController');
    const apples = require('../src/controllers/appleIdController');
    const req = {
      params: { id: String(recipient.id) },
      body: { phone: '   ' },
      user: { role: 'operator', permissions: ['recipients.read', 'apple_ids.read'] },
    };
    const res = { json: jest.fn(), set: jest.fn() };
    await recipients.updateRecipient(req, res);
    expect((await recipient.reload()).phone).toBeNull();
    await expect(
      recipients.updateRecipient({ ...req, body: { phone: 'invalid' } }, res)
    ).rejects.toMatchObject({ statusCode: 400 });
    await recipients.getRecipientDetail(req, res);
    expect(res.json.mock.lastCall[0].data).toMatchObject({
      id_card_number: recipient.idCardNumber,
      phone: null,
      street_address: null,
    });
    await apples.getAppleIdDetail({ ...req, params: { id: String(apple.id) } }, res);
    expect(res.json.mock.lastCall[0].data.password).toBe(apple.password);
    expect(res.json.mock.lastCall[0].data).not.toHaveProperty('securityQa');
  });

  test('只读预览和错误指纹不会删除记录', async () => {
    const plan = await clearTestProfiles();
    expect(plan).toMatchObject({
      executed: false,
      appleIds: 1,
      recipients: 1,
      orders: 1,
      paymentTasks: 1,
    });
    await expect(
      clearTestProfiles({ execute: true, expectedFingerprint: '0'.repeat(64) })
    ).rejects.toThrow('资料已变化');
    expect(await models.AppleId.count()).toBe(1);
    expect(await models.Recipient.count()).toBe(1);
  });

  test('未知级联关联拒绝且回滚，正确执行仅清理基础资料与外键', async () => {
    await models.sequelize.query(
      'CREATE TABLE profile_cleanup_guard (id integer REFERENCES recipients(id) ON DELETE CASCADE)'
    );
    try {
      const plan = await clearTestProfiles();
      await expect(
        clearTestProfiles({ execute: true, expectedFingerprint: plan.fingerprint })
      ).rejects.toThrow('未知或非置空外键');
      expect(await models.Recipient.count()).toBe(1);
    } finally {
      await models.sequelize.query('DROP TABLE profile_cleanup_guard');
    }
    const before = order.toJSON();
    const plan = await clearTestProfiles();
    expect(
      await clearTestProfiles({ execute: true, expectedFingerprint: plan.fingerprint })
    ).toMatchObject({
      executed: true,
      remainingAppleIds: 0,
      remainingRecipients: 0,
      ordersUnchangedExceptLinks: true,
      paymentTasksUnchanged: true,
    });
    await order.reload();
    expect(order.appleIdRef).toBeNull();
    expect(order.recipientRef).toBeNull();
    expect(order.applePassword).toBe(before.applePassword);
    expect(order.recipientIdCard).toBe(before.recipientIdCard);
    expect(order.products).toEqual(before.products);
    expect(order.tag).toBe(before.tag);
    expect(await models.PaymentTask.count()).toBe(1);
  });
});
