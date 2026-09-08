const { createRequire } = require('module');

const express = require('express');
const axios = require('axios');
const { request } = require('undici');
const { Address4, Address6 } = require('ip-address');
const utf7 = require('utf7');
const cron = require('node-cron');
const { DataTypes } = require('sequelize');
const { toDefaultValue } = require('sequelize/lib/utils');

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { parseMimeEmail } = require('../src/services/emailParser');
const { buildMime } = require('./fixtures/emailMessages');

describe('安全依赖升级兼容性', () => {
  test('IMAP 保留 UTF-7 编解码并使用已修复的 semver', () => {
    const fromUtf7 = createRequire(require.resolve('utf7'));
    expect(fromUtf7('semver/package.json').version).toBe('5.7.2');
    expect(fromUtf7('semver').gte(process.version, '6.0.0')).toBe(true);
    expect(fromUtf7('semver').valid(`1.${'9'.repeat(1024)}.0`)).toBeNull();
    for (const mailbox of ['INBOX', '收件箱', '订单 & 已归档', '测试📧']) {
      expect(utf7.imap.decode(utf7.imap.encode(mailbox))).toBe(mailbox);
    }
    expect(utf7.imap.encode('&')).toBe('&-');
  });

  test('Sequelize 原有 UUID 默认值与 CommonJS 调用保持兼容', () => {
    const fromSequelize = createRequire(require.resolve('sequelize'));
    const uuid = fromSequelize('uuid');
    expect(fromSequelize('uuid/package.json').version).toBe('11.1.1');
    for (const [type, version] of [
      [DataTypes.UUIDV1, 1],
      [DataTypes.UUIDV4, 4],
    ]) {
      const value = toDefaultValue(new type());
      expect(uuid.validate(value)).toBe(true);
      expect(uuid.version(value)).toBe(version);
    }
  });

  test('node-cron 保留任务命名、手动执行和停止行为', () => {
    const fromCron = createRequire(require.resolve('node-cron'));
    const uuid = fromCron('uuid');
    expect(fromCron('uuid/package.json').version).toBe('11.1.1');
    const handler = jest.fn();
    const task = cron.schedule('* * * * * *', handler, { scheduled: false });
    try {
      expect(uuid.validate(task.options.name)).toBe(true);
      expect(uuid.version(task.options.name)).toBe(4);
      expect(handler).not.toHaveBeenCalled();
      task.now();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(cron.validate('not-a-cron')).toBe(false);
    } finally {
      task.stop();
      cron.getTasks().delete(task.options.name);
    }
  });

  test('IP 解析保留有效代理地址并拒绝歧义前导零', () => {
    expect(new Address4('192.0.2.20').correctForm()).toBe('192.0.2.20');
    expect(Address4.isValid('010.0.0.1')).toBe(false);
    expect(Address4.isValid('999.1.1.1')).toBe(false);
    expect(new Address6('::ffff:192.0.2.20').is4()).toBe(true);
  });

  test('更新 MIME 依赖后仍正确处理 HTML、编码与正文', async () => {
    const mime = buildMime({
      body: '<p>安全回归 &amp; 测试</p><p>第二行</p>',
      transferEncoding: 'base64',
      encode: true,
    });
    const { parsed } = await parseMimeEmail(mime);
    expect(parsed.from.value[0].address).toBe('orders@example.com');
    expect(parsed.text).toContain('安全回归 & 测试');
    expect(parsed.text).toContain('第二行');
  });

  test('MIME 异常输入和超限继续返回稳定错误码', async () => {
    await expect(parseMimeEmail({})).rejects.toMatchObject({ code: 'MIME_PARSE_FAILED' });
    await expect(parseMimeEmail(Buffer.alloc(0))).rejects.toMatchObject({ code: 'BODY_MISSING' });
    await expect(parseMimeEmail(Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toMatchObject({
      code: 'MIME_TOO_LARGE',
    });
  });
});

describe('Express 与 HTTP 客户端升级后的本地传输契约', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    app.get('/query', (req, res) => res.json(req.query));
    app.post('/body', (req, res) => res.json(req.body));
    app.use((error, _req, res, _next) =>
      res.status(error.status || 500).json({
        code: error.type || 'unexpected',
      })
    );
    await new Promise((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      );
    }
  });

  test('qs 定向覆盖保留嵌套筛选并阻断原型污染', async () => {
    const fromExpress = createRequire(require.resolve('express'));
    expect(fromExpress('qs/package.json').version).toBe('6.16.0');
    const response = await axios.get(
      `${baseUrl}/query?status=payment_due&filter[page]=2&__proto__[polluted]=true&constructor[prototype][polluted]=true`,
      { proxy: false }
    );
    expect(response.data).toMatchObject({ status: 'payment_due', filter: { page: '2' } });
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(Object.hasOwn(response.data, '__proto__')).toBe(false);
  });

  test('Undici 保留 JSON 请求响应且不访问外部服务', async () => {
    const response = await request(`${baseUrl}/body`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'payment_due', quantity: 0 }),
    });
    expect(response.statusCode).toBe(200);
    await expect(response.body.json()).resolves.toEqual({ status: 'payment_due', quantity: 0 });
  });

  test('表单数组和中文字段保持可解析', async () => {
    const response = await axios.post(`${baseUrl}/body`, 'items[0]=test&tag=%E6%B5%8B%E8%AF%95', {
      proxy: false,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(response.data).toEqual({ items: ['test'], tag: '测试' });
  });

  test('非法 JSON 与超过 10MB 的请求继续失败', async () => {
    const options = {
      proxy: false,
      headers: { 'content-type': 'application/json' },
      transformRequest: [value => value],
      validateStatus: () => true,
    };
    const invalid = await axios.post(`${baseUrl}/body`, '{invalid', options);
    expect(invalid.status).toBe(400);
    expect(invalid.data.code).toBe('entity.parse.failed');
    const oversized = await axios.post(
      `${baseUrl}/body`,
      JSON.stringify({ value: 'x'.repeat(10 * 1024 * 1024) }),
      options
    );
    expect(oversized.status).toBe(413);
    expect(oversized.data.code).toBe('entity.too.large');
  });
});
