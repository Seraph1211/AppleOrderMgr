jest.mock('axios', () => ({ post: jest.fn() }));
jest.mock('../src/services/wecomNotificationContent', () => ({ MAX_TEXT_BYTES: 2048 }));

const axios = require('axios');
const { sendMarkdown } = require('../src/services/wecomTransport');

const WEBHOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic_key_123456';

beforeEach(() => {
  jest.resetAllMocks();
});

describe('企业微信监控 Markdown 传输分类', () => {
  test('成功回执归类为 accepted，正文与传输安全选项准确', async () => {
    axios.post.mockResolvedValue({ status: 200, data: { errcode: 0 } });

    await expect(sendMarkdown(WEBHOOK, '合成告警内容')).resolves.toEqual({ status: 'accepted' });

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      WEBHOOK,
      { msgtype: 'markdown', markdown: { content: '合成告警内容' } },
      expect.objectContaining({ maxRedirects: 0, proxy: false, timeout: 10000 })
    );
  });

  test.each([
    [{ status: 429, data: {} }],
    [{ status: 200, data: { errcode: 45009 } }],
  ])('明确限流返回可重试 pending', async response => {
    axios.post.mockResolvedValue(response);

    await expect(sendMarkdown(WEBHOOK, '限流合成内容')).resolves.toEqual({
      status: 'pending',
      errorCode: 'RATE_LIMITED',
      retryMs: 60000,
    });
  });

  test.each([
    [{ status: 200, data: { errcode: 93000 } }, 'WEBHOOK_REJECTED'],
    [{ status: 200, data: { errcode: 40001 } }, 'API_REJECTED'],
  ])('明确拒绝暂停通道且不伪装成未知', async (response, errorCode) => {
    axios.post.mockResolvedValue(response);

    await expect(sendMarkdown(WEBHOOK, '拒绝合成内容')).resolves.toEqual({
      status: 'failed',
      errorCode,
      pause: true,
    });
  });

  test('超时属于未知结果，且不向调用方泄漏底层错误文本', async () => {
    const timeout = Object.assign(new Error('private socket details'), { code: 'ETIMEDOUT' });
    axios.post.mockRejectedValue(timeout);

    await expect(sendMarkdown(WEBHOOK, '超时合成内容')).resolves.toEqual({
      status: 'unknown',
      errorCode: 'TRANSPORT_UNKNOWN',
    });
  });

  test('重定向响应归类为未知并确认 Axios 禁止跟随重定向', async () => {
    axios.post.mockResolvedValue({ status: 302, data: { location: 'https://evil.example' } });

    await expect(sendMarkdown(WEBHOOK, '重定向合成内容')).resolves.toEqual({
      status: 'unknown',
      errorCode: 'RESPONSE_UNKNOWN',
    });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post.mock.calls[0][2].maxRedirects).toBe(0);
  });

  test.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'])('明确未建立连接的 %s 可安全重试', async code => {
    axios.post.mockRejectedValue(Object.assign(new Error('private host details'), { code }));

    await expect(sendMarkdown(WEBHOOK, '连接失败合成内容')).resolves.toEqual({
      status: 'pending',
      errorCode: 'CONNECT_FAILED',
      retryMs: 10000,
    });
  });

  test('TLS 证书错误是安全连接失败，不能自动重试或泄漏证书错误', async () => {
    axios.post.mockRejectedValue(
      Object.assign(new Error('private certificate details'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
    );

    await expect(sendMarkdown(WEBHOOK, 'TLS 合成内容')).resolves.toEqual({
      status: 'unknown',
      errorCode: 'TRANSPORT_UNKNOWN',
    });
  });

  test('正好 3500 字节可发送，超出上限则在本地拒绝且不发请求', async () => {
    axios.post.mockResolvedValue({ status: 200, data: { errcode: 0 } });

    await expect(sendMarkdown(WEBHOOK, 'a'.repeat(3500))).resolves.toEqual({ status: 'accepted' });
    expect(axios.post).toHaveBeenCalledTimes(1);

    await expect(sendMarkdown(WEBHOOK, '告'.repeat(1167))).resolves.toEqual({
      status: 'failed',
      errorCode: 'TEXT_TOO_LONG',
    });
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
});
