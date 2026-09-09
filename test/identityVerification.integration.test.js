const crypto = require('crypto');
const XLSX = require('xlsx');
const describeIntegration =
  process.env.RUN_IDENTITY_INTEGRATION === 'true' ? describe : describe.skip;
const CARD = '110101199001010015';
// 真实数据库连接和模型加载给予独立时间预算，不改变业务限流标准。
jest.setTimeout(30000);

describeIntegration('身份核验真实PostgreSQL与HTTP隔离验收', () => {
  let models;
  let service;
  let runner;
  let server;
  let root;
  let admin;
  let owner;
  let other;
  let tokens;
  let permissions;
  let seq = Date.now();
  const makeBuffer = rows => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([['姓名', '身份证号'], ...rows]),
      '身份核验'
    );
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  };
  const makeUser = async role => {
    try {
      const sessionId = crypto.randomUUID();
      const user = await models.User.create({
        username: `idv_${++seq}`,
        password: 'Synthetic-pass-42',
        role,
        activeSessions: [
          {
            id: sessionId,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        ],
      });
      const token = require('../src/utils/jwtUtils').generateToken({
        userId: user.id,
        username: user.username,
        role,
        sessionId,
      });
      return { user, token };
    } catch (error) {
      throw new Error('合成账号创建失败', { cause: error });
    }
  };
  const request = async (path, token = tokens.owner, options = {}) => {
    try {
      return await fetch(root + path, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.body && typeof options.body === 'string'
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...options.headers,
        },
      });
    } catch (error) {
      throw new Error('隔离HTTP请求失败', { cause: error });
    }
  };
  const tick = async fn => {
    try {
      await models.IdentityVerificationItem.update(
        { startedAt: new Date(Date.now() - 2000) },
        { where: {} }
      );
      return await runner.runOnce(fn);
    } catch (error) {
      throw new Error('隔离执行失败', { cause: error });
    }
  };
  beforeAll(async () => {
    if (!/^apple_order_mgr_identity_test_\d+$/.test(process.env.DB_NAME || ''))
      throw new Error('必须使用身份核验专用隔离库');
    process.env.IDENTITY_APPCODE = 'syntheticAppCodeForLocalTestOnly';
    process.env.IDENTITY_VERIFICATION_ENABLED = 'true';
    models = require('../src/models');
    service = require('../src/services/identityVerificationService');
    runner = require('../src/services/identityVerificationRunner');
    permissions = require('../src/constants/business').PERMISSIONS;
    const created = await Promise.all([
      makeUser('admin'),
      makeUser('operator'),
      makeUser('operator'),
    ]);
    [admin, owner, other] = created.map(value => value.user);
    tokens = { admin: created[0].token, owner: created[1].token, other: created[2].token };
    await models.UserPermission.bulkCreate(
      [
        permissions.IDENTITY_READ,
        permissions.IDENTITY_VERIFY,
        permissions.IDENTITY_BATCH,
        permissions.IDENTITY_EXPORT,
      ].flatMap(permissionCode =>
        [owner, other].map(user => ({ userId: user.id, permissionCode, grantedBy: admin.id }))
      )
    );
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api', require('../src/middleware/authMiddleware').authenticate);
    app.use('/api/identity-verifications', require('../src/routes/identityVerifications'));
    app.use(require('../src/middleware/errorHandler'));
    server = await new Promise(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    root = `http://127.0.0.1:${server.address().port}/api/identity-verifications`;
  });
  beforeEach(async () => {
    await models.IdentityVerificationItem.destroy({ where: {} });
    await models.IdentityVerificationBatch.destroy({ where: {} });
    await owner.update({ status: 'active' });
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (models) await models.sequelize.close();
  });

  test('只有查看权限时可读本人历史，所有核验与导出动作均拒绝', async () => {
    const preview = await service.preview(owner, makeBuffer([['只读测试', CARD]]));
    const codes = [
      permissions.IDENTITY_VERIFY,
      permissions.IDENTITY_BATCH,
      permissions.IDENTITY_EXPORT,
    ];
    await models.UserPermission.destroy({ where: { userId: owner.id, permissionCode: codes } });
    try {
      expect((await request(`/batches/${preview.batch.id}`)).status).toBe(200);
      expect((await request('/template')).status).toBe(403);
      expect((await request('/preview', tokens.owner, { method: 'POST' })).status).toBe(403);
      expect(
        (
          await request('/single', tokens.owner, {
            method: 'POST',
            body: JSON.stringify({ name: '测试', idCardNumber: CARD }),
          })
        ).status
      ).toBe(403);
      expect(
        (await request(`/batches/${preview.batch.id}/start`, tokens.owner, { method: 'POST' }))
          .status
      ).toBe(403);
      expect(
        (await request(`/batches/${preview.batch.id}/stop`, tokens.owner, { method: 'POST' }))
          .status
      ).toBe(403);
      expect((await request(`/batches/${preview.batch.id}/export`)).status).toBe(403);
    } finally {
      await models.UserPermission.bulkCreate(
        codes.map(permissionCode => ({ userId: owner.id, permissionCode, grantedBy: admin.id }))
      );
    }
  });
  test('错误输入、关闭服务与超过活动批次容量均不进入执行队列', async () => {
    await expect(service.createSingle(owner, null, crypto.randomUUID())).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      service.createSingle(owner, { name: '测试', idCardNumber: CARD }, 'invalid')
    ).rejects.toMatchObject({ statusCode: 400 });
    process.env.IDENTITY_VERIFICATION_ENABLED = 'false';
    try {
      await expect(
        service.createSingle(owner, { name: '测试', idCardNumber: CARD }, crypto.randomUUID())
      ).rejects.toMatchObject({ statusCode: 503 });
      expect(await models.IdentityVerificationItem.count()).toBe(0);
    } finally {
      process.env.IDENTITY_VERIFICATION_ENABLED = 'true';
    }
    await models.IdentityVerificationBatch.bulkCreate(
      Array.from({ length: 10 }, () => ({
        id: crypto.randomUUID(),
        userId: owner.id,
        source: 'excel',
        status: 'draft',
        summary: {},
      }))
    );
    await expect(
      service.createSingle(owner, { name: '测试', idCardNumber: CARD }, crypto.randomUUID())
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await models.IdentityVerificationItem.count()).toBe(0);
  });
  test('单人并发重复提交只创建一行，原键不同内容返回409', async () => {
    const key = crypto.randomUUID();
    const data = { name: '合成测试', idCardNumber: CARD };
    const results = await Promise.all([
      service.createSingle(owner, data, key),
      service.createSingle(owner, data, key),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await models.IdentityVerificationItem.count()).toBe(1);
    await expect(
      service.createSingle(owner, { ...data, name: '不同姓名' }, key)
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  test('真实HTTP：完整原文显示和导出、跨用户列表／详情／导出隔离，管理员可见', async () => {
    const preview = await service.preview(owner, makeBuffer([[' 原始测试 ', CARD]]));
    const id = preview.batch.id;
    const detailResponse = await request(`/batches/${id}`);
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.headers.get('cache-control')).toBe('no-store');
    expect((await detailResponse.json()).data.rows[0]).toMatchObject({
      name: ' 原始测试 ',
      idCardNumber: CARD,
    });
    expect((await request(`/batches/${id}`, tokens.other)).status).toBe(404);
    expect((await request(`/batches/${id}/export`, tokens.other)).status).toBe(404);
    expect((await request(`/batches/${id}/start`, tokens.other, { method: 'POST' })).status).toBe(
      404
    );
    expect((await request(`/batches/${id}`, tokens.admin)).status).toBe(200);
    expect((await (await request('/batches', tokens.other)).json()).data.total).toBe(0);
    const template = await request('/template');
    expect(template.status).toBe(200);
    const templateSheet = XLSX.read(Buffer.from(await template.arrayBuffer()), {
      type: 'buffer',
      cellStyles: true,
    }).Sheets['身份核验'];
    expect(templateSheet.A1.v).toBe('姓名');
    expect(templateSheet.B1.v).toBe('身份证号');
    const output = await request(`/batches/${id}/export`);
    const sheet = XLSX.read(Buffer.from(await output.arrayBuffer()), { type: 'buffer' }).Sheets[
      '核验结果'
    ];
    expect(sheet.C2).toMatchObject({ t: 's', v: CARD });
    const [raw] = await models.sequelize.query(
      'SELECT name, id_card_number FROM identity_verification_items'
    );
    expect(raw[0].name).toMatch(/^enc:/);
    expect(JSON.stringify(raw)).not.toContain(CARD);
  });
  test('Excel上传预览不外呼，重复组合只调用一次并映射各原始行', async () => {
    const data = new FormData();
    data.append(
      'file',
      new Blob([
        makeBuffer([
          ['测试', CARD],
          ['测试', CARD],
          ['错误', '123'],
        ]),
      ]),
      'test.xlsx'
    );
    const response = await request('/preview', tokens.owner, { method: 'POST', body: data });
    expect(response.status).toBe(200);
    const preview = (await response.json()).data;
    expect(preview.batch.summary).toMatchObject({ valid: 1, duplicates: 1, invalid: 1 });
    const verify = jest.fn().mockResolvedValue({ status: 'matched', message: '一致' });
    await tick(verify);
    expect(verify).not.toHaveBeenCalled();
    await Promise.all([
      service.control(owner, preview.batch.id, 'start'),
      service.control(owner, preview.batch.id, 'start'),
    ]);
    await tick(verify);
    await tick(verify);
    expect(verify).toHaveBeenCalledTimes(1);
    const detail = await service.detail(owner, preview.batch.id);
    expect(detail.rows.map(row => row.status)).toEqual(['matched', 'matched', 'invalid']);
    expect(detail.batch.status).toBe('completed');
  });
  test('已撤销权限的旧JWT无法查看原文或导出，执行器暂停后续发送', async () => {
    const created = await service.createSingle(
      owner,
      { name: '测试', idCardNumber: CARD },
      crypto.randomUUID()
    );
    await models.UserPermission.destroy({
      where: { userId: owner.id, permissionCode: permissions.IDENTITY_READ },
    });
    try {
      expect((await request(`/batches/${created.batchId}`)).status).toBe(403);
      const verify = jest.fn();
      await tick(verify);
      expect(verify).not.toHaveBeenCalled();
      expect((await models.IdentityVerificationBatch.findByPk(created.batchId)).status).toBe(
        'paused'
      );
    } finally {
      await models.UserPermission.create({
        userId: owner.id,
        permissionCode: permissions.IDENTITY_READ,
        grantedBy: admin.id,
      });
    }
  });
  test('额度异常暂停所有活动批次，继续只执行pending，失败行不重试', async () => {
    const preview = await service.preview(
      owner,
      makeBuffer([
        ['测试甲', CARD],
        ['测试乙', CARD],
      ])
    );
    await service.control(owner, preview.batch.id, 'start');
    const otherBatch = await service.createSingle(
      other,
      { name: '测试丙', idCardNumber: CARD },
      crypto.randomUUID()
    );
    const verify = jest
      .fn()
      .mockResolvedValue({ status: 'error', fatal: true, message: '额度不足' });
    await tick(verify);
    expect((await models.IdentityVerificationBatch.findByPk(otherBatch.batchId)).status).toBe(
      'paused'
    );
    await service.control(owner, preview.batch.id, 'start');
    verify.mockResolvedValue({ status: 'matched', message: '一致' });
    await tick(verify);
    const detail = await service.detail(owner, preview.batch.id);
    expect(detail.rows.map(row => row.status)).toEqual(['error', 'matched']);
    expect(verify).toHaveBeenCalledTimes(2);
  });
  test('持久化processing中断标unknown，不重新发送，其他待处理行保持pending', async () => {
    const preview = await service.preview(
      owner,
      makeBuffer([
        ['测试甲', CARD],
        ['测试乙', CARD],
      ])
    );
    await service.control(owner, preview.batch.id, 'start');
    await models.IdentityVerificationItem.update(
      { status: 'processing' },
      { where: { batchId: preview.batch.id, rowNumber: 2 } }
    );
    const verify = jest.fn();
    await tick(verify);
    expect(verify).not.toHaveBeenCalled();
    const detail = await service.detail(owner, preview.batch.id);
    expect(detail.rows.map(row => row.status)).toEqual(['unknown', 'pending']);
    expect(detail.batch.status).toBe('paused');
  });
  test('停止期间在途请求可落结果，第二个执行器不能重复领取，未开始行取消', async () => {
    const preview = await service.preview(
      owner,
      makeBuffer([
        ['测试甲', CARD],
        ['测试乙', CARD],
      ])
    );
    await service.control(owner, preview.batch.id, 'start');
    let finish;
    let entered;
    const started = new Promise(resolve => {
      entered = resolve;
    });
    const verify = jest.fn(() => {
      entered();
      return new Promise(resolve => {
        finish = resolve;
      });
    });
    const work = tick(verify);
    await started;
    expect(await runner.runOnce(verify)).toBe(false);
    await service.control(owner, preview.batch.id, 'stop');
    finish({ status: 'mismatched', message: '不一致' });
    await work;
    const detail = await service.detail(owner, preview.batch.id);
    expect(detail.rows.map(row => row.status)).toEqual(['mismatched', 'cancelled']);
    expect(detail.batch.status).toBe('cancelled');
    expect(verify).toHaveBeenCalledTimes(1);
  });
  test('全局500ms间隔生效，预览过期拒绝开始', async () => {
    const preview = await service.preview(
      owner,
      makeBuffer([
        ['测试甲', CARD],
        ['测试乙', CARD],
      ])
    );
    await service.control(owner, preview.batch.id, 'start');
    const verify = jest.fn().mockResolvedValue({ status: 'matched' });
    await tick(verify);
    const firstStartedAt = await models.IdentityVerificationItem.max('startedAt');
    const now = jest.spyOn(Date, 'now').mockReturnValue(new Date(firstStartedAt).getTime() + 100);
    try {
      await runner.runOnce(verify);
    } finally {
      now.mockRestore();
    }
    expect(verify).toHaveBeenCalledTimes(1);
    const expired = await service.preview(owner, makeBuffer([['测试丙', CARD]]));
    await models.IdentityVerificationBatch.update(
      { expiresAt: new Date(0) },
      { where: { id: expired.batch.id } }
    );
    await expect(service.control(owner, expired.batch.id, 'start')).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
