const crypto = require('crypto');
const { encrypt } = require('../src/utils/fieldEncryption');
const enabled = process.env.RUN_AOS_DB_INTEGRATION === 'true';
const describeDatabase = enabled ? describe : describe.skip;
const EXPECTED_PICKUP_STORE_COUNT = 49;

describeDatabase('AOS 隔离 PostgreSQL 事务验收', () => {
  const models = require('../src/models');
  const repo = require('../src/services/ingestionRepository');
  const aos = require('../src/services/aosIngestionService');
  const management = require('../src/services/ingestionManagementService');
  const { buildAosLine } = require('./fixtures/aosRecords');
  const {
    sequelize,
    IngestionSetting,
    AosDevice,
    AosRecord,
    Order,
    OrderSource,
    OrderRefreshJob,
    PaymentTask,
    PickupStore,
    Recipient,
    IngestionOperation,
    User,
  } = models;
  let device;
  let auth;
  let actor;
  let sequence = 0;

  function event(overrides = {}) {
    const orderNumber = `W99${String(++sequence).padStart(8, '0')}`;
    return {
      eventId: crypto.randomUUID(),
      directoryId: crypto.randomUUID(),
      fileInstanceId: crypto.randomUUID(),
      fileName: 'AOS订单记录-0910(test).txt',
      lineNumber: 1,
      observedAt: new Date().toISOString(),
      scanRequestId: null,
      rawLine: buildAosLine({
        0: orderNumber,
        13: `https://www.apple.com.cn/xc/cn/vieworder/${orderNumber}/contact%40example.com`,
        14: `${repo.businessDate()} 10:00:00.123`,
      }),
      ...overrides,
    };
  }
  function request(body, path = '/settings', method = 'PUT', key = crypto.randomUUID()) {
    return {
      body,
      user: actor,
      method,
      baseUrl: '/api/order-ingestion',
      path,
      params: {},
      get: () => key,
    };
  }
  beforeAll(async () => {
    if (!/aos_ingestion_test_/.test(sequelize.config.database))
      throw new Error('必须使用独立 AOS 测试数据库');
    await sequelize.query(
      'TRUNCATE aos_records, aos_devices, ingestion_operations, order_sources, orders, recipients, apple_ids, users CASCADE'
    );
    await IngestionSetting.update({ version: 1 }, { where: { id: 1 } });
    actor = await User.create({
      username: 'aos_test_admin',
      password: 'synthetic-admin-password',
      role: 'admin',
    });
    await models.PaymentDispatchSetting.upsert({
      id: 1,
      enabled: true,
      scopeStartedAt: new Date(Date.now() - 86400000),
    });
    const credential = repo.createCredential();
    auth = `Bearer ${credential.credential}`;
    device = await AosDevice.create({
      id: crypto.randomUUID(),
      name: '合成测试设备',
      credentialHash: credential.credentialHash,
      credentialCiphertext: encrypt(credential.credential),
    });
    await IngestionSetting.update({ activeSource: 'aos' }, { where: { id: 1 } });
  });
  afterAll(async () => {
    await sequelize.close();
  });

  test('并发同事件回执不重复、密文落库且异载荷冲突', async () => {
    const input = event();
    const replies = await Promise.all(
      [1, 2].map(() => aos.receiveBatch(auth, { schemaVersion: 1, records: [input] }))
    );
    expect(replies.map(r => r.results[0].receiptStatus).sort()).toEqual([
      'accepted',
      'already_received',
    ]);
    const row = await AosRecord.findOne({ where: { eventId: input.eventId } });
    expect(row.getDataValue('payload').__encrypted).toMatch(/^enc:/);
    expect(JSON.stringify(row.getDataValue('payload'))).not.toContain('synthetic-password');
    expect(JSON.stringify(aos.recordDto(row))).not.toContain('synthetic-password');
    const conflict = await aos.receiveBatch(auth, {
      schemaVersion: 1,
      records: [{ ...input, lineNumber: 2 }],
    });
    expect(conflict.results[0].errorCode).toBe('EVENT_PAYLOAD_CONFLICT');
    await aos.processQueue();
    const order = await Order.findOne({ where: { orderNumber: row.orderNumber } });
    expect(order).not.toBeNull();
    expect(order.ingestionSource).toBe('aos');
    expect(order.appleId).toBe('account@example.com');
    expect(order.sourceContactEmail).toBe('contact@example.com');
    expect(order.recipientRef).toBeNull();
    expect(await OrderRefreshJob.count({ where: { orderId: order.id } })).toBe(1);
    expect(await PaymentTask.count({ where: { orderId: order.id } })).toBe(1);
  });
  test('第 16 列身份证后四位参与取机人匹配，R502 补全成都万象城', async () => {
    expect(await PickupStore.count()).toBe(EXPECTED_PICKUP_STORE_COUNT);
    const stores = await Promise.all(
      ['R388', 'R793', 'R639', 'R645', 'R502'].map(code => PickupStore.findByPk(code))
    );
    expect(stores.map(store => store.name)).toEqual([
      'Apple 西单大悦城',
      'Apple 前海壹方城',
      'Apple 珠江新城',
      'Apple 朝阳大悦城',
      'Apple 成都万象城',
    ]);
    const recipient = await Recipient.create({
      lastName: '门店',
      firstName: '匹配',
      idCardNumber: '110101199001015678',
      phone: '13900000000',
      email: 'store-match@example.com',
    });
    const matched = event();
    const orderNumber = matched.rawLine.split('\t')[0];
    matched.rawLine = buildAosLine({
      0: orderNumber,
      1: 'store-match@example.com',
      4: '门店',
      5: '匹配',
      6: 'R502',
      9: '13900000000',
      13: `https://www.apple.com.cn/xc/cn/vieworder/${orderNumber}/` + 'store-match%40example.com',
      14: `${repo.businessDate()} 10:00:00.123`,
      15: '5678',
    });
    const mismatched = event();
    mismatched.rawLine = mismatched.rawLine.replace(/\t1234$/, '\t9999');
    await aos.receiveBatch(auth, { schemaVersion: 1, records: [matched, mismatched] });
    await aos.processQueue();
    const matchedRow = await AosRecord.findOne({ where: { eventId: matched.eventId } });
    const mismatchedRow = await AosRecord.findOne({ where: { eventId: mismatched.eventId } });
    expect((await Order.findByPk(matchedRow.orderId)).recipientRef).toBe(recipient.id);
    expect((await Order.findByPk(matchedRow.orderId)).pickupStore).toBe('Apple 成都万象城');
    expect((await Order.findByPk(mismatchedRow.orderId)).recipientRef).toBeNull();
  });
  test('同订单不同事件只留来源，不覆盖商品、密码或 TAG', async () => {
    const input = event();
    await aos.receiveBatch(auth, { schemaVersion: 1, records: [input] });
    await aos.processQueue();
    const original = await AosRecord.findOne({ where: { eventId: input.eventId } });
    const changed = {
      ...input,
      eventId: crypto.randomUUID(),
      rawLine: input.rawLine.replace('测试 TAG', '冲突 TAG'),
    };
    await aos.receiveBatch(auth, { schemaVersion: 1, records: [changed] });
    await aos.processQueue();
    const duplicate = await AosRecord.findOne({ where: { eventId: changed.eventId } });
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.orderId).toBe(original.orderId);
    expect((await Order.findByPk(original.orderId)).sourceRecipientTag).toBe('测试 TAG');
    expect(await OrderSource.count({ where: { orderId: original.orderId } })).toBe(2);
    expect(await OrderRefreshJob.count({ where: { orderId: original.orderId } })).toBe(1);
  });
  test('混合坏行可靠接收，格式错误不阻塞有效订单', async () => {
    const valid = event();
    const invalid = event({ rawLine: 'incomplete-but-stable' });
    const result = await aos.receiveBatch(auth, { schemaVersion: 1, records: [valid, invalid] });
    expect(result.results.map(r => r.receiptStatus)).toEqual(['accepted', 'accepted']);
    await aos.processQueue();
    expect((await AosRecord.findOne({ where: { eventId: invalid.eventId } })).status).toBe(
      'manual_review'
    );
    expect((await AosRecord.findOne({ where: { eventId: valid.eventId } })).status).toBe(
      'succeeded'
    );
  });
  test('来源停用仍接收，启用后自动入库且不消耗重试', async () => {
    await IngestionSetting.update({ activeSource: 'email' }, { where: { id: 1 } });
    const input = event();
    const result = await aos.receiveBatch(auth, { schemaVersion: 1, records: [input] });
    expect(result.results[0].eligibility).toBe('source_disabled');
    expect(await aos.processQueue()).toBe(0);
    expect((await AosRecord.findOne({ where: { eventId: input.eventId } })).attemptCount).toBe(0);
    await IngestionSetting.update({ activeSource: 'aos' }, { where: { id: 1 } });
    await aos.processQueue();
    expect((await AosRecord.findOne({ where: { eventId: input.eventId } })).status).toBe(
      'succeeded'
    );
  });
  test('已有日期采集许可支持跨天，无许可旧日期不会自动入库', async () => {
    const yesterday = repo.businessDate(new Date(Date.now() - 86400000));
    const permit = await IngestionOperation.create({
      id: crypto.randomUUID(),
      kind: 'permit',
      scope: crypto.randomUUID(),
      deviceId: device.id,
      status: 'active',
      data: { businessDate: yesterday, settingsVersion: 1 },
    });
    const old = event();
    old.rawLine = old.rawLine.replace(`${repo.businessDate()} 10:00`, `${yesterday} 10:00`);
    const allowed = event();
    allowed.rawLine = allowed.rawLine.replace(`${repo.businessDate()} 10:00`, `${yesterday} 10:00`);
    allowed.capturePermitId = permit.id;
    const result = await aos.receiveBatch(auth, { schemaVersion: 1, records: [old, allowed] });
    expect(result.results.map(r => r.eligibility)).toEqual(['out_of_range', 'allowed']);
    await aos.processQueue();
    expect((await AosRecord.findOne({ where: { eventId: old.eventId } })).status).toBe('ready');
    expect((await AosRecord.findOne({ where: { eventId: allowed.eventId } })).status).toBe(
      'succeeded'
    );
  });
  test('设备禁用拒绝接收且未开始任务停止', async () => {
    const input = event();
    await aos.receiveBatch(auth, { schemaVersion: 1, records: [input] });
    await device.update({ enabled: false });
    await expect(
      aos.receiveBatch(auth, { schemaVersion: 1, records: [event()] })
    ).rejects.toMatchObject({ code: 'DEVICE_DISABLED' });
    await aos.processQueue();
    expect((await AosRecord.findOne({ where: { eventId: input.eventId } })).status).toBe('ready');
    await device.update({ enabled: true });
    await aos.processQueue();
  });
  test('切换预览、并发版本与幂等回放保持一个补录任务', async () => {
    const setting = await IngestionSetting.findByPk(1);
    const preview = await management.switchPreview(
      request({ targetSource: 'email', expectedVersion: setting.version })
    );
    const req = request({
      activeSource: 'email',
      expectedVersion: setting.version,
      previewId: preview.previewId,
    });
    const first = await management.switchSource(req);
    const repeat = await management.switchSource(req);
    expect(first.backfillId).toBe(repeat.backfillId);
    expect(await IngestionOperation.count({ where: { kind: 'backfill' } })).toBe(1);
    await expect(management.switchSource(request({ ...req.body }))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
  });
  test('凭证重放不重复返回明文，旧凭证轮换失效', async () => {
    const req = request({ name: '凭证回放测试' }, '/devices', 'POST');
    const first = await management.manageDevice('create', req);
    const repeat = await management.manageDevice('create', req);
    expect(first.credential).toMatch(/^aos_/);
    const stored = await AosDevice.findByPk(first.device.id);
    expect(stored.credentialCiphertext).toMatch(/^enc:/);
    expect(stored.credentialCiphertext).not.toContain(first.credential);
    expect(await management.getDeviceCredential(first.device.id, actor)).toMatchObject({
      device: { id: first.device.id, credentialVersion: 1 },
      credential: first.credential,
    });
    expect(repeat.credential).toBeNull();
    expect(repeat.credentialDisplayed).toBe(true);
    const rotate = request(
      { expectedVersion: first.device.version },
      `/devices/${first.device.id}/rotate-credential`,
      'POST'
    );
    rotate.params.id = first.device.id;
    const rotated = await management.manageDevice('rotate', rotate);
    expect((await management.getDeviceCredential(first.device.id, actor)).credential).toBe(
      rotated.credential
    );
    await expect(repo.authenticateDevice(`Bearer ${first.credential}`)).rejects.toMatchObject({
      code: 'DEVICE_UNAUTHORIZED',
    });
  });
  test('管理、普通员工和设备凭证隔离；跨设备状态与敏感字段受限', async () => {
    const express = require('express');
    const { authenticate } = require('../src/middleware/authMiddleware');
    const { login } = require('../src/services/authService');
    const app = express();
    app.use('/collector', require('../src/routes/aosCollector'));
    app.use(express.json());
    app.use('/management', authenticate, require('../src/routes/orderIngestion'));
    app.use((error, _req, res, _next) =>
      res
        .status(error.statusCode || 500)
        .json({ success: false, error: { code: error.code || 'INTERNAL' } })
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.on('listening', resolve));
    const root = `http://127.0.0.1:${server.address().port}`;
    async function call(path, token, body) {
      try {
        return await fetch(root + path, {
          method: body ? 'POST' : 'GET',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch (error) {
        throw new Error(`HTTP 测试未完成：${error.code || 'NETWORK'}`);
      }
    }
    try {
      const admin = await login(actor.username, 'synthetic-admin-password');
      const staff = await User.create({
        username: 'aos_test_staff',
        password: 'synthetic-staff-password',
        role: 'operator',
      });
      const ordinary = await login(staff.username, 'synthetic-staff-password');
      expect((await call('/management/settings', `Bearer ${admin.token}`)).status).toBe(200);
      expect((await call('/management/settings', `Bearer ${ordinary.token}`)).status).toBe(403);
      const credentialResponse = await call(
        `/management/devices/${device.id}/credential`,
        `Bearer ${admin.token}`
      );
      expect(credentialResponse.status).toBe(200);
      expect((await credentialResponse.json()).data.credential).toBe(auth.slice('Bearer '.length));
      expect(
        (await call(`/management/devices/${device.id}/credential`, `Bearer ${ordinary.token}`))
          .status
      ).toBe(403);
      expect((await call('/management/settings', auth)).status).toBe(401);
      expect((await call('/collector/context', `Bearer ${admin.token}`)).status).toBe(401);
      const credential = repo.createCredential();
      const other = await AosDevice.create({
        id: crypto.randomUUID(),
        name: '隔离设备',
        credentialHash: credential.credentialHash,
      });
      const input = event();
      await aos.receiveBatch(auth, { schemaVersion: 1, records: [input] });
      const response = await call('/collector/records/status', `Bearer ${credential.credential}`, {
        eventIds: [input.eventId],
      });
      const data = await response.json();
      expect(data.data.items).toEqual([{ eventId: input.eventId, processingStatus: 'not_found' }]);
      const ordinaryRow = await AosRecord.findOne({ where: { eventId: input.eventId } });
      const content = await call(
        `/management/aos-records/${ordinaryRow.id}`,
        `Bearer ${admin.token}`
      );
      const text = await content.text();
      expect(text).not.toContain('synthetic-password');
      expect(text).not.toContain('contact@example.com');
      const oversized = await call('/collector/records', auth, { padding: 'x'.repeat(1050000) });
      expect(oversized.status).toBe(413);
      expect((await oversized.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
      await other.update({ enabled: false });
      expect((await call('/collector/context', `Bearer ${credential.credential}`)).status).toBe(
        403
      );
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('邮件来源停用阻止自动及人工入库，切回后统一按订单号去重', async () => {
    const { saveOrderFromEmail } = require('../src/services/orderService');
    const input = event();
    await IngestionSetting.update({ activeSource: 'aos' }, { where: { id: 1 } });
    const reply = await aos.receiveBatch(auth, { schemaVersion: 1, records: [input] });
    await aos.processQueue();
    const row = await AosRecord.findByPk(reply.results[0].recordId);
    const { data, password } = require('../src/services/aosParser').parseAosLine(input.rawLine);
    const email = {
      ...data,
      applePassword: password,
      recipient: { name: '测试用户', phone: data.contactPhone, email: data.contactEmail },
      orderStatus: 'pending',
    };
    await expect(saveOrderFromEmail(email, `aos-email-${sequence}`)).rejects.toMatchObject({
      code: 'SOURCE_DISABLED',
    });
    expect(await models.EmailLog.count({ where: { emailUid: `aos-email-${sequence}` } })).toBe(0);
    expect(await Order.count({ where: { orderNumber: data.orderNumber } })).toBe(1);
    await IngestionSetting.update({ activeSource: 'email' }, { where: { id: 1 } });
    await saveOrderFromEmail(email, `aos-email-${sequence}`);
    expect(await OrderSource.count({ where: { orderId: row.orderId } })).toBe(2);
    const duplicateMail = await models.EmailLog.findOne({
      where: { emailUid: `aos-email-${sequence}` },
    });
    expect(duplicateMail.status).toBe('superseded');
    expect(duplicateMail.parsedData.orderDate).toBe(data.orderDate);
    expect((await Order.findByPk(row.orderId)).ingestionSource).toBe('aos');
    await IngestionSetting.update({ activeSource: 'aos' }, { where: { id: 1 } });
  });

  test('人工修改日期后再重解析不能继承另一个日期的入库许可', async () => {
    const input = event();
    const reply = await aos.receiveBatch(auth, { schemaVersion: 1, records: [input] });
    const row = await AosRecord.findByPk(reply.results[0].recordId);
    const parsed = require('../src/services/aosParser').parseAosLine(input.rawLine);
    const req = request(
      {
        expectedVersion: row.version,
        data: { ...parsed.data, orderDate: '2025-01-01T02:00:00.000Z' },
        passwordAction: 'keep',
      },
      `/aos-records/${row.id}/draft`
    );
    req.params.id = row.id;
    const changed = await aos.processManual('draft', req);
    expect(changed.record.eligibility).toBe('out_of_range');
    expect((await AosRecord.findByPk(row.id)).eligibleAt).toBeNull();
    const reparse = request(
      { expectedVersion: changed.record.version },
      `/aos-records/${row.id}/reparse`,
      'POST'
    );
    reparse.params.id = row.id;
    const recovered = await aos.processManual('reparse', reparse);
    expect(recovered.record.eligibility).toBe('allowed');
  });

  test('补录完成必须核对服务端逐事件回执，其他设备不能代确认', async () => {
    const scan = await IngestionOperation.create({
      id: crypto.randomUUID(),
      kind: 'scan',
      scope: `scan-test:${crypto.randomUUID()}`,
      deviceId: device.id,
      status: 'queued',
      data: { businessDate: repo.businessDate(), settingsVersion: 2, ...repo.dayBounds() },
    });
    const input = event({ scanRequestId: scan.id });
    const body = {
      heartbeatId: crypto.randomUUID(),
      agentVersion: 'test',
      osVersion: 'Windows 10',
      observedAt: new Date().toISOString(),
      lastSuccessfulScanAt: new Date().toISOString(),
      lastNewOrderAt: null,
      directories: [],
      localCounts: { pendingUpload: 0, uploadError: 0, todayDiscovered: 1 },
      scanResults: [
        {
          scanRequestId: scan.id,
          status: 'completed',
          discoveredCount: 1,
          receiptedCount: 1,
          pendingUploadCount: 0,
          errorCode: null,
        },
      ],
    };
    await expect(management.heartbeat(auth, body)).rejects.toMatchObject({ statusCode: 400 });
    await aos.receiveBatch(auth, { schemaVersion: 1, records: [input] });
    await expect(management.heartbeat(auth, body)).rejects.toMatchObject({ statusCode: 400 });
    await aos.associateScan(auth, scan.id, [input.eventId]);
    await aos.associateScan(auth, scan.id, [input.eventId]);
    await management.heartbeat(auth, body);
    expect((await IngestionOperation.findByPk(scan.id)).status).toBe('completed');
    expect(
      await IngestionOperation.count({
        where: {
          scope: `scan-record:${scan.id}:${(await AosRecord.findOne({ where: { eventId: input.eventId } })).id}`,
        },
      })
    ).toBe(1);
    const before = (await AosDevice.findByPk(device.id)).heartbeatAt;
    await management.heartbeat(auth, body);
    expect((await AosDevice.findByPk(device.id)).heartbeatAt).toEqual(before);
    const other = await AosDevice.findOne({ where: { name: '凭证回放测试' } });
    const fake = await IngestionOperation.create({
      id: crypto.randomUUID(),
      kind: 'scan',
      scope: `scan-test:${crypto.randomUUID()}`,
      deviceId: other.id,
      status: 'queued',
      data: {},
    });
    await expect(aos.associateScan(auth, fake.id, [input.eventId])).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test('后续任务登记失败时订单整体回滚，人工重试后仅创建一次', async () => {
    await aos.processQueue();
    const input = event();
    const reply = await aos.receiveBatch(auth, { schemaVersion: 1, records: [input] });
    const spy = jest
      .spyOn(OrderSource, 'create')
      .mockRejectedValueOnce(new Error('synthetic-database-failure'));
    try {
      await aos.processQueue();
    } finally {
      spy.mockRestore();
    }
    let row = await AosRecord.findByPk(reply.results[0].recordId);
    expect(row.status).toBe('retry_wait');
    expect(row.attemptCount).toBe(1);
    expect(await Order.count({ where: { orderNumber: row.orderNumber } })).toBe(0);
    const retry = request({ expectedVersion: row.version }, `/aos-records/${row.id}/retry`, 'POST');
    retry.params.id = row.id;
    await aos.processManual('retry', retry);
    await aos.processQueue();
    row = await AosRecord.findByPk(row.id);
    expect(row.status).toBe('succeeded');
    expect(await OrderRefreshJob.count({ where: { orderId: row.orderId } })).toBe(1);
    expect(await PaymentTask.count({ where: { orderId: row.orderId } })).toBe(1);
  });

  test('取机人唯一姓名手机号且联系资料一致才关联，TAG 差异保留', async () => {
    const first = await models.Recipient.create({
      lastName: '测试',
      firstName: '用户',
      phone: '13800000000',
      email: 'contact@example.com',
      idCardNumber: '110101199001011234',
      tag: '档案 TAG',
    });
    const ingest = async () => {
      try {
        const reply = await aos.receiveBatch(auth, { schemaVersion: 1, records: [event()] });
        await aos.processQueue();
        const row = await AosRecord.findByPk(reply.results[0].recordId);
        return await Order.findByPk(row.orderId);
      } catch (error) {
        throw new Error(`匹配测试失败：${error.code || 'DATABASE'}`);
      }
    };
    const matched = await ingest();
    expect(matched.recipientRef).toBe(first.id);
    expect(matched.sourceRecipientTag).toBe('测试 TAG');
    await first.update({ email: 'conflict@example.com' });
    expect((await ingest()).recipientRef).toBeNull();
    await first.update({ email: 'contact@example.com' });
    await models.Recipient.create({
      lastName: '测试',
      firstName: '用户',
      phone: '13800000000',
      email: 'contact@example.com',
      idCardNumber: '110101199001011235',
      tag: '第二档案',
    });
    expect((await ingest()).recipientRef).toBe(first.id);
    await models.Recipient.create({
      lastName: '测试',
      firstName: '用户',
      phone: '13800000000',
      email: 'contact@example.com',
      idCardNumber: '110101199002021234',
      tag: '同尾四位档案',
    });
    expect((await ingest()).recipientRef).toBeNull();
  });

  test('来源停用仍可关闭坏行，但终态不能隐式重开', async () => {
    const reply = await aos.receiveBatch(auth, {
      schemaVersion: 1,
      records: [event({ rawLine: 'invalid' })],
    });
    let row = await AosRecord.findByPk(reply.results[0].recordId);
    await IngestionSetting.update({ activeSource: 'email' }, { where: { id: 1 } });
    const close = request(
      { expectedVersion: row.version, action: 'close', reason: '合成验收记录关闭' },
      `/aos-records/${row.id}/resolve`,
      'POST'
    );
    close.params.id = row.id;
    const result = await aos.processManual('resolve', close);
    expect(result.record.status).toBe('closed');
    const reparse = request(
      { expectedVersion: result.record.version },
      `/aos-records/${row.id}/reparse`,
      'POST'
    );
    reparse.params.id = row.id;
    await expect(aos.processManual('reparse', reparse)).rejects.toMatchObject({
      code: 'RECORD_STATE_INVALID',
    });
    await IngestionSetting.update({ activeSource: 'aos' }, { where: { id: 1 } });
  });

  test('已建档 Apple ID 和邮件取机人继续复用，AOS 密码不覆盖基础密码', async () => {
    const account = await models.AppleId.create({
      appleId: 'account@example.com',
      password: 'synthetic-profile-password',
    });
    const reply = await aos.receiveBatch(auth, { schemaVersion: 1, records: [event()] });
    await aos.processQueue();
    const row = await AosRecord.findByPk(reply.results[0].recordId);
    expect((await Order.findByPk(row.orderId)).appleIdRef).toBe(account.id);
    expect((await models.AppleId.findByPk(account.id)).password).toBe('synthetic-profile-password');
    const person = await models.Recipient.create({
      lastName: '测',
      firstName: '试员',
      phone: '13900000000',
      email: 'contact@example.com',
      idCardNumber: '110101199001011236',
      province: '测试省',
      city: '测试市',
    });
    const parsed = require('../src/services/aosParser').parseAosLine(event().rawLine).data;
    await IngestionSetting.update({ activeSource: 'email' }, { where: { id: 1 } });
    const order = await require('../src/services/orderService').saveOrderFromEmail(
      { ...parsed, recipient: { name: '测试员', idLast4: '1236' }, orderStatus: 'pending' },
      `aos-email-match-${sequence}`
    );
    expect(order.recipientRef).toBe(person.id);
    expect(order.recipientEmail).toBe('contact@example.com');
    expect(order.recipientAddress).toContain('测试省');
    await IngestionSetting.update({ activeSource: 'aos' }, { where: { id: 1 } });
  });

  test('补录设备范围固定，离线设备不会显示完成，新设备不扩大既有范围', async () => {
    await AosDevice.update({ enabled: false }, { where: { id: { [repo.Op.ne]: device.id } } });
    await IngestionSetting.update({ activeSource: 'email' }, { where: { id: 1 } });
    let settings = await IngestionSetting.findByPk(1);
    const preview = await management.switchPreview(
      request({ targetSource: 'aos', expectedVersion: settings.version }, '/switch-preview', 'POST')
    );
    const switched = await management.switchSource(
      request({
        activeSource: 'aos',
        expectedVersion: settings.version,
        previewId: preview.previewId,
      })
    );
    const before = await management.getBackfill(switched.backfillId);
    expect(before.status).toBe('waiting_source');
    expect(before.devices).toHaveLength(1);
    const created = await management.manageDevice(
      'create',
      request({ name: '补录后新增设备' }, '/devices', 'POST')
    );
    await aos.receiveBatch(`Bearer ${created.credential}`, {
      schemaVersion: 1,
      records: [event()],
    });
    await aos.processQueue();
    const after = await management.getBackfill(switched.backfillId);
    expect(after.counts.received).toBe(before.counts.received);
    expect(after.devices).toHaveLength(1);
    const scanId = before.devices[0].deviceId;
    expect(scanId).toBe(device.id);
    settings = await IngestionSetting.findByPk(1);
    const back = await management.switchPreview(
      request(
        { targetSource: 'email', expectedVersion: settings.version },
        '/switch-preview',
        'POST'
      )
    );
    await management.switchSource(
      request({
        activeSource: 'email',
        expectedVersion: settings.version,
        previewId: back.previewId,
      })
    );
    expect((await management.getBackfill(switched.backfillId)).status).toBe('superseded');
    await IngestionSetting.update({ activeSource: 'aos' }, { where: { id: 1 } });
  });
});
