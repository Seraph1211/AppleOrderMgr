const enabled = process.env.RUN_PAYMENT_CODE_DB === 'true';
const crypto = require('crypto');
const { makePng } = require('./fixtures/paymentCode');
const { buildAosLine } = require('./fixtures/aosRecords');
(enabled ? describe : describe.skip)('付款码独立数据库回归', () => {
  const models = require('../src/models');
  const { sequelize, User, AosDevice, IngestionSetting, Order, PaymentTask, OrderPaymentCode } =
    models;
  const service = require('../src/services/paymentCodeService');
  const updates = require('../src/services/collectorUpdateService');
  let actor;
  let other;
  let device;
  let order;
  let task;
  let header;
  const credential = 'aos_' + 'a'.repeat(43);
  beforeAll(async () => {
    if (!/^aos_payment_code_test_/.test(sequelize.config.database))
      throw new Error('仅可使用付款码隔离数据库');
    await sequelize.query(
      'TRUNCATE collector_update_jobs, order_payment_codes, payment_tasks, aos_devices, orders, users CASCADE'
    );
    actor = await User.create({
      username: 'code_admin',
      password: 'synthetic-test-password',
      role: 'admin',
    });
    other = await User.create({
      username: 'code_other',
      password: 'synthetic-other-password',
      role: 'operator',
    });
    device = await AosDevice.create({
      id: crypto.randomUUID(),
      name: '合成采集设备',
      credentialHash: crypto.createHash('sha256').update(credential).digest('hex'),
    });
    header = `Bearer ${credential}`;
    await IngestionSetting.update({ activeSource: 'aos' }, { where: { id: 1 } });
    order = await Order.create({
      orderNumber: 'W9900000021',
      appleId: 'account@example.com',
      orderUrl: 'https://www.apple.com.cn/xc/cn/vieworder/W9900000021/contact@example.com',
      products: [{ name: '合成商品', quantity: 1 }],
      paymentMethod: '微信',
      orderDate: new Date(Date.now() - 60000),
      tag: '保留 TAG',
      applePassword: 'preserved-secret',
    });
    task = await PaymentTask.create({
      orderId: order.id,
      assigneeUserId: actor.id,
      processingStatus: 'pending',
    });
  });
  afterAll(async () => {
    await sequelize.close();
  });
  function record(overrides = {}) {
    return {
      eventId: crypto.randomUUID(),
      orderNumber: order.orderNumber,
      orderDate: new Date(order.orderDate).toISOString(),
      sourceTime: new Date(Date.now() - 30000).toISOString(),
      contactEmail: 'contact@example.com',
      appleId: order.appleId,
      paymentMethod: '微信',
      imageDataUrl: makePng(),
      ...overrides,
    };
  }
  function alipayPaymentLink() {
    const params = new URLSearchParams(
      new Map([
        ['app_id', 'synthetic-app-id'],
        [
          'biz_content',
          JSON.stringify({
            ['out_trade_no']: order.orderNumber,
            ['product_code']: 'FAST_INSTANT_TRADE_PAY',
            subject: `${order.orderNumber}-synthetic`,
            ['timeout_express']: '30m',
            ['total_amount']: '1.00',
          }),
        ],
        ['charset', 'utf-8'],
        ['method', 'alipay.trade.page.pay'],
        ['notify_url', 'https://example.test/notify'],
        ['return_url', 'https://example.test/return'],
        ['sign', 'synthetic-signature'],
        ['sign_type', 'RSA2'],
        [
          'timestamp',
          new Intl.DateTimeFormat('sv-SE', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
          }).format(order.orderDate),
        ],
        ['version', '1.0'],
      ])
    );
    return `https://openapi.alipay.com/gateway.do?${params}`;
  }
  test('订单原文第17列直接读取，保留加密、权限、审计且不回填业务数据', async () => {
    const date = new Date(new Date(order.orderDate).getTime() + 8 * 3600000)
      .toISOString()
      .replace('T', ' ')
      .replace('Z', '');
    const rawLine = buildAosLine({
      0: order.orderNumber,
      13: order.orderUrl,
      14: date,
      16: makePng(4),
    });
    const source = await models.AosRecord.create({
      id: crypto.randomUUID(),
      deviceId: device.id,
      eventId: crypto.randomUUID(),
      payloadHash: 'a'.repeat(64),
      payload: { rawLine },
      fileName: 'AOS订单记录-0918(test).txt',
      lineNumber: 1,
      receivedAt: new Date(),
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderDate: order.orderDate,
      status: 'succeeded',
      eligibility: 'allowed',
    });
    try {
      const before = (await Order.findByPk(order.id)).toJSON();
      const sourceBefore = (await models.AosRecord.findByPk(source.id)).toJSON();
      const events = await models.PaymentTaskEvent.count();
      const result = await service.getPaymentCode(Number(task.id), actor.id);
      expect(result).toMatchObject({
        availability: 'available',
        imageDataUrl: makePng(4),
        sourceTime: new Date(order.orderDate).toISOString(),
      });
      await expect(service.getPaymentCode(Number(task.id), other.id)).rejects.toThrow(
        '付款任务不存在或已转派'
      );
      expect(await models.PaymentTaskEvent.count()).toBe(events + 1);
      expect(await OrderPaymentCode.count()).toBe(0);
      expect((await Order.findByPk(order.id)).toJSON()).toEqual(before);
      expect((await models.AosRecord.findByPk(source.id)).toJSON()).toEqual(sourceBefore);
      const [raw] = await sequelize.query('SELECT payload::text FROM aos_records WHERE id=:id', {
        replacements: { id: source.id },
      });
      expect(raw[0].payload).not.toContain('base64');
      await source.update({ status: 'duplicate' });
      expect((await service.getPaymentCode(Number(task.id), actor.id)).availability).toBe(
        'available'
      );
      await source.update({ status: 'manual_review' });
      expect((await service.getPaymentCode(Number(task.id), actor.id)).availability).toBe(
        'missing'
      );
    } finally {
      await source.destroy();
    }
  });
  test('支付宝第17列签名链接按调度或本人任务权限读取，原文和审计不泄露链接', async () => {
    const paymentUrl = alipayPaymentLink();
    const date = new Date(new Date(order.orderDate).getTime() + 8 * 3600000)
      .toISOString()
      .replace('T', ' ')
      .replace('Z', '');
    const source = await models.AosRecord.create({
      id: crypto.randomUUID(),
      deviceId: device.id,
      eventId: crypto.randomUUID(),
      payloadHash: 'b'.repeat(64),
      payload: {
        rawLine: buildAosLine({
          0: order.orderNumber,
          2: order.appleId,
          11: '支付宝',
          13: order.orderUrl,
          14: date,
          16: paymentUrl,
        }),
      },
      fileName: 'AOS订单记录-0924(test).txt',
      lineNumber: 1,
      receivedAt: new Date(),
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderDate: order.orderDate,
      status: 'succeeded',
      eligibility: 'allowed',
    });
    try {
      await order.update({ paymentMethod: '支付宝', sourceSnapshot: { paymentMethod: '支付宝' } });
      const events = await models.PaymentTaskEvent.count();
      const result =
        await require('../src/services/alipayPaymentLinkService').getDispatchAlipayPaymentLink(
          Number(task.id),
          actor.id
        );
      expect(result.paymentUrl).toBe(paymentUrl);
      expect(await models.PaymentTaskEvent.count()).toBe(events + 1);
      const latest = await models.PaymentTaskEvent.findOne({
        where: { paymentTaskId: task.id },
        order: [['id', 'DESC']],
      });
      expect(latest.details).toMatchObject({
        source: 'payment_dispatch',
        linkType: 'aos_alipay',
      });
      expect(JSON.stringify(latest.details)).not.toContain(paymentUrl);
      const ownResult =
        await require('../src/services/alipayPaymentLinkService').getOwnAlipayPaymentLink(
          Number(task.id),
          actor.id
        );
      expect(ownResult.paymentUrl).toBe(paymentUrl);
      await expect(
        require('../src/services/alipayPaymentLinkService').getOwnAlipayPaymentLink(
          Number(task.id),
          other.id
        )
      ).rejects.toThrow('付款任务不存在或已转派');
      expect(await models.PaymentTaskEvent.count()).toBe(events + 2);
      const ownLatest = await models.PaymentTaskEvent.findOne({
        where: { paymentTaskId: task.id },
        order: [['id', 'DESC']],
      });
      expect(ownLatest.details).toMatchObject({
        source: 'payment_tasks',
        linkType: 'aos_alipay',
      });
      expect(JSON.stringify(ownLatest.details)).not.toContain(paymentUrl);
      const [raw] = await sequelize.query('SELECT payload::text FROM aos_records WHERE id=:id', {
        replacements: { id: source.id },
      });
      expect(raw[0].payload).not.toContain('openapi.alipay.com');
    } finally {
      await source.destroy();
      await order.update({ paymentMethod: '微信', sourceSnapshot: null });
    }
  });
  test('存量补码不修改订单，重复事件幂等且载荷不可变', async () => {
    const before = (await Order.findByPk(order.id)).toJSON();
    const row = record();
    expect(
      (await service.receivePaymentCodes(header, { records: [row] })).results[0].receiptStatus
    ).toBe('accepted');
    expect(
      (await service.receivePaymentCodes(header, { records: [row] })).results[0].receiptStatus
    ).toBe('already_received');
    expect(
      (
        await service.receivePaymentCodes(header, {
          records: [{ ...row, imageDataUrl: makePng(1) }],
        })
      ).results[0].errorCode
    ).toBe('EVENT_PAYLOAD_CONFLICT');
    expect((await Order.findByPk(order.id)).toJSON()).toEqual(before);
    const [raw] = await sequelize.query('SELECT payload::text FROM order_payment_codes');
    expect(raw[0].payload).not.toContain('base64');
  });
  test('迟到旧码不会覆盖最新码，保留历史', async () => {
    const newer = record({
      imageDataUrl: makePng(2),
      sourceTime: new Date(Date.now() - 1000).toISOString(),
    });
    const older = record({
      imageDataUrl: makePng(3),
      sourceTime: new Date(Date.now() - 50000).toISOString(),
    });
    await service.receivePaymentCodes(header, { records: [newer, older] });
    expect((await service.getPaymentCode(Number(task.id), actor.id)).imageDataUrl).toBe(
      newer.imageDataUrl
    );
    expect(await OrderPaymentCode.count()).toBe(3);
  });
  test('没有订单只返回等待，不创建订单', async () => {
    const before = await Order.count();
    const result = await service.receivePaymentCodes(header, {
      records: [record({ orderNumber: 'W9900000099' })],
    });
    expect(result.results[0]).toMatchObject({ errorCode: 'ORDER_NOT_READY', retryable: true });
    expect(await Order.count()).toBe(before);
  });
  test('身份矛盾永久拒绝、来源暂停可重试', async () => {
    expect(
      (
        await service.receivePaymentCodes(header, {
          records: [record({ appleId: 'other@example.com' })],
        })
      ).results[0]
    ).toMatchObject({ errorCode: 'PAYMENT_CODE_IDENTITY_MISMATCH', retryable: false });
    await IngestionSetting.update({ activeSource: 'email' }, { where: { id: 1 } });
    expect(
      (await service.receivePaymentCodes(header, { records: [record()] })).results[0]
    ).toMatchObject({ errorCode: 'SOURCE_DISABLED', retryable: true });
    await IngestionSetting.update({ activeSource: 'aos' }, { where: { id: 1 } });
  });
  test('转派后原负责人不可读取，管理员接口可读取终态码', async () => {
    await task.update({ assigneeUserId: other.id });
    await expect(service.getPaymentCode(Number(task.id), actor.id)).rejects.toThrow(
      '付款任务不存在或已转派'
    );
    await order.update({ status: 'cancelled' });
    expect((await service.getPaymentCode(Number(task.id), actor.id, false)).availability).toBe(
      'available'
    );
    expect((await service.getPaymentCode(Number(task.id), other.id)).officialOrderStatus).toBe(
      'cancelled'
    );
  });
  test.each(
    require('../src/utils/paymentMethod').PAYMENT_METHODS.filter(method => method !== '微信')
  )('%s 只返回无法获取提示，不返回历史图片或链接', async paymentMethod => {
    await order.update({ paymentMethod: 'WECHAT', sourceSnapshot: { paymentMethod } });
    expect(await service.getPaymentCode(Number(task.id), other.id)).toEqual({
      availability: 'unsupported',
      message: `${paymentMethod}暂无法获取付款码`,
    });
    const own = await require('../src/services/paymentTaskService').listOwnTasks(other.id, {});
    const dispatch = await require('../src/services/paymentDispatchService').listDispatchTasks({});
    expect(own.items.find(item => item.id === task.id).paymentMethod).toBe(paymentMethod);
    expect(dispatch.items.find(item => item.id === task.id).paymentMethod).toBe(paymentMethod);
    const controller = require('../src/controllers/orderController');
    expect(controller.serializeOrderListItem(order).payment_method).toBe(paymentMethod);
    expect(controller.serializeOrderDetail(order).payment_method).toBe(paymentMethod);
    expect(JSON.stringify(own)).not.toContain('sourceSnapshot');
    await order.update({ paymentMethod: '支付宝', sourceSnapshot: null });
  });
  test('更新任务归属隔离及状态不倒退', async () => {
    const job = await models.CollectorUpdateJob.create({
      id: crypto.randomUUID(),
      deviceId: device.id,
      releaseVersion: '1.1.0',
      actorId: actor.id,
    });
    await expect(
      updates.reportUpdate(header, job.id, { status: 'succeeded', agentVersion: '1.1.0' })
    ).rejects.toThrow();
    await updates.reportUpdate(header, job.id, { status: 'downloading', agentVersion: '1.0.0' });
    await updates.reportUpdate(header, job.id, { status: 'installing', agentVersion: '1.0.0' });
    await expect(
      updates.reportUpdate(header, job.id, { status: 'downloading', agentVersion: '1.0.0' })
    ).rejects.toThrow();
    await updates.reportUpdate(header, job.id, { status: 'succeeded', agentVersion: '1.1.0' });
    await updates.reportUpdate(header, job.id, { status: 'succeeded', agentVersion: '1.1.0' });
    await expect(
      updates.reportUpdate(header, job.id, { status: 'failed', agentVersion: '1.1.0' })
    ).rejects.toThrow();
  });
  test('正式路由权限、管理员角色和 no-store', async () => {
    await task.update({ assigneeUserId: other.id });
    await order.update({ paymentMethod: '支付宝', sourceSnapshot: { paymentMethod: '支付宝' } });
    const alipayService = require('../src/services/alipayPaymentLinkService');
    const alipayLinkRead = jest
      .spyOn(alipayService, 'getDispatchAlipayPaymentLink')
      .mockResolvedValue({
        paymentUrl:
          'https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay&sign=synthetic',
        serverTime: new Date(),
        deadlineAt: null,
      });
    const ownAlipayLinkRead = jest
      .spyOn(alipayService, 'getOwnAlipayPaymentLink')
      .mockResolvedValue({
        paymentUrl:
          'https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay&sign=synthetic',
        serverTime: new Date(),
        deadlineAt: null,
      });
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = {
        id: other.id,
        role: req.get('x-role') || 'operator',
        permissions: (req.get('x-permissions') || '').split(','),
      };
      next();
    });
    app.use('/own', require('../src/routes/paymentTasks'));
    app.use('/dispatch', require('../src/routes/paymentDispatch'));
    app.use((error, _req, res, _next) =>
      res.status(error.statusCode || 500).json({ error: 'controlled' })
    );
    const server = await new Promise(resolve => {
      const value = app.listen(0, '127.0.0.1', () => resolve(value));
    });
    const send = async (path, headers = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.json(),
      };
    };
    try {
      expect((await send(`/own/${task.id}/payment-code`)).status).toBe(403);
      const allowed = await send(`/own/${task.id}/payment-code`, {
        'x-permissions': 'payment_tasks.link.read_own',
      });
      expect(allowed.status).toBe(200);
      expect(allowed.headers['cache-control']).toBe('no-store');
      expect(allowed.body.data).toEqual({
        availability: 'unsupported',
        message: '支付宝暂无法获取付款码',
      });
      expect((await send(`/own/${task.id}/alipay-payment-link`)).status).toBe(403);
      const ownAlipayAllowed = await send(`/own/${task.id}/alipay-payment-link`, {
        'x-permissions': 'payment_tasks.link.read_own',
      });
      expect(ownAlipayAllowed.status).toBe(200);
      expect(ownAlipayAllowed.headers['cache-control']).toBe('no-store');
      expect(ownAlipayAllowed.body.data.paymentUrl).toContain('openapi.alipay.com/gateway.do');
      expect(
        (
          await send(`/dispatch/tasks/${task.id}/payment-code`, {
            'x-permissions': 'payment_dispatch.read',
          })
        ).status
      ).toBe(403);
      expect(
        (
          await send(`/dispatch/tasks/${task.id}/payment-code`, {
            'x-permissions': 'payment_dispatch.read',
            'x-role': 'admin',
          })
        ).status
      ).toBe(200);
      expect(
        (
          await send(`/dispatch/tasks/${task.id}/alipay-payment-link`, {
            'x-permissions': 'payment_dispatch.read',
          })
        ).status
      ).toBe(403);
      const alipayAllowed = await send(`/dispatch/tasks/${task.id}/alipay-payment-link`, {
        'x-permissions': 'payment_dispatch.read',
        'x-role': 'admin',
      });
      expect(alipayAllowed.status).toBe(200);
      expect(alipayAllowed.headers['cache-control']).toBe('no-store');
      expect(alipayAllowed.body.data.paymentUrl).toContain('openapi.alipay.com/gateway.do');
    } finally {
      await new Promise(resolve => server.close(resolve));
      alipayLinkRead.mockRestore();
      ownAlipayLinkRead.mockRestore();
    }
  });
  test('签名发布下发幂等、文件篡改和跨设备下载保护', async () => {
    const fs = require('fs/promises');
    const os = require('os');
    const path = require('path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collector-release-test-'));
    const oldDir = process.env.COLLECTOR_RELEASE_DIR;
    const oldKey = process.env.COLLECTOR_UPDATE_PUBLIC_KEY_FILE;
    try {
      const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const version = '1.2.0';
      const bytes = Buffer.from('MZ-synthetic-not-executable');
      const payload = Buffer.from(
        JSON.stringify({
          product: 'AppleOrderMgrAosCollector',
          version,
          platform: 'win-x64',
          queueSchema: 1,
          size: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        })
      );
      await fs.mkdir(path.join(root, version));
      await fs.writeFile(path.join(root, version, 'AosCollector.exe'), bytes);
      await fs.writeFile(
        path.join(root, version, 'manifest.json'),
        JSON.stringify({
          payload: payload.toString('base64'),
          signature: crypto.sign('RSA-SHA256', payload, keys.privateKey).toString('base64'),
        })
      );
      await fs.writeFile(
        path.join(root, 'public.pem'),
        keys.publicKey.export({ type: 'spki', format: 'pem' })
      );
      process.env.COLLECTOR_RELEASE_DIR = root;
      process.env.COLLECTOR_UPDATE_PUBLIC_KEY_FILE = path.join(root, 'public.pem');
      const req = { user: actor, body: { deviceIds: [device.id], releaseVersion: version } };
      const a = await updates.scheduleUpdates(req);
      const b = await updates.scheduleUpdates(req);
      expect(a.items[0].id).toBe(b.items[0].id);
      expect((await updates.pollUpdate(header)).job.id).toBe(a.items[0].id);
      expect((await updates.updatePackage(header, a.items[0].id)).manifest.version).toBe(version);
      const credential2 = 'aos_' + 'b'.repeat(43);
      await AosDevice.create({
        id: crypto.randomUUID(),
        name: '其他合成设备',
        credentialHash: crypto.createHash('sha256').update(credential2).digest('hex'),
      });
      await expect(updates.updatePackage('Bearer ' + credential2, a.items[0].id)).rejects.toThrow(
        '更新任务不存在'
      );
      await fs.writeFile(path.join(root, version, 'AosCollector.exe'), Buffer.from('tampered'));
      await expect(updates.updatePackage(header, a.items[0].id)).rejects.toThrow(
        '发布制品与清单不一致'
      );
    } finally {
      if (oldDir === undefined) delete process.env.COLLECTOR_RELEASE_DIR;
      else process.env.COLLECTOR_RELEASE_DIR = oldDir;
      if (oldKey === undefined) delete process.env.COLLECTOR_UPDATE_PUBLIC_KEY_FILE;
      else process.env.COLLECTOR_UPDATE_PUBLIC_KEY_FILE = oldKey;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
