import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readStockBoxBarcodes, stockSerialBarcodes } from '../src/utils/stockBoxBarcode.js';

test('仅SN条码保留，前导S去重但真实S开头SN不截断，过滤IMEI与异常类型', () => {
  const result = stockSerialBarcodes([
    ' SAB12CD34EF ', 'AB12CD34EF', 'S012CD34EF', '123456789012345',
    '1234567890', '', null, undefined, 123, 'bad',
  ]);
  assert.deepEqual(result, ['AB12CD34EF', 'S012CD34EF']);
  assert.equal(stockSerialBarcodes(Array.from({ length: 12 }, (_, i) => `AB12CD34${String(i).padStart(2, '0')}`)).length, 10);
});

test('读取开始前取消不访问检测器，检测完成后取消也丢弃条码', async () => {
  const original = globalThis.BarcodeDetector;
  let calls = 0;
  let active = true;
  globalThis.BarcodeDetector = class {
    async detect() {
      calls += 1;
      active = false;
      return [{ rawValue: 'SAB12CD34EF' }];
    }
  };
  try {
    assert.deepEqual(await readStockBoxBarcodes({}, () => false), []);
    assert.equal(calls, 0);
    assert.deepEqual(await readStockBoxBarcodes({}, () => active), []);
    assert.equal(calls, 1);
  } finally {
    if (original) globalThis.BarcodeDetector = original;
    else delete globalThis.BarcodeDetector;
  }
});
