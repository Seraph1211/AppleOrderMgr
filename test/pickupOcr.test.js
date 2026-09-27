const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/src/utils/pickupOcr.js'), 'utf8');
const { normalizeOcrSerial, extractSerialCandidates, validateOcrFile } = vm.runInNewContext(
  `${source.replace(/export function /g, 'function ')}; ({normalizeOcrSerial, extractSerialCandidates, validateOcrFile})`
);

describe('序列号 OCR 候选与人工复核边界', () => {
  test.each([
    ['(S) Serial No. C02ABC123XYZ\nIMEI 490154203237518', ['C02ABC123XYZ']],
    ['Serial No: S234567890', ['S234567890']],
    ['Serial No. CWJCTVJ2RY\nSerial No. TEST000002', ['CWJCTVJ2RY', 'TEST000002']],
    ['Serial No. TEST 000001', ['TEST000001']],
    ['Serial No.\nTEST000001', ['TEST000001']],
    ['Serial No. ABCDEFGHIJ', ['ABCDEFGHIJ']],
    ['TEST000001\nTEST000001\nMANUFACTURED', ['TEST000001']],
    ['IMEI 490154203237518\nUPC 195951411859\nEID 8904903202100881500296964381382', []],
    ['Serial No. TEST000001\nIMEI 123456789012\nModel ABC1234567', ['TEST000001']],
    ['', []],
  ])('候选仅作人工核对 %s', (text, expected) => {
    expect(extractSerialCandidates(text)).toEqual(expected);
  });
  test('不猜测易混淆字符，不去掉印刷号码的真实 S', () => {
    expect(normalizeOcrSerial('S234567890')).toBe('S234567890');
    expect(normalizeOcrSerial('STEST000001')).toBeNull();
    expect(normalizeOcrSerial(' testOOO001 ')).toBe('TESTOOO001');
    expect(normalizeOcrSerial('195951411859')).toBeNull();
  });
  test('限制类型、大小及空文件', () => {
    expect(validateOcrFile({ type: 'image/jpeg', size: 1024 })).toBe('');
    expect(validateOcrFile({ type: 'image/heic', size: 1024 })).toMatch(/JPG/);
    expect(validateOcrFile({ type: 'image/svg+xml', size: 1024 })).not.toBe('');
    expect(validateOcrFile({ type: 'image/png', size: 0 })).not.toBe('');
    expect(validateOcrFile({ type: 'image/png', size: 21000000 })).not.toBe('');
  });
});
