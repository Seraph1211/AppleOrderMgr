const { randomUUID } = require('crypto');
const suite = process.env.AOS_TASK_CONFIG_HTTP_DB === '1' ? describe : describe.skip;
suite('任务配置真实用户INTEGER身份与HTTP鉴权链路', () => {
  let models;
  let server;
  let base;
  let instance;
  let device;
  const users = [];
  const tokens = [];
  beforeAll(async () => {
    if (
      process.env.DB_HOST !== 'postgres' ||
      process.env.DB_NAME !== 'aos_task_config_dev' ||
      process.env.DATABASE_URL
    )
      throw new Error('HTTP隔离数据库门禁未通过');
    models = require('../src/models');
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use(require('../src/middleware/authMiddleware').authenticate);
    app.use('/api/server-monitor', require('../src/routes/serverMonitor'));
    app.use(require('../src/middleware/errorHandler'));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/server-monitor/task-configs`;
    for (const role of ['admin', 'operator']) {
      const session = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
      const user = await models.User.create({
        username: `taskqa_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        password: 'Synthetic-Only-TaskQA-123!',
        role,
        status: 'active',
        activeSessions: [session],
      });
      users.push(user);
      tokens.push(
        require('../src/utils/jwtUtils').generateToken({
          userId: user.id,
          username: user.username,
          role,
          sessionId: session.id,
        })
      );
    }
    device = await models.AosDevice.create({
      id: randomUUID(),
      name: 'US_TASK_HTTP_QA',
      enabled: true,
      credentialHash: '0'.repeat(64),
    });
    instance = await models.MonitorInstance.create({
      id: randomUUID(),
      deviceId: device.id,
      localId: randomUUID(),
      label: 'HTTP验收实例',
      active: true,
    });
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (models) {
      if (instance) {
        await models.AosTaskConfigPreview.destroy({ where: { instanceId: instance.id } });
        await models.AosTaskConfigVersion.destroy({ where: { instanceId: instance.id } });
        await models.AosTaskConfig.destroy({ where: { instanceId: instance.id } });
        await instance.destroy();
      }
      if (device) await device.destroy();
      for (const user of users) await user.destroy({ force: true });
      await models.sequelize.close();
    }
  });
  async function call(path, body, token = tokens[0]) {
    try {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, json: await response.json() };
    } catch (error) {
      throw new Error('TASK_HTTP_QA_FAILED', { cause: error });
    }
  }
  test('真实整数用户从认证、预览、发布到历史查询均成功，正文伪造actor不起效', async () => {
    expect(Number.isInteger(users[0].id)).toBe(true);
    const fields = Array(36).fill('');
    [fields[0], fields[1], fields[2], fields[3], fields[4]] = [
      'http-task@example.invalid',
      'never-store-secret',
      '广州天环广场',
      'iPhone Duo 星光白色 512G',
      '2',
    ];
    const preview = await call(`/${instance.id}/preview`, {
      text: [fields.join(','), fields.join(',')].join('\n'),
      actorId: users[1].id,
    });
    expect(preview.status).toBe(200);
    expect(preview.json.data).toMatchObject({ valid: true, taskCount: 2 });
    const result = await call(`/${instance.id}/activate`, {
      previewId: preview.json.data.previewId,
      expectedRevision: preview.json.data.expectedRevision,
    });
    expect(result.status).toBe(200);
    expect(result.json.data.currentVersion).toMatchObject({ taskCount: 2, actorId: users[0].id });
    const history = await call(`/${instance.id}/versions`);
    expect(history.status).toBe(200);
    expect(history.json.data.items).toHaveLength(1);
    expect(JSON.stringify(history.json)).not.toMatch(/never-store-secret|http-task@example/);
  });
  test('无认证401、真实无权限用户403', async () => {
    expect((await call('', undefined, '')).status).toBe(401);
    expect((await call('', undefined, tokens[1])).status).toBe(403);
    expect((await call(`/${instance.id}/preview`, { text: 'anything' }, tokens[1])).status).toBe(
      403
    );
  });
});
