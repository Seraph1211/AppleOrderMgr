const { verifyOrderMailAuthenticity } = require('../src/services/orderMailAuthentication');

const raw = Buffer.from('From: Apple <orders@orders.apple.com>\r\n\r\nbody');
const parsed = { from: { value: [{ address: 'orders@orders.apple.com' }] } };

describe('订单邮件来源验证', () => {
  test('只有 Apple 对齐域的密码学通过结果可自动应用', async () => {
    const result = await verifyOrderMailAuthenticity(raw, parsed, {
      senderDomains: ['apple.com'],
      verifier: () => ({
        results: [
          {
            signingDomain: 'orders.apple.com',
            selector: 'apple',
            algo: 'rsa-sha256',
            signatureTimeValid: true,
            status: { result: 'pass' },
          },
        ],
      }),
    });
    expect(result).toEqual({
      status: 'verified',
      reason: null,
      evidence: {
        method: 'dkim',
        signingDomain: 'orders.apple.com',
        selector: 'apple',
        algorithm: 'rsa-sha256',
      },
    });
  });

  test('From 白名单、签名存在或其他域通过都不能冒充验证成功', async () => {
    const result = await verifyOrderMailAuthenticity(raw, parsed, {
      senderDomains: ['apple.com'],
      verifier: () => ({
        results: [{ signingDomain: 'example.test', status: { result: 'pass' } }],
      }),
    });
    expect(result).toMatchObject({ status: 'failed', reason: 'DKIM_NOT_VERIFIED' });
  });

  test('配置不能把非 Apple From 域扩展为自动可信来源', async () => {
    const result = await verifyOrderMailAuthenticity(
      raw,
      { from: { value: [{ address: 'orders@example.test' }] } },
      {
        senderDomains: ['example.test', 'apple.com'],
        verifier: () => ({
          results: [{ signingDomain: 'apple.com', status: { result: 'pass' } }],
        }),
      }
    );
    expect(result).toMatchObject({ status: 'failed', reason: 'SENDER_NOT_ALLOWED' });
  });

  test('DNS 暂时故障进入可重试状态', async () => {
    const result = await verifyOrderMailAuthenticity(raw, parsed, {
      verifier: () =>
        Promise.reject(Object.assign(new Error('dns timeout'), { code: 'ETIMEOUT' })),
    });
    expect(result).toMatchObject({ status: 'temporary_failure', reason: 'DKIM_TEMPORARY' });
  });
});
