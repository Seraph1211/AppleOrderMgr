const crypto = require('crypto');
const zlib = require('zlib');
const ApiError = require('../utils/ApiError');
const MAX_PNG_BYTES = 128 * 1024;
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** 严格检查有限尺寸、完整 PNG；不访问码内地址。 @param {string} value Data URL @returns {string} 图片摘要 */
function validatePaymentPng(value) {
  try {
    if (
      typeof value !== 'string' ||
      value.length > MAX_PNG_BYTES * 1.4 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
    )
      throw new Error();
    const base64 = value.slice('data:image/png;base64,'.length);
    const bytes = Buffer.from(base64, 'base64');
    if (
      bytes.length > MAX_PNG_BYTES ||
      bytes.toString('base64') !== base64 ||
      bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    )
      throw new Error();
    let pos = 8;
    let width;
    let height;
    let depth;
    let color;
    let ended = false;
    const chunks = [];
    while (pos < bytes.length) {
      if (pos + 12 > bytes.length || ended) throw new Error();
      const size = bytes.readUInt32BE(pos);
      const type = bytes.toString('ascii', pos + 4, pos + 8);
      if (
        pos + size + 12 > bytes.length ||
        crc32(bytes.subarray(pos + 4, pos + 8 + size)) !== bytes.readUInt32BE(pos + 8 + size)
      )
        throw new Error();
      if (pos === 8) {
        if (type !== 'IHDR' || size !== 13) throw new Error();
        width = bytes.readUInt32BE(pos + 8);
        height = bytes.readUInt32BE(pos + 12);
        depth = bytes[pos + 16];
        color = bytes[pos + 17];
        if (
          width < 21 ||
          width > 1024 ||
          height !== width ||
          ![1, 2, 4, 8, 16].includes(depth) ||
          ![0, 2, 3, 4, 6].includes(color) ||
          bytes[pos + 18] !== 0 ||
          bytes[pos + 19] !== 0 ||
          bytes[pos + 20] !== 0
        )
          throw new Error();
      } else if (!['IDAT', 'IEND', 'PLTE', 'tRNS'].includes(type)) throw new Error();
      if (type === 'IDAT') chunks.push(bytes.subarray(pos + 8, pos + 8 + size));
      if (type === 'IEND') {
        if (size !== 0) throw new Error();
        ended = true;
      }
      pos += size + 12;
    }
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
    const expected = (Math.ceil((width * depth * channels) / 8) + 1) * height;
    if (
      !ended ||
      !chunks.length ||
      zlib.inflateSync(Buffer.concat(chunks), { maxOutputLength: 9 * 1024 * 1024 }).length !==
        expected
    )
      throw new Error();
    return crypto.createHash('sha256').update(bytes).digest('hex');
  } catch (_error) {
    throw ApiError.badRequest('付款码图片无效或不完整');
  }
}
module.exports = { validatePaymentPng };
