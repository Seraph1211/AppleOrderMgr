const crypto = require('crypto');
const enabled = process.env.RUN_ORDER_MAIL_INTEGRATION === 'true';

(enabled ? describe : describe.skip)('订单邮件隔离库与HTTP权限回归', () => {
  let models, service, sender, config, server, baseUrl, user, other, order, otherOrder, message;
  let token, otherToken;
  const mime = (number = 'W1234567890', from = 'a@orders.apple.com') =>
    Buffer.from(
      [
        'From: Apple <' + from + '>',
        'To: original@vvv8.net',
        'Subject: Order ' + number,
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary=boundary123',
        '',
        '--boundary123',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Order ' + number + ' body',
        '--boundary123',
        'Content-Type: text/plain',
        'Content-Disposition: attachment; filename=receipt.txt',
        '',
        'synthetic receipt',
        '--boundary123--',
      ].join('\r\n')
    );
  const key = () => crypto.randomUUID();
  const headers = auth => ({ Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' });
  async function request(path = '', options = {}) {
    try {
      const response = await fetch(
        baseUrl + '/api/orders/' + (options.orderId || order.id) + '/emails' + path,
        {
          method: options.method || 'GET',
          headers: headers(options.token || token),
          body: options.body ? JSON.stringify(options.body) : undefined,
        }
      );
      return {
        status: response.status,
        headers: response.headers,
        data: response.headers.get('content-type')?.includes('application/json')
          ? await response.json()
          : Buffer.from(await response.arrayBuffer()),
      };
    } catch (error) {
      error.testContext = 'order-mail';
      throw error;
    }
  }
  async function grant(target, allowed) {
    try {
      await models.UserPermission.destroy({ where: { userId: target.id } });
      await models.UserPermission.bulkCreate(
        allowed.map(permissionCode => ({
          userId: target.id,
          permissionCode,
          grantedBy: target.id,
        }))
      );
    } catch (error) {
      error.testContext = 'order-mail';
      throw error;
    }
  }
  async function enqueue(overrides = {}) {
    try {
      const actor = await service.currentActor(user.id);
      return await service.enqueueForward(actor, order.id, message.id, {
        recipient: 'destination@example.test',
        note: '合成备注',
        idempotencyKey: key(),
        ...overrides,
      });
    } catch (error) {
      error.testContext = 'order-mail';
      throw error;
    }
  }
  beforeAll(async () => {
    if (
      !/^apple_order_mgr_mail_test_[0-9]+$/.test(process.env.DB_NAME || '') ||
      process.env.DATABASE_URL
    )
      throw new Error('必须使用独立订单邮件测试库');
    process.env.ORDER_MAIL_ENABLED = 'true';
    process.env.ORDER_MAIL_IMAP_HOST = 'imap.example.invalid';
    process.env.ORDER_MAIL_SMTP_HOST = 'smtp.example.invalid';
    process.env.ORDER_MAIL_USER = 'sender@example.test';
    process.env.ORDER_MAIL_PASSWORD = 'synthetic-password';
    delete process.env.ORDER_MAIL_PASSWORD_FILE;
    models = require('../src/models');
    service = require('../src/services/orderMailService');
    sender = require('../src/services/orderMailSender');
    config = require('../src/services/orderMailConfig').getOrderMailConfig();
    const migration = require('../migrations/20260920000003-add-order-mail');
    const lifecycleMigration = require('../migrations/20260921000002-add-order-mail-lifecycle');
    const qi = models.sequelize.getQueryInterface();
    await lifecycleMigration.down(qi).catch(() => {});
    await migration.down(qi);
    await migration.up(qi, models.Sequelize);
    await lifecycleMigration.up(qi, models.Sequelize);
    await models.sequelize.query('TRUNCATE users, orders RESTART IDENTITY CASCADE');
    const sessions = [
      {
        id: key(),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    ];
    [user, other] = await Promise.all(
      ['mail_user', 'mail_other'].map(username =>
        models.User.create({
          username,
          password: 'Synthetic-Password-1!',
          role: 'operator',
          status: 'active',
          orderAccess: { mode: 'tags', tags: ['MAIL-A'] },
          activeSessions: sessions,
        })
      )
    );
    await grant(user, ['orders.read', 'order_mail.manage']);
    await grant(other, ['orders.read']);
    const { generateToken } = require('../src/utils/jwtUtils');
    [token, otherToken] = [user, other].map(actor =>
      generateToken({
        userId: actor.id,
        username: actor.username,
        role: actor.role,
        sessionId: sessions[0].id,
      })
    );
    [order, otherOrder] = await Promise.all(
      ['W1234567890', 'W2234567890'].map((orderNumber, index) =>
        models.Order.create({
          orderNumber,
          tag: index ? 'MAIL-B' : 'MAIL-A',
          products: [{ name: '合成商品', quantity: 1 }],
          orderDate: new Date(),
          orderUrl: 'https://example.invalid/' + orderNumber,
        })
      )
    );
    await models.OrderMailState.create({ mailboxIdentityHash: config.identity });
    const identity = { mailboxIdentityHash: config.identity, uidValidity: '123' };
    await service.receiveOrderMail({ rawBuffer: mime(), emailUid: 1 }, identity, config);
    await service.receiveOrderMail(
      { rawBuffer: mime(otherOrder.orderNumber), emailUid: 2 },
      identity,
      config
    );
    message = await models.OrderMailMessage.findOne({ where: { orderNumber: order.orderNumber } });
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use(require('../src/middleware/requestLogger')());
    app.use(require('../src/middleware/authMiddleware').authenticate);
    app.use(require('../src/middleware/operationAudit').operationAudit);
    app.use('/api/orders/:id/emails', require('../src/routes/orderMail'));
    app.use('/api/mail-contacts', require('../src/routes/mailContacts'));
    app.use(require('../src/middleware/errorHandler'));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = 'http://127.0.0.1:' + server.address().port;
  }, 30000);
  afterAll(async () => {
    try {
      if (server) await new Promise(resolve => server.close(resolve));
      await models?.sequelize.close();
    } catch (error) {
      error.testContext = 'order-mail';
      throw error;
    }
  });
  beforeEach(async () => {
    await grant(user, ['orders.read', 'order_mail.manage']);
    await user.update({
      role: 'operator',
      orderAccess: { mode: 'tags', tags: ['MAIL-A'] },
      status: 'active',
    });
    await models.OrderMailDelivery.destroy({ where: {} });
  });
  test('未授权用户列表、正文、附件、历史和转发全部403', async () => {
    for (const [path, method] of [
      ['', 'GET'],
      ['/' + message.id, 'GET'],
      ['/' + message.id + '/attachments/0', 'GET'],
      ['/' + message.id + '/forwards', 'GET'],
      ['/' + message.id + '/forward', 'POST'],
    ])
      expect(
        (
          await request(path, {
            token: otherToken,
            method,
            body: method === 'POST' ? {} : undefined,
          })
        ).status
      ).toBe(403);
  });
  test('权限可独立授予普通用户且要求订单读取权限', () => {
    const permissions = require('../src/services/permissionService');
    expect(permissions.validatePermissionSet(['orders.read', 'order_mail.manage'])).toContain(
      'order_mail.manage'
    );
    expect(() => permissions.validatePermissionSet(['order_mail.manage'])).toThrow('权限依赖');
  });
  test.each(['operator', 'readOnly'])('%s 仅查看和转发，不允许重解析或核定', async role => {
    await user.update({ role });
    await grant(user, ['orders.read', 'order_mail.read']);
    for (const path of [
      '',
      '/' + message.id,
      '/' + message.id + '/attachments/0',
      '/' + message.id + '/forwards',
    ]) {
      expect((await request(path)).status).toBe(200);
    }
    expect(
      (await request('/' + message.id + '/forward', { method: 'POST', body: {} })).status
    ).toBe(403);
    await expect(enqueue()).rejects.toMatchObject({ statusCode: 403 });
    await grant(user, ['orders.read', 'order_mail.read', 'order_mail.forward']);
    for (const action of ['replay', 'review']) {
      expect(
        (await request('/' + message.id + '/lifecycle/' + action, { method: 'POST', body: {} }))
          .status
      ).toBe(403);
    }
    const lifecycle = require('../src/services/orderMailLifecycleService');
    const actor = await service.currentActor(user.id);
    await expect(lifecycle.enqueueReplay(actor, order.id, message.id)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(lifecycle.enqueueOrderReplay(actor, [order.id])).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      lifecycle.reviewLifecycleEvent(actor, order.id, message.id, {
        expectedVersion: 0,
        reason: '合成权限边界验证',
        orderStatus: 'confirmed',
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await request('', { orderId: otherOrder.id })).status).toBe(404);
    const forbidden = await models.OrderMailMessage.findOne({
      where: { orderNumber: otherOrder.orderNumber },
    });
    expect(
      (
        await request('/' + forbidden.id + '/forward', {
          method: 'POST',
          body: { recipient: 'destination@example.test', idempotencyKey: key() },
        })
      ).status
    ).toBe(404);
    const queued = await request('/' + message.id + '/forward', {
      method: 'POST',
      body: { recipient: 'destination@example.test', idempotencyKey: key() },
    });
    expect(queued.status).toBe(202);
    const transport = {
      sendMail: jest.fn().mockResolvedValue({ accepted: ['destination@example.test'] }),
    };
    await sender.sendNextOrderMail({ transport, config });
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect((await models.OrderMailDelivery.findByPk(queued.data.data.id)).status).toBe('accepted');
  });
  test('保留查看权限但撤销转发权限后，旧Token拒绝发送且排队任务取消', async () => {
    await grant(user, ['orders.read', 'order_mail.read', 'order_mail.forward']);
    const delivery = await enqueue();
    await grant(user, ['orders.read', 'order_mail.read']);
    expect((await request('/' + message.id)).status).toBe(200);
    expect(
      (await request('/' + message.id + '/forward', { method: 'POST', body: {} })).status
    ).toBe(403);
    const transport = { sendMail: jest.fn() };
    await sender.sendNextOrderMail({ transport, config });
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect((await models.OrderMailDelivery.findByPk(delivery.id)).status).toBe('cancelled');
  });
  test('TAG范围、跨订单邮件ID和附件均不能越权', async () => {
    expect((await request('', { orderId: otherOrder.id })).status).toBe(404);
    const forbidden = await models.OrderMailMessage.findOne({
      where: { orderNumber: otherOrder.orderNumber },
    });
    for (const path of [
      '/' + forbidden.id,
      '/' + forbidden.id + '/attachments/0',
      '/' + forbidden.id + '/forwards',
    ])
      expect((await request(path)).status).toBe(404);
    expect(
      (
        await request('/' + forbidden.id + '/forward', {
          method: 'POST',
          body: {
            recipient: 'a@example.test',
            idempotencyKey: key(),
          },
        })
      ).status
    ).toBe(404);
  });
  test('分页、正文、附件下载和元信息无原文泄露', async () => {
    const list = await request();
    expect(list.status).toBe(200);
    expect(list.data.data.total).toBe(1);
    expect(list.data.data.items[0].to).toBe('original@vvv8.net');
    expect(JSON.stringify(list.data)).not.toContain('rawContent');
    expect(list.headers.get('cache-control')).toBe('no-store');
    const detail = await request('/' + message.id);
    expect(detail.data.data.text).toContain('Order W1234567890 body');
    const file = await request('/' + message.id + '/attachments/0');
    expect(file.data.toString()).toContain('synthetic receipt');
    expect(file.headers.get('content-disposition')).toContain('attachment');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await request('?page=-1')).status).toBe(400);
  });
  test('UID幂等，非Apple或多订单邮件不归档，MIME与元信息加密', async () => {
    const identity = { mailboxIdentityHash: config.identity, uidValidity: '123' };
    expect(
      await service.receiveOrderMail({ rawBuffer: mime(), emailUid: 1 }, identity, config)
    ).toEqual({ created: false });
    for (const [rawBuffer, emailUid] of [
      [mime('W1234567890 W2234567890'), 3],
      [mime('W1234567890', 'a@evilapple.com'), 4],
      [Buffer.alloc(0), 5],
    ])
      expect(await service.receiveOrderMail({ rawBuffer, emailUid }, identity, config)).toEqual({
        created: false,
      });
    expect(
      await service.receiveOrderMail(
        { rawBuffer: mime(), emailUid: 901 },
        { ...identity, uidValidity: '456' },
        config
      )
    ).toEqual({ created: false });
    expect(await models.OrderMailMessage.count()).toBe(2);
    const [rows] = await models.sequelize.query(
      'SELECT raw_content, metadata FROM order_mail_messages'
    );
    expect(rows[0].raw_content).toMatch(/^enc:/);
    expect(rows[0].metadata.__encrypted).toMatch(/^enc:/);
  });
  test('同步状态区分未启用、尚未开始、同步中和失败', async () => {
    process.env.ORDER_MAIL_ENABLED = 'false';
    expect((await service.syncStatus()).status).toBe('disabled');
    process.env.ORDER_MAIL_ENABLED = 'true';
    expect((await service.syncStatus()).status).toBe('pending');
    const state = await models.OrderMailState.findByPk(config.identity);
    await state.update({ isConnected: true, lastScanStartedAt: new Date() });
    expect((await service.syncStatus()).status).toBe('syncing');
    await state.update({ lastScanSucceededAt: new Date(Date.now() + 10) });
    expect((await service.syncStatus()).status).toBe('ready');
    await state.update({ lastScanErrorCode: 'IMAP_TEMPORARY' });
    expect((await service.syncStatus()).status).toBe('error');
  });
  test('双击并发仅排队一次，同键改收件人409，目标地址加密', async () => {
    const idempotencyKey = key();
    const values = await Promise.all([enqueue({ idempotencyKey }), enqueue({ idempotencyKey })]);
    expect(values[0].id).toBe(values[1].id);
    expect(await models.OrderMailDelivery.count()).toBe(1);
    await expect(
      enqueue({ idempotencyKey, recipient: 'other@example.test' })
    ).rejects.toMatchObject({ statusCode: 409 });
    const [rows] = await models.sequelize.query('SELECT payload FROM order_mail_deliveries');
    expect(rows[0].payload.__encrypted).toMatch(/^enc:/);
  });
  test('SMTP接受才记录accepted，附件和EML保留；不发送第二次', async () => {
    const delivery = await enqueue();
    const transport = {
      sendMail: jest.fn().mockResolvedValue({ accepted: ['destination@example.test'] }),
    };
    expect(await sender.sendNextOrderMail({ transport, config })).toBe(true);
    expect(await sender.sendNextOrderMail({ transport, config })).toBe(false);
    const sent = transport.sendMail.mock.calls[0][0];
    expect(sent.from).toBe('sender@example.test');
    expect(sent.to).toBe('destination@example.test');
    expect(sent.text).toContain('合成备注');
    expect(sent.attachments).toHaveLength(2);
    expect(sent.attachments[1].content).toEqual(mime());
    expect((await models.OrderMailDelivery.findByPk(delivery.id)).status).toBe('accepted');
    const history = await request('/' + message.id + '/forwards');
    expect(history.data.data[0].recipient).toBe('destination@example.test');
  });
  test.each(['permission', 'scope', 'locked'])('发送前撤销 %s 则取消，绝不调用SMTP', async mode => {
    const delivery = await enqueue();
    if (mode === 'permission') await grant(user, ['orders.read']);
    if (mode === 'scope') await user.update({ orderAccess: { mode: 'tags', tags: [] } });
    if (mode === 'locked') await user.update({ status: 'locked' });
    const transport = { sendMail: jest.fn() };
    await sender.sendNextOrderMail({ transport, config });
    expect(transport.sendMail).not.toHaveBeenCalled();
    expect((await models.OrderMailDelivery.findByPk(delivery.id)).status).toBe('cancelled');
  });
  test('不明网络结果禁止自动重发，明确临时拒绝才重试', async () => {
    const delivery = await enqueue();
    const transport = { sendMail: jest.fn().mockRejectedValue({ code: 'ETIMEDOUT' }) };
    await sender.sendNextOrderMail({ transport, config });
    expect((await models.OrderMailDelivery.findByPk(delivery.id)).status).toBe('unknown');
    expect(await sender.sendNextOrderMail({ transport, config })).toBe(false);
    expect(sender.classifySendFailure({ responseCode: 451 }, 1).status).toBe('retry_wait');
    expect(sender.classifySendFailure({ responseCode: 451 }, 3).status).toBe('failed');
    expect(sender.classifySendFailure({ responseCode: 550 }, 1).status).toBe('failed');
  });
  test('发送前数据库临时失败可以重试，不误报撤权或调用SMTP', async () => {
    const delivery = await enqueue();
    const failure = jest
      .spyOn(models.User, 'findByPk')
      .mockRejectedValueOnce(new Error('synthetic database failure'));
    const transport = { sendMail: jest.fn() };
    try {
      await sender.sendNextOrderMail({ transport, config });
      expect(transport.sendMail).not.toHaveBeenCalled();
      const saved = await models.OrderMailDelivery.findByPk(delivery.id);
      expect(saved.status).toBe('retry_wait');
      expect(saved.errorCode).toBe('PREPARE_TEMPORARY');
    } finally {
      failure.mockRestore();
    }
  });
  test('发送中断租约过期转unknown，不能再次领取', async () => {
    const delivery = await enqueue();
    await models.OrderMailDelivery.update(
      { status: 'sending', startedAt: new Date(Date.now() - 3600000) },
      { where: { id: delivery.id } }
    );
    expect(await sender.claimDelivery()).toBeNull();
    expect((await models.OrderMailDelivery.findByPk(delivery.id)).status).toBe('unknown');
  });
  test('批量并发重试去重，目标顺序和大小写不产生重复任务', async () => {
    const body = {
      recipients: ['B@example.test', 'a@example.test', 'b@example.test'],
      note: '批量备注',
      idempotencyKey: key(),
    };
    const path = '/' + message.id + '/forward-batch';
    const results = await Promise.all([
      request(path, { method: 'POST', body }),
      request(path, { method: 'POST', body }),
    ]);
    expect(results.map(result => result.status)).toEqual([202, 202]);
    expect(results[0].data.data.items.map(item => item.id)).toEqual(
      results[1].data.data.items.map(item => item.id)
    );
    expect(await models.OrderMailDelivery.count()).toBe(2);
    expect(results[0].data.data.items[0]).not.toHaveProperty('batchRecipients');
    for (const patch of [
      { recipients: ['a@example.test'] },
      { recipients: ['a@example.test', 'c@example.test'] },
      { note: '改动' },
    ]) {
      expect((await request(path, { method: 'POST', body: { ...body, ...patch } })).status).toBe(
        409
      );
    }
    expect(await models.OrderMailDelivery.count()).toBe(2);
  });
  test('批量无权、范围外及无效目标均不产生任务', async () => {
    const body = { recipients: ['a@example.test'], idempotencyKey: key() };
    const path = '/' + message.id + '/forward-batch';
    expect((await request(path, { method: 'POST', body, token: otherToken })).status).toBe(403);
    expect((await request(path, { method: 'POST', body, orderId: otherOrder.id })).status).toBe(
      404
    );
    for (const recipients of [
      [],
      ['ok@example.test', 'invalid'],
      Array(51).fill('a@example.test'),
    ]) {
      expect((await request(path, { method: 'POST', body: { ...body, recipients } })).status).toBe(
        400
      );
    }
    expect(await models.OrderMailDelivery.count()).toBe(0);
  });
  test('批量写入后异常回滚全部任务', async () => {
    const original = models.OrderMailDelivery.bulkCreate.bind(models.OrderMailDelivery);
    const spy = jest
      .spyOn(models.OrderMailDelivery, 'bulkCreate')
      .mockImplementationOnce(async (...args) => {
        try {
          await original(...args);
          throw new Error('synthetic rollback');
        } catch (error) {
          error.testContext = 'batch rollback';
          throw error;
        }
      });
    try {
      const actor = await service.currentActor(user.id);
      await expect(
        service.enqueueBatchForward(actor, order.id, message.id, {
          recipients: ['a@example.test', 'b@example.test'],
          idempotencyKey: key(),
        })
      ).rejects.toThrow('synthetic rollback');
      expect(await models.OrderMailDelivery.count()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
  test('多收件人独立发送，单个失败不影响其他收件人', async () => {
    const actor = await service.currentActor(user.id);
    await service.enqueueBatchForward(actor, order.id, message.id, {
      recipients: ['a@example.test', 'b@example.test'],
      note: '',
      idempotencyKey: key(),
    });
    const transport = {
      sendMail: jest
        .fn()
        .mockRejectedValueOnce({ responseCode: 550 })
        .mockImplementationOnce(async mail => {
          try {
            return await Promise.resolve({ accepted: [mail.to] });
          } catch (error) {
            error.testContext = 'fake SMTP';
            throw error;
          }
        }),
    };
    await sender.sendNextOrderMail({ transport, config });
    await sender.sendNextOrderMail({ transport, config });
    expect(transport.sendMail).toHaveBeenCalledTimes(2);
    const deliveries = await models.OrderMailDelivery.findAll();
    expect(deliveries.map(item => item.status).sort()).toEqual(['accepted', 'failed']);
    expect(transport.sendMail.mock.calls.map(([mail]) => mail.to).sort()).toEqual([
      'a@example.test',
      'b@example.test',
    ]);
  });
  test('联系人迁移、管理员CRUD、普通转发用户只读、唯一邮箱与快照', async () => {
    const migration = require('../migrations/20260922000003-create-mail-contacts');
    const qi = models.sequelize.getQueryInterface();
    await qi.dropTable('mail_contacts');
    await migration.up(qi, models.Sequelize);
    await migration.down(qi);
    await migration.up(qi, models.Sequelize);
    async function contacts(path = '', method = 'GET', body, auth = token) {
      try {
        const response = await fetch(baseUrl + '/api/mail-contacts' + path, {
          method,
          headers: headers(auth),
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: response.status, data: await response.json() };
      } catch (error) {
        error.testContext = 'contacts';
        throw error;
      }
    }
    expect((await contacts('', 'GET', undefined, otherToken)).status).toBe(403);
    expect((await contacts()).status).toBe(200);
    expect((await contacts('', 'POST', { name: '测试', email: 'a@example.test' })).status).toBe(
      403
    );
    await user.update({ role: 'admin' });
    const created = await contacts('', 'POST', { name: ' 测试联系人 ', email: ' A@example.test ' });
    expect(created.status).toBe(201);
    const contact = created.data.data;
    expect(contact.name).toBe('测试联系人');
    expect(contact.email).toBe('a@example.test');
    expect((await contacts('', 'POST', { name: '另一个', email: 'A@example.test' })).status).toBe(
      409
    );
    expect((await contacts('', 'POST', { name: '', email: 'a@example.test' })).status).toBe(400);
    expect((await contacts('?search=测试')).data.data.total).toBe(1);
    expect((await contacts('?search=%25')).data.data.total).toBe(0);
    expect((await contacts('?page=0')).status).toBe(400);
    const actor = await service.currentActor(user.id);
    const batch = await service.enqueueBatchForward(actor, order.id, message.id, {
      recipients: [contact.email],
      idempotencyKey: key(),
    });
    expect(
      (await contacts('/' + contact.id, 'PUT', { name: '新名', email: 'new@example.test' })).status
    ).toBe(200);
    await user.update({ role: 'operator' });
    expect((await contacts('/' + contact.id, 'DELETE')).status).toBe(403);
    expect(
      (await contacts('/' + contact.id, 'PUT', { name: '绕过', email: 'hack@example.test' })).status
    ).toBe(403);
    await user.update({ role: 'admin' });
    expect((await contacts('/' + contact.id, 'DELETE')).status).toBe(200);
    expect((await contacts('/' + contact.id, 'DELETE')).status).toBe(404);
    expect((await models.OrderMailDelivery.findByPk(batch.items[0].id)).payload.recipient).toBe(
      'a@example.test'
    );
  });
  test('内容到期禁读禁发，清理原文但保留关联', async () => {
    await message.update({ expiresAt: new Date(Date.now() - 1) });
    expect((await request('/' + message.id)).status).toBe(410);
    await expect(enqueue()).rejects.toMatchObject({ statusCode: 410 });
    expect(
      (
        await request('/' + message.id + '/forward-batch', {
          method: 'POST',
          body: { recipients: ['a@example.test'], idempotencyKey: key() },
        })
      ).status
    ).toBe(410);
    await service.purgeOrderMail();
    await message.reload();
    expect(message.rawContent).toBeNull();
    expect(message.metadata).toBeNull();
    expect((await request()).data.data.items[0].expired).toBe(true);
  });
});
