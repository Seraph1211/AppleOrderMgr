import { parseSerialBarcode } from './pickupBarcode.js';

/** 只保留 Apple SN 条码；IMEI、纯数字和非 SN 编码不能成为设备身份。 */
export function stockSerialBarcodes(values) {
  const serials = new Map();
  for (const value of values) {
    const serial = parseSerialBarcode(value);
    if (serial) serials.set(serial, value.trim().toUpperCase());
  }
  return [...serials.values()].slice(0, 10);
}

/** 在有界画布上尝试完整图、分区和旋转，条码不可读时仍允许 OCR 人工核对。 */
export async function readStockBoxBarcodes(source, isCurrent = () => true) {
  const found = [];
  try {
    if (!isCurrent()) return [];
    if (globalThis.BarcodeDetector) {
      try {
        const detector = new globalThis.BarcodeDetector({ formats: ['code_128', 'code_39'] });
        const results = await detector.detect(source);
        found.push(...results.map(result => result.rawValue));
      } catch (_error) {
        // 浏览器未实现相应格式时继续本地 ZXing，不增加云端请求。
      }
    }
    if (!isCurrent()) return [];
    const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
      import('@zxing/browser'),
      import('@zxing/library'),
    ]);
    const reader = new BrowserMultiFormatReader(
      new Map([
        [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39]],
        [DecodeHintType.TRY_HARDER, true],
      ])
    );
    const width = source.width;
    const height = source.height;
    for (const [top, portion] of [
      [0, 1],
      [0, 0.5],
      [0.25, 0.5],
      [0.5, 0.5],
    ]) {
      for (const rotated of [false, true]) {
        if (!isCurrent()) return [];
        const cropHeight = Math.round(height * portion);
        const scale = Math.min(1, 1600 / Math.max(width, cropHeight));
        const w = Math.max(1, Math.round(width * scale));
        const h = Math.max(1, Math.round(cropHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = rotated ? h : w;
        canvas.height = rotated ? w : h;
        const context = canvas.getContext('2d');
        if (rotated) {
          context.translate(h, 0);
          context.rotate(Math.PI / 2);
        }
        context.drawImage(source, 0, Math.round(height * top), width, cropHeight, 0, 0, w, h);
        try {
          const result = reader.decodeFromCanvas(canvas);
          found.push(result.getText());
        } catch (_error) {
          // 单个方向没有条码属正常情况；保留其他分区结果，交由服务端交叉核对。
        }
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    return isCurrent() ? stockSerialBarcodes(found) : [];
  } catch (_error) {
    return isCurrent() ? stockSerialBarcodes(found) : [];
  }
}
