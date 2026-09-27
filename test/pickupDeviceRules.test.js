const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { normalizeDeviceBarcodes } = require('../src/services/pickupDeviceRules');

const source = fs.readFileSync(
  path.join(__dirname, '../frontend/src/utils/pickupBarcode.js'),
  'utf8'
);
const frontend = vm.runInNewContext(
  `${source.replace(/export function /g, 'function ')}; ({parseSerialBarcode, cameraErrorMessage})`
);

describe('包装盒号码校验与前后端一致性', () => {
  test.each([
    ['TEST000001', 'TEST000001'],
    ['STEST000001', 'TEST000001'],
    ['S234567890', 'S234567890'],
    ['SS234567890', 'S234567890'],
    ['C02TEST0001X', 'C02TEST0001X'],
    ['SC02TEST0001X', 'C02TEST0001X'],
    [' test000001 ', 'TEST000001'],
  ])('序列号 %s 规范化为 %s，保留真实 S', (raw, expected) => {
    expect(normalizeDeviceBarcodes({ serialBarcode: raw }).serialNumber).toBe(expected);
    expect(frontend.parseSerialBarcode(raw)).toBe(expected);
  });
  test.each([
    '',
    '123',
    '123456789012345',
    '195951411859',
    '1234567890',
    'A'.repeat(65),
    'TEST-00001',
    {},
    null,
  ])('拒绝错误序列号 %p', raw => {
    expect(() => normalizeDeviceBarcodes({ serialBarcode: raw })).toThrow();
    expect(frontend.parseSerialBarcode(raw)).toBeNull();
  });
  test('仅序列号即可登记，保留原始条码且忽略历史 IMEI 输入', () => {
    expect(
      normalizeDeviceBarcodes({ serialBarcode: 'STEST000001', imeiBarcode: 'unused' })
    ).toEqual({
      serialNumber: 'TEST000001',
      serialBarcode: 'STEST000001',
    });
  });
  test.each([
    'NotAllowedError',
    'SecurityError',
    'NotReadableError',
    'AbortError',
    'NotFoundError',
    'OverconstrainedError',
    'OtherError',
  ])('相机错误 %s 有可操作提示', name => {
    expect(frontend.cameraErrorMessage({ name })).toMatch(/相机/);
  });
});
