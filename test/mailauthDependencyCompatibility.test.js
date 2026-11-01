/* eslint-disable no-magic-numbers -- 合成 RSA 密钥长度与测试超时。 */
const { generateKeyPairSync } = require('crypto');
const { dkimSign } = require('mailauth/lib/dkim/sign');
const { dkimVerify } = require('mailauth/lib/dkim/verify');
const { verifyOrderMailAuthenticity } = require('../src/services/orderMailAuthentication');

test.each([false, true])('安全依赖升级后真实 DKIM 验证，正文篡改=%s', async tampered => {
  try {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const body = Buffer.from(
      'From: Synthetic CI <ci@apple.com>\r\nTo: receiver@example.test\r\n' +
        'Subject: Synthetic offline DKIM test\r\n\r\noriginal body\r\n'
    );
    const signature = await dkimSign(body, {
      signTime: new Date('2026-01-01T00:00:00Z'),
      signatureData: [
        {
          signingDomain: 'apple.com',
          selector: 'synthetic-ci',
          privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        },
      ],
    });
    expect(signature.errors).toHaveLength(0);
    const signed = Buffer.concat([
      Buffer.from(signature.signatures),
      tampered ? Buffer.from(body.toString().replace('original body', 'changed body')) : body,
    ]);
    const resolver = jest.fn((name, type) => {
      try {
        expect(name).toBe('synthetic-ci._domainkey.apple.com');
        expect(type).toBe('TXT');
        return Promise.resolve([
          [
            `v=DKIM1; k=rsa; p=${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`,
          ],
        ]);
      } catch (error) {
        throw Object.assign(error, { component: 'synthetic-dkim-dns' });
      }
    });
    const result = await verifyOrderMailAuthenticity(
      signed,
      { from: { value: [{ address: 'ci@apple.com' }] } },
      { verifier: raw => dkimVerify(raw, { resolver, curTime: new Date('2026-01-02T00:00:00Z') }) }
    );
    if (!tampered) expect(resolver).toHaveBeenCalled();
    expect(result.status).toBe(tampered ? 'failed' : 'verified');
  } catch (error) {
    throw Object.assign(error, { component: 'mailauth-dependency-compatibility' });
  }
});
