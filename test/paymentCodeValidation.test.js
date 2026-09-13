const crypto = require('crypto');
const { validatePaymentPng } = require('../src/services/paymentCodeValidation');
const { verifyManifest } = require('../src/services/collectorReleaseService');
const { makePng } = require('./fixtures/paymentCode');
describe('付款码图片容器与签名边界', () => {
  test('接受完整 PNG 并按实际图片内容区分摘要', () => {
    expect(validatePaymentPng(makePng())).toMatch(/^[a-f0-9]{64}$/);
    expect(validatePaymentPng(makePng())).not.toBe(validatePaymentPng(makePng(1)));
  });
  test.each([
    null,
    '',
    'https://www.apple.com.cn/xc/cn/vieworder/example',
    'data:image/svg+xml,<svg/>',
    'data:image/png;base64,AAAA',
    makePng().slice(0, -4),
    makePng() + 'AAAA',
  ])('拒绝错误、截断和外链输入 %#', value => expect(() => validatePaymentPng(value)).toThrow());
  test('拒绝被篡改的分块', () => {
    const bytes = Buffer.from(makePng().split(',')[1], 'base64');
    bytes[20] ^= 1;
    expect(() => validatePaymentPng('data:image/png;base64,' + bytes.toString('base64'))).toThrow();
  });
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const manifest = {
    product: 'AppleOrderMgrAosCollector',
    platform: 'win-x64',
    version: '1.1.0',
    size: 100,
    sha256: 'a'.repeat(64),
    queueSchema: 1,
  };
  const sign = value => {
    const bytes = Buffer.from(JSON.stringify(value));
    return {
      payload: bytes.toString('base64'),
      signature: crypto.sign('RSA-SHA256', bytes, keys.privateKey).toString('base64'),
    };
  };
  test('使用精确 payload 字节验签', () =>
    expect(verifyManifest(sign(manifest), keys.publicKey)).toEqual(manifest));
  test('拒绝伪造签名', () =>
    expect(() =>
      verifyManifest(
        { ...sign(manifest), signature: Buffer.alloc(256).toString('base64') },
        keys.publicKey
      )
    ).toThrow());
  test.each([
    { ...manifest, version: '../test' },
    { ...manifest, product: 'OtherApp' },
    { ...manifest, platform: 'linux' },
    { ...manifest, size: 400 * 1024 * 1024 },
    { ...manifest, queueSchema: 2 },
  ])('即使签名正确也拒绝不支持的产品和格式 %#', value =>
    expect(() => verifyManifest(sign(value), keys.publicKey)).toThrow()
  );
});
