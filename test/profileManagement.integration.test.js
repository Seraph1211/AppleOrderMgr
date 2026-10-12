/* eslint-disable camelcase -- 接口及 SQL 字段 */
const describeIntegration =
  process.env.RUN_PROFILE_MANAGEMENT_TEST === 'true' ? describe : describe.skip;

/** 只在一次性隔离库执行；包含真实触发器、事务、加密和并发。 */
describeIntegration('取机人和账号管理 PostgreSQL 回归', () => {
  let models, user, recipientController, appleController, imports, associations, importService;
  let counter = 0;
  const response = () => ({
    json: jest.fn(),
    set: jest.fn(),
    setHeader: jest.fn(),
    send: jest.fn(),
    status: jest.fn().mockReturnThis(),
  });
  const person = (name = '测试', values = {}) =>
    models.Recipient.create({
      lastName: name.slice(0, 1),
      firstName: name.slice(1),
      idCardNumber: `11010119900101${String(++counter).padStart(4, '0')}`,
      ...values,
    });
  const account = (values = {}) =>
    models.AppleId.create({
      appleId: `account-${++counter}@example.invalid`,
      password: 'synthetic-password',
      ...values,
    });
  const query = async sql => (await models.sequelize.query(sql))[0];
  beforeAll(async () => {
    if (
      !/^apple_order_mgr_profiles_test_\d+$/.test(process.env.DB_NAME || '') ||
      process.env.DATABASE_URL
    )
      throw new Error('仅允许隔离库');
    models = require('../src/models');
    recipientController = require('../src/controllers/recipientController');
    appleController = require('../src/controllers/appleIdController');
    imports = require('../src/controllers/importController');
    associations = require('../src/controllers/profileAssociationController');
    importService = require('../src/services/profileImportService');
    await models.sequelize.authenticate();
    await models.sequelize.query(
      'TRUNCATE users, apple_ids, recipients, orders RESTART IDENTITY CASCADE'
    );
    const created = await models.User.create({
      username: 'profile_synthetic',
      password: 'Synthetic123456!',
      role: 'admin',
    });
    user = {
      id: created.id,
      role: created.role,
      permissions: Object.values(require('../src/constants/business').PERMISSIONS),
    };
  });
  afterAll(async () => {
    if (models) await models.sequelize.close();
  });

  test('编辑地址、真实电话和备注；生成下单资料不会覆盖真实电话', async () => {
    const x = await person();
    await recipientController.updateRecipient(
      {
        params: { id: x.id },
        body: {
          province: '四川省',
          city: '成都市',
          district: '武侯区',
          streetAddress: '合成地址1号',
          notes: '说明',
          realPhone: '13900000000',
        },
        user,
      },
      response()
    );
    await recipientController.batchGenerateContact(
      { body: { recipient_ids: [x.id] }, user },
      response()
    );
    await x.reload();
    expect(x.email).toBe(`${x.phone}@vvv8.net`);
    expect(x.realPhone).toBe('13900000000');
    expect(x.notes).toBe('说明');
    expect(x.streetAddress).toBe('合成地址1号');
    await recipientController.updateRecipient(
      { params: { id: x.id }, body: { realPhone: '', streetAddress: '', notes: '' }, user },
      response()
    );
    await x.reload();
    expect(x.realPhone).toBeNull();
    expect(x.streetAddress).toBeNull();
    expect(x.notes).toBeNull();
  });

  test('有权限读取现有密保；普通请求不返回；清空与保留语义正确', async () => {
    const qa = Object.fromEntries(
      [1, 2, 3].flatMap(i => [
        [`question${i}`, `Q${i}`],
        [`answer${i}`, `A${i}`],
      ])
    );
    const a = await account({ securityQa: qa });
    const res = response();
    await appleController.getAppleIdDetail(
      { params: { id: a.id }, query: { includeSecrets: 'true' }, user },
      res
    );
    expect(res.json.mock.lastCall[0].data.security_qa).toEqual(qa);
    await expect(
      appleController.getAppleIdDetail(
        {
          params: { id: a.id },
          query: { includeSecrets: 'true' },
          user: { permissions: ['apple_ids.read'] },
        },
        response()
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    await appleController.updateAppleId(
      { params: { id: a.id }, body: { notes: '普通编辑' }, user },
      response()
    );
    expect((await a.reload()).securityQa).toEqual(qa);
    await appleController.updateAppleId(
      { params: { id: a.id }, body: { security_qa: null }, user },
      response()
    );
    expect((await a.reload()).securityQa).toBeNull();
  });

  test('已确认账号差异才更新；取机人导入不回绑、密码加密且备注不丢', async () => {
    const a = await account({ notes: '旧备注' });
    const snapshot = await importService.loadProfiles();
    const rows = [
      {
        fileName: '合成.xlsx',
        sheetName: 'Apple IDs',
        rowNumber: 2,
        data: { appleId: a.appleId, password: 'new-synthetic', notes: '新备注' },
      },
    ];
    const unresolved = importService.buildImportPlan(rows, 'apple_ids', snapshot);
    expect(unresolved.summary.conflicts).toBe(2);
    await expect(
      models.sequelize.transaction(transaction =>
        importService.applyImportPlan(unresolved, { user }, transaction)
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    const choices = Object.fromEntries(
      unresolved.conflicts.map(conflict => [conflict.id, 'source0'])
    );
    const plan = importService.buildImportPlan(rows, 'apple_ids', snapshot, choices);
    await models.sequelize.transaction(async transaction => {
      await require('../src/services/profileBindingService').lockProfiles(
        transaction,
        user.id,
        true
      );
      await importService.applyImportPlan(plan, { user }, transaction);
    });
    await a.reload();
    expect(a.password).toBe('new-synthetic');
    expect(a.notes).toBe('新备注');
    const stored = await query(`SELECT password FROM apple_ids WHERE id=${a.id}`);
    expect(stored[0].password).not.toBe(a.password);
    const x = await person();
    const profiles = await importService.loadProfiles();
    const recipientPlan = importService.buildImportPlan(
      [
        {
          rowNumber: 2,
          data: {
            lastName: x.lastName,
            firstName: x.firstName,
            idCardNumber: x.idCardNumber,
            appleId: a.appleId,
          },
        },
      ],
      'recipients',
      profiles
    );
    await models.sequelize.transaction(async transaction => {
      await require('../src/services/profileBindingService').lockProfiles(
        transaction,
        user.id,
        true
      );
      await importService.applyImportPlan(recipientPlan, { user }, transaction);
    });
    const history = await query(`SELECT * FROM profile_bindings WHERE recipient_id=${x.id}`);
    expect(history).toEqual([]);
    expect((await x.reload()).appleIdRef).toBeNull();
  });

  test('文件预览只读、资料变化后令牌拒绝执行，无真实文件留存', async () => {
    const fs = require('fs'),
      os = require('os'),
      path = require('path'),
      XLSX = require('xlsx');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-integration-'));
    try {
      const file = path.join(dir, 'input.xlsx'),
        book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.aoa_to_sheet([
          ['Apple ID', '密码'],
          ['preview@example.invalid', 'synthetic'],
        ]),
        'Apple IDs'
      );
      XLSX.writeFile(book, file);
      const res = response();
      await imports.previewImport(
        {
          query: { type: 'apple_ids' },
          body: {},
          file: { path: file, originalname: '合成.xlsx' },
          user,
        },
        res
      );
      expect(await models.AppleId.count({ where: { appleId: 'preview@example.invalid' } })).toBe(0);
      expect(fs.existsSync(file)).toBe(false);
      await account();
      await expect(
        imports.executeImport(
          {
            body: { type: 'apple_ids', sessionToken: res.json.mock.lastCall[0].data.sessionToken },
            user,
          },
          response()
        )
      ).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('历史关联必须确认；只补空外键，不依赖当前绑定，不改快照', async () => {
    const x = await person('证据人'),
      a = await account();
    const order = await models.Order.create({
      orderNumber: 'W7000000010',
      ingestionSource: 'aos',
      recipientPhone: '13900000001',
      recipientEmail: 'different@example.invalid',
      appleId: a.appleId,
      recipientName: '证据人',
      recipientIdLast4: x.idCardLast4,
      products: [{ name: '合成商品', quantity: 1 }],
      tag: '历史TAG',
      applePassword: '历史密码',
    });
    const res = response();
    await associations.previewAssociations({ body: {}, user }, res);
    const preview = res.json.mock.lastCall[0].data;
    expect((await order.reload()).recipientRef).toBeNull();
    expect(preview.records.find(row => row.orderId === order.id)).toMatchObject({
      recipientId: x.id,
      appleIdRef: a.id,
    });
    await associations.executeAssociations(
      { body: { token: preview.token, orderIds: [order.id] }, user },
      response()
    );
    await order.reload();
    expect(order.toJSON()).toMatchObject({
      recipientRef: x.id,
      appleIdRef: a.id,
      applePassword: '历史密码',
      recipientPhone: '13900000001',
      recipientEmail: 'different@example.invalid',
      tag: '历史TAG',
    });
  });

  test('完整导出只返回逐行 TXT 录入模板串', async () => {
    const x = await person('欧阳明', {
        lastName: '欧阳',
        firstName: '明',
        phone: '13800000000',
        email: '13800000000@vvv8.net',
        tag: '合成TAG',
        realPhone: '13900000000',
        notes: '备注',
      }),
      y = await person('测试乙', { phone: '13900000001', tag: '第二TAG' });
    const res = response();
    await recipientController.exportRecipients(
      { query: { ids: `${x.id},${y.id}`, includeSensitive: 'true' }, user },
      res
    );
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8');
    expect(res.setHeader.mock.calls.find(([name]) => name === 'Content-Disposition')[1]).toContain(
      '.txt'
    );
    const lines = res.send.mock.lastCall[0].toString('utf8').split('\n');
    expect(lines).toHaveLength(2);
    expect(lines).toContain(
      `,,,,1,指定地址,13800000000,欧阳,明,,13800000000@vvv8.net,,,,,,,,,,,,WECHAT,0,,,,否##0#7-1-8-9-2-0#0#0#否#否#否#否#否#5000#0#0#否#0#0#0#0#否#否##否##否#,${x.idCardNumber},合成TAG,,,`
    );
    expect(lines.every(line => line.startsWith(',,,,1,'))).toBe(true);
  });
});
